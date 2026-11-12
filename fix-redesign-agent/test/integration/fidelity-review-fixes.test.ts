import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { captureDesign, hintsFromBaseline, htmlSha256Of, previewTargets, snapshotTargets, toBaseline, type CaptureHints } from '../../src/fidelity/capture.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import type { DesignBaseline, DesignCapture, FidelityReport, SectionDesign } from '../../src/fidelity/types.ts';
import { applyFidelityToTargets } from '../../src/fidelity/verify.ts';
import { openOfflineSnapshot } from '../../src/preview/extract.ts';
import { fingerprintOf } from '../../src/session/fingerprint.ts';
import { resolutionOf, target } from '../helpers/fidelity-captures.ts';

/**
 * The review fixes against a real browser: what the capture attempts (every finding element is hovered, every really focusable control is
 * focused), what a lost hover reveal on a child looks like, how running animations and sub-pixel layout stay out of the report, and what the
 * capture records when it has to cut a part short. Fully offline.
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
async function observe(htmlBySection: Record<string, string>, css: string, opts: { hints?: CaptureHints; shouldStop?: () => boolean; wait?: number } = {}): Promise<DesignCapture> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>p</title></head><body style="margin:0;font-family:Arial,sans-serif"><main id="m"></main>
<script>const css = ${JSON.stringify(BASE_CSS + css)};
for (const h of ${JSON.stringify(Object.entries(htmlBySection).map(([id, html]) => ({ id, html })))}) { const host = document.createElement('div'); host.setAttribute('data-pv-section', h.id); document.getElementById('m').appendChild(host);
  const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<style>' + css + '</style><div data-pv-mount>' + h.html + '</div>'; }</script></body></html>`;
    await page.setContent(doc, { waitUntil: 'domcontentloaded' });
    if (opts.wait) await page.waitForTimeout(opts.wait);
    return await captureDesign({ page, targets: previewTargets(Object.keys(htmlBySection)), viewports: DESKTOP, source: { kind: 'preview', htmlSha256: null, url: 'fixture-preview' }, ...(opts.hints ? { hints: opts.hints } : {}), ...(opts.shouldStop ? { shouldStop: opts.shouldStop } : {}) });
  } finally { await ctx.close(); }
}
const compare = (b: DesignBaseline, o: DesignCapture): FidelityReport => compareDesign({ baseline: b, observed: o, exemptions: [], now: () => new Date(0) });
const sectionOf = (c: DesignCapture, id = 's'): SectionDesign => c.sections.find((s) => s.sectionId === id && s.viewport === 'desktop')!;
const sec = (inner: string, id = 's') => `<section data-fra-section="${id}">${inner}</section>`;
const stable = (r: FidelityReport): string => { const { generatedAt: _g, ...rest } = r; return fingerprintOf(rest); };

describe('review 3 · 1 — a finding element that is not a link or a button is still hovered', () => {
  const CSS = '.card{background:#000;color:#fff;padding:24px}.card:hover{background:#fff;color:#000}';
  const HTML = sec('<div class="card" data-fra-element="c" data-fra-findings="F1">Card</div>');

  it('the capture hovers it and counts it as eligible', async () => {
    const b = await baselineOf(HTML, CSS);
    const card = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(card.stateAttempt?.hover).toBe('captured');
    expect(sectionOf(b).eligible?.hover).toBeGreaterThanOrEqual(1);
    expect(card.states.hover?.effect).toBe(true);
  }, 60_000);

  it('a preview that lost the black-to-white hover is a hover regression (was: verdict pass, no gap)', async () => {
    const b = await baselineOf(HTML, CSS);
    const o = await observe({ s: HTML }, '.card{background:#000;color:#fff;padding:24px}', { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(r.verdict).toBe('fail');
    expect(r.differences.filter((d) => d.classification === 'regression' && d.category === 'hover').map((d) => d.property)).toEqual(expect.arrayContaining(['background-color']));
  }, 90_000);
});

describe('review 3 · 2 — a hover reveal on a child that the preview lost', () => {
  const CSS = '.tile{display:block;position:relative;padding:40px;background:#eee;color:#000;text-decoration:none}.ov{position:absolute;inset:0}.tile:hover .ov{background:rgb(176,31,36)}';
  const HTML = sec('<a class="tile" href="#a" data-fra-element="t" data-fra-findings="F1">Tile<span class="ov"></span></a>');
  const LOST = '.tile{display:block;position:relative;padding:40px;background:#eee;color:#000;text-decoration:none}.ov{position:absolute;inset:0}';

  it('the preview captures the children the ORIGINAL listed, so the lost reveal is a hover regression on the child', async () => {
    const b = await baselineOf(HTML, CSS);
    const o = await observe({ s: HTML }, LOST, { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(r.verdict).toBe('fail');
    expect(r.differences.some((d) => d.classification === 'regression' && d.category === 'hover' && d.property === 'background-color' && d.elementKey.endsWith('/0'))).toBe(true);
  }, 90_000);

  it('without hints (a bare capture) it is never a pass either: the missing member is a required gap', async () => {
    const b = await baselineOf(HTML, CSS);
    const o = await observe({ s: HTML }, LOST);
    const r = compare(b, o);
    expect(r.verdict).not.toBe('pass');
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'state-subtree-member-missing-in-output': 1 });
  }, 90_000);

  it('the unchanged page stays a clean pass', async () => {
    const b = await baselineOf(HTML, CSS);
    const o = await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b) });
    expect(compare(b, o).verdict).toBe('pass');
  }, 90_000);

  it('a hover reveal GAINED on a child the original does not have is a REQUIRED gap (round 3: it was disclosed only, so an added hover effect passed)', async () => {
    const b = await baselineOf(HTML, LOST);
    const o = await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(r.coverage!.gaps.find((g) => g.reason === 'state-reveal-gained-in-output')).toMatchObject({ required: true });
    expect(r.coverage!.families.hover.reasons).toHaveProperty('state-reveal-gained-in-output');
  }, 90_000);
});

describe('review 3 · 3 — keyboard focus follows real focusability, not a tag list', () => {
  const CSS = '.b{display:inline-block;padding:8px;background:#eee;color:#000}.b:focus-visible{outline:3px solid rgb(255,0,0);outline-offset:2px}';
  const HTML = sec('<div class="b" role="button" tabindex="0" data-fra-element="b" data-fra-findings="F1">Go</div><div class="b" role="button">Not focusable</div>');

  it('div[role=button][tabindex=0] is focus-eligible and attempted; the same role without tabindex is not', async () => {
    const b = await baselineOf(HTML, CSS);
    const els = sectionOf(b).elements;
    const focusable = els.find((e) => e.findingIds.includes('F1'))!;
    expect(focusable.stateAttempt?.['focus-visible']).toBe('captured');
    expect(focusable.states['focus-visible']?.focusVisibleMatched).toBe(true);
    expect(sectionOf(b).eligible?.focusVisible).toBe(1);
    expect(els.filter((e) => e.stateAttempt?.['focus-visible']).length).toBe(1);
  }, 60_000);

  it('a preview that lost the :focus-visible ring is a focus regression (was: verdict pass)', async () => {
    const b = await baselineOf(HTML, CSS);
    const o = await observe({ s: HTML }, '.b{display:inline-block;padding:8px;background:#eee;color:#000}', { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(r.verdict).toBe('fail');
    expect(r.differences.some((d) => d.classification === 'regression' && d.category === 'focus-visible' && /outline/.test(d.property ?? ''))).toBe(true);
  }, 90_000);
});

describe('review 3 · 7 — running animations do not make an unchanged page regress or the report flap', () => {
  const CSS = '.mq{display:block;width:200px;animation:mv 4s linear infinite}.fin{display:block;animation:fade 1s ease-out 1 both}@keyframes mv{from{transform:translateX(0)}to{transform:translateX(120px)}}@keyframes fade{from{opacity:.2}to{opacity:1}}';
  const HTML = sec('<div class="mq">Marquee</div><p class="fin">Fades in</p>');

  it('freezes them identically on both sides: no transform regression, and two captures at different moments give the same report', async () => {
    const b = await baselineOf(HTML, CSS);
    const o1 = await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b) });
    const o2 = await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b), wait: 700 });
    const r1 = compare(b, o1), r2 = compare(b, o2);
    expect(r1.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(r1.verdict).toBe('pass');
    expect(stable(r1)).toBe(stable(r2));
  }, 120_000);

  it('discloses how many animated elements were frozen', async () => {
    const b = await baselineOf(HTML, CSS);
    expect(sectionOf(b).animationsFrozen).toBe(2);
    expect(compare(b, await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b) })).coverage!.sampling.animationsFrozen).toBe(2);
  }, 90_000);

  it('a hover that STARTS an endless animation is still reported unsettled (the freeze covers the animations running before the state, not the one the state starts)', async () => {
    const css = '.a{display:block;padding:8px}.a:hover span{animation:blink 120ms infinite alternate}@keyframes blink{from{color:#111}to{color:#eee}}';
    const b = await baselineOf(sec('<a class="a" href="#a" data-fra-element="a" data-fra-findings="F1"><span>Never settles</span></a>'), css);
    expect(sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!.stateAttempt?.hover).toBe('unsettled');
  }, 60_000);
});

describe('review 4 · 1 — what the capture cut is recorded, and a cut part is never preserved-verified', () => {
  it('a list with more members than the cap: partKeys.truncated says how many, and a descendants decision is unverified even though the output regressed past the cap', async () => {
    // (alternating tags keep the members from being detected as a card group, which would be sampled for hover and slow the test)
    const items = Array.from({ length: 100 }, (_v, i) => (i % 2 ? `<p>Item ${i}</p>` : `<div>Item ${i}</div>`)).join('');
    const HTML = sec(`<div data-fra-element="u" data-fra-findings="F1">${items}</div>`);
    const b = await baselineOf(HTML, 'p,div{color:#000}');
    const ul = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(ul.partKeys?.descendants.length).toBe(80);
    expect(ul.partKeys?.truncated?.descendants).toBe(20);
    const o = await observe({ s: HTML }, 'p,div{color:#000}[data-fra-element] > :nth-child(96){color:#f00}', { hints: hintsFromBaseline(b) });
    const report = compare(b, o);
    expect(report.verdict).toBe('fail'); // the regression is seen globally
    const resolution = resolutionOf(target({ part: 'descendants', property: 'color' }));
    applyFidelityToTargets(resolution, report, b, []);
    expect(resolution.targets[0]!.status.verification).toBe('unverified');
    expect(resolution.targets[0]!.status.verificationDetail).toMatch(/part capped/);
  }, 120_000);

  it('a subtree deeper than the walk limit is recorded (walkCut) on the section and on the finding element, and discloses itself', async () => {
    const deep = (n: number, inner: string): string => (n === 0 ? inner : `<div>${deep(n - 1, inner)}</div>`);
    const HTML = sec(`<div data-fra-element="d" data-fra-findings="F1">${deep(20, '<p>Deep text</p>')}</div>`);
    const b = await baselineOf(HTML, '');
    const s = sectionOf(b);
    expect(s.walkCut ?? 0).toBeGreaterThan(0);
    expect(s.elements.find((e) => e.findingIds.includes('F1'))!.partKeys?.truncated?.walk ?? 0).toBeGreaterThan(0);
    const report = compare(b, await observe({ s: HTML }, '', { hints: hintsFromBaseline(b) }));
    expect(report.coverage!.sampling.walkCut).toBeGreaterThan(0);
  }, 90_000);
});

describe('review 3 · 2 (cap) — a hovered subtree larger than maxDescendants says so, with the count', () => {
  const CSS = '.card{display:block;padding:8px;color:#000;text-decoration:none}.card span,.card em{display:block;font-style:normal}.card:hover{color:#b01f24}';
  const HTML = sec(`<a class="card" href="#a" data-fra-element="c" data-fra-findings="F1">${Array.from({ length: 30 }, (_v, i) => (i % 2 ? `<em>Line ${i}</em>` : `<span>Line ${i}</span>`)).join('')}</a>`);

  it('records how many qualifying descendants were beyond the cap, and the report discloses it (disclosed, not required)', async () => {
    const b = await baselineOf(HTML, CSS);
    const card = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(card.states.hover?.truncated).toBe(6);
    const r = compare(b, await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b) }));
    const g = r.coverage!.gaps.find((x) => x.reason === 'state-subtree-capped');
    expect(g).toMatchObject({ required: false });
    expect(g!.detail).toMatch(/6 more/);
    expect(r.coverage!.sampling.hoverSubtreeDropped).toBe(6);
    expect(r.verdict).toBe('pass');
  }, 90_000);
});

describe('review 4 · 1 (node limit) — a section bigger than the walk limit records that it was cut', () => {
  it('walkCut > 0 on the section when more than 4000 nodes are reached', async () => {
    const HTML = sec(Array.from({ length: 3000 }, () => '<div><b>t</b></div>').join(''));
    const b = await baselineOf(HTML, '');
    expect(sectionOf(b).walkCut ?? 0).toBeGreaterThan(0);
  }, 120_000);
});

describe('review 4 · 8 — the hashed report does not carry sub-pixel jitter', () => {
  it('two captures whose boxes differ by a fraction of a pixel produce the same coverage.elements and the same report hash', async () => {
    const html = (w: string) => `.pill{display:inline-block;width:${w};padding:8px;background:#eee;color:#000}`;
    const HTML = sec('<a class="pill" href="#a" data-fra-element="p" data-fra-findings="F1">Pill</a>');
    const b = await baselineOf(HTML, html('200.3px'));
    const o1 = await observe({ s: HTML }, html('200.2px'), { hints: hintsFromBaseline(b) });
    const o2 = await observe({ s: HTML }, html('200.4px'), { hints: hintsFromBaseline(b) });
    const [r1, r2] = [compare(b, o1), compare(b, o2)];
    expect(r1.verdict).toBe('pass');
    // the observed box is not stored at all (only the verdict per axis beside the whole-pixel baseline box): nothing raw of this side reaches the hash
    for (const e of [...r1.coverage!.elements, ...r2.coverage!.elements]) { const bx = e.box?.baseline; if (bx) { expect(Number.isInteger(bx.w)).toBe(true); expect(Number.isInteger(bx.h)).toBe(true); } expect(e.box).not.toHaveProperty('observed'); }
    expect(JSON.stringify(r1.coverage!.elements)).toBe(JSON.stringify(r2.coverage!.elements));
    expect(stable(r1)).toBe(stable(r2));
  }, 120_000);
});

describe('review 3 (missing test) — a verification budget that runs out in the middle of a section', () => {
  it('the output side surfaces the budget as the reason, not a generic "uncaptured"', async () => {
    const CSS = '.btn{display:block;padding:8px;color:#000;text-decoration:none}.btn:hover{color:#b01f24}';
    const HTML = sec('<a class="btn" href="#a">First</a><a class="btn" href="#b">Second</a><a class="btn" href="#c" data-fra-element="c" data-fra-findings="F1">Third</a>');
    const b = await baselineOf(HTML, CSS);
    let calls = 0;
    const o = await observe({ s: HTML }, CSS, { hints: hintsFromBaseline(b), shouldStop: () => ++calls > 2 }); // the section starts, then the first hover, then the budget is gone
    const r = compare(b, o);
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'state-budget-stopped': 2 });
  }, 90_000);
});
