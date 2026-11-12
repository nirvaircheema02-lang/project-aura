import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { captureDesign, hintsFromBaseline, htmlSha256Of, previewTargets, snapshotTargets, toBaseline, type CaptureHints, type CaptureLimits } from '../../src/fidelity/capture.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import type { DesignBaseline, DesignCapture, FidelityReport, SectionDesign } from '../../src/fidelity/types.ts';
import { openOfflineSnapshot } from '../../src/preview/extract.ts';
import type { Exemption } from '../../src/resolution/schema.ts';

/**
 * Round 4 of the fidelity re-review, against a real browser (fully offline): the box a pseudo-element is sized from (a stretched link, an in-flow block ::after), what an authorized
 * change can plausibly drive, url() in cursor / content, and where the pointer is parked.
 */

const DESKTOP = [{ name: 'desktop' as const, width: 1440, height: 900 }];
const BASE_CSS = 'body{margin:0;font-family:Arial,sans-serif}';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

async function baselineOf(html: string, css: string, ids = ['s'], limits?: Partial<CaptureLimits>): Promise<DesignBaseline> {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>o</title><style>${BASE_CSS}${css}</style></head><body>${html}</body></html>`;
  const ctx = await browser.newContext();
  try {
    const { page: p, close } = await openOfflineSnapshot(ctx, page);
    const c = await captureDesign({ page: p, targets: snapshotTargets(ids), viewports: DESKTOP, source: { kind: 'pre-edit-snapshot', htmlSha256: htmlSha256Of(page), url: null }, ...(limits ? { limits } : {}) });
    await close();
    return toBaseline(c);
  } finally { await ctx.close(); }
}

/** The running preview, simulated: each section in an open shadow root, exactly like the generated app. `chrome` is page-level markup outside any section (a header). */
async function observe(htmlBySection: Record<string, string>, css: string, opts: { hints?: CaptureHints; limits?: Partial<CaptureLimits>; chrome?: string; svg?: string } = {}): Promise<DesignCapture> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // (a preview serves its images from /assets: stand-in host that answers with the same picture)
  if (opts.svg) await ctx.route('https://example.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: opts.svg! }));
  try {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>p</title></head><body style="margin:0;font-family:Arial,sans-serif">${opts.chrome ?? ''}<main id="m"></main>
<script>const css = ${JSON.stringify(BASE_CSS + css)};
for (const h of ${JSON.stringify(Object.entries(htmlBySection).map(([id, html]) => ({ id, html })))}) { const host = document.createElement('div'); host.setAttribute('data-pv-section', h.id); document.getElementById('m').appendChild(host);
  const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<style>' + css + '</style><div data-pv-mount>' + h.html + '</div>'; }</script></body></html>`;
    await page.setContent(doc, { waitUntil: 'domcontentloaded' });
    return await captureDesign({ page, targets: previewTargets(Object.keys(htmlBySection)), viewports: DESKTOP, source: { kind: 'preview', htmlSha256: null, url: 'fixture-preview' }, ...(opts.hints ? { hints: opts.hints } : {}), ...(opts.limits ? { limits: opts.limits } : {}) });
  } finally { await ctx.close(); }
}
const ex = (property: string, over: Partial<Exemption> = {}): Exemption => ({ findingId: 'F1', property, part: 'self', state: 'default', viewport: 'any', targetId: `t-${property}`, reason: `fix ${property}`, ...over });
const compare = (b: DesignBaseline, o: DesignCapture, exemptions: Exemption[] = []): FidelityReport => compareDesign({ baseline: b, observed: o, exemptions, now: () => new Date(0) });
const sectionOf = (c: DesignCapture, id = 's'): SectionDesign => c.sections.find((s) => s.sectionId === id && s.viewport === 'desktop')!;
const sec = (inner: string, id = 's') => `<section data-fra-section="${id}">${inner}</section>`;
const regs = (r: FidelityReport) => r.differences.filter((d) => d.classification === 'regression').map((d) => `${d.category} ${d.elementKey} ${d.property} ${d.baseline}->${d.observed}`);

describe('round 4 · 1 — a pseudo-element is compared with the box it is SIZED from', () => {
  // the stretched-link pattern: the link's ::after covers the positioned CARD, the link's own box never moves
  const STRETCH = '.card{position:relative;padding:40px;background:#fff}.card a{color:#000;text-decoration:none}.card a::after{content:"";position:absolute;inset:0;background:rgba(0,0,0,0)}.card a:hover::after{background:rgba(0,0,0,0.05)}';
  const CARD = sec('<div class="card" data-fra-element="c" data-fra-findings="F1"><a href="#a">Read more</a></div>');

  it('the capture records the box each pseudo is sized from: the card\'s padding box for the stretched link, the owner\'s content box for an in-flow block', async () => {
    const b = await baselineOf(CARD, STRETCH);
    const link = sectionOf(b).elements.find((e) => e.tag === 'a')!;
    expect(link.pseudoRef?.after?.from).toBe('containing-block');
    const card = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(link.pseudoRef!.after!.box).toEqual({ w: card.box!.w, h: card.box!.h });
    expect(link.states.hover?.pseudoRef?.['::after']).toEqual(link.pseudoRef!.after);
    const flow = await baselineOf(sec('<a class="b" href="#a" data-fra-element="b" data-fra-findings="F1">Block</a>'), '.b{display:block;padding:10px 30px 10px 20px;border:2px solid #000}.b::after{content:"";display:block;height:1px;background:#ddd}');
    const a = sectionOf(flow).elements.find((e) => e.tag === 'a')!;
    expect(a.pseudoRef?.after).toEqual({ from: 'content-box', box: { w: a.box!.w - 20 - 30 - 4, h: a.box!.h - 20 - 4 } });
  }, 120_000);

  it('case 1 — a stretched link whose CARD padding is authorized: pass in the default, hover and focus states (was: a FAIL no correction could clear)', async () => {
    const b = await baselineOf(CARD, STRETCH);
    const o = await observe({ s: CARD }, `${STRETCH}.card{padding:24px}`, { hints: hintsFromBaseline(b) });
    const r = compare(b, o, [ex('padding')]);
    expect(regs(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
    // the same with NO authorization: the card's own padding is the regression, the stretched link is judged against the card (no false pseudo difference)
    expect(regs(compare(b, o)).every((x) => !x.includes('::after'))).toBe(true);
  }, 120_000);

  it('case 2 — an in-flow block ::after (a divider sized by the owner\'s CONTENT box) with only padding-left authorized: pass in every state', async () => {
    const css = '.card{display:block;padding:40px;color:#000;text-decoration:none}.card:hover{color:rgb(176,31,36)}.card::after{content:"";display:block;height:1px;margin-top:12px;background:#ddd}';
    const h = sec('<a class="card" href="#a" data-fra-element="c" data-fra-findings="F1">Read the whole report</a>');
    const b = await baselineOf(h, css);
    const r = compare(b, await observe({ s: h }, `${css}.card{padding-left:20px}`, { hints: hintsFromBaseline(b) }), [ex('padding-left')]);
    expect(regs(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
  }, 120_000);

  it('a ring with an inset (inset:-6px) follows the box it surrounds', async () => {
    const css = '.card{position:relative;display:block;padding:40px;color:#000;text-decoration:none}.card::after{content:"";position:absolute;inset:-6px;border:1px solid #888}';
    const h = sec('<a class="card" href="#a" data-fra-element="c" data-fra-findings="F1">Ring</a>');
    const b = await baselineOf(h, css);
    expect(regs(compare(b, await observe({ s: h }, `${css}.card{padding:12px}`, { hints: hintsFromBaseline(b) }), [ex('padding')]))).toEqual([]);
  }, 120_000);

  it('a ring that really stopped covering the card is still a regression, authorized padding or not', async () => {
    const b = await baselineOf(CARD, STRETCH);
    const o = await observe({ s: CARD }, `${STRETCH}.card{padding:24px}.card a::after{inset:auto;width:20px;height:20px}`, { hints: hintsFromBaseline(b) });
    expect(regs(compare(b, o, [ex('padding')])).some((x) => x.includes('::after') && /width|height/.test(x))).toBe(true);
  }, 120_000);
});

describe('round 4 · 2 — an authorized change excuses a pseudo size change only where it can plausibly drive it', () => {
  const CSS = '.i{display:inline-block;width:200px;padding:10px;color:#000;font-size:16px}.i::after{content:"";display:inline-block;width:20px;height:20px;background:#000}';
  const H = sec('<a class="i" href="#a" data-fra-element="i" data-fra-findings="F1">Open</a>');

  it('the reviewer\'s repro: a fixed-px pseudo that doubled (20px to 40px) with padding authorized FAILS, in the default, hover and focus states', async () => {
    const b = await baselineOf(H, CSS);
    const o = await observe({ s: H }, `${CSS}.i{padding:24px}.i::after{width:40px}`, { hints: hintsFromBaseline(b) });
    const r = compare(b, o, [ex('padding')]);
    expect(r.verdict).toBe('fail');
    expect(regs(r)).toEqual(['default-style 0::after width 20px->40px', 'hover 0::after width 20px->40px', 'focus-visible 0::after width 20px->40px']);
    expect(r.differences.filter((d) => d.elementKey === '0::after' && d.classification === 'intentional')).toEqual([]);
  }, 120_000);

  it('the same authorized padding fix with the pseudo untouched passes', async () => {
    const b = await baselineOf(H, CSS);
    expect(compare(b, await observe({ s: H }, `${CSS}.i{padding:24px}`, { hints: hintsFromBaseline(b) }), [ex('padding')]).verdict).toBe('pass');
  }, 120_000);

  it('an icon sized in em grows with an authorized font-size change (intentional) and is a regression without it', async () => {
    const css = '.i{display:inline-block;width:100px;color:#000;font-size:16px}.i::after{content:"";display:inline-block;width:1em;height:1em;margin-left:4px;background:#000}';
    const h = sec('<a class="i" href="#a" data-fra-element="i" data-fra-findings="F1">Open</a>');
    const b = await baselineOf(h, css);
    const o = await observe({ s: h }, `${css}.i{font-size:20px}`, { hints: hintsFromBaseline(b) });
    expect(regs(compare(b, o, [ex('font-size')]))).toEqual([]);
    expect(regs(compare(b, o)).some((x) => x.includes('::after width'))).toBe(true);
  }, 120_000);
});

describe('round 4 · 3 — url() reduction for cursor and for url() outside quoted strings', () => {
  const PIC = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#b01f24"/></svg>';
  const DATA = `data:image/svg+xml;base64,${Buffer.from(PIC).toString('base64')}`;
  const ASSET = 'https://example.invalid/assets/c.svg';

  it('a custom cursor the preview serves from /assets is the same cursor: a clean pass in the default, hover and focus states (was: a regression on every element that has or inherits it)', async () => {
    const css = (u: string) => `.l{display:inline-block;color:#000;cursor:url('${u}') 0 0, pointer}.l:hover{color:rgb(176,31,36)}`;
    const h = sec('<a class="l" href="#a" data-fra-element="l" data-fra-findings="F1">Link</a>');
    const b = await baselineOf(h, css(DATA));
    expect(sectionOf(b).elements.find((e) => e.tag === 'a')!.style['cursor']).toBe('url(~) 0 0, pointer');
    const r = compare(b, await observe({ s: h }, css(ASSET), { hints: hintsFromBaseline(b), svg: PIC }));
    expect(regs(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
    // a different hotspot or fallback is still a difference
    const changed = compare(b, await observe({ s: h }, css(ASSET).replace('0 0, pointer', '4 4, pointer'), { hints: hintsFromBaseline(b), svg: PIC }));
    expect(regs(changed).some((x) => x.includes('cursor'))).toBe(true);
  }, 120_000);

  it('a pseudo content of quoted text followed by an image url is the same content once the url is served from /assets', async () => {
    const css = (u: string) => `.k{display:inline-block;color:#000}.k::after{content:"a" url("${u}")}`;
    const h = sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Link</a>');
    const b = await baselineOf(h, css(DATA));
    const r = compare(b, await observe({ s: h }, css(ASSET), { hints: hintsFromBaseline(b), svg: PIC }));
    expect(regs(r)).toEqual([]);
    expect(regs(compare(b, await observe({ s: h }, css(ASSET).replace('"a"', '"b"'), { hints: hintsFromBaseline(b), svg: PIC }))).some((x) => x.includes('content'))).toBe(true);
  }, 120_000);
});

describe('round 4 · 4 — the pointer is parked outside the viewport before every default-state and focus read', () => {
  const CSS = '.k{display:block;height:40px;color:#000;text-decoration:none}.k:hover{color:rgb(176,31,36)}.sp{height:1200px}';
  const link = (n: number) => `<a class="k" href="#a${n}" data-fra-element="k${n}" data-fra-findings="F${n}">Link ${n}</a>`;
  const sections = `${sec(link(1), 's1')}<div style="height:700px"></div>${sec(link(2), 's2')}`;
  const HEADER = '<header style="position:fixed;top:0;left:0;right:0;height:80px;background:#ccc;z-index:10">Nav</header>';
  const previewSections = { s1: sec(link(1), 's1'), s2: sec(link(2), 's2') };

  it('the report\'s repro: the original has a fixed header over the top-left corner, the Selected-Sections preview does not — no hover is read on the unchanged page', async () => {
    const b = await baselineOf(`${HEADER}<div class="sp"></div>${sections}<div style="height:1600px"></div>`, CSS, ['s1', 's2']);
    const o = await observe(previewSections, CSS, { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(regs(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
  }, 180_000);

  it('the control without any header: the original scrolls the second section to the top of a long page, the short preview cannot — neither side reads a hover', async () => {
    const b = await baselineOf(`<div class="sp"></div>${sections}<div style="height:1600px"></div>`, CSS, ['s1', 's2']);
    const o = await observe(previewSections, CSS, { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(regs(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
    for (const id of ['s1', 's2']) expect(sectionOf(b, id).elements.find((e) => e.tag === 'a')!.style['color']).toBe('rgb(0, 0, 0)');
    for (const id of ['s1', 's2']) expect(sectionOf(o, id).elements.find((e) => e.tag === 'a')!.style['color']).toBe('rgb(0, 0, 0)');
  }, 180_000);

  it('a link at the very origin: its keyboard-focus capture is read without the hover colour', async () => {
    const css = '.k{display:block;height:40px;color:#000;text-decoration:none}.k:hover{color:rgb(176,31,36)}';
    const h = sec(link(1), 's1') + sec(link(2), 's2');
    const b = await baselineOf(h, css, ['s1', 's2']);
    for (const id of ['s1', 's2']) {
      const a = sectionOf(b, id).elements.find((e) => e.tag === 'a')!;
      expect(a.states['focus-visible']?.subtree['']?.['color']).toBe('rgb(0, 0, 0)');
      expect(a.style['color']).toBe('rgb(0, 0, 0)');
    }
  }, 180_000);
});
