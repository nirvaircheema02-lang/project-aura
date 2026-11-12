import PQueue from 'p-queue';
import type Database from 'better-sqlite3';
import type { Edge, NodeId } from './edges.ts';
import { RETRY_POLICY, backoffDelayMs, classify, type ExecutionType } from './retry.ts';
import { fanOutSettled, incrementFanOut, setRunStatus, type RunStatus } from './state.ts';
import { gateOutcome, openGate, statusForGate } from './gates.ts';
import { withNodeSpan } from '../tracing/index.ts';

/**
 * IMPLEMENTATION-PLAN.md §2's "Orchestrator shape" — a small typed-edge-driven
 * loop, not a general-purpose workflow engine. Scope, honestly stated:
 *
 * - Node *data* (a node's return value, passed to the next node) is threaded
 *   in-memory for the duration of one `runGraph` call. Durable, cross-process
 *   RESTART state is the Graph State in state.ts (run status, fan_out counts,
 *   checkpoints) — exactly what Decision Log #1's page-level-restart needs.
 *   Full node-output durability was explicitly rejected (Decision Log #1);
 *   this engine does not pretend to have it. A gate's `from` node is expected
 *   to persist whatever the gate/reviewer needs (e.g. `runs.scope_json`)
 *   before pausing — resume does not re-run that node, it re-enters routing
 *   directly with caller-supplied state (reconstructed from durable storage
 *   in a real caller), matching "no finer state to recover" (Decision Log #1).
 * - `gate` edges stop the walk and return a paused result; a separate
 *   `resumeGraph` call re-enters routing at the recorded node — matching
 *   "the process can exit; a separate `resume <run_id>` command re-enters at
 *   the recorded position" (§2's orchestrator shape).
 */

export interface NodeContext {
  db: Database.Database;
  runId: string;
  /** Real setTimeout by default; tests inject a no-op to skip real backoff waits. */
  sleep: (ms: number) => Promise<void>;
}

export type NodeFn<TIn = unknown, TOut = unknown> = (ctx: NodeContext, input: TIn) => Promise<TOut>;

// The registry is intentionally type-erased (NodeFn<any, any>): a graph is a
// heterogeneous dispatch table by nature — each real node's own module (once
// B1-B6/etc. exist) is fully typed against its own Zod-validated input/output;
// only the *engine's* boundary, which dispatches across all of them uniformly,
// gives that up. Runtime shape-safety at that boundary is S0's job, not TS's.
export interface GraphDefinition {
  nodes: Record<NodeId, NodeFn<any, any>>;
  executionTypes: Record<NodeId, ExecutionType>;
  edges: Edge[];
  start: NodeId;
}

export type RunOutcome =
  | { kind: 'complete'; result: unknown }
  | { kind: 'paused'; status: RunStatus; at: NodeId }
  | { kind: 'aborted'; status: RunStatus; at: NodeId }
  | { kind: 'failed'; at: NodeId; error: unknown };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function edgesFrom(edges: Edge[], from: NodeId): Edge[] {
  return edges.filter((e) => 'from' in e && e.from === from);
}

/**
 * Runs one node with the §2.4 classify -> retry loop for its execution type.
 * On exhausted retries (or an immediate TERMINAL), writes an escalation_queue
 * row (reason: NODE_FAILURE) — the same queue LOW_CONFIDENCE escalations use
 * — and rethrows so the caller can route accordingly.
 */
async function executeWithRetry(
  db: Database.Database,
  runId: string,
  nodeId: NodeId,
  executionType: ExecutionType,
  fn: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void>,
): Promise<unknown> {
  const policy = RETRY_POLICY[executionType];
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      // §2.6: every node ATTEMPT is its own span, so a retry is visible as a
      // retry rather than hidden inside one long span.
      return await withNodeSpan({ runId, nodeId, attempt, isAi: executionType === 'ai' || executionType === 'hybrid' }, fn);
    } catch (err) {
      lastError = err;
      const failureClass = classify(err);
      if (failureClass === 'TERMINAL') break;
      if (attempt < policy.maxAttempts) {
        await sleep(backoffDelayMs(policy, attempt));
      }
    }
  }
  db.prepare(
    `INSERT INTO escalation_queue (run_id, node_id, reason, detail_json, created_at) VALUES (?, ?, 'NODE_FAILURE', ?, ?)`,
  ).run(runId, nodeId, JSON.stringify({ error: lastError instanceof Error ? lastError.message : String(lastError) }), Date.now());
  throw lastError;
}

/** Fans out `edge.to` over every item `edge.items(fromNodeResult)` produces (§2.1/§2's orchestrator shape). */
async function runFanOut(
  db: Database.Database,
  runId: string,
  ctx: NodeContext,
  graph: GraphDefinition,
  edge: Extract<Edge, { type: 'fan-out' }>,
  fromNodeResult: unknown,
): Promise<void> {
  const items = edge.items(fromNodeResult);
  const queue = new PQueue({ concurrency: edge.concurrency });
  const nodeFn = graph.nodes[edge.to];
  if (!nodeFn) throw new Error(`fan-out target node "${edge.to}" is not registered`);
  const executionType = graph.executionTypes[edge.to] ?? 'deterministic';

  for (const item of items) {
    incrementFanOut(db, runId, 'dispatched');
    void queue.add(async () => {
      try {
        await executeWithRetry(db, runId, edge.to, executionType, () => nodeFn(ctx, item), ctx.sleep);
        incrementFanOut(db, runId, 'completed');
      } catch {
        // Exhausted retries already logged to escalation_queue by executeWithRetry.
        // §2.4 partial fan-in: one branch failing must never block its siblings.
        incrementFanOut(db, runId, 'failed');
      }
    });
  }
  await queue.onIdle();
}

/**
 * Given that `nodeId` just produced `result`, decides what happens next by
 * inspecting its outgoing edges. Never re-executes `nodeId` itself — this is
 * the function `resumeGraph` re-enters directly, deliberately skipping
 * execution of the node that was already run before the pause.
 */
async function routeFrom(
  db: Database.Database,
  runId: string,
  ctx: NodeContext,
  graph: GraphDefinition,
  nodeId: NodeId,
  result: unknown,
): Promise<RunOutcome> {
  const outgoing = edgesFrom(graph.edges, nodeId);
  const gate = outgoing.find((e): e is Extract<Edge, { type: 'gate' }> => e.type === 'gate');

  if (gate) {
    const outcome = gateOutcome(db, runId, gate.name);
    if (outcome === 'NOT_OPENED') {
      const status = openGate(db, runId, gate.name, gate.timeoutMs);
      setRunStatus(db, runId, status);
      return { kind: 'paused', status, at: nodeId };
    }
    if (outcome === 'PENDING' || outcome === 'TIMED_OUT_AWAITING_FALLBACK') {
      // Already open. PENDING: awaiting a decision, don't re-open. TIMED_OUT: still
      // PENDING — never auto-approve/reject (§4.2); caller/CLI pages a fallback
      // reviewer, the run stays paused either way.
      // A resume that finds the gate still undecided puts the run BACK into its
      // AWAITING state — leaving it RUNNING would let stale-run recovery fail it.
      const status = statusForGate(gate.name);
      setRunStatus(db, runId, status);
      return { kind: 'paused', status, at: nodeId };
    }
    if (outcome === 'REJECTED') {
      setRunStatus(db, runId, 'ABORTED');
      return { kind: 'aborted', status: 'ABORTED', at: nodeId };
    }
    // APPROVED — proceed to the gate's `to` node.
    return executeAndRoute(db, runId, ctx, graph, gate.to, result);
  }

  const fanOutEdge = outgoing.find((e): e is Extract<Edge, { type: 'fan-out' }> => e.type === 'fan-out');
  if (fanOutEdge) {
    await runFanOut(db, runId, ctx, graph, fanOutEdge, result);
    const fanInEdge = outgoing.find((e): e is Extract<Edge, { type: 'fan-in' }> => e.type === 'fan-in');
    if (!fanInEdge) throw new Error(`fan-out from "${nodeId}" has no matching fan-in edge`);
    if (!fanOutSettled(fanOutCountsOf(db, runId))) {
      // Should not happen within one process's synchronous drain, but never silently
      // consolidate on an unsettled batch (§2.4 A4 precondition).
      throw new Error(`fan-in for "${nodeId}" reached before fan_out settled — refusing to consolidate early`);
    }
    return executeAndRoute(db, runId, ctx, graph, fanInEdge.to, result);
  }

  const conditional = outgoing.find((e): e is Extract<Edge, { type: 'conditional' }> => e.type === 'conditional');
  const sequential = outgoing.find((e): e is Extract<Edge, { type: 'sequential' }> => e.type === 'sequential');
  const nextEdge = conditional ?? sequential;

  if (!nextEdge) {
    return { kind: 'complete', result };
  }
  if (nextEdge.type === 'conditional') {
    const branch = nextEdge.branches.find((b) => b.when(result));
    return executeAndRoute(db, runId, ctx, graph, branch?.to ?? nextEdge.fallback, result);
  }
  return executeAndRoute(db, runId, ctx, graph, nextEdge.to, result);
}

/** Executes `nodeId` against `input`, then routes from its result. */
async function executeAndRoute(
  db: Database.Database,
  runId: string,
  ctx: NodeContext,
  graph: GraphDefinition,
  nodeId: NodeId,
  input: unknown,
): Promise<RunOutcome> {
  const nodeFn = graph.nodes[nodeId];
  if (!nodeFn) throw new Error(`node "${nodeId}" is not registered`);
  const executionType = graph.executionTypes[nodeId] ?? 'deterministic';

  let result: unknown;
  try {
    result = await executeWithRetry(db, runId, nodeId, executionType, () => nodeFn(ctx, input), ctx.sleep);
  } catch (error) {
    return { kind: 'failed', at: nodeId, error };
  }
  return routeFrom(db, runId, ctx, graph, nodeId, result);
}

// Small helper kept local — avoid a second DB read shape leaking into state.ts's public API.
function fanOutCountsOf(db: Database.Database, runId: string) {
  return db.prepare('SELECT dispatched, completed, failed, retrying, cache_hits FROM fan_out WHERE run_id = ?').get(runId) as {
    dispatched: number;
    completed: number;
    failed: number;
    retrying: number;
    cache_hits: number;
  };
}

export async function runGraph(
  db: Database.Database,
  runId: string,
  graph: GraphDefinition,
  initialState: unknown = undefined,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  /**
   * A nested graph (the B graph running inside one of A3's fan-out branches)
   * shares the OUTER run's row. It must not mark that run COMPLETE when the
   * page finishes, or the first page would end the whole site audit.
   */
  options: { manageRunStatus?: boolean } = {},
): Promise<RunOutcome> {
  const ctx: NodeContext = { db, runId, sleep };
  const manageRunStatus = options.manageRunStatus ?? true;
  const outcome = await executeAndRoute(db, runId, ctx, graph, graph.start, initialState);
  if (manageRunStatus && outcome.kind === 'complete') setRunStatus(db, runId, 'COMPLETE');
  if (manageRunStatus && outcome.kind === 'failed') setRunStatus(db, runId, 'FAILED');
  return outcome;
}

/**
 * Re-enters a paused run at `atNode` — the node whose gate previously paused
 * the walk. Does NOT re-execute `atNode`'s own function (it already ran
 * before the pause); `state` is the result that node already produced,
 * supplied by the caller (a real caller reconstructs it from durable
 * storage, e.g. `runs.scope_json` — see the module-level note above). Only
 * makes forward progress if the relevant checkpoint has since been
 * APPROVED/REJECTED — otherwise returns the same `paused` outcome again.
 */
export async function resumeGraph(
  db: Database.Database,
  runId: string,
  graph: GraphDefinition,
  atNode: NodeId,
  state: unknown,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<RunOutcome> {
  const ctx: NodeContext = { db, runId, sleep };
  const outcome = await routeFrom(db, runId, ctx, graph, atNode, state);
  if (outcome.kind === 'complete') setRunStatus(db, runId, 'COMPLETE');
  if (outcome.kind === 'failed') setRunStatus(db, runId, 'FAILED');
  return outcome;
}
