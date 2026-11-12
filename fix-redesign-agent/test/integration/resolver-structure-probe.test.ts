import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { inferElementKinds } from '../../src/reference/element-kind.ts';
import { probeStructure } from '../../src/resolution/structure-probe.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * The structure probe against a real Chromium page. It only COLLECTS facts (booleans, counts, sizes); the classifier decides. The probe must tell
 * a bordered card with a heading, text and a link apart from a plain wrapper div, without any audit data.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
.grid{display:flex;gap:16px;padding:16px}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px}
.outer{width:600px}
.band{width:100%;height:400px;background:#f4f1ee}
.shadow{width:240px;height:160px;box-shadow:0 1px 3px rgba(0,0,0,.2);padding:8px}
</style></head><body>
<div class="grid">
  <div class="tile" data-fra-element="card1"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div>
  <div class="tile" data-fra-element="card2"><h3>Plan B</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#b">Read more</a></div>
  <div class="tile" data-fra-element="card3"><h3>Plan C</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#c">Read more</a></div>
</div>
<div class="outer" data-fra-element="wrap"><div><h3>Heading</h3><p>Plain wrapper content with a few words in it.</p><svg width="24" height="24"></svg></div></div>
<a class="tile" href="#x" data-fra-element="anchor"><h3>Blog</h3><p>An anchor card with text in it.</p></a>
<div class="band" data-fra-element="band"><h2>Section title</h2><p>Some text inside a full width tinted band.</p></div>
<div class="shadow" data-fra-element="shadow"><h4>Shadowed</h4><p>Only a box shadow gives this box away.</p></div>
<div data-fra-element="contents" style="display:contents"><p>Contents wrapper that has no box of its own.</p></div>
<div data-fra-element="hidden" style="visibility:hidden;width:200px;height:100px">Hidden text that is not shown</div>
<button data-fra-element="btn">Go</button>
<div role="button" tabindex="0" data-fra-element="rolebtn" style="cursor:pointer">Clickable</div>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.setContent(PAGE);
});
afterAll(async () => {
  await browser.close();
});

const probe = async (name: string) => probeStructure(page, `[data-fra-element="${name}"]`);

describe('probeStructure — facts from the rendered element', () => {
  it('reads a bordered card with a heading, text, media and a link, repeated three times', async () => {
    const f = (await probe('card2'))!;
    expect(f).toMatchObject({ tag: 'div', role: null, displayContents: false, visible: true, bordered: true, shadowed: false, tinted: false, gradient: false, interactive: false, selfAnchor: false, onlyChildSameBox: false });
    expect(f.headings).toBe(1);
    expect(f.textBlocks).toBeGreaterThanOrEqual(1);
    expect(f.media).toBe(1);
    expect(f.actions).toBe(1);
    expect(f.similarSiblings).toBe(2);
    expect(f.width).toBeCloseTo(300, 0);
    expect(f.height).toBeCloseTo(200, 0);
    expect(f.widthRatio).toBeCloseTo(300 / 1280, 2);
  });

  it('reads a plain wrapper as unstyled with a single child that has the same box', async () => {
    const f = (await probe('wrap'))!;
    expect(f).toMatchObject({ bordered: false, shadowed: false, tinted: false, onlyChildSameBox: true, similarSiblings: 0 });
    expect(f.headings).toBe(1);
  });

  it('reads an anchor card, a tinted full-width band, a shadow-only box, display:contents and a hidden element', async () => {
    expect(await probe('anchor')).toMatchObject({ tag: 'a', selfAnchor: true, interactive: true, bordered: true });
    const band = (await probe('band'))!;
    expect(band).toMatchObject({ tinted: true, bordered: false });
    expect(band.widthRatio).toBeGreaterThan(0.98);
    expect(await probe('shadow')).toMatchObject({ shadowed: true, bordered: false, tinted: false });
    expect(await probe('contents')).toMatchObject({ displayContents: true });
    expect(await probe('hidden')).toMatchObject({ visible: false });
  });

  it('reads controls: a native button and a role=button div are interactive', async () => {
    expect(await probe('btn')).toMatchObject({ tag: 'button', interactive: true });
    expect(await probe('rolebtn')).toMatchObject({ role: 'button', interactive: true });
  });

  it('returns null for an element that is not on the page', async () => {
    expect(await probe('nope')).toBeNull();
  });

  it('is deterministic: two probes of the same element are identical', async () => {
    expect(await probe('card1')).toEqual(await probe('card1'));
  });
});

describe('probe → classifier, on the real page and with NO audit evidence', () => {
  const kinds = async (name: string, tag = 'div') => inferElementKinds({ audit: { productionType: null, dsComponent: null, signals: [], possibleMatches: [] }, mapping: { tagName: tag, role: null, href: null, type: null, ariaExpanded: null, ariaControls: null, dsComponent: null, dsBasis: 'none' }, structure: await probe(name) }).kinds.map((k) => k.kind);

  it('a repeated bordered card with heading + text + media + link is a card', async () => {
    expect(await kinds('card2')).toEqual(['card']);
  });

  it('a plain wrapper div, a full-width band as a card, a hidden element and a display:contents wrapper are not cards', async () => {
    expect(await kinds('wrap')).toEqual([]);
    expect(await kinds('band')).not.toContain('card');
    expect(await kinds('band')).toEqual(['section']);
    expect(await kinds('hidden')).toEqual([]);
    expect(await kinds('contents')).toEqual([]);
  });

  it('a single shadowed composed box is a panel, a lone anchor card is below the line without audit corroboration', async () => {
    expect(await kinds('shadow')).toEqual(['panel']);
    expect(await kinds('anchor', 'a')).not.toContain('card');
  });

  it('a button is never a card whatever its box looks like', async () => {
    expect(await kinds('btn', 'button')).toEqual(['button']);
  });
});

// ── defects found in review: timing, painted shadows/gradients, viewport, labels, navigation ─────────────────────────────────────

const NO_AUDIT = { productionType: null, dsComponent: null, signals: [] as string[], possibleMatches: [] };
const MAPPED = (tagName = 'div') => ({ tagName, role: null, href: null, type: null, ariaExpanded: null, ariaControls: null, dsComponent: null, dsBasis: 'none' });

describe('probeStructure — classification does not depend on animation timing', () => {
  const FADE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
@keyframes reveal{from{opacity:0;transform:scale(.2) translateY(40px)}to{opacity:1;transform:none}}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px;margin:16px}
.reveal{animation:reveal 800ms linear 500ms both}
</style></head><body>
<div class="tile reveal" data-fra-element="fade"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div>
<div class="tile" data-fra-element="faded" style="opacity:0"><h3>Plan B</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#b">Read more</a></div>
<div class="tile" data-fra-element="scaled" style="transform:scale(.2);transform-origin:0 0"><h3>Plan C</h3><p>Some descriptive text about the plan.</p></div>
<div data-fra-element="none" style="display:none"><h3>x</h3></div>
<div data-fra-element="empty" style="width:0;height:0"></div>
</body></html>`;
  let p: Page;
  beforeAll(async () => {
    p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await p.setContent(FADE);
  });
  const probeOn = (name: string) => probeStructure(p, `[data-fra-element="${name}"]`);
  const kindsFor = async (name: string, productionType: string | null) => inferElementKinds({ audit: { ...NO_AUDIT, productionType }, mapping: MAPPED(), structure: await probeOn(name) });

  it('an element that fades in: the facts read mid-animation and after it are IDENTICAL, so is the classification', async () => {
    const during = await probeOn('fade');
    await p.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished'), undefined, { timeout: 30_000 }); // animation STATE, not a sleep
    const after = await probeOn('fade');
    expect(during).toEqual(after);
    expect(during!.visible).toBe(true);
    expect(JSON.stringify(await kindsFor('fade', 'card'))).toBe(JSON.stringify(await kindsFor('fade', 'card')));
  });

  it('an audit-typed card at opacity 0 (a scroll-reveal card before it reveals) is still a card, with candidates and a stable record', async () => {
    expect((await probeOn('faded'))!.visible).toBe(true);
    expect((await kindsFor('faded', 'card')).kinds.map((k) => k.kind)).toEqual(['card']);
    expect((await kindsFor('fade', 'card')).kinds.map((k) => k.kind)).toEqual(['card']);
  });

  it('layout size is measured WITHOUT transforms: a scale(.2) element reports its layout box', async () => {
    const f = (await probeOn('scaled'))!;
    expect(f.width).toBeCloseTo(300, 0);
    expect(f.height).toBeCloseTo(200, 0);
  });

  it('display:none and a zero-size box are the only invisible elements', async () => {
    expect((await probeOn('none'))!.visible).toBe(false);
    expect((await probeOn('empty'))!.visible).toBe(false);
    expect(await kindsFor('none', 'card')).toMatchObject({ kinds: [{ kind: 'card' }] }); // typed evidence is not vetoed by invisibility
    expect((await kindsFor('none', null)).kinds).toEqual([]);
  });
});

describe('probeStructure — a shadow or gradient counts only when it is PAINTED', () => {
  const TW = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
.row{display:flex;gap:16px;padding:16px}
.box{box-sizing:border-box;width:300px;height:200px;padding:16px}
.reset{box-shadow:0 0 #0000,0 0 #0000,0 0 #0000}
</style></head><body>
<div class="row">
  <div class="box reset" data-fra-element="w1"><h3>Plan A</h3><p>Some descriptive text about the plan.</p></div>
  <div class="box reset" data-fra-element="w2"><h3>Plan B</h3><p>Some descriptive text about the plan.</p></div>
  <div class="box reset" data-fra-element="w3"><h3>Plan C</h3><p>Some descriptive text about the plan.</p></div>
</div>
<div class="box" data-fra-element="allzero" style="box-shadow:0 0 0 0 rgba(0,0,0,.5)"></div>
<div class="box" data-fra-element="blur" style="box-shadow:0 0 4px rgba(0,0,0,.3)"></div>
<div class="box" data-fra-element="ring" style="box-shadow:0 0 0 1px rgba(0,0,0,.1)"></div>
<div class="box" data-fra-element="offset" style="box-shadow:2px 0 0 0 #888"></div>
<div class="box" data-fra-element="inset" style="box-shadow:inset 0 1px 2px rgba(0,0,0,.2)"></div>
<div class="box" data-fra-element="mixed" style="box-shadow:0 0 0 0 transparent,0 1px 2px rgba(0,0,0,.2)"></div>
<div class="box" data-fra-element="clear" style="box-shadow:0 1px 3px rgba(0,0,0,0)"></div>
<div class="box" data-fra-element="g0" style="background-image:linear-gradient(transparent,transparent)"></div>
<div class="box" data-fra-element="g1" style="background-image:linear-gradient(rgba(0,0,0,0),rgba(255,255,255,0))"></div>
<div class="box" data-fra-element="g2" style="background-image:linear-gradient(#fff,#eee)"></div>
<div class="box" data-fra-element="g3" style="background-image:linear-gradient(to right,transparent 0%,#eee 100%)"></div>
<div class="box" data-fra-element="g4" style="background-image:radial-gradient(circle,rgba(0,0,0,0) 0%,rgba(0,0,0,.2) 100%)"></div>
<div class="box" data-fra-element="nobg"></div>
</body></html>`;
  let p: Page;
  beforeAll(async () => {
    p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await p.setContent(TW);
  });
  const probeOn = (name: string) => probeStructure(p, `[data-fra-element="${name}"]`);

  it('transparent / zero shadow layers (Tailwind resets) do not paint a box', async () => {
    expect((await probeOn('w1'))!.shadowed).toBe(false);
    expect((await probeOn('allzero'))!.shadowed).toBe(false);
    expect((await probeOn('clear'))!.shadowed).toBe(false);
  });

  it('unstyled layout wrappers with a Tailwind shadow reset are NOT cards or panels (three siblings, heading + text)', async () => {
    for (const n of ['w1', 'w2', 'w3']) {
      const k = inferElementKinds({ audit: NO_AUDIT, mapping: MAPPED(), structure: await probeOn(n) });
      expect(k.kinds, n).toEqual([]);
    }
  });

  it('a shadow with any painted layer (blur, spread ring, offset, inset, or one visible layer among resets) is shadowed', async () => {
    for (const n of ['blur', 'ring', 'offset', 'inset', 'mixed']) expect((await probeOn(n))!.shadowed, n).toBe(true);
  });

  it('a gradient counts only when some stop is non-transparent', async () => {
    for (const n of ['g0', 'g1', 'nobg']) expect((await probeOn(n))!.gradient, n).toBe(false);
    for (const n of ['g2', 'g3', 'g4']) expect((await probeOn(n))!.gradient, n).toBe(true);
  });
});

describe('probeStructure — viewport class, labels, navigation', () => {
  const RESP = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
.grid{display:flex;gap:16px;padding:16px}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px}
@media (max-width:600px){.grid{display:block;padding:0}.tile{width:100%;height:340px}}
.pick{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px}
nav ul{list-style:none;margin:0;padding:0;display:flex}
</style></head><body>
<div class="grid">
  <div class="tile" data-fra-element="c1"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div>
  <div class="tile" data-fra-element="c2"><h3>Plan B</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#b">Read more</a></div>
  <div class="tile" data-fra-element="c3"><h3>Plan C</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#c">Read more</a></div>
</div>
<label class="pick" data-fra-element="pick"><input type="radio" name="p"><h3>Pro</h3><p>Everything in the free plan plus more.</p></label>
<label class="pick" data-fra-element="plain" for="x">Remember me on this device</label><input id="x" type="checkbox">
<nav><ul>
  <li class="tile" data-fra-element="n1"><h3>Reports</h3><p>All of our research reports in one place.</p><svg width="24" height="24"></svg></li>
  <li class="tile" data-fra-element="n2"><h3>Studies</h3><p>All of our case studies in one place.</p><svg width="24" height="24"></svg></li>
</ul></nav>
</body></html>`;
  const open = async (width: number) => {
    const pg = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
    await pg.setContent(RESP);
    return pg;
  };
  const kinds = (facts: Awaited<ReturnType<typeof probeStructure>>, productionType: string | null = null, signals: string[] = [], tag = 'div') => inferElementKinds({ audit: { ...NO_AUDIT, productionType, signals }, mapping: MAPPED(tag), structure: facts });

  it('the viewport class (desktop / mobile) is part of the facts', async () => {
    expect((await probeStructure(await open(1280), '[data-fra-element="c1"]'))!.viewport).toBe('desktop');
    expect((await probeStructure(await open(375), '[data-fra-element="c1"]'))!.viewport).toBe('mobile');
  });

  it('the same card classifies the same at 375px (stacked, full width) and at 1280px (a row of three)', async () => {
    const desktop = kinds(await probeStructure(await open(1280), '[data-fra-element="c2"]'));
    const mobile = kinds(await probeStructure(await open(375), '[data-fra-element="c2"]'));
    expect(desktop.kinds.map((k) => k.kind)).toEqual(['card']);
    expect(mobile.kinds.map((k) => k.kind)).toEqual(['card']);
    expect(desktop.viewport).toBe('desktop');
    expect(mobile.viewport).toBe('mobile');
  });

  it('a <label> radio tile with a heading and text, typed card by the audit, is handled as a card; a label of nothing but text is not', async () => {
    const pg = await open(1280);
    const pick = (await probeStructure(pg, '[data-fra-element="pick"]'))!;
    expect(pick).toMatchObject({ tag: 'label', headings: 1, controls: 1 });
    expect(kinds(pick, 'card', [], 'label').kinds.map((k) => k.kind)).toEqual(['card']);
    expect(kinds(pick, null, [], 'label').kinds).toEqual([]); // structure alone never makes a label a card
    const plain = (await probeStructure(pg, '[data-fra-element="plain"]'))!;
    expect(plain.headings).toBe(0);
    expect(kinds(plain, 'card', [], 'label').kinds).toEqual([]);
  });

  it('a navigation <li> pair that looks like bordered composed boxes is not a card or panel when the audit says "inside navigation"', async () => {
    const f = await probeStructure(await open(1280), '[data-fra-element="n1"]');
    expect(kinds(f, null, ['inside navigation'], 'li').kinds).toEqual([]);
    expect(kinds(f, 'card', ['inside navigation'], 'li').kinds.map((k) => k.kind)).toEqual(['card']);
  });
});
