import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { runB1 } from '../../src/agents/b1-page-analyzer/index.ts';
import { runB2 } from '../../src/agents/b2-component-detector/index.ts';
import { runB3 } from '../../src/agents/b3-ds-matcher/index.ts';
import { runB4 } from '../../src/agents/b4-compliance-auditor/index.ts';
import { pageIdFor } from '../../src/agents/page-graph.ts';
import { DisabledLlmClient } from '../../src/llm/provider.ts';
import { withCapturedPage } from '../../src/t-layer/capture.ts';
import type { Config } from '../../src/config/index.ts';
import type { NodeContext } from '../../src/graph/engine.ts';
import type { DsRegistry } from '../../src/ds/d2-registry/index.ts';
import type { BrowserPool } from '../../src/t-layer/browser.ts';
import type { Politeness } from '../../src/t-layer/politeness.ts';
import type { B4Output, PageSession } from '../../src/agents/types.ts';

/**
 * The REAL first pass — B1 → B2 → B3 → B4, the same node functions the page graph runs, on a live page in
 * a real browser against the real Design System — with the page still open, handing back the session and
 * B4's output exactly as B5 receives them. A test can then do to that output what a real gap would
 * (drop a component B2 "missed", corrupt a finding, replace B3's answer) and run B5 on it, instead of
 * asserting on hand-built stand-ins.
 */
export interface LivePipelineDeps {
  db: Database.Database;
  registry: DsRegistry;
  config: Config;
  pool: BrowserPool;
  politeness: Politeness;
  evidenceRoot: string;
}

export async function withFirstPass<T>(url: string, deps: LivePipelineDeps, fn: (session: PageSession, firstPass: B4Output) => Promise<T>): Promise<T> {
  const { db, registry, config, pool, politeness } = deps;
  return withCapturedPage(pool, politeness, url, async (page, capture, observer) => {
    const pageId = pageIdFor(capture.canonical.pageUrl);
    const evidenceDir = join(deps.evidenceRoot, pageId);
    mkdirSync(evidenceDir, { recursive: true });
    const session: PageSession = {
      page, observer, capture, registry, db, aiMode: 'no-api', llm: new DisabledLlmClient(), config,
      runId: 'live-first-pass', auditId: 'audit-live-first-pass', pageId, url: capture.canonical.pageUrl, templateFamily: null, evidenceDir,
    };
    const ctx: NodeContext = { db, runId: session.runId, sleep: async () => {} };
    const b1 = await runB1(ctx, session);
    const b2 = await runB2(ctx, { ...b1, session });
    const b3 = await runB3(ctx, { ...b2, session });
    const { session: _session, ...b4 } = await runB4(ctx, { ...b3, session }) as B4Output & { session?: PageSession };
    return fn(session, b4);
  });
}
