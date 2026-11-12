import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { runGraph, resumeGraph, type GraphDefinition, type NodeContext, type RunOutcome } from '../graph/engine.ts';
import { claimRun, createRun, getFanOut, incrementFanOut } from '../graph/state.ts';
import { buildSiteMap, type SiteMap } from './a1-site-mapper/index.ts';
import { classifyTemplates, type ClassifiedUrl } from './a2-template-classifier/index.ts';
import { consolidateSite, type ConsolidatedResult } from './a4-site-consolidator/index.ts';
import { auditPage, pageIdFor, type PageAuditDeps } from './page-graph.ts';
import { buildAuditData, type AuditData } from './c2-json-writer/index.ts';
import { pageResultsFromDb } from '../skills/s7-audit-state-history.ts';
import { policyVersionFor } from '../graph/run-metadata.ts';
import type { PageResult } from '../skills/s0-result-contract.ts';
import type { DsRegistry } from '../ds/d2-registry/index.ts';
import type { LlmClient } from '../llm/client.ts';
import type { AiMode } from '../llm/provider.ts';
import type { Config } from '../config/index.ts';
import type { BrowserPool } from '../t-layer/browser.ts';
import type { Politeness } from '../t-layer/politeness.ts';

/**
 * The full-site graph (v1.0 §8):
 *
 *   A1 → A2 → [Scope Gate] → A3 ⇉ (N parallel page audits) ⇉ A4 → [Publish Gate] → C
 *
 * Both gates are real `gate` edges: the run pauses, the process can exit, and
 * `resumeSiteAudit` re-enters at the recorded node once a human decides
 * (§4.2). Fan-out/fan-in, the atomic counters and partial fan-in all come from
 * the engine — one failing page never blocks its siblings or A4 (§2.4).
 */

export interface SiteAuditDeps {
  db: Database.Database;
  registry: DsRegistry;
  /** Decision Log #31: which strategy A2, A4 and every page's B nodes run. */
  aiMode: AiMode;
  llm: LlmClient;
  config: Config;
  pool: BrowserPool;
  politeness: Politeness;
  evidenceRoot: string;
  /** Bounded discovery — an explicit limit, surfaced in the scope a human approves. */
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

export interface SiteScope {
  root: string;
  siteMap: SiteMap;
  classified: ClassifiedUrl[];
  families: Array<{ name: string; pages: number }>;
  estimatedBInstances: number;
  concurrency: number;
}

export interface SiteAuditState {
  scope: SiteScope;
  pages: PageResult[];
  failedPages: Array<{ url: string; reason: string }>;
  data?: AuditData;
  consolidated?: ConsolidatedResult;
}

/** Collected per run so A4 can consolidate; the durable record is SQLite. */
interface Collector {
  pages: PageResult[];
  failed: Array<{ url: string; reason: string }>;
}

export function buildSiteGraph(deps: SiteAuditDeps, runId: string, collector: Collector, startedAt: string): GraphDefinition {
  const concurrency = Math.max(1, deps.config.politeness.maxConcurrentContexts);

  return {
    start: 'A1',
    nodes: {
      A1: async (_ctx: NodeContext, root: string): Promise<SiteScope> => {
        const siteMap = await buildSiteMap(root, { pool: deps.pool, politeness: deps.politeness, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }, { maxPages: deps.maxPages ?? 50 });
        return { root: siteMap.root, siteMap, classified: [], families: [], estimatedBInstances: siteMap.urls.length, concurrency };
      },

      A2: async (_ctx, scope: SiteScope): Promise<SiteScope> => {
        const { map, classified } = await classifyTemplates(scope.siteMap, deps.llm, deps.aiMode);
        const families = map.families.map((f) => ({ name: f.name, pages: classified.filter((c) => c.templateFamily === f.name).length }));
        const withScope: SiteScope = { ...scope, classified, families, estimatedBInstances: classified.length };
        // Persist what the Scope Gate reviewer will see BEFORE pausing — resume does
        // not re-run A2, so the scope must already be durable (§2 orchestrator shape).
        deps.db.prepare('UPDATE runs SET scope_json = ? WHERE run_id = ?').run(JSON.stringify(withScope), runId);
        return withScope;
      },

      /**
       * A3 — dispatcher: decides what actually gets audited, honouring page-level
       * restart. §4.4 memoization is NOT decided here: it needs the page's CURRENT
       * DOM, which only exists after capture — the old check here compared the
       * stored hash with itself, so a second run skipped every page and published
       * an empty report. Each PAGE branch now checks after capturing (reuseIfUnchanged).
       */
      A3: async (_ctx, scope: SiteScope): Promise<{ scope: SiteScope; toDispatch: ClassifiedUrl[] }> => {
        const toDispatch: ClassifiedUrl[] = [];
        for (const target of scope.classified) {
          const pageId = pageIdFor(target.url);
          const alreadyDoneThisRun = deps.db
            .prepare('SELECT 1 FROM audit_history WHERE page_id = ? AND run_id = ?')
            .get(pageId, runId);
          if (alreadyDoneThisRun) continue; // page-level restart: never redo a finished page
          toDispatch.push(target);
        }
        return { scope, toDispatch };
      },

      /** One fan-out branch = one page audit, in its own BrowserContext. */
      PAGE: async (_ctx, target: ClassifiedUrl): Promise<void> => {
        const pageDeps: PageAuditDeps = {
          db: deps.db,
          registry: deps.registry,
          aiMode: deps.aiMode,
          llm: deps.llm,
          config: deps.config,
          pool: deps.pool,
          politeness: deps.politeness,
          evidenceRoot: deps.evidenceRoot,
        };
        try {
          const result = await auditPage(target.url, pageDeps, {
            runId,
            runAlreadyCreated: true,
            nested: true,
            templateFamily: target.templateFamily,
            reuseIfUnchanged: true,
          });
          if (result.reusedFromRunId) incrementFanOut(deps.db, runId, 'cache_hits');
          // A page that failed an earlier attempt and then succeeded is audited, not failed.
          // (Spliced in place: A4 holds the same array.)
          const failedBefore = collector.failed.findIndex((f) => f.url === target.url);
          if (failedBefore >= 0) collector.failed.splice(failedBefore, 1);
          collector.pages.push(result);
        } catch (err) {
          // Recorded, never swallowed: this is what fills v1.0 §15's "09 Failed / Skipped Pages".
          // Keyed by URL because this node runs once per RETRY ATTEMPT (§2.4) — appending
          // blindly would report one broken page as several failed pages.
          const reason = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
          const existing = collector.failed.find((f) => f.url === target.url);
          if (existing) existing.reason = reason;
          else collector.failed.push({ url: target.url, reason });
          throw err; // let the engine count it as a failed branch (§2.4 partial fan-in)
        }
      },

      /** A4 — consolidate everything the branches produced. */
      A4: async (_ctx, input: { scope: SiteScope }): Promise<SiteAuditState> => {
        // Pages finished before a pause live in SQLite, not in this process's
        // memory — a resumed run must consolidate those too, not just what it
        // audited since resuming.
        const restored = pageResultsFromDb(deps.db, runId);
        const seen = new Set(collector.pages.map((p) => p.pageId));
        const pages = [...collector.pages, ...restored.filter((p) => !seen.has(p.pageId))];
        const data = buildAuditData({
          runId,
          auditId: `audit-${runId}`,
          mode: 'full-site',
          startedAt,
          targetUrl: input.scope.root,
          pages,
          failedPages: collector.failed,
          renderingPolicy: deps.pool.renderingPolicy(),
          aiMode: deps.aiMode,
        });
        const consolidated = await consolidateSite(data, deps.llm, deps.aiMode);
        const state: SiteAuditState = { scope: input.scope, pages, failedPages: collector.failed, data, consolidated };
        // Persist BEFORE the Publish Gate pauses — resume re-enters routing and
        // must not have to re-run A4 (or lose the master result on a restart).
        deps.db
          .prepare('INSERT OR REPLACE INTO run_results (run_id, node_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
          .run(runId, 'A4', JSON.stringify(state), Date.now());
        return state;
      },

      /** Terminal node after the Publish Gate — C1/C2/C3/C4 are driven by the caller. */
      PUBLISH: async (_ctx, state: SiteAuditState): Promise<SiteAuditState> => state,
    },
    executionTypes: {
      A1: 'deterministic',
      A2: deps.aiMode === 'no-api' ? 'deterministic' : 'ai',
      A3: 'deterministic',
      PAGE: deps.aiMode === 'no-api' ? 'deterministic' : 'hybrid',
      A4: deps.aiMode === 'no-api' ? 'deterministic' : 'ai',
      PUBLISH: 'deterministic',
    },
    edges: [
      { type: 'sequential', from: 'A1', to: 'A2' },
      // Scope Confirmation Gate — full-site only, after A2, before dispatch (§4.2).
      { type: 'gate', from: 'A2', to: 'A3', name: 'scope_confirmation', timeoutMs: 24 * 60 * 60_000 },
      { type: 'fan-out', from: 'A3', to: 'PAGE', items: (r: unknown) => (r as { toDispatch: ClassifiedUrl[] }).toDispatch, concurrency },
      { type: 'fan-in', from: 'A3', to: 'A4' },
      // Publish Confirmation Gate — before anything is written to Figma (§4.2).
      { type: 'gate', from: 'A4', to: 'PUBLISH', name: 'publish_confirmation', timeoutMs: 24 * 60 * 60_000 },
    ],
  };
}

export interface SiteAuditHandle {
  outcome: RunOutcome;
  collector: Collector;
  graph: GraphDefinition;
}

export async function startSiteAudit(root: string, deps: SiteAuditDeps, runId: string): Promise<SiteAuditHandle> {
  await mkdir(deps.evidenceRoot, { recursive: true });
  const rendering = deps.pool.renderingPolicy();
  createRun(deps.db, {
    run_id: runId,
    run_type: 'full-site',
    url: root,
    ds_registry_version: deps.registry.version.dsRegistryVersion,
    policy_version: policyVersionFor(rendering, deps.aiMode),
    rendering_policy_json: JSON.stringify(rendering),
  });
  const collector: Collector = { pages: [], failed: [] };
  const graph = buildSiteGraph(deps, runId, collector, new Date().toISOString());
  const outcome = await runGraph(deps.db, runId, graph, root);
  return { outcome, collector, graph };
}

/**
 * Re-enters a paused site run after a gate decision. The node the run paused
 * at is re-routed from, not re-executed — A2's scope is read back from
 * `runs.scope_json` rather than recomputed by re-crawling the site.
 */
export async function resumeSiteAudit(
  deps: SiteAuditDeps,
  runId: string,
  atNode: string,
  handle: SiteAuditHandle,
): Promise<RunOutcome> {
  const row = deps.db.prepare('SELECT scope_json FROM runs WHERE run_id = ?').get(runId) as { scope_json: string | null } | undefined;
  if (!row?.scope_json) throw new Error(`run ${runId} has no persisted scope to resume from`);
  const scope = JSON.parse(row.scope_json) as SiteScope;

  let state: unknown = scope;
  if (atNode === 'A4') {
    const saved = deps.db.prepare('SELECT payload_json FROM run_results WHERE run_id = ? AND node_id = ?').get(runId, 'A4') as
      | { payload_json: string }
      | undefined;
    if (!saved) throw new Error(`run ${runId} paused at the publish gate but has no persisted A4 result to resume from`);
    state = JSON.parse(saved.payload_json) as SiteAuditState;
  }
  // Take ownership atomically, only from the expected pause — two concurrent resumes cannot
  // both proceed, and the run carries THIS process's pid (not the dead one that started it).
  const expected = atNode === 'A4' ? 'AWAITING_PUBLISH_CONFIRMATION' : 'AWAITING_SCOPE_CONFIRMATION';
  if (!claimRun(deps.db, runId, [expected])) {
    throw new Error(`run ${runId} is not paused at the ${atNode === 'A4' ? 'publish' : 'scope'} gate (or is already being resumed)`);
  }
  return resumeGraph(deps.db, runId, handle.graph, atNode, state);
}

/** Counters a reviewer sees at a gate, straight from Graph State. */
export function runCounters(db: Database.Database, runId: string) {
  return getFanOut(db, runId);
}

export function evidenceDirFor(root: string, runId: string): string {
  return join(root, runId);
}
