import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { openDb, type Database } from '../../src/db/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { DisabledLlmClient } from '../../src/llm/provider.ts';
import { resumeSiteAudit, runCounters, startSiteAudit, type SiteAuditDeps, type SiteAuditHandle, type SiteAuditState, type SiteScope } from '../../src/agents/site-graph.ts';
import { decideCheckpoint, getRun } from '../../src/graph/state.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Decision Log #31, requirement 3: a FULL-SITE audit completes in no-api mode
 * — A1 discovery, A2's deterministic template families, the Scope Gate, the
 * fan-out of page audits (deterministic B1–B6), A4's deterministic clusters,
 * the Publish Gate — with a model client that refuses every call, so a single
 * model request anywhere would fail the run instead of passing silently.
 */

const page = (title: string) => `<!doctype html><html><head><title>${title}</title><style>
 body { font-family: "DM Sans", sans-serif; margin: 0; }
 .cta { height: 44px; background: #b01f24; color: #fff; border: 0; padding: 0 20px; font-family: Manrope, sans-serif; font-size: 12px; border-radius: 6px; }
 .card { cursor: pointer; border: 1px solid #d9d1ce; padding: 12px; width: 220px; }
</style></head><body>
<nav aria-label="Nav"><a href="/">Home</a><a href="/reports/a">Report A</a><a href="/reports/b">Report B</a></nav>
<main><section aria-label="Hero"><h1>${title}</h1><button type="button" class="cta">Talk to a Strategy Expert</button></section>
<section aria-label="Cards"><div class="card">Card one</div><div class="card">Card two</div></section></main>
</body></html>`;

let dir: string;
let db: Database;
let registry: DsRegistry;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let deps: SiteAuditDeps;
let llm: DisabledLlmClient;
let handle: SiteAuditHandle;
const runId = 'run-site-no-api';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-site-noapi-'));
  const config = loadConfig();
  registry = await loadDsRegistry(config.designSystemPath);
  db = openDb(join(dir, 'audit.db'));
  server = await startLocalServer({
    '/': { body: page('Ken Research') },
    '/reports/a': { body: page('Report A') },
    '/reports/b': { body: page('Report B') },
    '/sitemap.xml': { body: '' },
  });
  server.routes['/sitemap.xml'] = {
    body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${server.origin}/</loc></url><url><loc>${server.origin}/reports/a</loc></url><url><loc>${server.origin}/reports/b</loc></url></urlset>`,
    headers: { 'content-type': 'application/xml' },
  };
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  llm = new DisabledLlmClient();
  deps = { db, registry, aiMode: 'no-api', llm, config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'evidence'), maxPages: 10 };
  handle = await startSiteAudit(server.origin, deps, runId);
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('full-site audit in no-api mode', () => {
  it('A2 classifies templates deterministically and the run pauses at the Scope Gate', () => {
    expect(handle.outcome.kind).toBe('paused');
    const scope = JSON.parse(getRun(db, runId)!.scope_json!) as SiteScope;
    expect(scope.classified).toHaveLength(3);
    expect(scope.families.map((f) => f.name).sort()).toEqual(['Home', 'Reports (/reports/*)']);
    expect(getRun(db, runId)!.policy_version).toContain('+ai-no-api+');
  });

  it('fans out every page, reaches the Publish Gate, and completes — with zero model calls', async () => {
    decideCheckpoint(db, runId, 'scope_confirmation', 'APPROVED', 'design@kenresearch.com');
    const atPublish = await resumeSiteAudit(deps, runId, 'A2', handle);
    expect(atPublish.kind).toBe('paused');
    const counters = runCounters(db, runId);
    expect(counters).toMatchObject({ dispatched: 3, completed: 3, failed: 0 });

    decideCheckpoint(db, runId, 'publish_confirmation', 'APPROVED', 'design@kenresearch.com');
    const final = await resumeSiteAudit(deps, runId, 'A4', handle);
    expect(final.kind).toBe('complete');
    const state = (final as { result: SiteAuditState }).result;
    const data = state.data!;
    expect(data.run.aiMode).toBe('no-api');
    expect(data.websiteSummary.pagesAudited).toBe(3);
    // The hand-rolled Manrope CTA breaks R1.4 on every page — measured, so INCORRECT, not a guess.
    expect(data.findings.some((f) => f.classification === 'INCORRECT' && f.comparison.ruleViolations.some((r) => r.ruleId === 'R1.4'))).toBe(true);
    // …and A4's deterministic clustering names the shared cause across the three pages.
    expect(state.consolidated!.rootCauses.some((c) => /R1\.4/.test(c.title) && c.likelyOrigin.startsWith('deterministic cluster'))).toBe(true);
    expect(getRun(db, runId)!.status).toBe('COMPLETE');
    expect(llm.attempts).toBe(0);
  }, 300_000);
});
