import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { islandWrapperStyle, islandWidthCss } from '../../src/preview/jsx.ts';
import { extractSections } from '../../src/preview/extract.ts';

/**
 * Regression: the hero CTA is a block-level flex box centred by AUTO margins. The audit's CSS targets (display inline-flex, padding 0) were
 * applied before the layout was read, so the slot recorded was "inline-flex, margin 0" and the design-system Button that replaced it landed at
 * the LEFT edge instead of the centre.
 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0}.wrap{width:1000px;margin:0 auto}.cta{display:flex;width:max-content;margin:32px auto 0;padding:8px 24px;background:#b01f24;color:#fff}
</style></head><body><section data-fra-section="hero"><div class="wrap"><a class="cta" href="/go" data-fra-element="e1" data-fra-findings="F1">Get Pricing</a></div></section></body></html>`;
const EDITS: TargetedEdit[] = [
  { findingId: 'F1', selector: '[data-fra-element="e1"]', expectedMatches: 1, kind: 'style', property: 'display', value: 'inline-flex', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'audit target', confidence: 1 },
];

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const layoutOf = async (dsFirst: boolean) => {
  const ctx = await browser.newContext();
  try {
    const out = await extractSections(ctx, HTML, { sectionIds: ['hero'], fullPage: false, names: { hero: 'Hero' }, edits: EDITS, ...(dsFirst ? { dsFirst: true } : {}) });
    return out.sections[0]!.findingElements.find((f) => f.stamp === 'e1')!.layout;
  } finally { await ctx.close(); }
};

describe('the slot a design-system component takes over', () => {
  it('REGRESSION: with DS-first the slot is the ORIGINAL element\'s (flex, auto-margin centred), not the one the CSS edit left behind', async () => {
    const edited = await layoutOf(false);
    expect(edited.display).toBe('inline-flex'); // what the old order recorded
    const original = await layoutOf(true);
    expect(original.display).toBe('flex');
    expect(parseFloat(original.margin[1])).toBeGreaterThan(8);
    expect(Math.abs(parseFloat(original.margin[1]) - parseFloat(original.margin[3]))).toBeLessThan(2);
  });

  it('an auto-margin-centred control keeps `margin: auto` and a shrink-wrapped width (centred at every viewport), other margins stay as measured', () => {
    expect(islandWrapperStyle({ display: 'flex', margin: ['32px', '475.859px', '0px', '475.859px'], alignSelf: 'auto', flexGrow: '0', fullWidth: false }))
      .toEqual({ display: 'flex', margin: '32px auto 0px auto', width: 'max-content', maxWidth: '100%' });
    expect(islandWrapperStyle({ display: 'flex', margin: ['4px', '0px', '0px', '0px'], alignSelf: 'auto', flexGrow: '0', fullWidth: false })).toEqual({ display: 'flex', margin: '4px 0px 0px 0px' });
    expect(islandWrapperStyle({ display: 'flex', margin: ['0px', '300px', '0px', '300px'], alignSelf: 'auto', flexGrow: '0', fullWidth: true })).toMatchObject({ width: '100%' });
  });
  it('preserves the original responsive heading width instead of shrinking it to its new DS text', async () => {
    const ctx = await browser.newContext({viewport:{width:1440,height:900}});
    try {
      const html = `<!doctype html><style>body{margin:0}.wrap{max-width:1200px;margin:auto}h1{width:100%;margin:0 auto}@media(min-width:640px){h1{width:80%}}@media(min-width:768px){h1{width:60%}}</style><section class="wrap" data-fra-section="hero"><h1 data-fra-element="heading" data-fra-findings="F1">Your Dealers Know What Your Data Doesn’t</h1></section>`;
      const out = await extractSections(ctx, html, {sectionIds:['hero'],fullPage:false,names:{hero:'Hero'},edits:[],dsFirst:true});
      const layout = out.sections[0]!.findingElements[0]!.layout;
      const page = await ctx.newPage();
      await page.setContent(`<style>body{margin:0}[data-pv-section]{max-width:1200px;margin:auto}${islandWidthCss('hero','heading',layout)}</style><div data-pv-section="hero"><div slot="heading"><h1>DS heading</h1></div></div>`);
      await page.locator('[slot]').evaluate((el, style) => Object.assign((el as HTMLElement).style, style), islandWrapperStyle(layout));
      for (const [viewport,expected] of [[1440,720],[700,560],[390,390]]) {
        await page.setViewportSize({width:viewport!,height:900});
        const box = await page.locator('[slot]').boundingBox();
        expect(box!.width).toBeCloseTo(expected!,0);
        expect(box!.x + box!.width / 2).toBeCloseTo(viewport! / 2,0);
      }
    } finally { await ctx.close(); }
  });

});
