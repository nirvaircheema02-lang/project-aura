import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractSections } from '../../src/preview/extract.ts';
import { islandPaddingCss, islandWrapperStyle } from '../../src/preview/jsx.ts';

/**
 * Regression: "Our Impact" had `max-sm:px-4` on its heading. The DS SectionHeading that replaced it carried the desktop slot only, so on a phone the
 * title touched the screen edge while the paragraph under it stayed 16px in. The responsive horizontal padding now follows the heading into its slot.
 */
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0}.wrap{max-width:1200px;margin:auto}h2{margin:0;font-size:32px}
@media (max-width:639px){.px{padding-left:16px;padding-right:16px}}
.plain{padding-left:8px}
</style></head><body><section data-fra-section="s"><div class="wrap">
<h2 class="px" data-fra-element="e1" data-fra-findings="F1">Our Impact</h2>
<h2 class="plain" data-fra-element="e2" data-fra-findings="F2">Other</h2>
</div></section></body></html>`;

describe('responsive heading padding follows a replaced heading into its slot', () => {
  it('records only padding that is set inside a media query', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const out = await extractSections(ctx, HTML, { sectionIds: ['s'], fullPage: false, names: { s: 'S' }, edits: [], dsFirst: true });
      const [a, b] = out.sections[0]!.findingElements;
      expect(a!.layout.paddingRules).toHaveLength(1);
      expect(a!.layout.paddingRules![0]!.groups[0]).toMatch(/^@media/);
      expect(b!.layout.paddingRules).toBeUndefined(); // unconditional padding is the original element's own design, not carried
    } finally { await ctx.close(); }
  });

  it('applies at the breakpoint only: 16px on a phone, none on desktop', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const out = await extractSections(ctx, HTML, { sectionIds: ['s'], fullPage: false, names: { s: 'S' }, edits: [], dsFirst: true });
      const layout = out.sections[0]!.findingElements[0]!.layout;
      const page = await ctx.newPage();
      await page.setContent(`<style>body{margin:0}${islandPaddingCss('s', 'h', layout)}</style><div data-pv-section="s"><div slot="h"><h2>Our Impact</h2></div></div>`);
      await page.locator('[slot]').evaluate((el, style) => Object.assign((el as HTMLElement).style, style), islandWrapperStyle(layout));
      for (const [vw, pad] of [[1440, 0], [390, 16]] as const) {
        await page.setViewportSize({ width: vw, height: 900 });
        expect(await page.locator('[slot]').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))).toBe(pad);
        expect(await page.locator('[slot]').evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))).toBe(pad);
      }
    } finally { await ctx.close(); }
  });

  it('is empty when the element has no responsive padding', () => {
    expect(islandPaddingCss('s', 'h', { display: 'block', margin: ['0px', '0px', '0px', '0px'], alignSelf: 'auto', flexGrow: '0', fullWidth: false })).toBe('');
  });
});
