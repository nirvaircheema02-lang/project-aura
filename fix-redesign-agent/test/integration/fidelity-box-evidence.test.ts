import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { captureDesign, htmlSha256Of, previewTargets, snapshotTargets, toBaseline } from '../../src/fidelity/capture.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { applyFidelityToTargets } from '../../src/fidelity/verify.ts';
import type { DesignBaseline, DesignCapture } from '../../src/fidelity/types.ts';
import type { Exemption } from '../../src/resolution/schema.ts';
import { extractSections, openOfflineSnapshot } from '../../src/preview/extract.ts';
import { resolutionOf, target } from '../helpers/fidelity-captures.ts';

/**
 * Width and height preserve decisions are verified from the BOX that was actually measured on both pages (border-box, evidence only —
 * never a global regression detector): equal -> evidence, changed with an authorized layout change -> unverified (explained), changed
 * without one -> failed, baseline captured before box evidence existed -> unverified. Real Chromium, fully offline.
 */

const ORIGINAL = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title><style>
body{margin:0;font-family:Arial,sans-serif}
.cards{padding:40px}
.card{display:block;width:200px;background:#eee;color:#000;padding:10px;text-decoration:none}
</style></head><body>
<section data-fra-section="cards" class="cards"><a class="card" href="#a" data-fra-element="e1" data-fra-findings="F1">Alpha card</a><p>Other copy</p></section>
</body></html>`;

let browser: Browser;
let baseline: DesignBaseline;
let sectionHtml: string;
beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  try {
    const { page, close } = await openOfflineSnapshot(ctx, ORIGINAL);
    sectionHtml = await page.evaluate(() => document.querySelector('[data-fra-section="cards"]')!.outerHTML);
    baseline = toBaseline(await captureDesign({ page, targets: snapshotTargets(['cards']), source: { kind: 'pre-edit-snapshot', htmlSha256: htmlSha256Of(ORIGINAL), url: null } }));
    await close();
  } finally { await ctx.close(); }
}, 120_000);
afterAll(async () => { await browser?.close(); });

const edit = (property: string, value: string): TargetedEdit => ({ findingId: 'F1', selector: '[data-fra-element="e1"]', expectedMatches: 1, kind: 'style', property, value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'test', confidence: 1 });

async function observe(edits: TargetedEdit[]): Promise<DesignCapture> {
  const ctx = await browser.newContext();
  try {
    const ex = await extractSections(ctx, ORIGINAL, { sectionIds: ['cards'], fullPage: false, names: { cards: 'Cards' }, edits });
    const page: Page = await ctx.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><main id="m"></main><script>const host=document.createElement('div');host.setAttribute('data-pv-section','cards');document.getElementById('m').appendChild(host);
const root=host.attachShadow({mode:'open'});root.innerHTML='<style>'+${JSON.stringify(ex.scopedCss)}+'</style><div data-pv-mount>'+${JSON.stringify(sectionHtml)}+'</div>';</script></body></html>`, { waitUntil: 'domcontentloaded' });
    return await captureDesign({ page, targets: previewTargets(['cards']), source: { kind: 'preview', htmlSha256: null, url: 'fixture-preview' } });
  } finally { await ctx.close(); }
}

function verdict(property: string, observed: DesignCapture, exemptions: Exemption[] = [], b: DesignBaseline = baseline) {
  const resolution = resolutionOf(target({ findingId: 'F1', property }));
  const report = compareDesign({ baseline: b, observed, exemptions });
  applyFidelityToTargets(resolution, report, b, exemptions);
  return { status: resolution.targets[0]!.status.verification, detail: resolution.targets[0]!.status.verificationDetail ?? '', report };
}
const padding: Exemption = { findingId: 'F1', property: 'padding', part: 'self', state: 'default', viewport: 'any', targetId: 't-pad', reason: 'resolved target: padding' };

describe('box evidence', () => {
  it('is recorded for every enumerated element, separately from the style record', () => {
    const card = baseline.sections.find((s) => s.sectionId === 'cards' && s.viewport === 'desktop')!.elements.find((e) => e.findingIds.includes('F1'))!;
    expect(card.box).toEqual({ w: 220, h: expect.any(Number) }); // 200 + 2 x 10 padding: the border box
    expect(Object.keys(card.style)).not.toContain('width');
    expect(Object.keys(card.style)).not.toContain('height');
  });

  it('an unchanged element: width and height targets are preserved-verified on desktop and mobile', async () => {
    const o = await observe([]);
    expect(verdict('width', o).status).toBe('preserved-verified');
    expect(verdict('height', o).status).toBe('preserved-verified');
  }, 60_000);

  it('an unauthorized width edit is a FAILED preserve decision — and not a global regression (box is evidence only)', async () => {
    const o = await observe([edit('width', '260px')]);
    const r = verdict('width', o);
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/220.*280/);
    expect(r.report.differences.filter((d) => d.property === 'width')).toEqual([]);
  }, 60_000);

  it('the same box change next to an authorized layout-affecting change (padding on this element) is unverified: explained, not attributable', async () => {
    const o = await observe([edit('padding-left', '40px')]);
    const r = verdict('width', o, [padding]);
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/t-pad/);
  }, 60_000);

  it('a baseline captured before box evidence existed is unverified with the reason — never a pass', async () => {
    const legacy: DesignBaseline = { ...baseline, sections: baseline.sections.map((s) => ({ ...s, elements: s.elements.map(({ box: _box, ...e }) => e) })) };
    const r = verdict('width', await observe([]), [], legacy);
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/box/);
  }, 60_000);
});
