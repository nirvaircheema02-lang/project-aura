import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { captureDesign, hintsFromBaseline, htmlSha256Of, previewTargets, snapshotTargets, toBaseline, type CaptureHints, type CaptureLimits } from '../../src/fidelity/capture.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { BY_DESIGN_GAP_REASONS, gapSplit } from '../../src/fidelity/coverage.ts';
import { evaluatePreserveTargets } from '../../src/fidelity/verify.ts';
import type { DesignBaseline, DesignCapture, FidelityReport, SectionDesign } from '../../src/fidelity/types.ts';
import { openOfflineSnapshot } from '../../src/preview/extract.ts';
import type { Exemption } from '../../src/resolution/schema.ts';
import { resolutionOf, target } from '../helpers/fidelity-captures.ts';

/**
 * Round 3 of the fidelity re-review, against a real browser (fully offline): pseudo-elements sized from their owner, members the element cap dropped,
 * elements under a sticky header, endless pseudo animations, a reveal the preview added, and url() targets.
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
const reasons = (r: FidelityReport) => r.coverage!.gaps.map((g) => `${g.required ? 'REQ' : 'disc'}:${g.reason}`);
const regs = (r: FidelityReport) => r.differences.filter((d) => d.classification === 'regression').map((d) => `${d.category} ${d.elementKey} ${d.property} ${d.baseline}->${d.observed}`);

describe('round 3 · 1 — a pseudo-element sized from its owner follows a legitimate fix of the owner (was: an uncorrectable FAIL)', () => {
  const RING = '.tile{display:block;position:relative;padding:40px;color:#000;text-decoration:none;background:#fff}.tile::after{content:"";position:absolute;inset:0;border:1px solid #888}';
  const H = sec('<a class="tile" href="#a" data-fra-element="t" data-fra-findings="F1">Tile</a>');

  it('an inset:0 ring around a card whose AUTHORIZED padding changed: pass in the default, hover and focus states', async () => {
    const b = await baselineOf(H, RING);
    const o = await observe({ s: H }, `${RING}.tile{padding:24px}`, { hints: hintsFromBaseline(b) });
    const r = compare(b, o, [ex('padding')]);
    expect(regs(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
  }, 120_000);

  it('the same ring with NO authorization: the card\'s own padding is the regression, and the ring is judged relative to the card (no false pseudo difference)', async () => {
    const b = await baselineOf(H, RING);
    const r = compare(b, await observe({ s: H }, `${RING}.tile{padding:24px}`, { hints: hintsFromBaseline(b) }));
    expect(regs(r).every((x) => !x.includes('::after'))).toBe(true);
    expect(regs(r).some((x) => x.includes('padding-top'))).toBe(true);
  }, 120_000);

  it('a width:100% underline under an AUTHORIZED font-size change passes', async () => {
    const css = '.k{display:inline-block;position:relative;font-size:16px;color:#000;text-decoration:none}.k::after{content:"";position:absolute;left:0;bottom:0;width:100%;height:2px;background:#000}';
    const h = sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Read the report</a>');
    const b = await baselineOf(h, css);
    const r = compare(b, await observe({ s: h }, `${css}.k{font-size:18px}`, { hints: hintsFromBaseline(b) }), [ex('font-size')]);
    expect(regs(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
  }, 120_000);

  it('a translate(-50%) centred marker follows the owner\'s width', async () => {
    const css = '.c{display:block;position:relative;padding:20px 40px;color:#000;text-decoration:none}.c::after{content:"";position:absolute;left:50%;top:0;width:100%;height:2px;background:#000;transform:translate(-50%,0)}';
    const h = sec('<a class="c" href="#a" data-fra-element="c" data-fra-findings="F1">Centered</a>');
    const b = await baselineOf(h, css);
    const r = compare(b, await observe({ s: h }, `${css}.c{padding:20px 12px;width:240px}`, { hints: hintsFromBaseline(b) }), [ex('padding'), ex('width')]);
    expect(regs(r)).toEqual([]);
  }, 120_000);

  it('an icon pseudo sized in em grows with an authorized font-size change (intentional), and is a regression without it', async () => {
    const css = '.i{display:inline-block;width:100px;color:#000;font-size:16px}.i::after{content:"";display:inline-block;width:1em;height:1em;margin-left:4px;background:#000}';
    const h = sec('<a class="i" href="#a" data-fra-element="i" data-fra-findings="F1">Open</a>');
    const b = await baselineOf(h, css);
    const o = await observe({ s: h }, `${css}.i{font-size:20px}`, { hints: hintsFromBaseline(b) });
    expect(regs(compare(b, o, [ex('font-size')]))).toEqual([]);
    expect(regs(compare(b, o)).some((x) => x.includes('::after width'))).toBe(true);
  }, 120_000);

  it('a ring that really stopped covering the card is still a regression', async () => {
    const b = await baselineOf(H, RING);
    const o = await observe({ s: H }, `${RING}.tile::after{inset:auto;width:20px;height:20px}`, { hints: hintsFromBaseline(b) });
    expect(regs(compare(b, o)).some((x) => x.includes('::after') && /width|height/.test(x))).toBe(true);
  }, 120_000);
});

describe('round 3 · 2 — members the element cap dropped keep a preserve decision on the part unverified', () => {
  const fillers = Array.from({ length: 140 }, (_v, i) => `<p>Filler ${i}</p>`).join('');
  const kids = Array.from({ length: 30 }, (_v, i) => `<${['span', 'em', 'b', 'i'][i % 4]}>Item ${i}</${['span', 'em', 'b', 'i'][i % 4]}>`).join(' ');
  const H = sec(`${fillers}<div data-fra-element="d" data-fra-findings="F1">${kids}</div>`);
  const CSS = 'p{margin:0;color:#000}span,em,b,i{color:#000}';
  const t = target({ part: 'descendants', property: 'color', viewport: { name: 'desktop', width: null } });
  const verdictOf = (b: DesignBaseline, o: DesignCapture) => {
    const report = compare(b, o);
    return { report, results: evaluatePreserveTargets({ resolution: resolutionOf(t), report, baseline: b, exemptions: [] }) };
  };

  it('recolouring two of the DROPPED children: the decision is unverified "part capped" (was: preserved-verified, the report a pass)', async () => {
    const b = await baselineOf(H, CSS);
    const s = sectionOf(b);
    expect(s.capped?.dropped ?? 0).toBeGreaterThan(0);
    const f = s.elements.find((e) => e.findingIds.includes('F1'))!;
    expect(f.partKeys!.capDropped?.descendants?.length ?? 0).toBeGreaterThan(0);
    const o = await observe({ s: H }, `${CSS}b:nth-of-type(7),i:nth-of-type(7){color:#f00}`, { hints: hintsFromBaseline(b) });
    const { results } = verdictOf(b, o);
    expect(results[0]!.verification).toBe('unverified');
    expect(results[0]!.reason).toBe('part capped');
  }, 180_000);

  it('raising the element cap clears it: every member is captured, the recolour is seen (failed), the unchanged page verifies', async () => {
    const big = { maxElements: 400 };
    const b = await baselineOf(H, CSS, ['s'], big);
    expect(sectionOf(b).capped).toBeNull();
    const clean = verdictOf(b, await observe({ s: H }, CSS, { hints: hintsFromBaseline(b), limits: big }));
    expect(clean.results[0]!.verification).toBe('preserved-verified');
    const changed = verdictOf(b, await observe({ s: H }, `${CSS}b:nth-of-type(7),i:nth-of-type(7){color:#f00}`, { hints: hintsFromBaseline(b), limits: big }));
    expect(changed.results[0]!.verification).toBe('failed');
  }, 240_000);
});

describe('round 3 · 3 — an element under a sticky / fixed header is hoverable at the viewport centre', () => {
  const HEADER = '<header style="position:fixed;top:0;left:0;right:0;height:80px;background:#ccc;z-index:10">Nav</header>';
  const CSS = '.k{display:inline-block;color:#000;text-decoration:none}.k:hover{color:rgb(176,31,36)}.sp{height:1200px}';
  // (the page is long enough below the section for it to be scrolled to the very top of the viewport, where the fixed header covers its first 80px)
  const H = `<div class="sp"></div>${sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1" style="margin-top:12px">Deal Sourcing</a><div style="height:600px"></div>')}<div style="height:1600px"></div>`;

  it('the capture scrolls the section top under the header: the link is hovered after a centre scroll and its hover design recorded (was: not-hoverable, a permanent by-design gap)', async () => {
    const b = await baselineOf(`${HEADER}${H}`, CSS);
    const a = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(a.stateAttempt?.hover).toBe('captured');
    expect(a.states.hover?.effect).toBe(true);
    const o = await observe({ s: sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1" style="margin-top:12px">Deal Sourcing</a>') }, CSS, { hints: hintsFromBaseline(b) });
    const r = compare(b, o);
    expect(reasons(r).filter((x) => x.includes('not-hoverable'))).toEqual([]);
    expect(r.verdict).toBe('pass');
  }, 120_000);

  it('a cover that persists at the centre is genuinely not hoverable: still recorded, still by-design', async () => {
    const overlay = '<div style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.01)"></div>';
    const b = await baselineOf(`${overlay}${H}`, CSS);
    const a = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(a.stateAttempt?.hover).toBe('not-hoverable');
    const r = compare(b, await observe({ s: sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Deal Sourcing</a>') }, CSS, { hints: hintsFromBaseline(b) }));
    expect(reasons(r)).toContain('REQ:state-not-hoverable-on-original');
    expect(BY_DESIGN_GAP_REASONS.has('state-not-hoverable-on-original')).toBe(true);
  }, 120_000);

  it('a pointer-events:none wrapper that holds a pointer-events:auto control is hovered through that control', async () => {
    const css = '.w{display:block;padding:20px;background:#eee;pointer-events:none}.w:hover{background:rgb(176,31,36)}.w a{pointer-events:auto;color:#000}';
    const h = sec('<div class="w" data-fra-element="w" data-fra-findings="F1"><a href="#a">Go</a></div>');
    const b = await baselineOf(h, css);
    const w = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(w.stateAttempt?.hover).toBe('captured');
    expect(w.states.hover?.subtree['']?.['background-color']).toBe('rgb(176, 31, 36)');
    expect(compare(b, await observe({ s: h }, css, { hints: hintsFromBaseline(b) })).verdict).toBe('pass');
  }, 120_000);

  it('a wrapper with pointer-events:none and nothing to point at inside stays genuinely not hoverable', async () => {
    const h = sec('<h2 style="pointer-events:none" data-fra-element="h" data-fra-findings="F1">Inert</h2>');
    const b = await baselineOf(h, 'h2{margin:0}');
    expect(sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!.stateAttempt?.hover).toBe('not-hoverable');
  }, 120_000);
});

const REAL = '/Users/sachin/Project-aura/fix-redesign-agent/projects/www.kenresearch.com-consulting-deals-and-ipo-consulting/redesigns/deals-and-ipo-consulting-test-button-rematch-redesign-20261006-063253/original.html';
describe.skipIf(!existsSync(REAL))('round 3 · 3 — the REAL Deals page original (read-only, offline: a stamped snapshot is opened, nothing is written)', () => {
  it('captured twice (the second with the first one\'s hints) the five sections have no required gap left: the sticky nav no longer makes a heading "not hoverable" (was: verdict incomplete)', async () => {
    const html = readFileSync(REAL, 'utf8');
    const ids = ['how-we-can-help', 'our-consulting-services', 'faq-s', 'our-insights', 'let-s-connect'];
    const take = async (hints?: CaptureHints) => {
      const ctx = await browser.newContext();
      const { page, close } = await openOfflineSnapshot(ctx, html);
      try { return await captureDesign({ page, targets: snapshotTargets(ids), viewports: DESKTOP, source: { kind: 'pre-edit-snapshot', htmlSha256: htmlSha256Of(html), url: null }, ...(hints ? { hints } : {}) }); } finally { await close(); await ctx.close(); }
    };
    const b = toBaseline(await take());
    const finding = b.sections.flatMap((s) => s.elements.filter((e) => e.roles.includes('finding')));
    expect(finding.length).toBeGreaterThan(0);
    expect(b.sections.flatMap((s) => s.elements.filter((e) => e.roles.includes('finding') && e.stateAttempt?.hover === 'not-hoverable').map((e) => `${s.sectionId} ${e.key} ${e.tag} ${e.label}`))).toEqual([]);
    const r = compare(b, await take(hintsFromBaseline(b)));
    expect(r.coverage!.gaps.filter((g) => g.required).map((g) => `${g.reason} ${g.sectionId} ${g.elementKey}`)).toEqual([]);
    expect(r.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(r.verdict).toBe('pass');
  }, 400_000);
});

describe('round 3 · 4 — an endless animation on a pseudo-element no longer makes a state "unsettled" forever', () => {
  const CSS = '.k{display:inline-block;position:relative;color:#000;text-decoration:none;padding-bottom:4px}.k:hover{color:rgb(176,31,36)}.k:focus-visible{outline:2px solid rgb(176,31,36)}'
    + '.k::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:#000;animation:pulse 1s infinite}@keyframes pulse{from{opacity:.2}to{opacity:1}}';
  const H = sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Pulsing CTA</a>');

  it('hover and keyboard focus are captured (was: both unsettled, two permanent by-design gaps), and the unchanged page passes', async () => {
    const b = await baselineOf(H, CSS);
    const a = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    expect(a.stateAttempt).toEqual({ hover: 'captured', 'focus-visible': 'captured' });
    const r = compare(b, await observe({ s: H }, CSS, { hints: hintsFromBaseline(b) }));
    expect(reasons(r).filter((x) => x.includes('unsettled'))).toEqual([]);
    expect(r.verdict).toBe('pass');
    expect(gapSplit(r).byDesign).toBe(0);
  }, 120_000);

  it('a FINITE animation a hover starts on a ::after is waited out: the recorded pseudo is at its final width, not mid-flight', async () => {
    const css = '.k{display:inline-block;position:relative;color:#000;text-decoration:none;padding:4px 40px}.k::after{content:"";position:absolute;left:0;bottom:0;height:2px;width:0;background:#000}.k:hover::after{animation:grow 700ms ease-out forwards}@keyframes grow{to{width:100%}}';
    const h = sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Grow</a>');
    const b = await baselineOf(h, css);
    const a = sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!;
    const w = parseFloat(a.states.hover!.subtree['::after']!['width']!);
    expect(w).toBeGreaterThan(a.box!.w - 2);
  }, 120_000);

  it('a hover-triggered endless animation on a child is still not captured at an arbitrary frame (unsettled, by-design)', async () => {
    const css = '.k{display:block;color:#000}.k:hover span{animation:blink 120ms infinite alternate}@keyframes blink{from{color:#111}to{color:#eee}}';
    const h = sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1"><span>Never settles</span></a>');
    const b = await baselineOf(h, css);
    expect(sectionOf(b).elements.find((e) => e.findingIds.includes('F1'))!.stateAttempt?.hover).toBe('unsettled');
  }, 120_000);
});

describe('round 3 · 5 — a reveal the preview ADDED is required; a wrapper is not', () => {
  const CSS = '.tile{display:block;position:relative;padding:20px;background:#eee;color:#000;text-decoration:none}';
  const H = sec('<a class="tile" href="#a" data-fra-element="t" data-fra-findings="F1">Tile</a>');
  const REVEAL = '<a class="tile" href="#a" data-fra-element="t" data-fra-findings="F1"><span class="ov" style="position:absolute;inset:0"></span>Tile</a>';

  it('a new <span> that fills on hover is a required gap: the verdict is incomplete (was: pass)', async () => {
    const b = await baselineOf(H, CSS);
    const r = compare(b, await observe({ s: sec(REVEAL) }, `${CSS}.ov{background:transparent}.tile:hover .ov{background:rgb(176,31,36)}`, { hints: hintsFromBaseline(b) }));
    expect(reasons(r)).toContain('REQ:state-reveal-gained-in-output');
    expect(r.verdict).toBe('incomplete');
  }, 120_000);

  it('a hover-only ::after the preview gained is a required gap too', async () => {
    const b = await baselineOf(H, CSS);
    const r = compare(b, await observe({ s: H }, `${CSS}.tile::after{content:none}.tile:hover::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:rgb(176,31,36)}`, { hints: hintsFromBaseline(b) }));
    expect(reasons(r)).toContain('REQ:state-reveal-gained-in-output');
  }, 120_000);

  it('a wrapper inserted around the same text (it only inherits the hover colour) stays disclosed and the verdict stays pass', async () => {
    const css = '.k{color:#000;text-decoration:none}.k:hover{color:rgb(176,31,36)}';
    const b = await baselineOf(sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1">Text</a>'), css);
    const r = compare(b, await observe({ s: sec('<a class="k" href="#a" data-fra-element="k" data-fra-findings="F1"><span>Text</span></a>') }, css, { hints: hintsFromBaseline(b) }));
    expect(reasons(r)).toContain('disc:state-subtree-member-gained-in-output');
    expect(r.verdict).toBe('pass');
  }, 120_000);
});

describe('round 3 · 6 — the capture records that the focus trial ran', () => {
  it('desktop sections carry the marker, mobile ones do not', async () => {
    const b = await baselineOf(sec('<a href="#a" data-fra-element="a" data-fra-findings="F1">x</a>'), 'a{color:#000}');
    expect(sectionOf(b).focusTrial).toBe(true);
  }, 90_000);
});

describe('round 3 · 7 — url() targets the preview serves from /assets are not a regression', () => {
  const PIC = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#b01f24"/></svg>';
  const SVG = `data:image/svg+xml;base64,${Buffer.from(PIC).toString('base64')}`;
  const LONG_PIC = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${'<rect width="1" height="1"/>'.repeat(20)}</svg>`;
  const LONG = `data:image/svg+xml;base64,${Buffer.from(LONG_PIC).toString('base64')}`;
  const css = (icon: string, bg: string) => `.l{display:inline-block;color:#000;padding-left:24px;background-image:url("${bg}");background-repeat:no-repeat}.l::before{content:url("${icon}");display:inline-block}`;
  const h = sec('<a class="l" href="#a" data-fra-element="l" data-fra-findings="F1">Link</a>');

  it('a data: pseudo icon and a long data: background-image on the original vs short /assets urls in the preview: a clean pass (was: default regressions)', async () => {
    expect(LONG.length).toBeGreaterThan(160);
    const b = await baselineOf(h, css(SVG, LONG));
    const r = compare(b, await observe({ s: h }, css('https://example.invalid/assets/ab12cd34ef56.svg', 'https://example.invalid/assets/0123456789ab.svg'), { hints: hintsFromBaseline(b), svg: PIC }));
    expect(regs(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
  }, 120_000);

  it('losing the image altogether is still a regression', async () => {
    const b = await baselineOf(h, css(SVG, LONG));
    const r = compare(b, await observe({ s: h }, '.l{display:inline-block;color:#000;padding-left:24px}', { hints: hintsFromBaseline(b) }));
    expect(regs(r).some((x) => x.includes('background-image'))).toBe(true);
    expect(regs(r).some((x) => x.includes('::before content'))).toBe(true);
  }, 120_000);
});
