import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { runGraph, type GraphDefinition, type NodeContext } from '../graph/engine.ts';
import { createRun, setRunStatus } from '../graph/state.ts';
import { runB1 } from './b1-page-analyzer/index.ts';
import { runB2 } from './b2-component-detector/index.ts';
import { runB3 } from './b3-ds-matcher/index.ts';
import { runB4 } from './b4-compliance-auditor/index.ts';
import { runB5 } from './b5-visual-verifier/index.ts';
import { runB6 } from './b6-new-component-evaluator/index.ts';
import { applyHistory, isCacheable, previousRunFor, priorFindings, recordAuditHistory, writeFindings } from '../skills/s7-audit-state-history.ts';
import { isAbsentThisRun, isNotCompared, isPriorIssueUnverified, scoreCompliance, type Finding, type PageResult } from '../skills/s0-result-contract.ts';
import { classify } from '../graph/retry.ts';
import { withCapturedPage } from '../t-layer/capture.ts';
import { policyVersionFor } from '../graph/run-metadata.ts';
import { BrowserPool } from '../t-layer/browser.ts';
import { Politeness } from '../t-layer/politeness.ts';
import type { Config } from '../config/index.ts';
import type { DsRegistry } from '../ds/d2-registry/index.ts';
import type { LlmClient } from '../llm/client.ts';
import type { AiMode } from '../llm/provider.ts';
import type { B4Output, B6Output, PageSession } from './types.ts';

/**
 * The single-page audit graph (v1.0 §9), run through the same engine the
 * full-site graph will use:
 *
 *   B1 → B2 → B3 → B4 → B5 → B6 → assemble
 *
 * The per-component conditional in the spec ("DS match → B4 → B5; no match →
 * B6") is realized as a data partition rather than a graph branch, because a
 * real page has components going BOTH ways at once: B3 splits the components
 * into `matched`/`unmatched` using S8's routing rule, B4/B5 process only the
 * matched set, and B6 only the unmatched set. Each node runs once per page,
 * so one LLM call handles a page's whole batch instead of one call per element.
 */

export interface PageAuditDeps {
  db: Database.Database;
  registry: DsRegistry;
  /** Decision Log #31: which strategy the AI nodes run. `no-api` never calls `llm`. */
  aiMode: AiMode;
  llm: LlmClient;
  config: Config;
  pool: BrowserPool;
  politeness: Politeness;
  evidenceRoot: string;
}

/**
 * A page audit that stopped at a node. Carries WHICH node, so the CLI can say
 * "failed at B4" and point at the trace, instead of printing a bare SDK error.
 * The original error stays the `cause`, and its failure class is preserved so
 * the site graph's retry policy still sees a TERMINAL as terminal.
 */
export class PageAuditError extends Error {
  readonly nodeId: string;
  readonly class?: 'TERMINAL' | 'REPAIRABLE';

  readonly status?: number;

  constructor(nodeId: string, cause: unknown) {
    const detail = cause instanceof Error ? (cause.message.split('\n')[0] ?? cause.message) : String(cause);
    super(detail.startsWith(`${nodeId}:`) ? detail : `${nodeId}: ${detail}`, { cause });
    this.nodeId = nodeId;
    // The cause's failure class, however it is expressed (a TerminalError, or an SDK
    // error's HTTP status): a wrapped 404/413 must still be TERMINAL to the site graph.
    const cls = classify(cause);
    if (cls !== 'RETRYABLE') this.class = cls;
    const status = (cause as { status?: unknown } | null)?.status;
    if (typeof status === 'number') this.status = status;
  }
}

export function pageIdFor(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
}

/** Wraps a node so it receives the live session alongside the threaded state. */
function withSession<TIn, TOut>(session: PageSession, fn: (ctx: NodeContext, input: TIn & { session: PageSession }) => Promise<TOut>) {
  return (ctx: NodeContext, input: TIn) => fn(ctx, { ...(input as TIn), session });
}

export function buildPageGraph(session: PageSession): GraphDefinition {
  // Same nodes and edges in both modes; only the strategy inside each node differs. A no-api
  // node is deterministic, so it gets the deterministic retry policy (§2.4) and no AI span flag.
  const ai = session.aiMode === 'no-api' ? 'deterministic' : 'ai';
  return {
    start: 'B1',
    nodes: {
      B1: (ctx) => runB1(ctx, session),
      B2: withSession(session, runB2),
      B3: withSession(session, runB3),
      B4: withSession(session, runB4),
      B5: withSession(session, runB5),
      B6: withSession(session, runB6),
    },
    executionTypes: { B1: ai, B2: ai, B3: ai, B4: session.aiMode === 'no-api' ? 'deterministic' : 'hybrid', B5: ai, B6: ai },
    edges: [
      { type: 'sequential', from: 'B1', to: 'B2' },
      { type: 'sequential', from: 'B2', to: 'B3' },
      { type: 'sequential', from: 'B3', to: 'B4' },
      { type: 'sequential', from: 'B4', to: 'B5' },
      { type: 'sequential', from: 'B5', to: 'B6' },
    ],
  };
}

export interface PageAuditOptions {
  runId: string;
  auditId?: string;
  /** Skips the run-level guard/creation when the caller (A3) already owns the run row. */
  runAlreadyCreated?: boolean;
  /** Template family from A2, carried into every finding this page produces. */
  templateFamily?: string | null;
  /**
   * True when this page audit is one branch of a full-site run. A nested page
   * must NOT mark the shared run COMPLETE/FAILED — the first page to finish
   * would otherwise end the whole site audit.
   */
  nested?: boolean;
  /**
   * §4.4 memoization (site mode): reuse the previous run's findings when the
   * page's freshly captured DOM AND the DS registry version are both unchanged.
   * The check needs the CURRENT DOM, so it can only happen here, after capture.
   */
  reuseIfUnchanged?: boolean;
}

/**
 * Audits one URL end to end. The whole graph executes inside one browser
 * session, because B2's evidence capture must happen while each element is
 * still resolvable in the state it was detected in.
 */
export async function auditPage(url: string, deps: PageAuditDeps, options: PageAuditOptions): Promise<PageResult> {
  const { db, registry, llm, config, pool, politeness, aiMode } = deps;
  const auditId = options.auditId ?? `audit-${options.runId}`;

  return withCapturedPage(pool, politeness, url, async (page, capture, observer) => {
    const pageId = pageIdFor(capture.canonical.pageUrl);
    const evidenceDir = `${deps.evidenceRoot}/${pageId}`;
    await mkdir(evidenceDir, { recursive: true });

    const policyVersion = policyVersionFor(capture.renderingPolicy, aiMode);
    // The page as delivered, before the audit interacts with it — the §4.4 cache key.
    const domHash = createHash('sha256').update(await page.content()).digest('hex');
    const captureSummary = {
      settled: capture.renderSettled.settled,
      httpStatus: capture.httpStatus,
      consoleSummary: capture.console.summary,
      criticalFailures: capture.network.criticalFailures.length,
    };

    if (options.reuseIfUnchanged) {
      const reused = reuseUnchangedResult(db, {
        pageId,
        runId: options.runId,
        auditId,
        domHash,
        dsRegistryVersion: registry.version.dsRegistryVersion,
        url: capture.canonical.pageUrl,
        templateFamily: options.templateFamily ?? null,
        policyVersion,
        capture: captureSummary,
      });
      if (reused) return reused;
    }

    if (!options.runAlreadyCreated) {
      createRun(db, {
        run_id: options.runId,
        run_type: 'single-page',
        url: capture.canonical.pageUrl,
        canonical_url: capture.canonical.declaredCanonical,
        ds_registry_version: registry.version.dsRegistryVersion,
        policy_version: policyVersion,
        rendering_policy_json: JSON.stringify(capture.renderingPolicy),
      });
    }

    const session: PageSession = {
      page,
      observer,
      capture,
      registry,
      db,
      aiMode,
      llm,
      config,
      runId: options.runId,
      auditId,
      pageId,
      url: capture.canonical.pageUrl,
      templateFamily: options.templateFamily ?? null,
      evidenceDir,
    };

    const outcome = await runGraph(db, options.runId, buildPageGraph(session), undefined, undefined, {
      manageRunStatus: !options.nested,
    });
    if (outcome.kind !== 'complete') {
      if (!options.nested) setRunStatus(db, options.runId, 'FAILED');
      const cause = outcome.kind === 'failed' ? outcome.error : new Error(`page audit did not complete: ${outcome.kind}`);
      throw new PageAuditError(outcome.at, cause);
    }

    const result = outcome.result as B6Output & B4Output;
    const findings = applyHistory(db, pageId, options.runId, result.findings);
    writeFindings(db, findings);
    recordAuditHistory(db, {
      pageId,
      runId: options.runId,
      domHash,
      dsRegistryVersion: registry.version.dsRegistryVersion,
    });

    return {
      runId: options.runId,
      pageId,
      url: capture.canonical.pageUrl,
      pageName: capture.canonical.pageUrl,
      templateFamily: options.templateFamily ?? null,
      domHash,
      dsRegistryVersion: registry.version.dsRegistryVersion,
      policyVersion,
      findings,
      compliance: scoreCompliance(findings),
      coverage: result.coverage,
      capture: captureSummary,
    } satisfies PageResult;
  });
}

/**
 * §4.4: when the page's DOM and the DS registry are both unchanged since the
 * page's last audit, that audit's findings still hold — copy them into this
 * run instead of paying for B1–B6 again. Not when the previous result had
 * anything unverified (NOT_COMPARED, or a prior issue carried unverified):
 * those deserve another attempt. Not across a policy / browser change either.
 */
function reuseUnchangedResult(
  db: Database.Database,
  input: {
    pageId: string;
    runId: string;
    auditId: string;
    domHash: string;
    dsRegistryVersion: string;
    url: string;
    templateFamily: string | null;
    policyVersion: string;
    capture: PageResult['capture'];
  },
): PageResult | null {
  if (!isCacheable(db, input.pageId, input.domHash, input.dsRegistryVersion)) return null;
  const previousRunId = previousRunFor(db, input.pageId, input.runId);
  if (!previousRunId) return null;
  const previous = priorFindings(db, previousRunId, input.pageId)
    .map((p) => p.payload)
    .filter((f): f is Finding => f !== null && !isAbsentThisRun(f));
  // Not when anything was left unverified (it deserves another attempt), and not across
  // a policy / browser change: the same DOM can render differently in another engine.
  if (previous.length === 0 || previous.some((f) => isNotCompared(f) || isPriorIssueUnverified(f))) return null;
  if (previous.some((f) => f.identity.policyVersion !== input.policyVersion)) return null;

  const now = new Date().toISOString();
  const copies: Finding[] = previous.map((f) => ({
    ...f,
    identity: { ...f.identity, runId: input.runId, auditId: input.auditId, timestamp: now },
    location: { ...f.location, templateFamily: input.templateFamily ?? f.location.templateFamily },
    // Reset, not hand-stamped: applyHistory below reads THIS run's actual predecessor
    // (previousRunId) back from the database and computes history the same way the live path
    // does — so a copied NEEDS_REVIEW finding gets delta:null like every other undecided one,
    // never the hand-stamped 'UNCHANGED_COMPLIANT' a genuinely unresolved item never earns
    // (third-pass review CH-3).
    history: { previousStatus: null, currentStatus: f.classification, delta: null, previousRunId: null },
  }));
  const findings = applyHistory(db, input.pageId, input.runId, copies);
  writeFindings(db, findings);
  recordAuditHistory(db, { pageId: input.pageId, runId: input.runId, domHash: input.domHash, dsRegistryVersion: input.dsRegistryVersion });
  return {
    runId: input.runId,
    pageId: input.pageId,
    url: input.url,
    pageName: input.url,
    templateFamily: input.templateFamily,
    domHash: input.domHash,
    dsRegistryVersion: input.dsRegistryVersion,
    policyVersion: input.policyVersion,
    findings,
    compliance: scoreCompliance(findings),
    coverage: {
      sectionsAnalyzed: 0,
      componentsDetected: findings.length,
      excludedPersonalized: 0,
      excludedOffDomain: 0,
      sampledListings: [],
      unexpandedStates: [],
      droppedRefs: [],
      truncation: [{ what: 'reused result', detail: `page DOM and Design System unchanged since ${previousRunId} — its findings were reused, not re-audited (§4.4)` }],
    },
    capture: input.capture,
    reusedFromRunId: previousRunId,
  };
}
