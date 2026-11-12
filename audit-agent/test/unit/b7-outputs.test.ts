import { describe, expect, it } from 'vitest';
import { buildAuditData } from '../../src/agents/c2-json-writer/index.ts';
import { buildWorkbook } from '../../src/agents/c1-excel-reporter/index.ts';
import { buildLedger, coverageLine, describeGate } from '../../src/agents/b7-coverage-qa/ledger.ts';
import type { ItemRecord } from '../../src/agents/b7-coverage-qa/reconcile.ts';
import { COVERAGE_INCOMPLETE_EXIT_CODE, coverageGateReport, coverageProgressLine } from '../../src/cli/coverage-gate.ts';
import { renderRun } from '../../src/dashboard/views/render.ts';
import { buildPublishPlan } from '../../src/figma/publish-plan.ts';
import { summaryTileColor } from '../../src/figma/publish-ops.ts';
import { FIGMA_CONTRACT_VERSION } from '../../src/figma/prompt-contract.ts';
import type { CoverageItemState, PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * Every output shows the Coverage Gate the audit produced — PASSED, or INCOMPLETE with exactly what is missing —
 * and an audit that predates B7 says it makes no such claim. The outputs only READ it: nothing here computes a
 * number of its own.
 */

const record = (state: CoverageItemState, text: string, reason = 'because', kind: ItemRecord['raw']['kind'] = 'text'): ItemRecord => ({
  raw: {
    id: `b7-${text.replace(/\W+/g, '')}`, kind, role: 'paragraph', tag: 'p', text, box: { x: 0, y: 0, width: 100, height: 20 }, visibility: 'visible', where: [], reveal: { kind: null, hostSelector: null, controlSelector: null },
    place: { inNavigation: false, inFooter: false, insideOwner: false, ownerText: null }, stamps: { self: [], inner: [], owner: [] }, source: 'dom',
    facts: { tag: 'p', classes: [], roleAttr: null, cursor: 'auto', text, hasSvg: false, hasImg: false, ownText: true, childElementCount: 0, style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: '16px', fontWeight: '400', display: 'block', opacity: '1', visibility: 'visible', textTransform: '', letterSpacing: '' }, box: { x: 0, y: 0, width: 100, height: 20 } },
  },
  sectionId: 's0', sectionName: 'Hero', aria: null, component: null, finding: null, independent: null, state, reason, gap: null, passes: 0,
});

function page(pageId: string, url: string, records: ItemRecord[] | null): PageResult {
  return {
    runId: 'r1', pageId, url, pageName: pageId, templateFamily: null, domHash: 'd', dsRegistryVersion: 'ds', policyVersion: 'p', findings: [],
    compliance: { match: 0, deviation: 0, incorrect: 0, newComponent: 0, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: null },
    coverage: {
      sectionsAnalyzed: 1, componentsDetected: 0, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [],
      ...(records ? { ledger: buildLedger(records, { actions: [{ pass: 1, route: 'B2' as const, itemId: 'b7-x', label: 'Step 06', outcome: 'resolved' as const, reason: 'classified as paragraph and captured' }], passes: 1, notes: ['2 embedded frame(s)'], sources: ['dom', 'accessibility-tree'], roleChecks: { checked: 4, inconsistent: 1, corrected: 1, unresolved: 0 }, recovery: { passes: 2, found: 4, recovered: 3, settled: 1, remaining: records.filter((r) => r.state === 'UNACCOUNTED').length, stopped: 'complete' } }) } : {}),
    },
    capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
  } as unknown as PageResult;
}

const build = (pages: PageResult[]) => buildAuditData({ runId: 'r1', auditId: 'a1', mode: 'full-site', startedAt: '2026-10-07T10:00:00.000Z', targetUrl: 'https://example.test/', pages, failedPages: [] });

const passing = () => build([page('p1', 'https://example.test/', [record('AUDITED', 'Hello'), record('EXCLUDED_WITH_REASON', 'Skip link', 'visually hidden — a box of ≤ 2px'), record('NEEDS_REVIEW', 'Pricing tab')])]);
const incomplete = () => build([page('p1', 'https://example.test/', [record('AUDITED', 'Hello'), record('UNACCOUNTED', 'Step 06', 'collapsed behind a carousel — never revealed, so never audited', 'text')])]);
const legacy = () => build([page('p1', 'https://example.test/', null)]);

describe('data.json: the gate is part of the canonical audit data', () => {
  it('a passing audit records the gate per page and across the run', () => {
    const data = passing();
    expect(data.coverageSummary.gate).toMatchObject({ passed: true, pages: 1, pagesWithoutLedger: 0, discovered: 3, audited: 1, excluded: 1, needsReview: 1, captureFailed: 0, unaccounted: 0, incomplete: [] });
    expect(data.pageSummary[0]?.coverageGate).toMatchObject({ passed: true, discovered: 3 });
    expect(data.coverage[0]?.ledger?.excludedByReason).toEqual([{ reason: 'visually hidden — a box of ≤ 2px', count: 1, examples: ['Skip link'] }]);
  });

  it('an incomplete audit says exactly what is missing', () => {
    const data = incomplete();
    expect(data.coverageSummary.gate).toMatchObject({ passed: false, unaccounted: 1 });
    expect(data.coverageSummary.gate?.incomplete).toEqual([{ pageUrl: 'https://example.test/', unaccounted: [expect.objectContaining({ label: 'Step 06', state: 'UNACCOUNTED', reason: expect.stringContaining('never revealed') })] }]);
  });

  it('an audit that predates B7 makes no gate claim at all (the field is absent — never a fake pass)', () => {
    const data = legacy();
    expect(data.coverageSummary.gate).toBeUndefined();
    expect(data.pageSummary[0]).not.toHaveProperty('coverageGate');
  });
});

describe('the HTML report and dashboard — Coverage is ONE compact line; the ledger sits in a collapsed accordion', () => {
  /** What the Summary shows (everything before the accordion) and what is inside it. */
  const split = (html: string) => {
    const from = html.indexOf('<div class="gate');
    const at = html.indexOf('<details class="gate-details"', from);
    return { visible: html.slice(from, at).replace(/<[^>]+>/g, '').trim(), accordion: html.slice(at, html.indexOf('</details>\n  </details>', at) + 1), from, at };
  };

  it('PASSED: the Summary says only `Coverage: PASSED · N discovered · N accounted · 0 unaccounted` (a review item is named, nothing else)', () => {
    const html = renderRun('proj', passing(), '/evidence');
    const { visible } = split(html);
    expect(visible).toBe('Coverage: PASSED · 3 discovered · 3 accounted · 0 unaccounted · 1 need review');
    expect(html).not.toContain('Coverage gate:');
    expect(html).not.toContain('This audit is incomplete');
    expect(html).toContain('class="gate"');
  });

  it('a CLEAN result is as small as it gets: no review or failure to name', () => {
    const clean = build([page('p1', 'https://example.test/', [record('AUDITED', 'Hello'), record('AUDITED', 'World'), record('EXCLUDED_WITH_REASON', 'Skip link', 'visually hidden — a box of ≤ 2px')])]);
    expect(split(renderRun('proj', clean, '/evidence')).visible).toBe('Coverage: PASSED · 3 discovered · 3 accounted · 0 unaccounted');
  });

  it('INCOMPLETE: `Coverage: INCOMPLETE · N discovered · R remaining` — red — and still nothing listed in the Summary', () => {
    const html = renderRun('proj', incomplete(), '/evidence');
    const { visible } = split(html);
    expect(visible).toBe('Coverage: INCOMPLETE · 2 discovered · 1 remaining');
    expect(html).toContain('class="gate fail"');
    expect(visible).not.toContain('Step 06');
  });

  it('everything else is inside ONE accordion, "Coverage details", COLLAPSED by default — and its long lists are collapsed accordions of their own', () => {
    const html = renderRun('proj', passing(), '/evidence');
    const { accordion, visible, at } = split(html);
    expect(html.slice(at).startsWith('<details class="gate-details"><summary>Coverage details</summary>')).toBe(true); // no `open` attribute: closed
    expect(html).toContain('<summary>Coverage details</summary>');
    expect(accordion).not.toMatch(/<details[^>]*\sopen/);
    // the numbers the gate is made of, and the recovery
    for (const label of ['discovered', 'audited', 'excluded with reason', 'needs review', 'capture failed', 'unaccounted', 'recovery passes', 'recovered items', 'settled with a reason', 'remaining']) expect(accordion, label).toContain(`<span>${label}</span>`);
    expect(accordion).toMatch(/<div><b>2<\/b><span>recovery passes<\/span><\/div>/);
    expect(accordion).toMatch(/<div><b>3<\/b><span>recovered items<\/span><\/div>/);
    // the per-item lists: only in the accordion, each one collapsed
    expect(accordion).toContain('<summary>Excluded with a stated reason (1)</summary>');
    expect(accordion).toContain('visually hidden — a box of ≤ 2px');
    expect(accordion).toContain('<summary>Need review (1)</summary>');
    expect(accordion).toContain('Pricing tab');
    expect(accordion).toContain('classified as paragraph and captured');
    expect(accordion).toContain('4 checked · 1 inconsistent · 1 corrected · 0 unresolved');
    expect(accordion).toContain('2 embedded frame(s)'); // the stated boundary of the manifest
    for (const text of ['Pricing tab', 'Skip link', 'visually hidden', 'classified as paragraph']) expect(visible).not.toContain(text);
  });

  it('INCOMPLETE: the remaining items and their reasons are in the accordion — listed in full there, never in the Summary', () => {
    const html = renderRun('proj', incomplete(), '/evidence');
    const { accordion } = split(html);
    expect(accordion).toContain('<summary>Remaining items (still unaccounted) (1)</summary>');
    expect(accordion).toContain('“Step 06” — Hero');
    expect(accordion).toContain('collapsed behind a carousel — never revealed, so never audited');
  });

  it('a HUGE unaccounted list (the real audit had 227) leaves the Summary one short line; all of it is in the collapsed accordion', () => {
    const many = Array.from({ length: 227 }, (_, i) => record('UNACCOUNTED', `Menu item ${i}`, 'in a faded (hover / scroll-in) layer — never revealed, so never audited', 'control'));
    const html = renderRun('proj', build([page('p1', 'https://example.test/', [...Array.from({ length: 246 }, (_, i) => record('AUDITED', `Audited ${i}`)), ...many])]), '/evidence');
    const { visible, accordion } = split(html);
    expect(visible).toBe('Coverage: INCOMPLETE · 473 discovered · 227 remaining');
    expect(visible.length).toBeLessThan(80);
    expect(accordion).toContain('<summary>Remaining items (still unaccounted) (227)</summary>');
    expect(accordion.match(/Menu item \d+/g)).toHaveLength(227);
    expect(html.slice(0, html.indexOf('<details class="gate-details"'))).not.toContain('Menu item');
  });

  it('an older ledger (written before the recovery loop) still renders — the recovery numbers say "not recorded", nothing is invented', () => {
    const old = passing();
    for (const c of old.coverage) if (c.ledger) delete c.ledger.recovery;
    const html = renderRun('proj', old, '/evidence');
    expect(split(html).accordion).toContain('<div><b>not recorded</b><span>recovered items</span></div>');
    expect(split(html).visible).toBe('Coverage: PASSED · 3 discovered · 3 accounted · 0 unaccounted · 1 need review');
  });

  it('text from the audited page is never injected as markup — labels, reasons, sections and exclusion examples are escaped', () => {
    const hostile = build([page('p1', 'https://example.test/?a=1&b=<x>', [
      record('UNACCOUNTED', '<img src=x onerror=alert(1)>', 'reason <script>alert(2)</script>', 'text'),
      record('EXCLUDED_WITH_REASON', '"><svg onload=alert(3)>', 'quoted "reason" & <b>bold</b>'),
      record('NEEDS_REVIEW', "<i>it's</i>", 'because <u>x</u>'),
    ])]);
    const html = renderRun('proj', hostile, '/evidence');
    const gateBlock = html.slice(html.indexOf('<div class="gate'), html.indexOf('<div class="gate') + 20_000);
    for (const raw of ['<img src=x', '<script>alert(2)', '<svg onload', '<b>bold</b>', '<i>it', '<u>x</u>']) expect(gateBlock, raw).not.toContain(raw);
    expect(gateBlock).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(gateBlock).toContain('reason &lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('a run that predates B7 says so instead of implying a pass', () => {
    const html = renderRun('proj', legacy(), '/evidence');
    expect(html).toContain('Coverage: not recorded');
    expect(html).not.toContain('Coverage: PASSED');
  });
});

describe('the Excel report and the Figma overview', () => {
  const cell = async (data: ReturnType<typeof build>) => {
    const wb = await buildWorkbook(data);
    const sheet = wb.getWorksheet('01 Executive Summary')!;
    const row = Array.from({ length: sheet.rowCount }, (_, i) => sheet.getRow(i + 1)).find((r) => String(r.getCell(1).value).startsWith('Coverage gate'))!;
    return String(row.getCell(2).value);
  };

  it('Excel: the gate, or what is missing, in the executive summary', async () => {
    expect(await cell(passing())).toBe(describeGate(passing().coverageSummary.gate!));
    expect(await cell(incomplete())).toMatch(/^INCOMPLETE — 2 discovered .* 1 unaccounted\. Missing: text “Step 06” \(Hero\): collapsed behind a carousel/);
    expect(await cell(legacy())).toContain('not recorded');
  });

  it('Figma: one more Overview tile — PASSED / INCOMPLETE — N unaccounted / not recorded — coloured by its verdict', () => {
    const tile = (data: ReturnType<typeof build>) => buildPublishPlan(data, FIGMA_CONTRACT_VERSION).pages['00 Overview'].tiles.find((t) => t.label === 'Coverage gate')!;
    expect(tile(passing()).value).toBe('PASSED');
    expect(tile(incomplete()).value).toBe('INCOMPLETE — 1 unaccounted');
    expect(tile(legacy()).value).toBe('not recorded');
    expect(summaryTileColor('Coverage gate', 'PASSED')).toBe('GREEN');
    expect(summaryTileColor('Coverage gate', 'INCOMPLETE — 1 unaccounted')).toBe('RED');
    expect(summaryTileColor('Coverage gate', 'not recorded')).toBe('GRAY');
  });

  it('the template stamps moved with it (what a template DRAWS changed): html-report-v19 — the Global Header / Global Footer accordion rows carry their chevron at the far right (v15: the accordions over the structural-region grouping) — and figma-layout-v6, which the HTML grouping does not touch', async () => {
    const { HTML_TEMPLATE_VERSION } = await import('../../src/dashboard/views/render.ts');
    expect(HTML_TEMPLATE_VERSION).toBe('html-report-v19');
    expect(FIGMA_CONTRACT_VERSION).toBe('figma-layout-v6');
  });
});

describe('the CLI states the gate — an INCOMPLETE audit says so on stderr and exits 3, never reads as a clean success', () => {
  it('PASSED: one line, nothing on stderr, no failing exit', () => {
    const report = coverageGateReport(passing());
    expect(report.line).toBe(`Coverage gate: ${describeGate(passing().coverageSummary.gate!)}`);
    expect(report.line).toMatch(/^Coverage gate: PASSED/);
    expect(report.errors).toEqual([]);
    expect(report.incomplete).toBe(false);
  });

  it('INCOMPLETE: the line, "AUDIT INCOMPLETE", every missing item with its page, kind, text, section and reason — and the exit code is 3', () => {
    const report = coverageGateReport(incomplete());
    expect(report.line).toMatch(/^Coverage gate: INCOMPLETE/);
    expect(report.incomplete).toBe(true);
    expect(COVERAGE_INCOMPLETE_EXIT_CODE).toBe(3);
    expect(report.errors[0]).toContain('AUDIT INCOMPLETE — 1 item(s) found on the page are not accounted for');
    expect(report.errors[1]).toBe('  · https://example.test/ — text “Step 06” (Hero): collapsed behind a carousel — never revealed, so never audited');
    expect(report.errors).toHaveLength(2);
  });

  it('a long list is cut at 25 on the terminal and says where the rest is — nothing is dropped from data.json', () => {
    const many = Array.from({ length: 30 }, (_, i) => record('UNACCOUNTED', `Missing item ${i}`, 'never reached', 'text'));
    const data = build([page('p1', 'https://example.test/', many)]);
    const report = coverageGateReport(data);
    expect(report.errors).toHaveLength(1 + 25 + 1);
    expect(report.errors.at(-1)).toBe('  … and 5 more (all listed in the HTML report and data.json)');
    expect(data.coverageSummary.gate?.incomplete[0]?.unaccounted).toHaveLength(30);
  });

  it('page text reaches the terminal without control characters — an ANSI escape in a label never reaches it', () => {
    const data = build([page('p1', 'https://example.test/', [record('UNACCOUNTED', 'Step\u001b[31m 06\u0007', 'never reached', 'text')])]);
    const line = coverageGateReport(data).errors[1]!;
    expect(line).toBe('  · https://example.test/ — text “Step [31m 06 ” (Hero): never reached');
    expect(line).not.toMatch(/[\u0000-\u001f]/);
  });

  it('a page with no ledger fails the gate and the terminal says so; an audit that predates B7 makes no claim (never a pass, never a failure)', () => {
    const mixed = build([page('p1', 'https://example.test/', [record('AUDITED', 'Hello')]), page('p2', 'https://example.test/old', null)]);
    const report = coverageGateReport(mixed);
    expect(report.incomplete).toBe(true);
    expect(report.errors[0]).toContain('1 page(s) carry no coverage ledger');
    const old = coverageGateReport(legacy());
    expect(old.line).toBe('Coverage gate: not recorded (this audit predates the B7 final coverage check)');
    expect(old.incomplete).toBe(false);
    expect(old.errors).toEqual([]);
  });
});

describe('the compact Coverage line — ONE wording for the Summary and the live CLI', () => {
  const gate = (over: Partial<Parameters<typeof coverageLine>[0]> = {}) => ({ discovered: 473, unaccounted: 0, needsReview: 0, captureFailed: 0, ...over });

  it('PASSED: `Coverage: PASSED · N discovered · N accounted · 0 unaccounted` — a clean result says exactly that', () => {
    expect(coverageLine(gate(), 'PASSED')).toBe('Coverage: PASSED · 473 discovered · 473 accounted · 0 unaccounted');
  });

  it('PASSED with items a person must look at: they are named (accounted for, never hidden) — and only when there are some', () => {
    expect(coverageLine(gate({ needsReview: 12 }), 'PASSED')).toBe('Coverage: PASSED · 473 discovered · 473 accounted · 0 unaccounted · 12 need review');
    expect(coverageLine(gate({ needsReview: 12, captureFailed: 3 }), 'PASSED')).toBe('Coverage: PASSED · 473 discovered · 473 accounted · 0 unaccounted · 12 need review · 3 capture failed');
  });

  it('RECHECKING and INCOMPLETE: `Coverage: <STATE> · N discovered · R remaining`', () => {
    expect(coverageLine(gate({ unaccounted: 227 }), 'RECHECKING')).toBe('Coverage: RECHECKING · 473 discovered · 227 remaining');
    expect(coverageLine(gate({ unaccounted: 227 }), 'INCOMPLETE')).toBe('Coverage: INCOMPLETE · 473 discovered · 227 remaining');
  });

  it('a page nobody checked is never "0 remaining": the pages without a ledger are named', () => {
    expect(coverageLine({ ...gate(), pagesWithoutLedger: 2 }, 'INCOMPLETE')).toBe('Coverage: INCOMPLETE · 473 discovered · 2 page(s) not checked');
  });

  it('the live CLI line is exactly the RECHECKING form', () => {
    expect(coverageProgressLine({ round: 1, discovered: 473, accounted: 246, remaining: 227 })).toBe('Coverage: RECHECKING · 473 discovered · 227 remaining');
  });
});
