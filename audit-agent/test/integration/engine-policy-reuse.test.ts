import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { openDb, type Database } from '../../src/db/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { DisabledLlmClient } from '../../src/llm/provider.ts';
import { resumeSiteAudit, startSiteAudit, type SiteAuditDeps, type SiteAuditState } from '../../src/agents/site-graph.ts';
import { decideCheckpoint } from '../../src/graph/state.ts';
import { AUDIT_ENGINE_REVISION, policyVersionFor } from '../../src/graph/run-metadata.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import type { AuditData } from '../../src/agents/c2-json-writer/index.ts';

/**
 * Full-site audit and the engine's policy version. A full-site run REUSES a page's previous
 * findings when its DOM and the Design System are unchanged (§4.4 memoization) — which, without a
 * policy check, would hand a page audited by an OLDER engine its old findings forever: it would
 * never see a detection or rule added since. `policyVersion` carries the engine's behaviour
 * revision, so this is the contract:
 *   - nothing changed (DOM, DS, engine)      → the page's findings are reused (the memoization works);
 *   - the engine changed since those findings → they are NOT reused: the page is audited again.
 * Driven through the real full-site graph (A1 discovery → Scope Gate → page fan-out → Publish Gate).
 * The page holds only MEASURED findings (a matched heading and an INCORRECT badge audited against the existing Badge): a page with an
 * unverified finding is never reused, whatever the policy.
 */

const html = `<!doctype html><html><head><title>Policy fixture</title><style>
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
h2{font-family:'Noto Serif',serif;font-weight:300;font-size:31.248px;letter-spacing:-0.01em;margin:0 0 16px}
section{padding:40px}
.badge{display:inline-block;width:57px;height:28px;box-sizing:border-box;border:1px solid rgb(176,31,36);border-radius:6px;background:rgba(176,31,36,.1);color:rgb(87,62,105);font-size:12px;padding:4px 8px}
</style></head><body><main><section aria-label="Approach"><h2>Our Approach</h2><div class="badge">Phase 1</div></section></main></body></html>`;

let dir: string;
let db: Database;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let deps: SiteAuditDeps;

/** One complete full-site audit, driven through both human gates exactly as the CLI does. */
async function fullSiteAudit(runId: string): Promise<AuditData> {
  const handle = await startSiteAudit(server.origin, deps, runId);
  expect(handle.outcome.kind).toBe('paused'); // Scope Gate
  decideCheckpoint(db, runId, 'scope_confirmation', 'APPROVED', 'design@kenresearch.com');
  const atPublish = await resumeSiteAudit(deps, runId, 'A2', handle);
  expect(atPublish.kind).toBe('paused'); // Publish Gate
  decideCheckpoint(db, runId, 'publish_confirmation', 'APPROVED', 'design@kenresearch.com');
  const final = await resumeSiteAudit(deps, runId, 'A4', handle);
  expect(final.kind).toBe('complete');
  return ((final as { result: SiteAuditState }).result).data!;
}

const reusedPages = (data: AuditData) => data.coverageSummary.truncation.filter((t) => t.what === 'reused result').length;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-engine-policy-'));
  const config = loadConfig();
  db = openDb(join(dir, 'audit.db'));
  server = await startLocalServer({ '/': { body: html }, '/sitemap.xml': { body: '' } });
  server.routes['/sitemap.xml'] = {
    body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${server.origin}/</loc></url></urlset>`,
    headers: { 'content-type': 'application/xml' },
  };
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  deps = { db, registry: await loadDsRegistry(config.designSystemPath), aiMode: 'no-api', llm: new DisabledLlmClient(), config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'evidence'), maxPages: 5 };
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('full-site audit: reuse follows the engine revision', () => {
  let first: AuditData;
  let control: AuditData;
  let afterEngineChange: AuditData;

  it('first audit: the page is audited for real — the badge is an existing-Badge finding, INCORRECT on the shared R1.2 rule', async () => {
    first = await fullSiteAudit('run-policy-1');
    expect(reusedPages(first)).toBe(0);
    expect(first.run.policyVersion).toContain(`+engine-r${AUDIT_ENGINE_REVISION}+`);
    const badge = first.findings.find((f) => f.component.productionType === 'badge')!;
    expect(badge.component.dsComponent).toBe('Badge'); // an existing DS family — never a new component
    expect(badge.classification).toBe('INCORRECT');
    expect(badge.comparison.ruleViolations.map((v) => v.ruleId)).toEqual(['R1.2']);
    expect(badge.comparison.mismatches.some((m) => m.property === 'border-top-left-radius' && m.expectedToken === '--radius-button')).toBe(true); // its 6px radius → the Badge variant's own 5px
  }, 300_000);

  it('CONTROL — nothing changed (same DOM, same Design System, same engine): the memoization works and the page\'s findings are reused', async () => {
    control = await fullSiteAudit('run-policy-2');
    expect(reusedPages(control)).toBe(1);
    expect(control.findings.map((f) => f.identity.findingId).sort()).toEqual(first.findings.map((f) => f.identity.findingId).sort());
  }, 300_000);

  it('the ENGINE changed since those findings were produced (an older engine revision): the page is NOT reused — it is audited again, by the current engine', async () => {
    const current = first.run.policyVersion;
    const older = policyVersionFor(pool.renderingPolicy(), 'no-api', AUDIT_ENGINE_REVISION - 1);
    expect(older).not.toBe(current);
    // Everything stored so far was produced by "the older engine": same page, same DS — only the policy differs.
    const changed = db.prepare('UPDATE findings SET payload_json = replace(payload_json, ?, ?)').run(current, older).changes;
    expect(changed).toBeGreaterThan(0);

    afterEngineChange = await fullSiteAudit('run-policy-3');
    expect(reusedPages(afterEngineChange)).toBe(0); // stale findings were not carried over
    expect(afterEngineChange.findings.every((f) => f.identity.policyVersion === current)).toBe(true); // every finding is the CURRENT engine's
    const badge = afterEngineChange.findings.find((f) => f.component.productionType === 'badge')!;
    expect(badge.component.dsComponent).toBe('Badge');
    expect(badge.comparison.ruleViolations.map((v) => v.ruleId)).toEqual(['R1.2']);
  }, 300_000);

  it('a full-site run states the baseline change instead of calling it a regression or a resolution', () => {
    const badge = afterEngineChange.findings.find((f) => f.component.productionType === 'badge')!;
    expect(badge.history.baselineChanged?.some((note) => note.includes('audit policy / browser changed'))).toBe(true);
    expect(badge.history.delta).not.toBe('REGRESSION');
    expect(badge.history.delta).not.toBe('RESOLVED');
  });
});
