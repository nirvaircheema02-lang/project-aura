/**
 * ARCHITECTURE.md §2.1 — the 7 typed edges. A discriminated union so the
 * engine (and anyone reading a graph definition) can switch on `type`
 * exhaustively. This file defines the *shape* of an edge; the engine (engine.ts)
 * defines what each type actually does at runtime.
 */

export type NodeId = string;

/** Runs `to` immediately after `from` completes. */
export interface SequentialEdge {
  type: 'sequential';
  from: NodeId;
  to: NodeId;
}

/** Routes to one of several `to` targets based on a predicate over run state. */
export interface ConditionalEdge<TState = unknown> {
  type: 'conditional';
  from: NodeId;
  branches: Array<{ to: NodeId; when: (state: TState) => boolean }>;
  /** Required — a conditional edge whose predicates all miss must not silently no-op. */
  fallback: NodeId;
}

/** Dispatches N parallel instances of `to`, one per item in a runtime-provided list. */
export interface FanOutEdge<TItem = unknown> {
  type: 'fan-out';
  from: NodeId;
  to: NodeId;
  items: (state: unknown) => TItem[];
  /** p-queue concurrency bound (IMPLEMENTATION-PLAN.md §2's orchestrator shape). */
  concurrency: number;
}

/** Consolidates a fan-out's results once `dispatched == completed + failed` (§2.4 partial fan-in). */
export interface FanInEdge {
  type: 'fan-in';
  from: NodeId;
  to: NodeId;
}

/** Cross-run only (§4) — never an in-run cycle (Decision Log #13). Reads/writes SQL directly. */
export interface FeedbackEdge {
  type: 'feedback';
  from: NodeId;
  /** Which prior run's/target's stored state this reads back into `from`. */
  source: 'root_cause_cluster' | 'registry_update' | 're_audit_baseline';
}

/** Pauses the run for human approve/reject, with a timeout-to-fallback-reviewer (§4.2). */
export interface GateEdge {
  type: 'gate';
  from: NodeId;
  to: NodeId;
  name: 'scope_confirmation' | 'publish_confirmation' | 'failure_threshold';
  timeoutMs: number;
}

/** Fires on node failure; routes through classify() -> retry -> escalation (§2.4). */
export interface ErrorEdge {
  type: 'error';
  from: NodeId;
  escalatesTo: 'escalation_queue';
}

export type Edge = SequentialEdge | ConditionalEdge | FanOutEdge | FanInEdge | FeedbackEdge | GateEdge | ErrorEdge;
