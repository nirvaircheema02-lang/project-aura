import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { extractSections } from '../../src/preview/extract.ts';
import { planIslands } from '../../src/preview/plan.ts';
import { islandWrapperStyle } from '../../src/preview/jsx.ts';
import { applyEyebrowRule, indicatorCss } from '../../src/preview/structural.ts';
import type { ExtractionResult, PreviewNode } from '../../src/preview/types.ts';

/**
 * Structural DS rules (docs/REDESIGN_RULES.md "Structural DS rules") against a real browser: an arrow link and an eyebrow label are recognised by what they are,
 * with no audit finding mapped — the situation where the audit's element-screenshot box was missing and C2 could not map "Read More".
 */

const ARROW = '<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1L7 7"/></svg>';
const ICON = '<svg width="20" height="20" viewBox="0 0 256 256"><path d="M0 0h10v10z"/></svg>';
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial} .card{width:300px;padding:16px;background:#fff}
.more{display:flex;justify-content:flex-end;padding:0 16px;margin-top:20px;font-size:14px;color:#656565;text-decoration:none}
.eyebrow{display:flex;align-items:center;gap:8px;color:#464449} .eyebrow h2{font-size:10px;font-weight:500;margin:0}
.dark{background:#141016;padding:20px} .dark a{color:#fff;display:flex}
.pill{display:flex;align-items:center;justify-content:center;width:111px;height:27px;border-radius:40px;background:rgba(237,236,251,0.1);color:#fff;font-size:12px;margin:0}
.bars{display:flex;gap:8px}.bar{width:80px;height:3px;border-radius:9999px;background:#BDBDBD4D}.bar.on{background:#7152D5}
.cta{display:flex;align-items:center;gap:8px;width:max-content;margin-left:auto;margin-top:4px;padding:0 20px;height:44px;color:#fff;text-decoration:none;border:1px solid #B01F24;background-image:linear-gradient(270deg,rgb(215,43,49),rgb(176,31,36))}
.sw{display:flex}.swiper-pagination-bullet{display:block;width:80px;height:3px;background:#d4d4d4}.swiper-pagination-bullet-active{background:#171717}
</style></head><body>
<section data-fra-section="s1"><div class="eyebrow">${ICON}<h2>ABOUT KEN SURVEY</h2></div>
<div class="eyebrow">${ICON}<h2>Step 01</h2></div>
<div class="eyebrow"><h2>NO ICON HERE</h2></div>
<div class="eyebrow">${ICON}<h2>Not all caps</h2></div>
<div class="card"><a class="more" href="/read">Read More ${ARROW}</a></div>
<div class="card"><a class="more" href="/plain">Read More</a></div>
<div class="card"><a class="more" href="/other">Contact us ${ARROW}</a></div>
<div class="card"><a class="more" href="/mapped" data-fra-element="e9" data-fra-findings="f9">Learn more ${ARROW}</a></div>
<div class="dark"><p class="pill">Featured Post</p><div class="bars"><div class="bar on"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div></div><a href="/dark">View All ${ARROW}</a></div>
<div class="dark" style="width:600px"><a class="cta" href="/customer-satisfaction-survey">Customer Satisfaction Surveys ${ARROW}</a><a href="/plain-link" style="color:#fff">Plain link in the dark</a></div>
<div class="sw"><span class="swiper-pagination-bullet swiper-pagination-bullet-active"></span><span class="swiper-pagination-bullet"></span><span class="swiper-pagination-bullet"></span></div>
<div class="card"><p class="pill" style="background:#fff;color:#000">Not translucent</p><button class="pill">Control</button></div>
</section></body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function extract(): Promise<ExtractionResult> {
  const ctx = await browser.newContext();
  try { return await extractSections(ctx, HTML, { sectionIds: ['s1'], fullPage: false, names: { s1: 'S1' }, edits: [], dsFirst: true }); } finally { await ctx.close(); }
}
const textOf = (n: PreviewNode): string => (n.t === 'text' ? n.v : n.children.map(textOf).join(''));

describe('structural elements', () => {
  it('finds arrow links with an arrow and eyebrow labels with a leading icon — and nothing else', async () => {
    const s = (await extract()).sections[0]!;
    const kinds = (s.structural ?? []).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'arrow-link')).toHaveLength(2); // "Read More ↗" and the dark "View All ↗"; not the arrowless one, not "Contact us", not the mapped one
    expect(kinds.filter((k) => k === 'eyebrow')).toHaveLength(1); // not "Step 01", not the iconless one, not the mixed-case one
  });

  it('plans a CTALink island per arrow link, keeping href, alignment and padding, and the DS onDark treatment on a dark surface', async () => {
    const r = await extract();
    const all = planIslands({ sections: r.sections, entries: [], findings: [], decisions: null, dsFirst: true }).plans;
    expect(all.every((p) => p.basis === 'structural' && p.findingIds.length === 0)).toBe(true);
    const plans = all.filter((p) => p.spec.component === 'CTALink');
    expect(plans).toHaveLength(2);
    const light = plans.find((p) => p.spec.props['href'] === '/read')!;
    const dark = plans.find((p) => p.spec.props['href'] === '/dark')!;
    expect(light.spec.props).toEqual({ size: 'md', href: '/read' });
    expect(dark.spec.props['onDark']).toBe(true);
    expect(light.label).toBe('Read More');
    const style = islandWrapperStyle(light.layout);
    expect(style).toMatchObject({ display: 'flex', justifyContent: 'flex-end', padding: '0px 16px 0px 16px' });
    expect(style['margin']).toBe('20px 0px 0px 0px');
  });

  it('plans a DS Badge for the translucent pill chip (dark surface: mode dark + overlay) and not for an opaque pill or a button', async () => {
    const r = await extract();
    const badges = planIslands({ sections: r.sections, entries: [], findings: [], decisions: null, dsFirst: true }).plans.filter((p) => p.spec.component === 'Badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ label: 'Featured Post', spec: { props: { variant: 'pill', size: 'sm', theme: 'neutral', mode: 'dark', overlay: true } } });
  });

  it('finds the carousel indicator group, what tells the active bar apart, and writes DS-token CSS keyed on those classes', async () => {
    const r = await extract();
    const g = (r.sections[0]!.indicators ?? []).filter((x) => x.shared.includes('bar'));
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ shared: ['bar'], active: ['on'], rest: [], dark: true });
    const css = indicatorCss(r.sections);
    expect(css).toContain('[class~="bar"][class~="on"] { background: var(--semantic-ink-on-dark-strong) !important');
    expect(css).toContain('[class~="bar"]:not([class~="on"]) { background: var(--semantic-ink-on-dark-faint) !important');
    expect(css).toContain('width: 28px');
  });

  it('plans a DS Button brand (animatedArrow, right-aligned slot) for an unmapped brand-red CTA link, and for nothing else', async () => {
    const r = await extract();
    const btn = planIslands({ sections: r.sections, entries: [], findings: [], decisions: null, dsFirst: true }).plans.filter((p) => p.spec.component === 'Button');
    expect(btn).toHaveLength(1);
    expect(btn[0]).toMatchObject({ label: 'Customer Satisfaction Surveys', spec: { props: { variant: 'brand', size: 'md', href: '/customer-satisfaction-survey', animatedArrow: true } } });
    expect(islandWrapperStyle(btn[0]!.layout)).toMatchObject({ margin: '4px 0px 0px auto' }); // the width is the original's own rule (w-max), re-applied by islandWidthCss
  });

  it('swiper bullets keep their spacing: 24px square bars 8px apart, with the DS colours', async () => {
    const r = await extract();
    const css = indicatorCss(r.sections);
    expect(css).toContain('[class~="swiper-pagination-bullet"] { width: 24px !important; margin: 0 4px !important; border-radius: 0 !important; }');
  });

  it('is not planned without DS-first', async () => {
    const r = await extract();
    expect(planIslands({ sections: r.sections, entries: [], findings: [], decisions: null }).plans).toHaveLength(0);
  });

  it('drops the eyebrow icon, keeps its text, and marks the label for the DS style', async () => {
    const s = (await extract()).sections[0]!;
    const changed = applyEyebrowRule([s]);
    expect(changed).toEqual([{ sectionId: 's1', label: 'ABOUT KEN SURVEY' }]);
    const eyebrow = JSON.stringify(s.tree);
    expect(eyebrow).toContain('data-pv-eyebrow');
    const walk = (n: PreviewNode, out: PreviewNode[] = []): PreviewNode[] => { if (n.t === 'el') { if (n.attrs['data-pv-eyebrow'] !== undefined) out.push(n); n.children.forEach((c) => walk(c, out)); } return out; };
    const [label] = walk(s.tree);
    expect(textOf(label!)).toBe('ABOUT KEN SURVEY');
    // the "Step 01" row still has its icon (a different rule), and the text of the whole section is unchanged
    expect(s.text).toContain('ABOUT KEN SURVEY');
  });
});


describe('structural elements — dark surface without a painted ancestor (a hero over an image)', () => {
  // REGRESSION (brand-perception run): the dark scrim of "Our Resources" is a SIBLING layer, so no ancestor had a dark background: the badge came out as the light-mode Badge
  // (a white pill) and the indicator bars got the light-surface colours (black on dark). The light text drawn on the surface says it is dark.
  const HERO = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:Arial} .hero{position:relative;padding:40px}
  .scrim{position:absolute;inset:0;background:#141016;z-index:-1}
  .pill{display:flex;align-items:center;justify-content:center;width:111px;height:27px;border-radius:40px;background:rgba(237,236,251,0.1);color:#fff;font-size:12px;margin:0}
  h2,p.t{color:#fff;margin:8px 0} .bars{display:flex;gap:8px}.bar{width:80px;height:3px;background:#BDBDBD4D}.bar.on{background:#7152D5}
  </style></head><body><section data-fra-section="h"><div class="hero"><div class="scrim"></div><p class="pill">Featured Post</p><h2>Smell the Success</h2><p class="t">Billion-Dollar Perfume Market</p><p class="t">Read the story</p>
  <div class="bars"><div class="bar on"></div><div class="bar"></div><div class="bar"></div></div></div></section></body></html>`;

  it('treats the surface as dark: Badge mode dark with the overlay treatment, and the dark indicator colours', async () => {
    const ctx = await browser.newContext();
    try {
      const r = await extractSections(ctx, HERO, { sectionIds: ['h'], fullPage: false, names: { h: 'H' }, edits: [], dsFirst: true });
      const badge = planIslands({ sections: r.sections, entries: [], findings: [], decisions: null, dsFirst: true }).plans.find((p) => p.spec.component === 'Badge')!;
      expect(badge.spec.props).toMatchObject({ mode: 'dark', overlay: true });
      expect(r.sections[0]!.indicators?.[0]?.dark).toBe(true);
    } finally { await ctx.close(); }
  });
});

describe('structural elements — a light card is a light surface', () => {
  // REGRESSION (brand-perception run): the "Read More" links in Our Impact's white cards were mounted as CTALink onDark (white text on white) because the card's light-GREY text made the
  // surrounding text look light. A painted background inside the section decides before the text does.
  const CARD = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:Arial}.card{background:#fff;padding:16px;width:300px}.g{color:#BDBDBD;margin:4px 0}a{display:flex;color:#656565;text-decoration:none}</style></head>
  <body><section data-fra-section="c"><div class="card"><p class="g">10% growth in market penetration</p><p class="g">32% improvement in retention</p><p class="g">another light grey line</p><a href="/x">Read More <svg width="8" height="8"><path d="M1 1L7 7"/></svg></a></div></section></body></html>`;
  it('mounts the arrow link without the on-dark treatment', async () => {
    const ctx = await browser.newContext();
    try {
      const r = await extractSections(ctx, CARD, { sectionIds: ['c'], fullPage: false, names: { c: 'C' }, edits: [], dsFirst: true });
      const link = planIslands({ sections: r.sections, entries: [], findings: [], decisions: null, dsFirst: true }).plans.find((p) => p.spec.component === 'CTALink')!;
      expect(link.spec.props['onDark']).toBeUndefined();
    } finally { await ctx.close(); }
  });
});
