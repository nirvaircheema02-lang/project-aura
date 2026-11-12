import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { inferElementKinds } from '../../src/reference/element-kind.ts';
import { probeStructure } from '../../src/resolution/structure-probe.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Round 2, defect 7. (a) The structure facts settle against animations of visibility / height / width before they are read, so an UNTYPED, structure-only
 * classification does not depend on when the page was probed. (b) The probe reads nav / footer / header landmarks - the live-only case of the audit's
 * "inside navigation / footer" signal - into the same soft veto.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
@keyframes vis{from{visibility:hidden}to{visibility:visible}}
@keyframes grow{from{height:0}to{height:200px}}
@keyframes wide{from{width:0}to{width:300px}}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px;margin:16px;overflow:hidden}
.vis{animation:vis 700ms linear 300ms both}
.hgt{animation:grow 600ms linear 300ms both}
.wid{animation:wide 600ms linear 300ms both}
.long{animation:grow 6s linear 300ms both}
nav ul,footer ul,header ul{list-style:none;margin:0;padding:0;display:flex;gap:8px}
</style></head><body>
<div class="tile vis" data-fra-element="vis"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div>
<div class="tile hgt" data-fra-element="hgt"><h3>Plan B</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#b">Read more</a></div>
<div class="tile wid" data-fra-element="wid"><h3>Plan C</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#c">Read more</a></div>
<div class="tile long" data-fra-element="long"><h3>Plan D</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#d">Read more</a></div>
<div class="tile" data-fra-element="still"><h3>Plan E</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#e">Read more</a></div>
<nav><ul><li class="tile" data-fra-element="navA"><h3>Menu A</h3><p>Some descriptive text about the menu.</p><a href="#a">Open</a></li><li class="tile" data-fra-element="navB"><h3>Menu B</h3><p>Some descriptive text about the menu.</p><a href="#b">Open</a></li></ul></nav>
<footer><ul><li class="tile" data-fra-element="footA"><h3>Links A</h3><p>Some descriptive text about the links.</p><a href="#a">Open</a></li><li class="tile" data-fra-element="footB"><h3>Links B</h3><p>Some descriptive text about the links.</p><a href="#b">Open</a></li></ul></footer>
<header><ul><li class="tile" data-fra-element="headA"><h3>Top A</h3><p>Some descriptive text about the top.</p><a href="#a">Open</a></li><li class="tile" data-fra-element="headB"><h3>Top B</h3><p>Some descriptive text about the top.</p><a href="#b">Open</a></li></ul></header>
<div role="navigation"><ul><li class="tile" data-fra-element="roleA"><h3>Role A</h3><p>Some descriptive text about the role.</p><a href="#a">Open</a></li><li class="tile" data-fra-element="roleB"><h3>Role B</h3><p>Some descriptive text about the role.</p><a href="#b">Open</a></li></ul></div>
<div role="contentinfo"><ul><li class="tile" data-fra-element="infoA"><h3>Info A</h3><p>Some descriptive text about the info.</p><a href="#a">Open</a></li><li class="tile" data-fra-element="infoB"><h3>Info B</h3><p>Some descriptive text about the info.</p><a href="#b">Open</a></li></ul></div>
<div class="tile" data-fra-element="mainA"><h3>Main A</h3><p>Some descriptive text about the main.</p><a href="#a">Open</a></div>
<div class="tile" data-fra-element="mainB"><h3>Main B</h3><p>Some descriptive text about the main.</p><a href="#b">Open</a></div>
<div id="host"></div>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<style>.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px;margin:16px}</style><nav><div class="tile" data-fra-element="shadowNav"><h3>Shadow</h3><p>Some descriptive text in a shadow root.</p><a href="#s">Open</a></div></nav>';</script>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.setContent(PAGE);
});
afterAll(async () => { await browser.close(); });

const NO_AUDIT = { productionType: null as string | null, dsComponent: null, signals: [] as string[], possibleMatches: [] };
const MAPPED = (tagName = 'div') => ({ tagName, role: null, href: null, type: null, ariaExpanded: null, ariaControls: null, dsComponent: null, dsBasis: 'none' });
const sel = (n: string) => `[data-fra-element="${n}"]`;
const kindsOf = async (n: string, productionType: string | null = null, signals: string[] = []) =>
  inferElementKinds({ audit: { ...NO_AUDIT, productionType, signals }, mapping: MAPPED(n.startsWith('nav') || n.includes('A') || n.includes('B') ? 'li' : 'div'), structure: await probeStructure(page, sel(n)) });

describe('structure facts settle against animations of visibility, height and width', () => {
  it.each(['vis', 'hgt', 'wid'])('%s: an untyped composed card has the same facts and the same kinds at the start of its animation and after it', async (name) => {
    await page.setContent(PAGE); // the animations start now
    const early = await probeStructure(page, sel(name)); // the animation has barely started: visibility hidden / height 0 / width 0 without the settle
    const earlyKinds = await kindsOf(name);
    await page.waitForFunction((n) => (document.querySelector(`[data-fra-element="${n}"]`)?.getAnimations() ?? []).every((a) => a.playState === 'finished'), name, { timeout: 15_000 });
    const late = await probeStructure(page, sel(name));
    expect(early, name).toEqual(late);
    expect(early!.visible).toBe(true);
    expect(early!.height).toBeGreaterThan(100);
    expect(JSON.stringify(earlyKinds)).toBe(JSON.stringify(await kindsOf(name)));
  });

  it('a TYPED card is the same card at any moment (the classification never depended on it), documented here beside the untyped case', async () => {
    await page.setContent(PAGE);
    const early = await kindsOf('vis', 'card');
    await page.waitForFunction(() => (document.querySelector('[data-fra-element="vis"]')?.getAnimations() ?? []).every((a) => a.playState === 'finished'), undefined, { timeout: 15_000 });
    const late = await kindsOf('vis', 'card');
    expect(early.kinds.map((k) => k.kind)).toEqual(['card']);
    expect(JSON.stringify(early)).toBe(JSON.stringify(late));
  });

  it('an animation that outlasts the settle cap: the structure is NOT used (fail closed, and the same at any moment), with the reason recorded', async () => {
    await page.setContent(PAGE);
    const first = await probeStructure(page, sel('long'));
    expect(first!.settled).toBe(false);
    const k1 = await kindsOf('long');
    expect(k1.kinds).toEqual([]);
    expect(k1.context.join(' ')).toMatch(/animation|settle/i);
    const k2 = await kindsOf('long');
    expect(JSON.stringify(k1)).toBe(JSON.stringify(k2));
    // typed evidence is unaffected
    expect((await kindsOf('long', 'card')).kinds.map((k) => k.kind)).toEqual(['card']);
  }, 30_000);

  it('a page with nothing animating is probed at once and reports settled', async () => {
    await page.setContent(PAGE);
    const f = await probeStructure(page, sel('still'));
    expect(f!.settled).toBe(true);
  });
});

describe('landmarks: the live-only case of "inside navigation / footer"', () => {
  it.each(['navA', 'footA', 'headA', 'roleA', 'infoA', 'shadowNav'])('%s: a bordered composed list item inside a landmark is not a card or panel on structure alone', async (name) => {
    await page.setContent(PAGE);
    const f = (await probeStructure(page, sel(name)))!;
    expect(f.landmark).not.toBeNull();
    const r = await kindsOf(name);
    expect(r.kinds.map((k) => k.kind), name).toEqual([]);
    expect(r.context.join(' ')).toMatch(/inside (?:navigation|footer|a page header)/);
  });

  it('the same markup outside any landmark is still a candidate card (the veto is the landmark, nothing else)', async () => {
    const f = (await probeStructure(page, sel('mainA')))!;
    expect(f.landmark).toBeNull();
    expect((await kindsOf('mainA')).kinds.length).toBeGreaterThan(0);
  });

  it('typed evidence keeps its kind inside a landmark (a soft veto, like the audit\'s signal)', async () => {
    expect((await kindsOf('navA', 'card')).kinds.map((k) => k.kind)).toEqual(['card']);
    expect((await kindsOf('footA', 'card')).kinds.map((k) => k.kind)).toEqual(['card']);
  });

  it('the audit\'s own signal and the probe agree, and do not double up', async () => {
    const r = await kindsOf('navA', null, ['inside navigation']);
    expect(r.kinds).toEqual([]);
    expect(r.context.filter((c) => /inside navigation/.test(c))).toHaveLength(1);
  });
});
