import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { measureResolvedTarget } from '../../src/preview/targets.ts';
import { measureTarget } from '../../src/resolution/resolve.ts';
import { measureBackdrop, renderedFacts } from '../../src/resolution/rendered.ts';
import type { ResolvedTarget } from '../../src/resolution/schema.ts';
import { colourMapping, colourTarget } from '../helpers/colour-target.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Colour-lane review (defects 2, 4, 13): the backdrop a colour is judged against is the one the page really draws - whatever form the browser reports the
 * background colour in, and IN the state being verified - and what is written back into resolved-targets.json is only what was measured, rounded.
 */

const FORMS: Record<string, string> = {
  oklch: 'oklch(0.2 0.02 270)',
  mix: 'color-mix(in srgb, #000 90%, #fff)',
  p3: 'color(display-p3 0.05 0.05 0.06)',
  lab: 'lab(10% 0 0)',
  hwb: 'hwb(220 5% 85%)',
  rgb: 'rgb(17 17 20)',
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
.box{width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08);margin:8px}
.hw{background:#fff} .hw:hover{background:#111114;border-color:rgba(0,0,0,.08)}
.hd{background:#111114;border-color:rgba(0,0,0,.08)} .hd:hover{background:#fff}
.hg{background:#fff} .hg:hover{background-image:linear-gradient(#fff,#eee)}
.hs{background:#fff} .hs:hover{border-color:rgba(0,0,0,.08)}
.pbg{padding:20px;background:#111114}
.pbg .card{width:120px;height:40px;box-sizing:border-box;background:#fff;border:1px solid rgba(0,0,0,.08)}
</style></head><body>
${Object.entries(FORMS).map(([k, v]) => `<div class="box" style="background:${v}" data-finding-ids="f-${k}" data-fra-element="e-${k}"></div>`).join('\n')}
<div class="box hw" data-finding-ids="fHw" data-fra-element="eHw"></div>
<div class="box hd" data-finding-ids="fHd" data-fra-element="eHd"></div>
<div class="box hg" data-finding-ids="fHg" data-fra-element="eHg"></div>
<div class="box hs" data-finding-ids="fHs" data-fra-element="eHs"></div>
<div class="pbg"><div class="card" data-finding-ids="fCard" data-fra-element="eCard"></div></div>
<script>window.__pvVerify = { findByFinding: (id) => document.querySelector('[data-finding-ids~="' + id + '"]') };</script>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  page = await ctx.newPage();
  await page.setContent(PAGE);
});
afterAll(async () => { await browser.close(); });

const sel = (id: string) => `[data-fra-element="${id}"]`;
const channels = (rgb: string | null): number[] => (rgb?.match(/\d+/g) ?? []).map(Number);

describe('defect 2: every computed colour form is read, or the backdrop is unverified - never transparent', () => {
  it.each(Object.keys(FORMS))('%s: the dark background is measured as dark, not as the white canvas behind it', async (k) => {
    const b = await measureBackdrop(page, sel(`e-${k}`), 'border-top-color');
    expect(b.rgb, `${k}: ${b.why}`).not.toBeNull();
    expect(b.rgb).not.toBe('rgb(255, 255, 255)');
    for (const c of channels(b.rgb)) expect(c, `${k}: ${b.rgb}`).toBeLessThan(60);
  });

  it.each(Object.keys(FORMS))('%s: R5 fails a black hairline on it (invisible) instead of passing it on white', async (k) => {
    const t = colourTarget(`f-${k}`);
    const m = await measureTarget(page, sel(`e-${k}`), t);
    expect(m.matches, `${k}: ${m.note}`).toBe(false);
    expect(m.note).toMatch(/not visible/);
    expect(t.provenance.reference!.colours[0]!.verification.rendered.status).toBe('failed');
  });

  it.each(Object.keys(FORMS))('%s: R8 fails it too', async (k) => {
    const t = colourTarget(`f-${k}`);
    const m = await measureResolvedTarget(page, t);
    expect(m.matches, `${k}: ${m.note}`).toBe(false);
    expect(m.note).toMatch(/not visible/);
  });

  it('the surface classifier reads the same forms: a dark oklch / color-mix / display-p3 background is a dark surface', async () => {
    for (const k of ['oklch', 'mix', 'p3', 'lab', 'hwb', 'rgb']) {
      const f = await renderedFacts(page, sel(`e-${k}`), 'border-top-color');
      expect(f.surface, k).toBe('dark');
    }
  });

  it('when the browser cannot resolve a colour, the backdrop is UNVERIFIED with a reason - never the canvas behind it - and the surface is unknown', async () => {
    const broken = await browser.newPage();
    try {
      await broken.setContent(PAGE);
      await broken.evaluate(() => { (HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null; });
      const b = await measureBackdrop(broken, sel('e-oklch'), 'border-top-color');
      expect(b.rgb).toBeNull();
      expect(b.why).toMatch(/oklch\(0\.2 0\.02 270\)/);
      // an rgb() background does not need the browser: still measured
      expect((await measureBackdrop(broken, sel('e-rgb'), 'border-top-color')).rgb).toBe('rgb(17, 17, 20)');
      const t = colourTarget('f-oklch');
      const m = await measureTarget(broken, sel('e-oklch'), t);
      expect(m.matches).toBe(false);
      expect((m as { unverified?: boolean }).unverified).toBe(true);
      expect(t.provenance.reference!.colours[0]!.verification.rendered.status).toBe('unverified');
      expect((await renderedFacts(broken, sel('e-oklch'), 'border-top-color')).surface).toBe('unknown');
    } finally {
      await broken.close();
    }
  });
});

describe('defect 4: a hover / focus colour is judged against the backdrop IN that state', () => {
  const hover = (id: string, value = 'rgba(0, 0, 0, 0.08)') =>
    colourTarget(id, { state: 'hover', target: { value, comparison: 'color-deltaE', token: '--border-card' } }, [{ kind: 'state-distinct', property: 'border-top-color', state: 'hover', viewport: 'any', comparison: 'color-deltaE', expected: '0' }], [colourMapping({ state: 'hover' })]);

  it('R5: a white card that turns dark on hover has its black hairline judged on the DARK backdrop: failed', async () => {
    const t = hover('fHw');
    const m = await measureTarget(page, sel('eHw'), t);
    expect(m.matches, m.note).toBe(false);
    expect(m.note).toMatch(/not visible/);
    expect(m.note).toMatch(/17, 17, 20/);
  });

  it('R5: a dark card that turns white on hover has it judged on the WHITE backdrop: visible, passed (it used to fail on the resting dark one)', async () => {
    const t = hover('fHd');
    const m = await measureTarget(page, sel('eHd'), t);
    expect(m.matches, m.note).toBe(true);
    expect(t.provenance.reference!.colours[0]!.verification.rendered.backdrop).toBe('rgb(255, 255, 255)');
  });

  it('R5: a state whose backdrop cannot be measured (a gradient appears on hover) is unverified even though the resting backdrop was white', async () => {
    const t = hover('fHg');
    const m = await measureTarget(page, sel('eHg'), t);
    expect(m.matches).toBe(false);
    expect((m as { unverified?: boolean }).unverified).toBe(true);
    expect(m.note).toMatch(/backdrop/);
  });

  it('R5: a state that does not change the backdrop still passes on it', async () => {
    const m = await measureTarget(page, sel('eHs'), hover('fHs'));
    expect(m.matches, m.note).toBe(true);
  });

  it('R8: the same four cases', async () => {
    const hw = await measureResolvedTarget(page, hover('fHw'));
    expect(hw.matches, hw.note).toBe(false);
    expect(hw.note).toMatch(/not visible/);
    expect(hw.note).toMatch(/17, 17, 20/);
    const hd = await measureResolvedTarget(page, hover('fHd'));
    expect(hd.matches, hd.note).toBe(true);
    const hg = await measureResolvedTarget(page, hover('fHg'));
    expect(hg.matches).toBe(false);
    expect(hg.measured).toBe(false);
    const hs = await measureResolvedTarget(page, hover('fHs'));
    expect(hs.matches, hs.note).toBe(true);
  });
});

describe('defect 3: the backdrop depends on the property being judged, not on the order of anything', () => {
  it('a background paints over the PARENT backdrop, a border over the element\'s own background', async () => {
    const own = await measureBackdrop(page, sel('eCard'), 'border-top-color');
    const parent = await measureBackdrop(page, sel('eCard'), 'background-color');
    expect(own.rgb).toBe('rgb(255, 255, 255)');
    expect(parent.rgb).toBe('rgb(17, 17, 20)');
  });

  it('an outline and a box-shadow are painted OUTSIDE the border box, over the parent backdrop', async () => {
    for (const property of ['outline-color', 'box-shadow']) expect((await measureBackdrop(page, sel('eCard'), property)).rgb, property).toBe('rgb(17, 17, 20)');
    expect((await measureBackdrop(page, sel('eCard'), 'color')).rgb).toBe('rgb(255, 255, 255)');
  });
});

describe('defect 13: only what was measured is stored, and it is stored rounded', () => {
  const mappings = () => [
    colourMapping({ property: 'border', state: 'default' }),
    colourMapping({ property: 'box-shadow', role: 'shadow', state: 'default', dsToken: '--shadow-card-rest' }),
    colourMapping({ property: 'border', state: 'hover' }),
    colourMapping({ property: 'background', role: 'fill', state: 'default', dsToken: '--tint-soft' }),
  ];

  it('R8 writes the rendered verification to the mapping of the measured property and state only', async () => {
    const t = colourTarget('fCard', {}, [], mappings());
    await measureResolvedTarget(page, t);
    const [border, shadow, hoverBorder, fill] = t.provenance.reference!.colours;
    expect(border!.verification.rendered.status).toBe('passed');
    expect(shadow!.verification.rendered.status).toBe('not-run');
    expect(hoverBorder!.verification.rendered.status).toBe('not-run');
    expect(fill!.verification.rendered.status).toBe('not-run');
  });

  it('R5 does the same', async () => {
    const t = colourTarget('fCard', {}, [], mappings());
    await measureTarget(page, sel('eCard'), t);
    const rendered = t.provenance.reference!.colours.map((c) => c.verification.rendered.status);
    expect(rendered).toEqual(['passed', 'not-run', 'not-run', 'not-run']);
  });

  it('the stored strength has at most two decimals (the file is hashed into the G2 fingerprint)', async () => {
    const t = colourTarget('fCard', {}, [], mappings());
    await measureResolvedTarget(page, t);
    const strength = t.provenance.reference!.colours[0]!.verification.rendered.strength!;
    expect(strength).toBeGreaterThan(1.5);
    expect(Math.round(strength * 100) / 100).toBe(strength);
  });

  it('a hover target writes to the hover mapping, not the default one', async () => {
    const t: ResolvedTarget = colourTarget('fHs', { state: 'hover' }, [], mappings());
    await measureResolvedTarget(page, t);
    expect(t.provenance.reference!.colours.map((c) => c.verification.rendered.status)).toEqual(['not-run', 'not-run', 'passed', 'not-run']);
  });

  it('two identical verification runs leave byte-identical targets (R8 and R5), a hover target included', async () => {
    const run = async (by: 'R8' | 'R5') => {
      const targets = [colourTarget('fCard', {}, [], mappings()), colourTarget('fHs', { state: 'hover' }, [], mappings())];
      for (const t of targets) await (by === 'R8' ? measureResolvedTarget(page, t) : measureTarget(page, sel(t.findingId === 'fCard' ? 'eCard' : 'eHs'), t));
      return JSON.stringify(targets);
    };
    for (const by of ['R8', 'R5'] as const) {
      const first = await run(by);
      expect(await run(by), by).toBe(first);
      expect(first).toMatch(/"status":"passed"/);
    }
  });
});
