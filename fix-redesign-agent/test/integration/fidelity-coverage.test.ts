import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureDesign, htmlSha256Of, previewTargets, snapshotTargets, toBaseline, type CaptureHints } from '../../src/fidelity/capture.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import type { DesignBaseline, DesignCapture } from '../../src/fidelity/types.ts';
import { openOfflineSnapshot } from '../../src/preview/extract.ts';

/**
 * The coverage model against a real browser: how the capture records what it attempted (so "not captured" is never silent), how sticky
 * pin/release becomes REACHABLE on a selected-sections preview (the document is padded identically on both sides during the trace),
 * and how the baseline's keys steer the preview's sampling. Fully offline.
 */

const CSS = `
body{margin:0;font-family:Arial,sans-serif}
.pair .row{display:flex;gap:16px;padding:24px}
.tile{display:block;padding:20px;background:#eee;color:#000;text-decoration:none}
.tools{padding:24px}
.btn{display:block;padding:8px;color:#000;text-decoration:none;transition:color .1s}
.btn:hover{color:#b01f24}
.nz:hover span{animation:blink 120ms infinite alternate}
@keyframes blink{from{color:#111}to{color:#eee}}
.help{display:grid;grid-template-columns:1fr 2fr;gap:24px;padding:24px;min-height:1800px}
.help aside{position:sticky;top:24px;align-self:start}
`;
const SECTIONS_HTML = {
  pair: `<section data-fra-section="pair" class="pair"><div class="row"><a class="tile" href="#1" data-fra-element="t1" data-fra-findings="F1">One</a><a class="tile" href="#2">Two</a></div></section>`,
  tools: `<section data-fra-section="tools" class="tools"><a class="btn" href="#a">First</a><a class="btn" href="#b">Second</a><a class="btn nz" href="#c" data-fra-element="c1" data-fra-findings="F2"><span>Never settles</span></a></section>`,
  help: `<section data-fra-section="help" class="help"><aside><h3>Need help?</h3><p>Talk to us</p></aside><div><p>Long body copy that makes the section tall enough for the aside to pin while it scrolls.</p></div></section>`,
};
const ALL = ['pair', 'tools', 'help'] as const;
const ORIGINAL = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title><style>${CSS}</style></head><body>${ALL.map((id) => SECTIONS_HTML[id]).join('')}</body></html>`;
const DESKTOP = [{ name: 'desktop' as const, width: 1440, height: 900 }];

let browser: Browser;
let baseline: DesignBaseline;
beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  try {
    const { page, close } = await openOfflineSnapshot(ctx, ORIGINAL);
    baseline = toBaseline(await captureDesign({ page, targets: snapshotTargets([...ALL]), source: { kind: 'pre-edit-snapshot', htmlSha256: htmlSha256Of(ORIGINAL), url: null } }));
    await close();
  } finally { await ctx.close(); }
}, 180_000);
afterAll(async () => { await browser?.close(); });

/** The running preview, simulated: each section in an open shadow root, exactly like the generated app. */
const previewPage = (htmlBySection: Record<string, string>, css = CSS): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>preview</title></head><body style="margin:0;font-family:Arial,sans-serif"><main id="m"></main>
<script>const css = ${JSON.stringify(css)};
for (const h of ${JSON.stringify(Object.entries(htmlBySection).map(([id, html]) => ({ id, html })))}) { const host = document.createElement('div'); host.setAttribute('data-pv-section', h.id); document.getElementById('m').appendChild(host);
  const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<style>' + css + '</style><div data-pv-mount>' + h.html + '</div>'; }</script></body></html>`;

async function observe(htmlBySection: Record<string, string>, opts: { css?: string; hints?: CaptureHints; shouldStop?: () => boolean; limits?: Partial<{ maxHoverTargets: number; maxFocusTargets: number }>; after?: (page: Page) => Promise<void> } = {}): Promise<DesignCapture> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.setContent(previewPage(htmlBySection, opts.css), { waitUntil: 'domcontentloaded' });
    const c = await captureDesign({ page, targets: previewTargets(Object.keys(htmlBySection)), source: { kind: 'preview', htmlSha256: null, url: 'fixture-preview' }, ...(opts.hints ? { hints: opts.hints } : {}), ...(opts.shouldStop ? { shouldStop: opts.shouldStop } : {}), ...(opts.limits ? { limits: opts.limits } : {}) });
    await opts.after?.(page);
    return c;
  } finally { await ctx.close(); }
}
const only = (b: DesignBaseline, ...ids: string[]): DesignBaseline => ({ ...b, sections: b.sections.filter((s) => ids.includes(s.sectionId)) });
const sectionOf = (c: DesignCapture, id: string, viewport = 'desktop') => c.sections.find((s) => s.sectionId === id && s.viewport === viewport)!;

describe('the capture records what it attempted, never silently', () => {
  it('an element whose hover never settles carries stateAttempt "unsettled" and the section exposes eligible / attempted / captured', () => {
    const tools = sectionOf(baseline, 'tools');
    const nz = tools.elements.find((e) => e.findingIds.includes('F2'))!;
    expect(nz.stateAttempt?.hover).toBe('unsettled');
    expect(nz.states.hover).toBeUndefined();
    expect(tools.elements.filter((e) => e.stateAttempt?.hover === 'captured').length).toBe(2);
    expect(tools.eligible?.hover).toBe(3);
    expect(tools.coverage.hover.attempted).toBeGreaterThan(tools.coverage.hover.captured);
  }, 60_000);

  it('beyond the hover cap an element is "sample-cap" — and a finding element is sampled BEFORE ordinary ones, whatever the document order', async () => {
    const ctx = await browser.newContext();
    try {
      const { page, close } = await openOfflineSnapshot(ctx, ORIGINAL);
      const c = await captureDesign({ page, targets: snapshotTargets(['tools']), viewports: DESKTOP, limits: { maxHoverTargets: 1 }, source: { kind: 'pre-edit-snapshot', htmlSha256: null, url: null } });
      await close();
      const els = sectionOf(c, 'tools').elements;
      expect(els.find((e) => e.findingIds.includes('F2'))!.stateAttempt?.hover).toBe('unsettled'); // the finding element was the one sampled
      expect(els.filter((e) => e.stateAttempt?.hover === 'sample-cap').length).toBe(2);
    } finally { await ctx.close(); }
  }, 60_000);

  it('a capture stopped by the verification budget marks its sections stopped:"budget" (not an absent section)', async () => {
    const c = await observe({ pair: SECTIONS_HTML.pair }, { shouldStop: () => true });
    expect(c.sections.every((s) => !s.located && s.stopped === 'budget')).toBe(true);
    const report = compareDesign({ baseline: only(baseline, 'pair', 'tools'), observed: { ...c, sections: [...c.sections, ...(await observe({ tools: SECTIONS_HTML.tools })).sections] }, exemptions: [] });
    expect(report.differences.filter((d) => d.classification === 'regression' && /not rendered/.test(d.detail))).toEqual([]);
    expect(report.coverage?.families.section.reasons).toMatchObject({ 'section-not-captured-budget': 2 }); // desktop and mobile
  }, 120_000);
});

describe('the baseline\'s keys steer the preview\'s sampling', () => {
  it('with hover hints the preview attempts exactly the elements the original captured (not its own first N)', async () => {
    const tools = sectionOf(baseline, 'tools');
    const captured = tools.elements.filter((e) => e.states.hover).map((e) => e.key);
    const c = await observe({ tools: SECTIONS_HTML.tools }, { hints: { hover: { 'tools|desktop': captured }, focus: { 'tools|desktop': [] } } });
    expect(sectionOf(c, 'tools').coverage.hover.attempted).toBe(captured.length);
    expect(sectionOf(c, 'tools').elements.filter((e) => e.states.hover).map((e) => e.key)).toEqual(captured);
  }, 60_000);

  it('a group the original detected stays detectable when a child gains a class (without the hint it vanishes: unverified; with it, it is measured)', async () => {
    const featured = SECTIONS_HTML.pair.replace('class="tile" href="#2"', 'class="tile featured" href="#2"');
    const plain = await observe({ pair: featured });
    const r0 = compareDesign({ baseline: only(baseline, 'pair'), observed: plain, exemptions: [] });
    expect(r0.verdict).toBe('incomplete');
    expect(r0.coverage?.families.composition.reasons).toMatchObject({ 'group-not-detected-in-output': 2 }); // desktop and mobile
    const groups = Object.fromEntries(baseline.sections.filter((s) => s.groups.length).map((s) => [`${s.sectionId}|${s.viewport}`, s.groups.map((g) => g.parentKey)]));
    const hinted = await observe({ pair: featured }, { hints: { groups } });
    const r1 = compareDesign({ baseline: only(baseline, 'pair'), observed: hinted, exemptions: [] });
    expect(r1.coverage?.families.composition).toMatchObject({ required: 2, verified: 2, unverified: 0 });
    expect(r1.verdict).toBe('pass');
  }, 120_000);
});

describe('sticky pin/release on a selected-sections preview', () => {
  const helpOnly = { help: SECTIONS_HTML.help };

  it('is traced under identical document padding on both sides: every position is reachable, the padding is restored, and an unchanged preview is a verified PASS', async () => {
    let paddingAfter = 'untouched';
    const c = await observe(helpOnly, { after: async (p) => { paddingAfter = await p.evaluate(() => document.documentElement.style.paddingTop); } });
    const traces = [...baseline.sections.filter((s) => s.sectionId === 'help'), ...c.sections].flatMap((s) => s.sticky);
    expect(traces.length).toBe(4); // original and preview, desktop and mobile
    for (const t of traces) {
      expect(t.positions.map((p) => (p.reachable ? 'Y' : 'n')).join('')).toBe('YYYYY');
      expect(t.padded).toBe(true);
    }
    expect(paddingAfter).toBe('');
    const report = compareDesign({ baseline: only(baseline, 'help'), observed: c, exemptions: [] });
    expect(report.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(report.coverage?.families.sticky).toMatchObject({ required: 2, verified: 2, unverified: 0 });
    expect(report.verdict).toBe('pass');
  }, 120_000);

  it('a lost pin on the selected-only preview is caught (at positions the unpadded trace could not reach)', async () => {
    const c = await observe(helpOnly, { css: CSS.replace('position:sticky', 'position:static') });
    const report = compareDesign({ baseline: only(baseline, 'help'), observed: c, exemptions: [] });
    expect(report.verdict).toBe('fail');
    expect(report.differences.some((d) => d.category === 'sticky' && d.classification === 'regression')).toBe(true);
  }, 120_000);

  it('a pin whose range is cut short (the container loses its height) is a sticky regression', async () => {
    const c = await observe(helpOnly, { css: CSS.replace('min-height:1800px', 'min-height:700px') });
    const report = compareDesign({ baseline: only(baseline, 'help'), observed: c, exemptions: [] });
    expect(report.verdict).toBe('fail');
    expect(report.differences.some((d) => d.category === 'sticky' && d.classification === 'regression')).toBe(true);
  }, 120_000);
});
