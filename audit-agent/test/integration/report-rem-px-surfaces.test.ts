import { describe, expect, it } from 'vitest';
import { buildAuditData } from '../../src/agents/c2-json-writer/index.ts';
import { buildWorkbook } from '../../src/agents/c1-excel-reporter/index.ts';
import { buildPublishPlan } from '../../src/figma/publish-plan.ts';
import { FIGMA_CONTRACT_VERSION } from '../../src/figma/prompt-contract.ts';
import { renderRun } from '../../src/dashboard/views/render.ts';
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * ONE rule on EVERY report surface: an Expected typography value in `rem` is displayed with its resolved
 * px beside it (`1.953rem (31.25px)`) — in the HTML report / dashboard, the Figma plan and the Excel
 * report alike — and never anywhere else: a rem SPACING value stays as it was, and the audit's own data
 * (`data.json`: the stored expected value, the status, the recommendation text) is byte-identical after
 * every surface has rendered it. The surfaces share `src/output/display-values.ts`; this proves they all
 * still use it.
 */

const RECOMMENDATION = 'Source: atoms/SectionHeading.tsx (level 3). font-size: 32px → 1.953rem; padding-left: 24px → 1rem; letter-spacing: 0.48px → -0.01em.';

function finding(on: { findingId?: string; pageId?: string; url?: string; signature?: string } = {}): Finding {
  return {
    identity: { auditId: 'a1', runId: 'r1', findingId: on.findingId ?? 'f-rem-1', timestamp: '2026-10-07T10:00:00.000Z', dsRegistryVersion: 'ds', policyVersion: 'p' },
    location: { url: on.url ?? 'https://example.test/', pageId: on.pageId ?? 'p1', pageName: 'A', templateFamily: null, section: 'Hero', captureState: 'default' },
    component: { productionType: 'section-heading', productionLabel: 'Find Your Survey', dsComponent: 'SectionHeading', dsVariant: 'level 3', signature: on.signature ?? 's1' },
    classification: 'DEVIATION',
    comparison: {
      mismatches: [
        { property: 'font-size', actual: '32px', expected: '1.953rem', expectedToken: null, comparison: 'length-px', delta: 0.75 },
        { property: 'padding-left', actual: '24px', expected: '1rem', expectedToken: null, comparison: 'length-px', delta: 8 },
        { property: 'letter-spacing', actual: '0.48px', expected: '-0.01em', expectedToken: null, comparison: 'length-px', delta: 0.8 },
      ],
      ruleViolations: [],
      properties: [
        { property: 'font-size', actual: '32px', expected: '1.953rem', expectedToken: null, source: 'atoms/SectionHeading.tsx', status: 'DIFFERENT', note: null },
        { property: 'padding-left', actual: '24px', expected: '1rem', expectedToken: null, source: 'atoms/SectionHeading.tsx', status: 'DIFFERENT', note: null },
      ],
    },
    quality: {
      severity: 'LOW', confidence: 0.85, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [],
      evidence: [{ kind: 'element-screenshot', ref: '/tmp/audit/screenshots/p1/e1-element.png', note: null, box: { x: 100, y: 200, width: 300, height: 60 } }],
      visualVerdict: 'NOT_CHECKED',
    },
    action: { recommendation: RECOMMENDATION, rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: 'DEVIATION', delta: null, previousRunId: null },
  } as Finding;
}

/** One page of the run. `root` is the root font size its capture MEASURED (omitted → recorded none, like an older run). */
function pageOf(on: { findingId: string; pageId: string; url: string; signature: string; root?: number }): PageResult {
  return {
    runId: 'r1', pageId: on.pageId, url: on.url, pageName: 'A', templateFamily: null, domHash: 'd', dsRegistryVersion: 'ds', policyVersion: 'p', findings: [finding(on)],
    compliance: { match: 0, deviation: 1, incorrect: 0, newComponent: 0, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
    coverage: { sectionsAnalyzed: 1, componentsDetected: 1, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
    capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0, ...(on.root === undefined ? {} : { rootFontSizePx: on.root }) },
  } as PageResult;
}

function auditData() {
  const page = pageOf({ findingId: 'f-rem-1', pageId: 'p1', url: 'https://example.test/', signature: 's1', root: 16 });
  return buildAuditData({ runId: 'r1', auditId: 'a1', mode: 'single-page', startedAt: '2026-10-07T10:00:00.000Z', targetUrl: 'https://example.test/', pages: [page], failedPages: [] });
}

/** Two pages in ONE run whose measured roots differ (16px and 20px) — and a third that recorded none (an older run). */
function mixedRootData() {
  const pages = [
    pageOf({ findingId: 'f-16', pageId: 'p16', url: 'https://example.test/sixteen', signature: 's16', root: 16 }),
    pageOf({ findingId: 'f-20', pageId: 'p20', url: 'https://example.test/twenty', signature: 's20', root: 20 }),
    pageOf({ findingId: 'f-old', pageId: 'pold', url: 'https://example.test/old', signature: 'sold' }),
  ];
  return buildAuditData({ runId: 'r1', auditId: 'a1', mode: 'full-site', startedAt: '2026-10-07T10:00:00.000Z', targetUrl: 'https://example.test/', pages, failedPages: [] });
}

/** Every string anywhere in a JSON-able value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe('the Figma plan shows the px beside an Expected typography rem value — in every line that quotes one', () => {
  const data = auditData();
  const snapshot = JSON.stringify(data);
  const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
  const all = strings(plan);

  it('the marker card\'s actual → expected bullets and the page audit\'s actual-vs-expected lines', () => {
    const bullets = plan.pageAudits.flatMap((p) => p.markerGroups.flatMap((g) => g.bullets));
    expect(bullets).toContain('font-size: 32px → 1.953rem (31.25px)');
    expect(all.some((s) => s.includes('font-size: 32px → expected 1.953rem (31.25px)'))).toBe(true);
  });

  it('the recommendation text on the cards quotes it with its px', () => {
    const recommendations = plan.pageAudits.flatMap((p) => p.markerGroups.map((g) => g.recommendation));
    expect(recommendations.length).toBeGreaterThan(0);
    for (const r of recommendations) expect(r).toContain('font-size: 32px → 1.953rem (31.25px)');
  });

  it('a rem SPACING value and a non-rem typography value are exactly as before', () => {
    const bullets = plan.pageAudits.flatMap((p) => p.markerGroups.flatMap((g) => g.bullets));
    expect(bullets).toContain('padding-left: 24px → 1rem');
    expect(bullets).toContain('letter-spacing: 0.48px → -0.01em');
    expect(all.some((s) => /padding-left: 24px → (expected )?1rem \(/.test(s))).toBe(false);
  });

  it('building the plan changed nothing in the audit data', () => {
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});

describe('the Excel report shows it too', () => {
  it('the Expected column and the Recommendation column of the findings sheet', async () => {
    const data = auditData();
    const snapshot = JSON.stringify(data);
    const wb = await buildWorkbook(data);
    const sheet = wb.getWorksheet('04 All Findings')!;
    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    const col = (name: string) => header.indexOf(name);
    const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
    const byProperty = (property: string) => rows.find((r) => String(r.getCell(col('Property')).value) === property)!;
    expect(String(byProperty('font-size').getCell(col('Expected')).value)).toBe('1.953rem (31.25px)');
    expect(String(byProperty('padding-left').getCell(col('Expected')).value)).toBe('1rem'); // spacing: unchanged
    expect(String(byProperty('letter-spacing').getCell(col('Expected')).value)).toBe('-0.01em');
    expect(String(byProperty('font-size').getCell(col('Recommendation')).value)).toContain('font-size: 32px → 1.953rem (31.25px)');
    expect(String(byProperty('font-size').getCell(col('Recommendation')).value)).toContain('padding-left: 24px → 1rem;');
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});

describe('all surfaces agree, and the stored data is untouched by every one of them', () => {
  it('the HTML report, the Figma plan and the Excel report show the same spelling; data.json\'s values are still the audit\'s own', async () => {
    const data = auditData();
    const html = renderRun('proj', data, '/evidence/proj/r1');
    const plan = JSON.stringify(buildPublishPlan(data, FIGMA_CONTRACT_VERSION));
    const wb = await buildWorkbook(data);
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? '')))));
    for (const surface of [html, plan, cells.join('\n')]) expect(surface).toContain('1.953rem (31.25px)');
    const stored = data.findings[0]!;
    expect(stored.comparison.mismatches[0]?.expected).toBe('1.953rem');
    expect(stored.action.recommendation).toBe(RECOMMENDATION);
    expect(stored.classification).toBe('DEVIATION');
  });
});

describe('the px follows the page\'s MEASURED root on every surface — two roots in one run, never one global 16', () => {
  const data = mixedRootData();
  const snapshot = JSON.stringify(data);
  const at16 = '1.953rem (31.25px)';
  const at20 = '1.953rem (39.06px)';

  it('data.json records the measured root per page, and omits it for a page that recorded none', () => {
    expect(data.pageSummary.map((p) => [p.pageId, p.rootFontSizePx])).toEqual([['p16', 16], ['p20', 20], ['pold', undefined]]);
    expect(data.pageSummary[2]).not.toHaveProperty('rootFontSizePx');
  });

  it('the HTML report: each finding\'s summary and detail use ITS page\'s root', () => {
    const html = renderRun('proj', data, '/evidence/proj/r1');
    const row = (id: string) => html.split('<div class="frow"').find((c) => c.includes(`data-finding-id="${id}"`)) as string;
    expect(row('f-16')).toContain(`font-size: 32px → ${at16}`);
    expect(row('f-16')).not.toContain('39.06px');
    expect(row('f-20')).toContain(`font-size: 32px → ${at20}`);
    expect(row('f-20')).toMatch(/<dd class="mono">1\.953rem \(39\.06px\)/);
    expect(row('f-20')).toContain(`font-size: 32px → ${at20}; padding-left: 24px → 1rem;`); // the recommendation view
    expect(row('f-20')).not.toContain('31.25px');
    expect(row('f-old')).toContain(`font-size: 32px → ${at16}`); // no root recorded → the browser-default fallback
  });

  it('the global-issue row quotes its example\'s own page root — found by the example\'s URL', () => {
    const issueRows = renderRun('proj', data, '/evidence/proj/r1').split('<tr>').filter((r) => r.includes('font-size: 32px →') && r.includes('<td>1</td>'));
    expect(issueRows.some((r) => r.includes(at20))).toBe(true);
    expect(issueRows.some((r) => r.includes(at16))).toBe(true);
  });

  it('the Figma plan: marker bullets, the page cards and the global-issue rows use each page\'s own root', () => {
    const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    const bullets = (pageId: string) => plan.pageAudits.find((p) => p.key === pageId)!.markerGroups.flatMap((g) => g.bullets);
    expect(bullets('p16')).toContain(`font-size: 32px → ${at16}`);
    expect(bullets('p20')).toContain(`font-size: 32px → ${at20}`);
    expect(bullets('pold')).toContain(`font-size: 32px → ${at16}`);
    const cards = (pageId: string) => plan.pageAudits.find((p) => p.key === pageId)!.cards.map((c) => c.actualVsExpected).join('\n');
    expect(cards('p20')).toContain(`font-size: 32px → expected ${at20}`);
    expect(cards('p16')).not.toContain('39.06px');
    const recs = (pageId: string) => plan.pageAudits.find((p) => p.key === pageId)!.markerGroups.map((g) => g.recommendation).join('\n');
    expect(recs('p20')).toContain(`font-size: 32px → ${at20}`);
    expect(recs('p20')).not.toContain('31.25px');
    expect(plan.pages['02 Global Issues'].rows.some((r) => r[4]!.includes(at20))).toBe(true);
    expect(plan.pages['02 Global Issues'].rows.some((r) => r[4]!.includes(at16))).toBe(true);
  });

  it('a root-cause card quotes its representative finding, so it carries the px of THAT finding\'s page', () => {
    // The three findings above share one mismatch signature, so they fold into ONE card (represented by the first);
    // a run holding only the 20px page's finding shows the same card with the 20px page's px.
    const card = (pages: PageResult[]) => buildPublishPlan(buildAuditData({ runId: 'r1', auditId: 'a1', mode: 'full-site', startedAt: '2026-10-07T10:00:00.000Z', targetUrl: 'https://example.test/', pages, failedPages: [] }), FIGMA_CONTRACT_VERSION).rootCauseCards;
    const only20 = card([pageOf({ findingId: 'f-20', pageId: 'p20', url: 'https://example.test/twenty', signature: 's20', root: 20 })]);
    expect(only20).toHaveLength(1);
    expect(only20[0]!.expected).toContain(at20);
    expect(only20[0]!.expected).not.toContain('31.25px');
    const only16 = card([pageOf({ findingId: 'f-16', pageId: 'p16', url: 'https://example.test/sixteen', signature: 's16', root: 16 })]);
    expect(only16[0]!.expected).toContain(at16);
    // Several pages, one card: the representative's page decides (never a blend of roots).
    expect(buildPublishPlan(data, FIGMA_CONTRACT_VERSION).rootCauseCards).toHaveLength(1);
  });

  it('the Excel report: Expected, recommendation and global-issue cells use each page\'s own root', async () => {
    const wb = await buildWorkbook(data);
    const sheet = wb.getWorksheet('04 All Findings')!;
    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    const col = (name: string) => header.indexOf(name);
    const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
    const cell = (url: string, name: string) => String(rows.find((r) => String(r.getCell(col('URL')).value) === url && String(r.getCell(col('Property')).value) === 'font-size')!.getCell(col(name)).value);
    expect(cell('https://example.test/sixteen', 'Expected')).toBe(at16);
    expect(cell('https://example.test/twenty', 'Expected')).toBe(at20);
    expect(cell('https://example.test/old', 'Expected')).toBe(at16);
    expect(cell('https://example.test/twenty', 'Recommendation')).toContain(`font-size: 32px → ${at20}`);
    expect(cell('https://example.test/sixteen', 'Recommendation')).not.toContain('39.06px');
  });

  it('display only: drawing every surface changed nothing the audit stored — not a value, not a status, not a recommendation', async () => {
    renderRun('proj', data, '/evidence/proj/r1');
    buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    await buildWorkbook(data);
    expect(JSON.stringify(data)).toBe(snapshot);
    for (const f of data.findings) {
      expect(f.comparison.mismatches[0]?.expected).toBe('1.953rem');
      expect(f.action.recommendation).toBe(RECOMMENDATION);
    }
  });
});
