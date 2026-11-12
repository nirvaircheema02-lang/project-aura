import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { measureBackdrop } from '../../src/resolution/rendered.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Reference lane round 4 (10): the backdrop reader failed open - "measured white" - for paint that overlaps the element without being out of flow or an ancestor's
 * background: a sibling stacked on it by a CSS grid, a negative margin or `z-index: -1`, an ancestor's INSET box-shadow, and an ancestor's outline that covers it. A
 * non-ancestor sibling that paints a fill or a replaced element and overlaps the box is a layer WHATEVER its position; an ancestor inset shadow / covering outline is
 * paint. Each is UNMEASURABLE with a reason, never the white canvas; the look-alikes that paint nothing over the box stay measured.
 */

const SVG = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22200%22%3E%3Crect width=%22400%22 height=%22200%22 fill=%22%23111114%22/%3E%3C/svg%3E';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
.wrap{position:relative;background:#fff;padding:8px;width:300px;margin-bottom:16px}
.card{position:relative;width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08);margin:8px}
.dark{height:60px;background:#111114}
.grid{display:grid}
.grid > *{grid-area:1/1}
.pseudo{position:absolute;left:0;top:0;width:300px;height:80px}
.pseudo.fill::before{content:"";position:absolute;inset:0;background:#111114}
.pseudo.clear::before{content:"";position:absolute;inset:0;background:transparent}
.pseudo.none::before{content:none;background:#111114}
</style></head><body>
<div class="wrap grid"><svg width="300" height="80"><rect width="300" height="80" fill="#111114"/></svg><div class="card" data-fra-element="gridSvg"></div></div>
<div class="wrap grid"><img src="${SVG}" alt="" style="width:100%;height:100%"><div class="card" data-fra-element="gridImg"></div></div>
<div class="wrap grid"><div class="dark"></div><div class="card" data-fra-element="gridFill"></div></div>
<div class="wrap"><div class="dark"></div><div class="card" style="margin-top:-60px" data-fra-element="negMargin"></div></div>
<div class="wrap"><div class="dark" style="position:relative;z-index:-1;margin-bottom:-60px"></div><div class="card" data-fra-element="zIndex"></div></div>
<div class="wrap"><div class="card" style="margin-bottom:-60px" data-fra-element="behindNeg"></div><div class="dark"></div></div>
<div class="wrap" style="box-shadow:inset 0 0 0 400px #111114"><div class="card" data-fra-element="inset"></div></div>
<div class="wrap" style="outline:60px solid #111114;outline-offset:-60px"><div class="card" data-fra-element="outline"></div></div>

<div class="wrap"><div class="dark"></div><div class="card" data-fra-element="touching"></div></div>
<div class="wrap grid"><div style="background:transparent"></div><div class="card" data-fra-element="gridClear"></div></div>
<div class="wrap grid"><svg width="300" height="80" style="visibility:hidden"><rect width="300" height="80" fill="#111114"/></svg><div class="card" data-fra-element="gridHidden"></div></div>
<div class="wrap" style="box-shadow:0 0 0 400px #111114"><div class="card" data-fra-element="outerShadow"></div></div>
<div class="wrap" style="box-shadow:none"><div class="card" data-fra-element="shadowNone"></div></div>
<div class="wrap" style="outline:6px solid #111114;outline-offset:6px"><div class="card" data-fra-element="outlineOutside"></div></div>
<div class="wrap" style="outline:none"><div class="card" data-fra-element="outlineNone"></div></div>
<div class="wrap"><div class="dark" style="height:0;overflow:hidden"></div><div class="card" data-fra-element="emptyDark"></div></div>
<div class="wrap"><div class="card" data-fra-element="alone"></div></div>
<div class="wrap"><div class="pseudo fill"></div><div class="card" data-fra-element="sibPseudoFill"></div></div>
<div class="wrap"><div class="pseudo clear"></div><div class="card" data-fra-element="sibPseudoClear"></div></div>
<div class="wrap"><div class="pseudo none"></div><div class="card" data-fra-element="sibPseudoNone"></div></div>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
  await page.setContent(PAGE);
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), undefined, { timeout: 10_000 });
});
afterAll(async () => { await browser.close(); });

const sel = (id: string) => `[data-fra-element="${id}"]`;
const WHITE = 'rgb(255, 255, 255)';

describe('a sibling that paints a fill or a replaced element and overlaps the box is a layer, whatever its position', () => {
  it.each([
    ['gridSvg', 'a CSS-grid stacked svg'], ['gridImg', 'a CSS-grid stacked image'], ['gridFill', 'a CSS-grid stacked fill'],
    ['sibPseudoFill', 'a sibling whose ::before paints the fill'], ['negMargin', 'a negative margin pulls the box over a fill'], ['zIndex', 'a z-index:-1 relative layer'], ['behindNeg', 'the box is pulled over the next sibling\'s fill'],
  ])('%s (%s): unmeasurable, with a reason, never the white canvas', async (id) => {
    const b = await measureBackdrop(page, sel(id), 'border-top-color');
    expect(b.rgb, `${id}: ${b.why}`).toBeNull();
    expect(b.why).toMatch(/overlaps/);
  });

  it.each([
    ['touching', 'a fill that ends exactly where the box starts'], ['gridClear', 'a stacked sibling with no paint'], ['gridHidden', 'a stacked hidden svg'], ['emptyDark', 'a fill with no height'], ['alone', 'no sibling'],
    ['sibPseudoClear', 'a sibling whose ::before is transparent'], ['sibPseudoNone', 'a sibling whose ::before generates no box'],
  ])('%s (%s) is nothing: measured', async (id) => {
    expect((await measureBackdrop(page, sel(id), 'border-top-color')).rgb).toBe(WHITE);
  });
});

describe('an ancestor\'s inset box-shadow, or an outline that covers the box, is paint', () => {
  it.each([['inset', /inset box-shadow/], ['outline', /outline/]])('%s: unmeasurable, with a reason', async (id, why) => {
    const b = await measureBackdrop(page, sel(id), 'border-top-color');
    expect(b.rgb, `${id}: ${b.why}`).toBeNull();
    expect(b.why).toMatch(why);
  });

  it.each(['outerShadow', 'shadowNone', 'outlineOutside', 'outlineNone'])('%s paints nowhere under the box: measured', async (id) => {
    expect((await measureBackdrop(page, sel(id), 'border-top-color')).rgb).toBe(WHITE);
  });
});
