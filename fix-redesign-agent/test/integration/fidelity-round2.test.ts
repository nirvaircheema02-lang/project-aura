import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { STATES_NOT_CAPTURED, captureDesign, hintsFromBaseline, htmlSha256Of, previewTargets, snapshotTargets, toBaseline, type CaptureHints } from '../../src/fidelity/capture.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { BY_DESIGN_GAP_REASONS, gapSplit } from '../../src/fidelity/coverage.ts';
import type { DesignBaseline, DesignCapture, FidelityReport, SectionDesign } from '../../src/fidelity/types.ts';
import { openOfflineSnapshot } from '../../src/preview/extract.ts';
import { fingerprintOf } from '../../src/session/fingerprint.ts';

/**
 * Round 2 of the fidelity re-review, against a real browser: finding elements beyond the walk limits, pseudo-element hover reveals,
 * the sampling priority, a wrapper inserted around text, real focusability and the hover retry. Fully offline.
 */

const DESKTOP = [{ name: 'desktop' as const, width: 1440, height: 900 }];
const BASE_CSS = 'body{margin:0;font-family:Arial,sans-serif}';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

async function baselineOf(html: string, css: string, ids = ['s']): Promise<DesignBaseline> {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>o</title><style>${BASE_CSS}${css}</style></head><body>${html}</body></html>`;
  const ctx = await browser.newContext();
  try {
    const { page: p, close } = await openOfflineSnapshot(ctx, page);
    const c = await captureDesign({ page: p, targets: snapshotTargets(ids), viewports: DESKTOP, source: { kind: 'pre-edit-snapshot', htmlSha256: htmlSha256Of(page), url: null } });
    await close();
    return toBaseline(c);
  } finally { await ctx.close(); }
}

/** The running preview, simulated: each section in an open shadow root, exactly like the generated app. */
async function observe(htmlBySection: Record<string, string>, css: string, opts: { hints?: CaptureHints } = {}): Promise<DesignCapture> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>p</title></head><body style="margin:0;font-family:Arial,sans-serif"><main id="m"></main>
<script>const css = ${JSON.stringify(BASE_CSS + css)};
for (const h of ${JSON.stringify(Object.entries(htmlBySection).map(([id, html]) => ({ id, html })))}) { const host = document.createElement('div'); host.setAttribute('data-pv-section', h.id); document.getElementById('m').appendChild(host);
  const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<style>' + css + '</style><div data-pv-mount>' + h.html + '</div>'; }</script></body></html>`;
    await page.setContent(doc, { waitUntil: 'domcontentloaded' });
    return await captureDesign({ page, targets: previewTargets(Object.keys(htmlBySection)), viewports: DESKTOP, source: { kind: 'preview', htmlSha256: null, url: 'fixture-preview' }, ...(opts.hints ? { hints: opts.hints } : {}) });
  } finally { await ctx.close(); }
}
const compare = (b: DesignBaseline, o: DesignCapture): FidelityReport => compareDesign({ baseline: b, observed: o, exemptions: [], now: () => new Date(0) });
const sectionOf = (c: DesignCapture, id = 's'): SectionDesign => c.sections.find((s) => s.sectionId === id && s.viewport === 'desktop')!;
const sec = (inner: string, id = 's') => `<section data-fra-section="${id}">${inner}</section>`;
const reasons = (r: FidelityReport) => r.coverage!.gaps.map((g) => `${g.required ? 'REQ' : 'disc'}:${g.reason}`);

describe('round 2 · 1 — finding elements are captured whatever the walk limits cut', () => {
  const filler = Array.from({ length: 2300 }, () => '<div><span></span></div>').join('');
  const deep = (n: number, inner: string): string => (n === 0 ? inner : `<div>${deep(n - 1, inner)}</div>`);
  const CSS = 'h2,h3{color:#000;margin:0}';

  it('a finding element past the 4000-node limit is captured, keeps its evidence, and a colour regression on it is seen (was: verdict pass, never captured)', async () => {
    const HTML = sec(`${filler}<div><h2 data-fra-element="x" data-fra-findings="F9">Nine</h2></div><h3 data-fra-element="y" data-fra-findings="F8">Eight</h3>`);
    const b = await baselineOf(HTML, CSS);
    const s = sectionOf(b);
    expect(s.walkCut ?? 0).toBeGreaterThan(0);
    expect(s.elements.filter((e) => e.findingIds.length).map((e) => e.findingIds[0]).sort()).toEqual(['F8', 'F9']);
    const o = await observe({ s: HTML }, `${CSS}h2{color:#f00}`, { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(r.verdict).toBe('fail');
    expect(r.differences.some((d) => d.classification === 'regression' && d.property === 'color' && d.elementLabel === 'Nine')).toBe(true);
    // the empty filler hides no control, group or sticky element: the cut is disclosed, not required
    expect(reasons(r).filter((x) => x.includes('walk-cut'))).toEqual([]);
    expect(r.coverage!.sampling.walkCut).toBeGreaterThan(0);
  }, 180_000);

  it('a finding element nested deeper than 16 levels is captured too', async () => {
    const HTML = sec(`<h3 data-fra-element="y" data-fra-findings="F8">Eight</h3>${deep(20, '<h2 data-fra-element="x" data-fra-findings="F7">Seven</h2>')}`);
    const b = await baselineOf(HTML, CSS);
    expect(sectionOf(b).elements.filter((e) => e.findingIds.length).map((e) => e.findingIds[0]).sort()).toEqual(['F7', 'F8']);
    const r = compare(b, await observe({ s: HTML }, `${CSS}h2{color:#f00}`, { hints: hintsFromBaseline(b) }));
    expect(r.verdict).toBe('fail');
    expect(r.differences.some((d) => d.classification === 'regression' && d.property === 'color' && d.elementLabel === 'Seven')).toBe(true);
  }, 120_000);

  it('a cut that hides a CONTROL is a REQUIRED gap (walk-cut), classed by-design; the same cut over decoration is only disclosed', async () => {
    const HTML = sec(`${filler}<div><a href="#late">Late link</a></div>`);
    const b = await baselineOf(HTML, CSS);
    expect(sectionOf(b).walkHidden?.controls ?? 0).toBeGreaterThan(0);
    const r = compare(b, await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b) }));
    expect(r.verdict).toBe('incomplete');
    expect(reasons(r)).toContain('REQ:walk-cut');
    expect(BY_DESIGN_GAP_REASONS.has('walk-cut')).toBe(true);
    expect(gapSplit(r)).toMatchObject({ byDesign: 1 });
  }, 180_000);
});

describe('round 2 · 2 — pseudo-element reveals', () => {
  const CSS = '.tile{display:block;position:relative;padding:40px;background:#eee;color:#000;text-decoration:none}.tile::after{content:"";position:absolute;inset:0;background:transparent}.tile:hover::after{background:rgb(176,31,36)}';
  const LOST = '.tile{display:block;position:relative;padding:40px;background:#eee;color:#000;text-decoration:none}.tile::after{content:"";position:absolute;inset:0;background:transparent}';
  const HTML = sec('<a class="tile" href="#a" data-fra-element="t" data-fra-findings="F1">Tile</a>');

  it('a ::after overlay revealed on hover that the preview lost is a hover regression on "<key>::after" (was: verdict pass)', async () => {
    const b = await baselineOf(HTML, CSS);
    const r = compare(b, await observe({ s: HTML }, LOST, { hints: hintsFromBaseline(b) }));
    expect(r.verdict).toBe('fail');
    expect(r.differences.some((d) => d.classification === 'regression' && d.category === 'hover' && d.property === 'background-color' && d.elementKey.endsWith('::after'))).toBe(true);
  }, 90_000);

  it('a ::before decoration that the preview lost in the DEFAULT state is a default regression', async () => {
    const css = '.k{display:block;color:#000}.k::before{content:"";display:block;height:3px;background:rgb(176,31,36)}';
    const H = sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Link</a>');
    const b = await baselineOf(H, css);
    const r = compare(b, await observe({ s: H }, '.k{display:block;color:#000}', { hints: hintsFromBaseline(b) }));
    expect(r.verdict).toBe('fail');
    expect(r.differences.some((d) => d.classification === 'regression' && d.category === 'default-style' && d.elementKey.endsWith('::before'))).toBe(true);
  }, 90_000);

  it('the unchanged page stays a clean pass', async () => {
    const b = await baselineOf(HTML, CSS);
    const r = compare(b, await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b) }));
    expect(r.verdict).toBe('pass');
  }, 90_000);

  it('a sibling reveal (:hover + .x) is still not captured, and every report says so', async () => {
    const css = '.tile{display:block;padding:20px;background:#eee;color:#000}.sib{display:block;padding:8px;background:transparent}.tile:hover + .sib{background:rgb(176,31,36)}';
    const H = sec('<a class="tile" href="#a" data-fra-element="t" data-fra-findings="F1">Tile</a><div class="sib">Sibling</div>');
    const b = await baselineOf(H, css);
    expect(b.statesNotCaptured.join(' ')).toMatch(/sibling|non-descendant/);
    const r = compare(b, await observe({ s: H }, '.tile{display:block;padding:20px;background:#eee;color:#000}.sib{display:block;padding:8px;background:transparent}', { hints: hintsFromBaseline(b) }));
    expect(r.statesNotCaptured.join(' ')).toMatch(/:hover \+ \.x/);
    expect(STATES_NOT_CAPTURED.join(' ')).toMatch(/:hover ~ \.x/);
  }, 90_000);
});

describe('round 2 · 3 — hover / focus sampling priority', () => {
  it('interactive controls are sampled before plain finding elements: 25 finding paragraphs + 5 links under the default cap hover all 5 links', async () => {
    const paras = Array.from({ length: 25 }, (_v, i) => `<p data-fra-element="p${i}" data-fra-findings="F${i}">Paragraph ${i}</p>`).join('');
    const links = Array.from({ length: 5 }, (_v, i) => `<a href="#l${i}">Link ${i}</a>`).join(' ');
    const b = await baselineOf(sec(`${paras}${links}`), 'a{color:#000}p{margin:2px 0}');
    const els = sectionOf(b).elements;
    const linkEls = els.filter((e) => e.tag === 'a');
    expect(linkEls).toHaveLength(5);
    expect(linkEls.map((e) => e.stateAttempt?.hover)).toEqual(['captured', 'captured', 'captured', 'captured', 'captured']);
    expect(sectionOf(b).coverage.hover.attempted).toBe(20);
    expect(els.filter((e) => e.tag === 'p' && e.stateAttempt?.hover === 'sample-cap')).toHaveLength(10);
  }, 240_000);
});

describe('round 2 · 4 — a wrapper inserted around text', () => {
  const CSS = '.k{color:#000;text-decoration:none}.k:hover{color:rgb(176,31,36)}';
  it('is a disclosed, NON-required gap: the verdict stays pass (was: incomplete)', async () => {
    const b = await baselineOf(sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Text</a>'), CSS);
    const o = await observe({ s: sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1"><span>Text</span></a>') }, CSS, { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(r.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(reasons(r)).toContain('disc:state-subtree-member-gained-in-output');
    expect(r.verdict).toBe('pass');
  }, 90_000);
});

describe('round 2 · 7 — real focusability and the hover retry', () => {
  it('div[contenteditable] takes keyboard focus; an <a> without href does not', async () => {
    const css = '.e{display:block;padding:8px}.e:focus-visible{outline:3px solid rgb(255,0,0)}';
    const b = await baselineOf(sec('<div class="e" contenteditable="true" data-fra-element="e" data-fra-findings="F1">Edit me</div><a class="e" data-fra-element="n" data-fra-findings="F2">No href</a>'), css);
    const els = sectionOf(b).elements;
    const ed = els.find((e) => e.findingIds.includes('F1'))!, nohref = els.find((e) => e.findingIds.includes('F2'))!;
    expect(ed.focusable).toBe(true);
    expect(ed.stateAttempt?.['focus-visible']).toBe('captured');
    expect(nohref.focusable).toBeUndefined();
    expect(nohref.stateAttempt?.['focus-visible']).toBeUndefined();
  }, 90_000);

  it('a finding element with pointer-events:none is genuinely not hoverable: recorded at once, by-design', async () => {
    const b = await baselineOf(sec('<h2 style="pointer-events:none" data-fra-element="h" data-fra-findings="F1">Inert</h2>'), 'h2{margin:0}');
    const t0 = Date.now();
    const h2 = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(h2.stateAttempt?.hover).toBe('not-hoverable');
    expect(Date.now() - t0).toBeLessThan(1500); // classified from the element, not by waiting out the click timeout
    const r = compare(b, await observe({ s: sec('<h2 style="pointer-events:none" data-fra-element="h" data-fra-findings="F1">Inert</h2>') }, 'h2{margin:0}', { hints: hintsFromBaseline(b) }));
    expect(reasons(r)).toContain('REQ:state-not-hoverable-on-original');
  }, 90_000);

  it('a hover that only fails for a moment is retried once and captured (was: a permanent "not hoverable")', async () => {
    // the element keeps moving for ~2.6 s, so the first 2 s click attempt cannot find it stable
    const html = sec('<a id="mv" class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Moving</a><script>const e=document.getElementById("mv");const t0=performance.now();(function f(){const dt=performance.now()-t0;if(dt<2600){e.style.marginLeft=(dt%40)+"px";requestAnimationFrame(f)}else e.style.marginLeft="0px"})()</script>');
    const b = await baselineOf(html, '.k{display:inline-block;color:#000}.k:hover{color:rgb(176,31,36)}');
    const a = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(a.stateAttempt?.hover).toBe('captured');
    expect(a.states.hover?.effect).toBe(true);
  }, 120_000);

  it('a hover that never works is "interrupted" (actionable: recapture the baseline), not "not hoverable" (by-design)', async () => {
    const html = sec('<a id="mv" class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Never still</a><script>const e=document.getElementById("mv");(function f(){e.style.marginLeft=(performance.now()%40)+"px";requestAnimationFrame(f)})()</script>');
    const b = await baselineOf(html, '.k{display:inline-block;color:#000}.k:hover{color:rgb(176,31,36)}');
    const a = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(a.stateAttempt?.hover).toBe('interrupted');
    const r = compare(b, await observe({ s: sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Never still</a>') }, '.k{display:inline-block;color:#000}', { hints: hintsFromBaseline(b) }));
    expect(reasons(r)).toContain('REQ:state-interrupted-on-original');
    expect(BY_DESIGN_GAP_REASONS.has('state-interrupted-on-original')).toBe(false);
  }, 180_000);
});

describe('round 2 · 2 (member) — a pseudo-element of a hovered CHILD', () => {
  const CSS = '.tile{display:block;padding:40px;color:#000;text-decoration:none}.ov{display:block;position:relative;height:6px}.ov::after{content:"";position:absolute;inset:0;background:transparent}.tile:hover .ov::after{background:rgb(176,31,36)}';
  const HTML = sec('<a class="tile" href="#a" data-fra-element="t" data-fra-findings="F1">Tile<span class="ov"></span></a>');

  it('a reveal that lives in a child\'s ::after and was dropped by the preview is a hover regression on "<child key>::after"', async () => {
    const b = await baselineOf(HTML, CSS);
    expect(Object.keys(sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!.states.hover!.subtree)).toContain('0::after');
    const r = compare(b, await observe({ s: HTML }, CSS.replace(/\.tile:hover[^}]*}/, ''), { hints: hintsFromBaseline(b) }));
    expect(r.verdict).toBe('fail');
    expect(r.differences.some((d) => d.classification === 'regression' && d.category === 'hover' && d.elementKey.endsWith('/0::after'))).toBe(true);
    expect(compare(b, await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b) })).verdict).toBe('pass');
  }, 120_000);
});

describe('round 2 · 6 — determinism of the hashed report across real captures', () => {
  it('previews laid out at 200.49px and 200.51px hash identically', async () => {
    const css = (w: string) => `.pill{display:inline-block;width:${w};padding:8px;background:#eee;color:#000}`;
    const HTML = sec('<a class="pill" href="#a" data-fra-element="p" data-fra-findings="F1">Pill</a>');
    const b = await baselineOf(HTML, css('200.2px'));
    const [r1, r2] = [compare(b, await observe({ s: HTML }, css('200.49px'), { hints: hintsFromBaseline(b) })), compare(b, await observe({ s: HTML }, css('200.51px'), { hints: hintsFromBaseline(b) }))];
    const hash = (r: FidelityReport) => { const { generatedAt: _g, ...rest } = r; return fingerprintOf(rest); };
    expect(r1.verdict).toBe('pass');
    expect(hash(r1)).toBe(hash(r2));
  }, 120_000);
});

describe('round 2 · 7 — a covered element is not hoverable; a clipped one is', () => {
  it('an overlay on top of a finding element (not its descendant) is recorded as not-hoverable at once', async () => {
    const html = sec('<div style="position:relative"><a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Under</a><div style="position:absolute;inset:0;background:rgba(255,255,255,.01)"></div></div>');
    const b = await baselineOf(html, '.k{display:block;padding:12px}');
    expect(sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!.stateAttempt?.hover).toBe('not-hoverable');
  }, 90_000);

  it('a control inside a horizontal scroller is scrolled into view and hovered (a point check before scrolling must not call it covered)', async () => {
    const html = sec('<div style="width:300px;overflow-x:auto;white-space:nowrap"><span style="display:inline-block;width:600px">pad</span><a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Far right</a></div>');
    const b = await baselineOf(html, '.k{display:inline-block;color:#000}.k:hover{color:rgb(176,31,36)}');
    const a = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(a.stateAttempt?.hover).toBe('captured');
    expect(a.states.hover?.effect).toBe(true);
  }, 90_000);
});

describe('round 2 · 2 (settling) — a transition on the pseudo-element itself is waited out', () => {
  it('the hovered ::after is recorded at its final colour, not mid-transition, and an unchanged preview passes', async () => {
    const css = '.tile{display:block;position:relative;padding:40px;background:#eee;color:#000}.tile::after{content:"";position:absolute;inset:0;background:transparent;transition:background-color .5s linear}.tile:hover::after{background:rgb(176,31,36)}';
    const HTML = sec('<a class="tile" href="#a" data-fra-element="t" data-fra-findings="F1">Tile</a>');
    const b = await baselineOf(HTML, css);
    const hov = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!.states.hover!;
    expect(hov.subtree['::after']!['background-color']).toBe('rgb(176, 31, 36)');
    expect(compare(b, await observe({ s: HTML }, css, { hints: hintsFromBaseline(b) })).verdict).toBe('pass');
  }, 120_000);
});
