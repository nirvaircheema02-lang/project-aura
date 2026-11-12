import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { measureBackdrop } from '../../src/resolution/rendered.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Reference lane round 3 (minor): the backdrop reader no longer fails open for paint it cannot read from a background colour - an absolute / fixed replaced
 * element behind the box (the hero-image pattern), a layer inside a shadow root beside a direct shadow child, and an ancestor with a filter, backdrop filter,
 * mask or clip-path. Each is UNMEASURABLE with a reason (never the white canvas); the harmless look-alikes stay measured.
 */

const SVG = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22200%22%3E%3Crect width=%22400%22 height=%22200%22 fill=%22%23111114%22/%3E%3C/svg%3E';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
.wrap{position:relative;background:#fff;padding:8px;width:300px}
.layer{position:absolute;left:0;top:0;width:300px;height:80px}
.layer.far{left:600px;width:20px;height:20px}
.layer.hidden{visibility:hidden}
.layer.flow{position:static}
.card{position:relative;width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08);margin:8px}
</style></head><body>
<div class="wrap"><img class="layer" src="${SVG}" alt=""><div class="card" data-fra-element="eImg"></div></div>
<div class="wrap"><svg class="layer" width="300" height="80"><rect width="300" height="80" fill="#111114"/></svg><div class="card" data-fra-element="eSvg"></div></div>
<div class="wrap"><picture class="layer"><img src="${SVG}" alt=""></picture><div class="card" data-fra-element="ePicture"></div></div>
<div class="wrap"><canvas class="layer" width="300" height="80"></canvas><div class="card" data-fra-element="eCanvas"></div></div>
<div class="wrap"><div class="layer"><img src="${SVG}" alt="" style="width:100%;height:100%"></div><div class="card" data-fra-element="eWrapped"></div></div>
<div class="wrap" style="position:fixed;left:700px;top:0;width:150px;padding:0"><div class="card" data-fra-element="eFixedNone"></div></div>
<div class="wrap"><img class="layer far" src="${SVG}" alt=""><div class="card" data-fra-element="eImgFar"></div></div>
<div class="wrap"><img class="layer hidden" src="${SVG}" alt=""><div class="card" data-fra-element="eImgHidden"></div></div>
<div class="wrap"><img class="layer flow" src="${SVG}" alt="" width="10" height="10"><div class="card" data-fra-element="eImgFlow"></div></div>
<div class="wrap" style="filter:invert(1)"><div class="card" data-fra-element="eFilter"></div></div>
<div class="wrap" style="filter:none"><div class="card" data-fra-element="eFilterNone"></div></div>
<div class="wrap" style="backdrop-filter:blur(4px)"><div class="card" data-fra-element="eBackdropFilter"></div></div>
<div class="wrap" style="clip-path:inset(0 0 0 0)"><div class="card" data-fra-element="eClip"></div></div>
<div class="wrap" style="-webkit-mask-image:linear-gradient(#000,transparent);mask-image:linear-gradient(#000,transparent)"><div class="card" data-fra-element="eMask"></div></div>
<div class="wrap"><div class="card" style="filter:drop-shadow(0 0 2px #000)" data-fra-element="eOwnFilter"></div></div>
<div id="host"></div>
<script>
  document.getElementById('host').style.cssText = 'position:relative;width:320px';
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<style>.box{position:relative;background:#fff;width:300px}.layer{position:absolute;left:0;top:0;width:300px;height:80px}.card{width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08);margin:8px}</style>'
    + '<div class="layer" style="background:#111114"></div><div class="card" data-fra-element="eShadowSib"></div>'
    + '<div class="box"><div class="layer" style="background:#111114"></div><div class="card" data-fra-element="eShadowDeep"></div></div>';
  const clear = document.createElement('div');
  clear.style.cssText = 'height:100px';
  document.body.appendChild(clear);
  const host2 = document.createElement('div');
  document.body.appendChild(host2);
  host2.style.cssText = 'position:relative;width:320px';
  host2.attachShadow({ mode: 'open' }).innerHTML = '<style>.layer{position:absolute;left:0;top:0;width:300px;height:80px;background:transparent}.card{width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08);margin:8px}</style><div class="layer"></div><div class="card" data-fra-element="eShadowClear"></div>';
</script>
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

describe('an out-of-flow replaced element behind the box is paint the reader cannot read', () => {
  it.each(['eImg', 'eSvg', 'ePicture', 'eCanvas', 'eWrapped'])('%s: unmeasurable, with a reason, never the white canvas', async (id) => {
    const b = await measureBackdrop(page, sel(id), 'border-top-color');
    expect(b.rgb, `${id}: ${b.why}`).toBeNull();
    expect(b.why).toMatch(/out-of-flow/);
  });

  it.each(['eImgFar', 'eImgHidden', 'eImgFlow'])('%s: one that does not overlap, is hidden or is in flow is nothing', async (id) => {
    expect((await measureBackdrop(page, sel(id), 'border-top-color')).rgb).toBe(WHITE);
  });
});

describe('an ancestor (or the element) with a filter, backdrop filter, mask or clip-path is unmeasurable', () => {
  it.each([['eFilter', /filter/], ['eBackdropFilter', /backdrop filter/], ['eClip', /clip-path/], ['eMask', /mask/], ['eOwnFilter', /filter/]])('%s', async (id, why) => {
    const b = await measureBackdrop(page, sel(id), 'border-top-color');
    expect(b.rgb, `${id}: ${b.why}`).toBeNull();
    expect(b.why).toMatch(why);
  });

  it('filter: none is nothing', async () => {
    expect((await measureBackdrop(page, sel('eFilterNone'), 'border-top-color')).rgb).toBe(WHITE);
  });
});

describe('layers inside a shadow root are seen for a DIRECT child of the root too', () => {
  it('eShadowSib: a dark absolute sibling in the same shadow root', async () => {
    const b = await measureBackdrop(page, sel('eShadowSib'), 'border-top-color');
    expect(b.rgb, b.why ?? '').toBeNull();
    expect(b.why).toMatch(/out-of-flow/);
  });

  it('eShadowDeep: the same layer one level down (already read)', async () => {
    expect((await measureBackdrop(page, sel('eShadowDeep'), 'border-top-color')).rgb).toBeNull();
  });

  it('eShadowClear: a transparent layer beside a direct shadow child is nothing', async () => {
    expect((await measureBackdrop(page, sel('eShadowClear'), 'border-top-color')).rgb).toBe(WHITE);
  });
});
