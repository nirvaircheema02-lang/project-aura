import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { openDb, type Database } from '../../src/db/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { auditPage } from '../../src/agents/page-graph.ts';
import { DisabledLlmClient } from '../../src/llm/provider.ts';
import { buildAuditData, type AuditData } from '../../src/agents/c2-json-writer/index.ts';
import { buildWorkbook } from '../../src/agents/c1-excel-reporter/index.ts';
import { buildPublishPlan } from '../../src/figma/publish-plan.ts';
import { FIGMA_CONTRACT_VERSION } from '../../src/figma/prompt-contract.ts';
import { renderRun } from '../../src/dashboard/views/render.ts';
import { FINDING_STATUSES, findingStatus, statusLabel, type Finding, type PageResult } from '../../src/skills/s0-result-contract.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { NO_API_PAGE } from '../helpers/no-api-page.ts';

/**
 * Decision Log #31 — a REAL single-page audit (real Chromium, the real Design
 * System) in no-api mode, with a model client that fails the run on any call:
 *   requirement 2 — completes with zero model API calls;
 *   requirement 4 — uncertain semantic cases enter NEEDS_REVIEW / UNVERIFIED,
 *                   each with reason, confidence, evidence, location, component
 *                   and possible DS matches, and nothing is guessed;
 *   requirement 5 — C1, C3 and C4 each equal C2;
 *   requirement 6 — re-audit history works across two no-api runs.
 */

let dir: string;
let db: Database;
let registry: DsRegistry;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let llm: DisabledLlmClient;
let run1: PageResult;
let data: AuditData;

const byLabel = (page: PageResult, label: string) => page.findings.filter((f) => f.component.productionLabel === label && !f.history.absentThisRun);
const one = (page: PageResult, label: string): Finding => {
  const found = byLabel(page, label);
  expect(found, `exactly one finding for "${label}"`).toHaveLength(1);
  return found[0]!;
};

async function audit(runId: string): Promise<PageResult> {
  const config = loadConfig();
  return auditPage(
    `${server.origin}/no-api`,
    // The run layout the dashboard serves evidence from: <run>/screenshots/<page>/<element>.png.
    { db, registry, aiMode: 'no-api', llm, config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'runs', runId, 'screenshots') },
    { runId },
  );
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-noapi-'));
  registry = await loadDsRegistry(loadConfig().designSystemPath);
  db = openDb(join(dir, 'audit.db'));
  server = await startLocalServer({ '/no-api': { body: NO_API_PAGE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  llm = new DisabledLlmClient();
  run1 = await audit('run-noapi-1');
  data = buildAuditData({ runId: 'run-noapi-1', auditId: 'audit-run-noapi-1', mode: 'single-page', startedAt: '2026-09-14T10:00:00.000Z', targetUrl: `${server.origin}/no-api`, pages: [run1], failedPages: [], renderingPolicy: pool.renderingPolicy(), aiMode: 'no-api' });
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a real single-page audit with zero model API calls', () => {
  it('completes without a single model call, and records its mode', () => {
    expect(llm.attempts).toBe(0);
    expect(run1.findings.length).toBeGreaterThan(0);
    expect(run1.policyVersion).toContain('+ai-no-api+');
    expect(data.run.aiMode).toBe('no-api');
  });

  it('a Button built from the DS with the DS values is a MATCH, found by its own class fingerprint', () => {
    const f = one(run1, 'Book discovery call');
    expect(f.classification).toBe('MATCH');
    expect(f.component.dsComponent).toBe('Button');
    expect(f.component.dsVariant).toMatch(/^brand · md/);
    expect(f.quality.evidence.some((e) => e.note?.startsWith('matched: class fingerprint'))).toBe(true);
  });

  it('the same Button at 44px is a DEVIATION, measured against the real --button-height-md', () => {
    const f = one(run1, 'Talk to a Strategy Expert');
    expect(f.classification).toBe('DEVIATION');
    expect(f.comparison.mismatches).toEqual([expect.objectContaining({ property: 'height', actual: '44px', expected: '48px', expectedToken: '--button-height-md' })]);
  });

  it('a hand-rolled Manrope link is INCORRECT on R1.4 — a measured breach, whatever component it is', () => {
    const f = one(run1, 'Explore all reports');
    expect(f.classification).toBe('INCORRECT');
    expect(f.comparison.ruleViolations.map((r) => r.ruleId)).toContain('R1.4');
  });

  it('repeated tabs on DS foundations with no DS equivalent are DS CANDIDATES — proposed, never approved', () => {
    const tabs = run1.findings.filter((f) => f.component.productionType === 'tabs');
    expect(tabs).toHaveLength(3);
    expect(tabs.every((f) => f.classification === 'DS_CANDIDATE' && f.action.registryUpdateRef)).toBe(true);
    const requests = db.prepare('SELECT status FROM registry_update_requests').all() as Array<{ status: string }>;
    expect(requests).toHaveLength(1); // one proposal for the pattern, not one per instance
    expect(requests.every((r) => r.status === 'PROPOSED')).toBe(true);
  });
});

describe('uncertain semantic cases are NEEDS REVIEW / UNVERIFIED — never guessed', () => {
  it('a lone card whose structure and rule-mapped family are clear is a DEVIATION against the closest existing Card variant, never NEEDS_REVIEW just because compliance is low', () => {
    // Component identity is decided before compliance (B3 deterministic.ts, case 2b): a large
    // clickable is evidently a card by structure alone (no class fingerprint at all here), the DS
    // names a card family for it, and enough of Card's governed properties CAN be measured — so
    // it is matched to the closest-fitting real variant, and every real difference (never
    // "resembles too loosely, send to a human") is reported as a deviation from it.
    const f = one(run1, 'Market sizing workshop');
    expect(f.classification).toBe('DEVIATION');
    expect(f.component.dsComponent).toBe('Card');
    expect(f.component.dsVariant).toMatch(/^outlined/);
    expect(f.comparison.mismatches.map((m) => m.property).sort()).toEqual(
      ['border-bottom-left-radius', 'border-bottom-right-radius', 'border-top-color', 'border-top-left-radius', 'border-top-right-radius'].sort(),
    );
    expect(f.review).toBeUndefined(); // a real identity + measured deviation, not an open question for a human
    expect(f.quality.confidence).toBeGreaterThanOrEqual(0.5); // MEDIUM floor: identity is not in doubt, only the variant was a structural call
    expect(f.quality.evidence.some((e) => e.kind === 'element-screenshot')).toBe(true);
    expect(f.location).toMatchObject({ url: `${server.origin}/no-api`, section: 'Offer' });
  });

  it('an h4 with no supported DS heading child stays UNVERIFIED with measured actual values', () => {
    const f = one(run1, 'Talk to us');
    expect(f.classification).toBe('UNVERIFIED');
    expect(f.component.dsComponent).toBe('SectionHeading');
    expect(f.review).toMatchObject({ status: 'UNVERIFIED', node: 'B4' });
    expect(f.review!.reason).toMatch(/SectionHeading/);
    expect(f.comparison.properties?.find(p => p.property === 'font-size')).toMatchObject({ actual: '31.25px', expected: null });
  });

  it('neither status is ever counted in the compliance score', () => {
    expect(run1.compliance).toMatchObject({ match: 1, deviation: 2, incorrect: 1, needsReview: 0, unverified: 1, dsCandidate: 3 });
    expect(run1.compliance.compliancePercent).toBe(25);
  });
});

describe('C1, C3 and C4 each equal C2', () => {
  it('C2 buckets every finding once, by S0 status, and lists the review queues', () => {
    const counts = Object.fromEntries(FINDING_STATUSES.map((s) => [s, data.findings.filter((f) => findingStatus(f) === s).length]));
    expect(data.statusCounts).toEqual(counts);
    expect(data.needsReview!.map((f) => f.component.productionLabel)).toEqual([]);
    expect(data.unverified!.map((f) => f.component.productionLabel)).toEqual(['Talk to us']);
    expect(data.websiteSummary).toMatchObject({ needsReview: 0, unverified: 1, dsCandidate: 3 });
  });

  it('C1 Excel: the summary numbers and the 10 Needs Review tab equal C2', async () => {
    const wb = await buildWorkbook(data);
    const values = new Map<string, unknown>();
    wb.getWorksheet('01 Executive Summary')!.eachRow((row, i) => {
      if (i > 1) values.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    expect(values.get('Match')).toBe(data.websiteSummary.match);
    expect(values.get('Deviation')).toBe(data.websiteSummary.deviation);
    expect(values.get('Incorrect implementation')).toBe(data.websiteSummary.incorrect);
    expect(values.get('DS candidates (excluded from score)')).toBe(data.websiteSummary.dsCandidate);
    expect(values.get('Needs review (excluded from score, awaiting a human decision)')).toBe(data.websiteSummary.needsReview);
    expect(values.get('Unverified — nothing compared (excluded from score, awaiting review)')).toBe(data.websiteSummary.unverified);
    expect(values.get('AI mode')).toMatch(/^no-api/);
    const review = wb.getWorksheet('10 Needs Review')!;
    expect(review.rowCount - 1).toBe(data.needsReview!.length + data.unverified!.length);
    const statuses = review.getColumn(1).values.slice(2).map(String).sort();
    expect(statuses).toEqual([statusLabel('UNVERIFIED')]);
  });

  it('C3 Figma plan: tiles and the 08 Needs Review page equal C2', () => {
    const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    const tiles = Object.fromEntries(plan.pages['00 Overview'].tiles.map((t) => [t.label, t.value]));
    expect(tiles).toMatchObject({ Match: '1', Deviation: '2', Incorrect: '1', 'DS candidates': '3', 'Needs review': '0', Unverified: '1' });
    expect(plan.pages['08 Needs Review'].rows).toHaveLength(data.needsReview!.length + data.unverified!.length);
    expect(plan.aiMode).toBe('no-api');
  });

  it('C4 dashboard: separate statuses, the same numbers, and a Needs Review area with the evidence', () => {
    const html = renderRun('proj', data, '/evidence/proj/run-noapi-1');
    for (const [label, value] of [
      ['Match', data.websiteSummary.match],
      ['Deviation', data.websiteSummary.deviation],
      ['Incorrect', data.websiteSummary.incorrect],
      ['DS candidates', data.websiteSummary.dsCandidate],
      ['Needs review', data.websiteSummary.needsReview],
      ['Unverified', data.websiteSummary.unverified],
    ] as Array<[string, number]>) {
      expect(html, `card ${label}`).toMatch(new RegExp(`<div class="n">${value}</div><div class="l">${label}</div>`));
    }
    for (const status of FINDING_STATUSES) {
      // v3: findings render as compact <div class="frow" data-classification="..."> cards, not
      // <tr> rows — the Findings table itself no longer exists (see render.ts's html-report-v3).
      const rows = (html.match(new RegExp(`<div class="frow" data-classification="${status}"`, 'g')) ?? []).length;
      expect(rows, `finding cards for ${status}`).toBe(data.statusCounts![status]);
    }
    // Not anchored to the tag's closing `">`: html-report-v2 appends data-finding-id (and, once
    // decided, data-decision) after data-status. The assertion is "one review card per
    // needs-review/unverified finding", not "these are the only two attributes on the tag".
    // Only "Talk to us" (UNVERIFIED) is a review card now — "Market sizing workshop" resolved to a
    // real Card identity with measured deviations instead of staying an open question.
    const items = html.match(/<article class="rv" data-status="(NEEDS_REVIEW|UNVERIFIED)"/g) ?? [];
    expect(items).toHaveLength(1);
    expect(html).toContain('Why no deterministic decision:');
    expect(html).toContain('Possible DS matches');
    expect(html).toMatch(/<img src="\/evidence\/proj\/run-noapi-1\/[^"]+-element\.png" alt="evidence for Talk to us"/);
  });
});

describe('re-audit history works in no-api mode', () => {
  it('a second run of the same page reads STILL OPEN / unchanged, and keeps undecided items undecided', async () => {
    const run2 = await audit('run-noapi-2');
    expect(llm.attempts).toBe(0);
    expect(one(run2, 'Talk to a Strategy Expert').history).toMatchObject({ previousStatus: 'DEVIATION', delta: 'STILL_OPEN', previousRunId: 'run-noapi-1' });
    expect(one(run2, 'Explore all reports').history).toMatchObject({ previousStatus: 'INCORRECT', delta: 'STILL_OPEN' });
    expect(one(run2, 'Book discovery call').history).toMatchObject({ previousStatus: 'MATCH', delta: 'UNCHANGED_COMPLIANT' });
    // Now a real, measured DEVIATION in both runs — the same real defect persisting, not an open question.
    expect(one(run2, 'Market sizing workshop').history).toMatchObject({ previousStatus: 'DEVIATION', delta: 'STILL_OPEN' });
    expect(run2.findings.some((f) => f.history.baselineChanged)).toBe(false);
    const data2 = buildAuditData({ runId: 'run-noapi-2', auditId: 'a2', mode: 'single-page', startedAt: '2026-09-14T11:00:00.000Z', targetUrl: 'u', pages: [run2], failedPages: [], aiMode: 'no-api' });
    expect(data2.reAudit).toMatchObject({ previousRunId: 'run-noapi-1', stillOpen: 3, newIssues: 0, regressions: 0, resolved: 0 });
  }, 300_000);

  // Third-pass review CH-3: the §4.4 cache-reuse path used to hand-stamp every reused finding's
  // delta with deltaFor(classification, classification) — for an undecided classification
  // (NEEDS_REVIEW) that produced the nonsensical 'UNCHANGED_COMPLIANT', which the live path never
  // produces for the same finding. A page whose only unresolved item is NEEDS_REVIEW (not
  // UNVERIFIED, which already blocks reuse outright) is needed to actually reach the cache path.
  //
  // A lone clickable div no longer reaches NEEDS_REVIEW on its own (B3 case 2b now resolves a
  // rule-mapped family's identity before compliance — see the Card fixture above), so this fixture
  // uses a role with NO Design System family mapping at all (`checkbox` has no RULE_CANDIDATES
  // entry) — genuinely undecided by construction, not by a fit score this change could ever affect.
  it('the §4.4 cache path gives an undecided finding the same delta the live path would — never UNCHANGED_COMPLIANT', async () => {
    const onlyNeedsReview = `<!doctype html><html><head><title>cache fixture</title></head><body>
      <main><section aria-label="Offer"><div role="checkbox" aria-checked="false" aria-label="Market sizing workshop" style="cursor:pointer;border:1px solid #d9d1ce;padding:16px;width:320px;height:120px;font-family:'DM Sans',sans-serif;font-size:16px;color:#000"></div></section></main>
    </body></html>`;
    const local = await startLocalServer({ '/cache': { body: onlyNeedsReview } });
    try {
      const config = loadConfig();
      const cacheDb = openDb(join(dir, 'cache.db'));
      const deps = { db: cacheDb, registry, aiMode: 'no-api' as const, llm, config, pool, politeness: new Politeness(0) };
      const runA = await auditPage(`${local.origin}/cache`, { ...deps, evidenceRoot: join(dir, 'runs', 'cache-a', 'screenshots') }, { runId: 'cache-a' });
      expect(one(runA, 'Market sizing workshop').classification).toBe('NEEDS_REVIEW');

      const runB = await auditPage(`${local.origin}/cache`, { ...deps, evidenceRoot: join(dir, 'runs', 'cache-b', 'screenshots') }, { runId: 'cache-b', reuseIfUnchanged: true });
      expect(runB.reusedFromRunId).toBe('cache-a'); // proves this actually went through the cache path
      expect(one(runB, 'Market sizing workshop').history).toMatchObject({ delta: null, previousRunId: 'cache-a' });
      cacheDb.close();
    } finally {
      await local.close();
    }
  }, 300_000);
});
