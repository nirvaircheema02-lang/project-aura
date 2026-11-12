import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { baselineCovers, captureDesign, htmlSha256Of, previewTargets, readBaseline, snapshotTargets, toBaseline, writeBaselineOnce, BaselineImmutableError } from '../../src/fidelity/capture.ts';
import { compareDesign, coveredProperties, valuesEqual } from '../../src/fidelity/compare.ts';
import { deriveFeedback } from '../../src/fidelity/feedback.ts';
import { guardKey } from '../../src/fidelity/guard.ts';
import type { DesignBaseline, DesignCapture } from '../../src/fidelity/types.ts';
import type { Exemption } from '../../src/resolution/schema.ts';
import { extractSections, openOfflineSnapshot } from '../../src/preview/extract.ts';
import { applyFidelityToTargets } from '../../src/fidelity/verify.ts';
import { resolutionOf, target as preserveTarget } from '../helpers/fidelity-captures.ts';

/**
 * Design & state fidelity against a real browser, fully offline. The ORIGINAL is a stamped snapshot with a
 * card that is black by default and white on hover; the OUTPUT is a simulated preview (each section in a
 * shadow root, like the generated app) built from the real extraction, so edits are replayed exactly the way
 * the pipeline replays them.
 */

const ORIGINAL = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<style>
body{margin:0;background:#fff}
section,header{font-family:Arial,sans-serif}
.hdr{padding:8px}
.cards{padding:40px 24px}
.cards h2{text-align:center;margin:0 0 24px;font-size:28px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{display:block;background:#000;color:#fff;padding:20px;border-radius:12px;text-decoration:none;transition:background-color .15s,color .15s}
.card:hover{background:#fff;color:#000}
.card:focus-visible{outline:3px solid #b01f24;outline-offset:2px}
.help{display:grid;grid-template-columns:1fr 2fr;gap:24px;padding:24px;min-height:1800px}
.help aside{position:sticky;top:24px;align-self:start}
@media (max-width:600px){.grid{grid-template-columns:1fr}.help{grid-template-columns:1fr}}
</style></head><body>
<header data-fra-section="header" data-fra-scope="excluded" class="hdr">Header</header>
<section data-fra-section="cards" class="cards"><h2>Our services</h2><div class="grid">
<a class="card" href="#a" data-fra-element="e1" data-fra-findings="fidCard">Alpha card</a>
<a class="card" href="#b">Beta card</a>
<a class="card" href="#c">Gamma card</a></div></section>
<section data-fra-section="help" class="help"><aside><h3>Need help?</h3><p>Talk to us</p></aside><div><p>Long body copy that makes the section tall enough for the aside to pin while it scrolls.</p></div></section>
</body></html>`;

const SECTIONS = ['cards', 'help'];
const NAMES = { cards: 'Services', help: 'Help' };

let browser: Browser;
let baselineCapture: DesignCapture;
let baseline: DesignBaseline;
let sectionHtml: Record<string, string>;

beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  try {
    const { page, close } = await openOfflineSnapshot(ctx, ORIGINAL);
    sectionHtml = Object.fromEntries(await page.evaluate(() => Array.from(document.querySelectorAll('[data-fra-section]')).map((e) => [e.getAttribute('data-fra-section'), e.outerHTML])));
    baselineCapture = await captureDesign({ page, targets: snapshotTargets(SECTIONS), source: { kind: 'pre-edit-snapshot', htmlSha256: htmlSha256Of(ORIGINAL), url: null } });
    await close();
  } finally { await ctx.close(); }
  baseline = toBaseline(baselineCapture);
}, 180_000);
afterAll(async () => { await browser?.close(); });

const edit = (property: string, value: string, over: Partial<TargetedEdit> = {}): TargetedEdit => ({ findingId: 'fidCard', selector: '[data-fra-element="e1"]', expectedMatches: 1, kind: 'style', property, value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'test', confidence: 1, ...over });

async function extraction(edits: TargetedEdit[], stateGuards?: ReadonlySet<string>) {
  const ctx = await browser.newContext();
  try { return await extractSections(ctx, ORIGINAL, { sectionIds: SECTIONS, fullPage: false, names: NAMES, edits, ...(stateGuards ? { stateGuards } : {}) }); } finally { await ctx.close(); }
}

/** The running preview, simulated: each section in an open shadow root, exactly like the generated app. */
function previewPage(scopedCss: string, htmlBySection: Record<string, string>): string {
  const hosts = SECTIONS.map((id) => ({ id, html: htmlBySection[id]! }));
  return `<!doctype html><html><head><meta charset="utf-8"><title>preview</title></head><body style="margin:0"><main id="m"></main>
<script>const css = ${JSON.stringify(scopedCss)};
for (const h of ${JSON.stringify(hosts)}) { const host = document.createElement('div'); host.setAttribute('data-pv-section', h.id); document.getElementById('m').appendChild(host);
  const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<style>' + css + '</style><div data-pv-mount>' + h.html + '</div>'; }</script></body></html>`;
}

async function observe(scopedCss: string, html: Record<string, string> = sectionHtml): Promise<DesignCapture> {
  const ctx = await browser.newContext();
  const page: Page = await ctx.newPage();
  try {
    await page.setContent(previewPage(scopedCss, html), { waitUntil: 'domcontentloaded' });
    return await captureDesign({ page, targets: previewTargets(SECTIONS), source: { kind: 'preview', htmlSha256: null, url: 'fixture-preview' } });
  } finally { await ctx.close(); }
}

const radiusExemption: Exemption = { findingId: 'fidCard', property: 'border-radius', part: 'self', state: 'default', viewport: 'any', targetId: 't-radius', reason: 'resolved target: border-radius 5px (DS --radius-xs)' };

describe('the baseline', () => {
  it('records default styles, hover and keyboard-focus states, group composition and the sticky trace of the ORIGINAL', () => {
    const desktop = baseline.sections.find((s) => s.sectionId === 'cards' && s.viewport === 'desktop')!;
    expect(desktop.located).toBe(true);
    const card = desktop.elements.find((e) => e.findingIds.includes('fidCard'))!;
    expect(card.style['background-color']).toBe('rgb(0, 0, 0)');
    expect(card.states.hover?.effect).toBe(true);
    expect(card.states.hover?.subtree['']?.['background-color']).toBe('rgb(255, 255, 255)');
    expect(card.states['focus-visible']?.subtree['']?.['outline-style']).toBe('solid');
    expect(desktop.groups[0]).toMatchObject({ columns: 3, rows: 1 });
    const help = baseline.sections.find((s) => s.sectionId === 'help' && s.viewport === 'desktop')!;
    expect(help.sticky.length).toBe(1);
    const mobile = baseline.sections.find((s) => s.sectionId === 'cards' && s.viewport === 'mobile')!;
    expect(mobile.groups[0]).toMatchObject({ columns: 1, rows: 3 });
    expect(mobile.coverage.hover.attempted).toBe(0);
    expect(baseline.statesNotCaptured.length).toBeGreaterThan(0);
  });

  it('is write-once: a valid baseline is never replaced, and a tampered file is refused rather than silently rewritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fra-baseline-'));
    const path = join(dir, 'design-baseline.json');
    const first = await writeBaselineOnce(path, baselineCapture);
    const second = await writeBaselineOnce(path, { ...baselineCapture, capturedAt: 'later', sections: [] });
    expect(second.baselineSha256).toBe(first.baselineSha256);
    expect((await readBaseline(path))?.sections.length).toBe(baselineCapture.sections.length);
    writeFileSync(path, JSON.stringify({ ...first, sections: [] }));
    expect(await readBaseline(path)).toBeNull();
    await expect(writeBaselineOnce(path, baselineCapture)).rejects.toBeInstanceOf(BaselineImmutableError);
    expect(baselineCovers(baseline, SECTIONS, baseline.viewports, htmlSha256Of(ORIGINAL))).toBe(true);
    expect(baselineCovers(baseline, SECTIONS, baseline.viewports, 'a-different-snapshot')).toBe(false);
  });
});

describe('compareDesign — an unchanged output', () => {
  it('has no difference at all and is not a false failure (default, hover, focus, composition and sticky all compared)', async () => {
    const ex = await extraction([]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [] });
    expect(report.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(report.summary.statesCompared.hover).toBeGreaterThan(0);
    expect(report.summary.statesCompared['focus-visible']).toBeGreaterThan(0);
    expect(report.summary.elementsCompared).toBeGreaterThan(5);
    expect(report.verdict).toBe('pass');
    // 'pass' now means no REQUIRED check is unverified: the fixture's sticky pin/release is VERIFIED (all positions reachable on both sides), not merely absent
    expect(report.coverage?.requiredUnverified).toBe(0);
    expect(report.coverage?.families.sticky.verified).toBeGreaterThan(0);
    expect(report.coverage?.families.hover.verified).toBeGreaterThan(0);
  }, 120_000);
});

describe('compareDesign — the radius fix preserves the original card behaviour', () => {
  it('border-radius 5px is an intentional, identified change; black default and white hover are preserved and verified', async () => {
    const ex = await extraction([edit('border-radius', '5px')]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [radiusExemption] });
    const radius = report.differences.filter((d) => d.property?.includes('radius'));
    expect(radius.filter((d) => d.state === 'default' && d.viewport === 'desktop').length).toBe(4);
    // the fix follows the element into hover and focus (the original hover does not alter the radius) …
    expect(radius.some((d) => d.state === 'hover')).toBe(true);
    expect(radius.every((d) => d.classification === 'intentional' && d.exemptionTargetId === 't-radius' && d.findingIds.includes('fidCard'))).toBe(true);
    // … but the fill is NOT a radius change: black default and white hover are compared, unchanged and preserved
    expect(report.differences.some((d) => d.property === 'background-color')).toBe(false);
    // nothing else changed: default fill, hover fill, focus outline
    expect(report.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(report.summary.statesCompared.hover).toBeGreaterThan(0);
    expect(report.verdict).toBe('pass');
  }, 120_000);

  it('the same change WITHOUT an exemption is a regression: an intentional change must be authorized per finding, property and state', async () => {
    const ex = await extraction([edit('border-radius', '5px')]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [] });
    expect(report.differences.filter((d) => d.classification === 'regression' && d.property?.includes('radius')).length).toBeGreaterThanOrEqual(4);
    expect(report.verdict).toBe('fail');
  }, 120_000);

  it('an exemption names ONE finding, property, part and state: it does not exempt the rest of the component or section', async () => {
    // radius is authorized; a SECOND, unauthorized change (padding) on the same element is still a regression
    const ex = await extraction([edit('border-radius', '5px'), edit('padding-left', '40px')]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [radiusExemption] });
    const bad = report.differences.filter((d) => d.classification === 'regression');
    expect(new Set(bad.map((d) => d.property))).toEqual(new Set(['padding-left']));
    expect(coveredProperties('border-radius').has('padding-left')).toBe(false);
  }, 120_000);
});

describe('compareDesign — a replayed edit that erases the original hover', () => {
  const bgExemption: Exemption = { findingId: 'fidCard', property: 'background-color', part: 'self', state: 'default', viewport: 'any', targetId: 't-bg', reason: 'resolved target: default fill #111' };

  it('is caught as a HOVER regression even though the default-state change was authorized, and routed to a state guard', async () => {
    const ex = await extraction([edit('background-color', '#111111')]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [bgExemption] });
    const hover = report.differences.filter((d) => d.classification === 'regression' && d.category === 'hover' && d.property === 'background-color');
    expect(hover.length).toBeGreaterThan(0);
    expect(hover[0]).toMatchObject({ baseline: 'rgb(255, 255, 255)', findingIds: ['fidCard'] });
    // the authorized default change itself is not a regression
    expect(report.differences.some((d) => d.category === 'default-style' && d.property === 'background-color' && d.classification === 'intentional')).toBe(true);
    const fb = deriveFeedback(report, { editsByFinding: new Map([['fidCard', [{ property: 'background-color', kind: 'style' }]]]), islandFindingIds: new Set(), overrideSectionIds: new Set() });
    const hoverFb = fb.find((f) => f.kind === 'state-regression' && f.property === 'background-color')!;
    expect(hoverFb.action).toEqual({ type: 'state-guard', findingId: 'fidCard', property: 'background-color' });
    expect(hoverFb.responsible).toBe('preview-generator');
    expect(hoverFb.message).toMatch(/hovered/);
    expect(hoverFb.message).toMatch(/desktop viewport/);
    expect(report.verdict).toBe('fail');
  }, 120_000);

  it('the state-guarded re-emission keeps the authorized default change AND restores the hover; the recheck passes', async () => {
    const guards = new Set([guardKey('fidCard', 'background-color')]);
    const ex = await extraction([edit('background-color', '#111111')], guards);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [bgExemption] });
    expect(report.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(report.differences.some((d) => d.category === 'default-style' && d.property === 'background-color' && d.classification === 'intentional')).toBe(true);
    expect(report.verdict).toBe('pass');
  }, 120_000);
});

describe('compareDesign — composition, alignment, sticky', () => {
  it('a centered heading that became left-aligned is a regression (measured from geometry, not only from text-align)', async () => {
    const ex = await extraction([]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss.replace('text-align: center', 'text-align: left')), exemptions: [] });
    const align = report.differences.filter((d) => d.category === 'alignment' && d.classification === 'regression');
    expect(align.length).toBeGreaterThan(0);
    expect(align[0]).toMatchObject({ property: 'text-alignment', baseline: 'center', observed: 'left' });
    expect(align[0]!.detail).toMatch(/renders left-aligned/);
    expect(report.differences.some((d) => d.property === 'text-align' && d.classification === 'regression')).toBe(true);
  }, 120_000);

  it('a lost three-column card grid and a lost sticky pin are regressions with actionable detail', async () => {
    const ex = await extraction([]);
    const css = ex.scopedCss.replace('grid-template-columns: repeat(3, 1fr)', 'grid-template-columns: 1fr').replace('position: sticky', 'position: static');
    const report = compareDesign({ baseline, observed: await observe(css), exemptions: [] });
    expect(report.differences.some((d) => d.category === 'composition' && d.property === 'columns' && d.viewport === 'desktop' && d.classification === 'regression')).toBe(true);
    const sticky = report.differences.find((d) => d.category === 'sticky');
    expect(sticky?.classification).toBe('regression');
    expect(sticky?.detail).toMatch(/pin/);
    const fb = deriveFeedback(report, { editsByFinding: new Map(), islandFindingIds: new Set(), overrideSectionIds: new Set() });
    // nothing authorized explains these, so they are BLOCKED honestly, never silently corrected or passed
    expect(fb.filter((f) => f.kind === 'composition-regression' || f.kind === 'sticky-regression').every((f) => f.action === null && f.blockedReason)).toBe(true);
  }, 120_000);
});

describe('preserve decisions judged on real captures', () => {
  const decisions = () => resolutionOf(
    preserveTarget({ id: 'p-color', findingId: 'fidCard', property: 'color' }),
    preserveTarget({ id: 'p-hover-bg', findingId: 'fidCard', property: 'background-color', state: 'hover' }),
    preserveTarget({ id: 'p-focus-outline', findingId: 'fidCard', property: 'outline-color', state: 'focus-visible' }),
    preserveTarget({ id: 'p-width', findingId: 'fidCard', property: 'width' }),
    preserveTarget({ id: 'p-margin', findingId: 'fidCard', property: 'margin-top' }),
  );
  const statuses = (r: ReturnType<typeof decisions>) => Object.fromEntries(r.targets.map((t) => [t.id, t.status.verification]));

  it('an unchanged output: default, hover, keyboard-focus and box evidence verify; a property the verifier does not measure stays unverified', async () => {
    const ex = await extraction([]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [] });
    const res = decisions();
    applyFidelityToTargets(res, report, baseline, []);
    expect(statuses(res)).toEqual({ 'p-color': 'preserved-verified', 'p-hover-bg': 'preserved-verified', 'p-focus-outline': 'preserved-verified', 'p-width': 'preserved-verified', 'p-margin': 'unverified' });
    expect(res.targets.find((t) => t.id === 'p-hover-bg')!.status.verificationDetail).toMatch(/hover/);
  }, 120_000);

  it('an erased hover is a FAILED hover preserve decision (the default one still verifies)', async () => {
    const ex = await extraction([edit('background-color', '#111111')]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [{ findingId: 'fidCard', property: 'background-color', part: 'self', state: 'default', viewport: 'any', targetId: 't-bg', reason: 'x' }] });
    const res = decisions();
    applyFidelityToTargets(res, report, baseline, []);
    expect(statuses(res)['p-hover-bg']).toBe('failed');
    expect(statuses(res)['p-color']).toBe('preserved-verified');
  }, 120_000);
});

describe('compareDesign — what cannot be checked is never a pass', () => {
  it('without a baseline the verdict is not-checked, with the reason', () => {
    const r = compareDesign({ baseline: null, observed: baselineCapture, exemptions: [] });
    expect(r.verdict).toBe('not-checked');
    expect(r.unavailable.join(' ')).toMatch(/baseline was not captured/);
  });

  it('a hover that visibly changed the original but cannot be captured on the output is reported, not claimed as preserved', async () => {
    const ex = await extraction([]);
    const report = compareDesign({ baseline, observed: await observe(`${ex.scopedCss}\n.card{pointer-events:none}`), exemptions: [] });
    expect(report.differences.some((d) => d.category === 'state-unavailable' && d.classification === 'not-checkable')).toBe(true);
    expect(report.verdict).toBe('incomplete'); // some checks ran and held, one visibly-effective hover could not be captured: INCOMPLETE, no longer the all-or-nothing 'not-checked'
    expect(report.coverage?.families.hover.reasons['state-uncaptured-on-output']).toBeGreaterThan(0);
    expect(report.unavailable.join(' ')).toMatch(/not claimed as preserved/);
  }, 120_000);

  it('a hand-authored section is listed as not structurally comparable, never silently passed', async () => {
    const ex = await extraction([]);
    const report = compareDesign({ baseline, observed: await observe(ex.scopedCss), exemptions: [], overrideSectionIds: new Set(['cards']) });
    expect(report.unavailable.join(' ')).toMatch(/cards: a hand-authored section/);
  }, 120_000);
});

describe('valuesEqual', () => {
  it('compares colours by perceptual distance, lengths within half a pixel, and everything else exactly', () => {
    expect(valuesEqual('color', 'rgb(0, 0, 0)', 'rgb(1, 1, 1)')).toBe(true);
    expect(valuesEqual('color', 'rgb(0, 0, 0)', 'rgb(40, 40, 40)')).toBe(false);
    expect(valuesEqual('border-top-left-radius', '12px', '12.4px')).toBe(true);
    expect(valuesEqual('border-top-left-radius', '12px', '5px')).toBe(false);
    expect(valuesEqual('border-top-left-radius', '3.35544e+07px', '1e+07px')).toBe(true);
    expect(valuesEqual('line-height', 'normal', '24px')).toBe(false);
    expect(valuesEqual('font-family', 'Arial', 'Arial')).toBe(true);
    expect(valuesEqual('font-family', 'Arial', 'Helvetica')).toBe(false);
  });
});
