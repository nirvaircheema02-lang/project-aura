import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { measureResolvedTarget } from '../../src/preview/targets.ts';
import { measureTarget } from '../../src/resolution/resolve.ts';
import { measureBackdrop, renderedFacts } from '../../src/resolution/rendered.ts';
import { colourTarget } from '../helpers/colour-target.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Round 2, defect 3: the backdrop reader must see the layers that really paint behind an element - across shadow-root boundaries (the PREVIEW renders
 * sections in shadow roots), not counting a `display: contents` layer (it paints nothing) - and must say UNMEASURABLE (a reason, never the white canvas) for paint
 * it cannot see: a `::before` / `::after` fill, an out-of-flow layer behind the box. The element's OWN opacity is not an input: it is what lies BEHIND it.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
.card{width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08);margin:8px}
.pseudo{position:relative;background:#fff;padding:8px}
.pseudo.before::before{content:"";position:absolute;inset:0;background:#111114;z-index:0}
.pseudo.after::after{content:"";position:absolute;inset:0;background:#111114}
.pseudo.clear::before{content:"";position:absolute;inset:0;background:transparent}
.pseudo.none::before{content:none;position:absolute;inset:0;background:#111114}
.pseudo > .card{position:relative;z-index:1}
.own::after{content:"";position:absolute;inset:0;background:#111114}
.own{position:relative;width:120px;height:40px;background:#fff;margin:8px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08)}
.wrap{position:relative;padding:8px;background:#fff}
.layer{position:absolute;inset:0;background:#111114}
.layer.clear{background:transparent}
.layer.far{inset:auto auto auto 400px;width:20px;height:20px;top:0}
.fade{animation:fade 2s linear 0s both}
@keyframes fade{from{opacity:0}to{opacity:1}}
</style></head><body>
<div class="pseudo before"><div class="card" data-fra-element="eBefore"></div></div>
<div class="pseudo after"><div class="card" data-fra-element="eAfter"></div></div>
<div class="pseudo clear"><div class="card" data-fra-element="eClear"></div></div>
<div class="pseudo none"><div class="card" data-fra-element="eNone"></div></div>
<div class="own" data-fra-element="eOwn"></div>
<div class="wrap"><div class="layer"></div><div class="card" data-fra-element="eLayer"></div></div>
<div class="wrap"><div class="layer clear"></div><div class="card" data-fra-element="eLayerClear"></div></div>
<div class="wrap"><div class="layer far"></div><div class="card" data-fra-element="eLayerFar"></div></div>
<div style="display:contents;background:#111114"><div class="card" data-fra-element="eContents"></div></div>
<div style="background:#111114"><div style="display:contents;background:#fff"><div class="card" data-fra-element="eContentsInDark"></div></div></div>
<div style="opacity:.5;background:#fff"><div class="card" data-fra-element="eAncestorFade"></div></div>
<div class="card" style="opacity:.5;background:#fff" data-fra-element="eOwnFade"></div>
<div class="card fade" style="background:#fff" data-fra-element="eAnimFade"></div>
<div id="host"></div>
<div id="slotHost"><div class="card" data-fra-element="eSlotted" slot="s"></div></div>
<script>
  const host = document.getElementById('host');
  host.style.background = '#111114';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>.card{width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08)}</style><div class="card" data-fra-element="eShadow" data-finding-ids="fShadow"></div><div class="card" style="border-color:rgba(255,255,255,.4)" data-fra-element="eShadowLight" data-finding-ids="fShadowLight"></div><div style="display:contents;background:#fff"><div class="card" data-fra-element="eShadowContents"></div></div>';
  const sh = document.getElementById('slotHost');
  sh.style.background = '#111114';
  sh.attachShadow({ mode: 'open' }).innerHTML = '<div><slot name="s"></slot></div>';
  window.__pvVerify = { findByFinding: (id) => id === 'fShadow' || id === 'fShadowLight' ? document.getElementById('host').shadowRoot.querySelector('[data-finding-ids~="' + id + '"]') : document.querySelector('[data-finding-ids~="' + id + '"]') };
</script>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
  await page.setContent(PAGE);
});
afterAll(async () => { await browser.close(); });

const sel = (id: string) => `[data-fra-element="${id}"]`;
const dark = (rgb: string | null) => (rgb?.match(/\d+/g) ?? []).map(Number).every((c) => c < 60);
const WHITE = 'rgb(255, 255, 255)';

describe('paint the reader cannot see is UNMEASURABLE with a reason, never the white canvas', () => {
  it.each([['eBefore', /::before/], ['eAfter', /::after/]])('%s: a dark pseudo-element fill on an ancestor', async (id, why) => {
    const b = await measureBackdrop(page, sel(id), 'border-top-color');
    expect(b.rgb, `${id}: ${b.why}`).toBeNull();
    expect(b.why).toMatch(why);
  });

  it('a pseudo-element fill on the element ITSELF matters for a border (it sits on its own background) but not for an outline / shadow', async () => {
    const own = await measureBackdrop(page, sel('eOwn'), 'border-top-color');
    expect(own.rgb).toBeNull();
    expect(own.why).toMatch(/::after/);
    expect((await measureBackdrop(page, sel('eOwn'), 'box-shadow')).rgb).toBe(WHITE);
  });

  it('a transparent pseudo-element, or one that generates no box (content: none), is nothing', async () => {
    expect((await measureBackdrop(page, sel('eClear'), 'border-top-color')).rgb).toBe(WHITE);
    expect((await measureBackdrop(page, sel('eNone'), 'border-top-color')).rgb).toBe(WHITE);
  });

  it('an out-of-flow sibling layer with a paint that overlaps the box is unmeasurable; a transparent one or one that does not overlap is nothing', async () => {
    const hit = await measureBackdrop(page, sel('eLayer'), 'border-top-color');
    expect(hit.rgb, hit.why ?? '').toBeNull();
    expect(hit.why).toMatch(/out-of-flow/);
    expect((await measureBackdrop(page, sel('eLayerClear'), 'border-top-color')).rgb).toBe(WHITE);
    expect((await measureBackdrop(page, sel('eLayerFar'), 'border-top-color')).rgb).toBe(WHITE);
  });

  it('R5 and R8 report such a target as UNVERIFIED (the value may match; the visibility is not established), never passed', async () => {
    const t = colourTarget('fx');
    const m = await measureTarget(page, sel('eBefore'), t);
    expect(m.matches).toBe(false);
    expect((m as { unverified?: boolean }).unverified).toBe(true);
    expect(t.provenance.reference!.colours[0]!.verification.rendered.status).toBe('unverified');
    // the finder is swapped for this check only: a later test finds its own elements through it (the swap used to leak and turn them into this one)
    const swap = (to: string | null) => page.evaluate((id) => {
      const v = (window as unknown as { __pvVerify: { findByFinding: (id: string) => Element | null; saved?: (id: string) => Element | null } }).__pvVerify;
      if (id !== null) { v.saved = v.findByFinding; v.findByFinding = () => document.querySelector(`[data-fra-element="${id}"]`); } else if (v.saved) { v.findByFinding = v.saved; delete v.saved; }
    }, to);
    await swap('eBefore');
    try {
      const r8 = await measureResolvedTarget(page, colourTarget('fx'));
      expect(r8.matches).toBe(false);
      expect(r8.measured).toBe(false);
      expect(r8.note).toMatch(/::before/);
    } finally { await swap(null); }
  });
});

describe('shadow roots and display: contents', () => {
  it('a card inside a shadow root is drawn over its HOST\'s background (the preview renders sections in shadow roots)', async () => {
    const b = await measureBackdrop(page, sel('eShadow'), 'background-color');
    expect(b.rgb, b.why ?? '').not.toBe(WHITE);
    expect(dark(b.rgb), b.rgb ?? b.why ?? '').toBe(true);
    expect(dark((await measureBackdrop(page, sel('eShadow'), 'box-shadow')).rgb)).toBe(true);
  });

  it('R8 (an element handle from inside a shadow root) judges a black hairline invisible on the host\'s dark background', async () => {
    const t = colourTarget('fShadow');
    t.acceptance.push({ kind: 'colour-visible', property: 'border-top-color', state: 'default', viewport: 'any', comparison: 'color-deltaE', expected: 'border:1.5' });
    // the card has its own transparent background, so its border sits on the host: dark
    const m = await measureResolvedTarget(page, t);
    expect(m.matches, m.note).toBe(false);
    expect(m.note).toMatch(/not visible|backdrop/);
  });

  it('R8: a light hairline that is visible ONLY on the host\'s dark background passes there (it would fail on the white canvas the walk used to fall back to)', async () => {
    const t = colourTarget('fShadowLight', { target: { value: 'rgba(255, 255, 255, 0.4)', comparison: 'color-deltaE', token: '--border-card' } });
    const m = await measureResolvedTarget(page, t);
    expect(m.matches, m.note).toBe(true);
  });

  it('a slotted element is drawn over the host the slot is assigned in', async () => {
    const b = await measureBackdrop(page, sel('eSlotted'), 'background-color');
    expect(dark(b.rgb), b.rgb ?? b.why ?? '').toBe(true);
  });

  it('the surface classifier crosses the same boundary', async () => {
    expect((await renderedFacts(page, sel('eShadow'), 'border-top-color')).surface).toBe('dark');
    expect((await renderedFacts(page, sel('eSlotted'), 'border-top-color')).surface).toBe('dark');
  });

  it('a display: contents layer paints nothing, so its background is not the backdrop', async () => {
    expect((await measureBackdrop(page, sel('eContents'), 'background-color')).rgb).toBe(WHITE);
    const inDark = await measureBackdrop(page, sel('eContentsInDark'), 'background-color');
    expect(dark(inDark.rgb), inDark.rgb ?? inDark.why ?? '').toBe(true);
    expect(dark((await measureBackdrop(page, sel('eShadowContents'), 'background-color')).rgb)).toBe(true);
    expect((await renderedFacts(page, sel('eContents'), 'color')).surface).toBe('light');
  });
});

describe('the element\'s own opacity is not an input', () => {
  it('a half-transparent element reads the same backdrop as an opaque one; an ANCESTOR\'s partial opacity still makes it unmeasurable', async () => {
    expect((await measureBackdrop(page, sel('eOwnFade'), 'border-top-color')).rgb).toBe(WHITE);
    expect((await measureBackdrop(page, sel('eOwnFade'), 'background-color')).rgb).toBe(WHITE);
    const anc = await measureBackdrop(page, sel('eAncestorFade'), 'border-top-color');
    expect(anc.rgb).toBeNull();
    expect(anc.why).toMatch(/opacity/);
  });

  it('a card that fades in reads the identical backdrop result (status and source) at the start, mid-way and at the end of the fade', async () => {
    const reads: string[] = [];
    for (const t of [0, 700, 1500]) {
      await page.evaluate((ms) => document.querySelectorAll('[data-fra-element="eAnimFade"]').forEach((e) => e.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; })), t);
      reads.push(JSON.stringify(await measureBackdrop(page, sel('eAnimFade'), 'border-top-color')));
    }
    expect(new Set(reads).size, reads.join(' | ')).toBe(1);
    expect(reads[0]).toContain(WHITE);
  });
});
