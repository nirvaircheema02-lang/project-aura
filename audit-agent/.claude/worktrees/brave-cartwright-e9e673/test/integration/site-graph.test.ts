import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { openDb, type Database } from '../../src/db/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { resumeSiteAudit, runCounters, startSiteAudit, type SiteAuditDeps, type SiteAuditHandle, type SiteAuditState, type SiteScope } from '../../src/agents/site-graph.ts';
import { decideCheckpoint, getRun } from '../../src/graph/state.ts';
import { buildSiteMap } from '../../src/agents/a1-site-mapper/index.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { ScriptedLlmClient } from '../helpers/scripted-llm.ts';

/**
 * Full-site mode end to end (build sequence step 9) against a real local
 * site: sitemap discovery, template classification, the Scope Gate, the
 * fan-out with bounded concurrency, partial fan-in with a deliberately broken
 * page, consolidation, and the Publish Gate.
 */

const page = (title: string, extra = '') => `<!doctype html><html><head><title>${title}</title><style>
 .cta{height:44px;background:#b01f24;color:#fff;border:0;padding:0 20px}
 .card{cursor:pointer;border:1px solid #d9d1ce;padding:12px}
</style></head><body>
<nav aria-label="Nav"><a href="/">Home</a><a href="/reports/a">Report A</a><a href="/reports/b">Report B</a></nav>
<main><section aria-label="Hero"><h1>${title}</h1><button type="button" class="cta">Talk to a Strategy Expert</button></section>
<section aria-label="Cards"><div class="card">Card one</div><div class="card">Card two</div></section>${extra}</main>
</body></html>`;

const SITEMAP = (origin: string) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/reports/a</loc></url>
  <url><loc>${origin}/reports/b</loc></url>
  <url><loc>${origin}/broken</loc></url>
</urlset>`;

let dir: string;
let db: Database;
let registry: DsRegistry;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let deps: SiteAuditDeps;
let handle: SiteAuditHandle;
const runId = 'run-site-1';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-site-'));
  const config = loadConfig();
  registry = await loadDsRegistry(config.designSystemPath);
  db = openDb(join(dir, 'audit.db'));

  server = await startLocalServer({
    '/': { body: page('Ken Research') },
    '/reports/a': { body: page('Report A') },
    '/reports/b': { body: page('Report B') },
    '/broken': { status: 500, body: 'server error' }, // one page must fail, on purpose
    '/sitemap.xml': { body: '', headers: { 'content-type': 'application/xml' } },
  });
  // The sitemap needs the server's own origin, known only after it binds.
  server.routes['/sitemap.xml'] = { body: SITEMAP(server.origin), headers: { 'content-type': 'application/xml' } };

  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();

  deps = {
    db,
    registry,
    aiMode: 'anthropic-api',
    llm: new ScriptedLlmClient(),
    config,
    pool,
    politeness: new Politeness(0),
    evidenceRoot: join(dir, 'evidence'),
    maxPages: 10,
  };

  handle = await startSiteAudit(server.origin, deps, runId);
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('A1 site mapper', () => {
  it('prefers the sitemap over crawling, and canonicalizes what it finds', async () => {
    const map = await buildSiteMap(server.origin, { pool, politeness: new Politeness(0) }, { maxPages: 10 });
    expect(map.sitemapUrl).toContain('/sitemap.xml');
    expect(map.urls.every((u) => u.source === 'sitemap' || u.source === 'seed')).toBe(true);
    expect(map.urls.map((u) => u.url)).toContain(`${server.origin}/reports/a`);
    expect(map.limits.truncated).toBe(false);
  });

  it('falls back to a bounded crawl when there is no sitemap', async () => {
    const noSitemap = await startLocalServer({ '/': { body: page('Root') }, '/reports/a': { body: page('A') }, '/reports/b': { body: page('B') } });
    try {
      const map = await buildSiteMap(noSitemap.origin, { pool, politeness: new Politeness(0) }, { maxPages: 10, maxDepth: 1 });
      expect(map.sitemapUrl).toBeNull();
      expect(map.urls.length).toBeGreaterThan(1);
      expect(map.urls.some((u) => u.source === 'crawl')).toBe(true);
    } finally {
      await noSitemap.close();
    }
  }, 60_000);
});

describe('Scope Confirmation Gate (§4.2)', () => {
  it('pauses before dispatching anything, with the scope a reviewer needs', () => {
    expect(handle.outcome.kind).toBe('paused');
    if (handle.outcome.kind !== 'paused') return;
    expect(handle.outcome.status).toBe('AWAITING_SCOPE_CONFIRMATION');
    expect(handle.outcome.at).toBe('A2');

    const run = getRun(db, runId)!;
    expect(run.status).toBe('AWAITING_SCOPE_CONFIRMATION');
    const scope = JSON.parse(run.scope_json!) as SiteScope;
    expect(scope.classified.length).toBeGreaterThan(0);
    expect(scope.estimatedBInstances).toBe(scope.classified.length);
    expect(scope.families.length).toBeGreaterThan(0);
  });

  it('dispatches nothing while the gate is pending — no page was audited before approval', () => {
    expect(runCounters(db, runId).dispatched).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as n FROM findings WHERE run_id = ?').get(runId)).toEqual({ n: 0 });
  });
});

describe('fan-out, partial fan-in and consolidation', () => {
  let resumed: Awaited<ReturnType<typeof resumeSiteAudit>>;

  beforeAll(async () => {
    decideCheckpoint(db, runId, 'scope_confirmation', 'APPROVED', 'design@kenresearch.com');
    resumed = await resumeSiteAudit(deps, runId, 'A2', handle);
  }, 300_000);

  it('audits every page and reaches the Publish Gate', () => {
    expect(resumed.kind).toBe('paused');
    if (resumed.kind !== 'paused') return;
    expect(resumed.status).toBe('AWAITING_PUBLISH_CONFIRMATION');
    expect(getRun(db, runId)!.status).toBe('AWAITING_PUBLISH_CONFIRMATION');
  });

  it('one failing page never blocks its siblings (§2.4 partial fan-in)', () => {
    const counters = runCounters(db, runId);
    expect(counters.dispatched).toBe(4);
    expect(counters.failed).toBe(1); // /broken returned 500
    expect(counters.completed).toBe(3);
    expect(counters.dispatched).toBe(counters.completed + counters.failed);
    expect(handle.collector.failed.map((f) => f.url)).toEqual([`${server.origin}/broken`]);
  });

  it('records findings for every page that succeeded, tagged with its template family', () => {
    const pages = handle.collector.pages;
    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.templateFamily !== null)).toBe(true);
    const rows = db.prepare('SELECT DISTINCT page_id FROM findings WHERE run_id = ?').all(runId);
    expect(rows).toHaveLength(3);
  });

  it('the failed page is reported, not silently dropped (v1.0 §15 tab 09)', () => {
    expect(handle.collector.failed).toHaveLength(1);
    expect(handle.collector.failed[0]!.reason).toMatch(/HTTP 500/);
  });

  it('A4 consolidates deduplicated issues across pages into root causes', () => {
    // Issues survived into the run's findings and are what A4 consolidates.
    const issues = db
      .prepare("SELECT COUNT(*) as n FROM findings WHERE run_id = ? AND classification IN ('DEVIATION','INCORRECT')")
      .get(runId) as { n: number };
    expect(issues.n).toBeGreaterThan(0);
  });
});

describe('Publish Confirmation Gate and completion', () => {
  it('completes only after the publish gate is approved', async () => {
    decideCheckpoint(db, runId, 'publish_confirmation', 'APPROVED', 'design@kenresearch.com');
    const final = await resumeSiteAudit(deps, runId, 'A4', handle);
    expect(final.kind).toBe('complete');
    const state = (final as { result: SiteAuditState }).result;
    expect(state.data!.websiteSummary.pagesAudited).toBe(3);
    expect(state.data!.websiteSummary.pagesFailed).toBe(1);
    expect(state.data!.templateSummary.length).toBeGreaterThan(0);
    expect(getRun(db, runId)!.status).toBe('COMPLETE');
  }, 120_000);

  it('a second run of an unchanged site reuses prior results instead of re-auditing (§4.4)', async () => {
    const secondRunId = 'run-site-2';
    const b1Calls = () => (deps.llm as ScriptedLlmClient).calls.filter((c) => c.nodeId === 'B1').length;
    const b1Before = b1Calls();
    const second = await startSiteAudit(server.origin, deps, secondRunId);
    expect(second.outcome.kind).toBe('paused'); // scope gate again
    decideCheckpoint(db, secondRunId, 'scope_confirmation', 'APPROVED', 'design@kenresearch.com');
    await resumeSiteAudit(deps, secondRunId, 'A2', second);

    const counters = runCounters(db, secondRunId);
    // Every page is loaded (the cache key is the CURRENT DOM, which only exists after capture);
    // the unchanged ones are cache hits — reused, not re-audited by the model.
    expect(counters.cache_hits).toBe(3);
    expect(b1Calls() - b1Before).toBe(0); // no model call for any reused page (the broken page fails at capture, before B1)

    // Regression: the old check compared the stored hash with ITSELF, skipped every page,
    // and published an empty report. The reused pages must be IN the report.
    decideCheckpoint(db, secondRunId, 'publish_confirmation', 'APPROVED', 'design@kenresearch.com');
    const final = await resumeSiteAudit(deps, secondRunId, 'A4', second);
    const data = (final as { result: SiteAuditState }).result.data!;
    expect(data.websiteSummary.pagesAudited).toBe(3);
    expect(data.websiteSummary.pagesFailed).toBe(1);
    expect(data.findings.length).toBeGreaterThan(0);
    expect(data.coverage.some((c) => c.truncation.some((t) => t.what === 'reused result'))).toBe(true);
  }, 300_000);
});

describe('a page that fails once and then succeeds (second-pass review)', () => {
  it('is reported as audited — not as both audited and failed', async () => {
    let hits = 0;
    const flaky = await startLocalServer({
      '/': { body: page('Root') },
      '/flaky': {
        get status() {
          return hits++ === 0 ? 503 : 200;
        },
        body: page('Flaky'),
      },
      '/sitemap.xml': { body: '' },
    });
    flaky.routes['/sitemap.xml'] = {
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${flaky.origin}/</loc></url><url><loc>${flaky.origin}/flaky</loc></url></urlset>`,
      headers: { 'content-type': 'application/xml' },
    };
    try {
      const flakyRun = 'run-site-flaky';
      const started = await startSiteAudit(flaky.origin, { ...deps, maxPages: 5 }, flakyRun);
      decideCheckpoint(db, flakyRun, 'scope_confirmation', 'APPROVED', 'design@kenresearch.com');
      await resumeSiteAudit({ ...deps, maxPages: 5 }, flakyRun, 'A2', started);
      decideCheckpoint(db, flakyRun, 'publish_confirmation', 'APPROVED', 'design@kenresearch.com');
      const final = await resumeSiteAudit({ ...deps, maxPages: 5 }, flakyRun, 'A4', started);
      const data = (final as { result: SiteAuditState }).result.data!;
      expect(hits).toBeGreaterThanOrEqual(2); // it really failed first
      expect(data.websiteSummary.pagesFailed).toBe(0);
      expect(data.websiteSummary.pagesAudited).toBe(2);
    } finally {
      await flaky.close();
    }
  }, 300_000);
});
