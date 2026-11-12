import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { effectiveTokenMap } from '../../src/ds/catalog.ts';
import { resolveToken } from '../../src/ds/d3-tokens/resolve.ts';
import { buildTypeContext, classifyCandidate } from '../../src/agents/b2-component-detector/deterministic.ts';
import type { DomFacts } from '../../src/agents/b2-component-detector/deterministic.ts';
import { checkFoundationRules } from '../../src/agents/b4-compliance-auditor/foundation-rules.ts';
import { decideMatch, dsIndex, type DsIndex } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import type { AriaElement } from '../../src/t-layer/element-registry.ts';
import type { DetectedComponent } from '../../src/agents/types.ts';

/**
 * Heading ROLE is decided from the section's whole text hierarchy, never from the h1–h3 tag:
 *   Supporting heading ≠ Main heading · HTML h2/h3 ≠ automatic SectionHeading ·
 *   the role is identified BEFORE nearest-size matching · DS first.
 * The fixtures are the brand-perception-survey intro section, measured live:
 *   h2 "ABOUT KEN SURVEY" 10px/500 · h3 "Built on Reach, Research, and Real Voices" 16px/400 ·
 *   p "Use real feedback from real audiences…" 30px/300 Noto Serif.
 */

type Box = { x: number; y: number; width: number; height: number };
const aria = (ref: string, role: string, text: string, box: Box): AriaElement => ({
  ref, role, name: role === 'heading' ? text : '', depth: 1, parentRef: null, box,
  line: `- ${role}${role === 'heading' ? ` "${text}"` : ''} [ref=${ref}] [box=${box.x},${box.y},${box.width},${box.height}]${role === 'heading' ? '' : `: ${text}`}`,
});

function facts(tag: string, text: string, style: Partial<DomFacts['style']> = {}, box: Box = { x: 0, y: 0, width: 300, height: 30 }): DomFacts {
  return {
    tag, classes: [], roleAttr: null, cursor: 'auto', text, hasSvg: false, hasImg: false, ownText: true, childElementCount: 0,
    style: {
      backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderTopWidth: '0px', borderTopStyle: 'none', paddingLeft: '0px', paddingTop: '0px',
      color: 'rgb(10, 10, 10)', fontSize: '16px', fontWeight: '400', display: 'block', opacity: '1', visibility: 'visible', textTransform: 'none', letterSpacing: 'normal',
      ...style,
    },
    box,
  };
}

// The survey intro section, in document order.
const EYEBROW = { el: aria('e1', 'heading', 'ABOUT KEN SURVEY', { x: 188, y: 1651, width: 140, height: 15 }), facts: facts('h2', 'ABOUT KEN SURVEY', { fontSize: '10px', fontWeight: '500', color: 'rgb(70, 68, 73)' }) };
const DESC = { el: aria('e2', 'heading', 'Built on Reach, Research, and Real Voices', { x: 160, y: 1684, width: 270, height: 48 }), facts: facts('h3', 'Built on Reach, Research, and Real Voices', { fontSize: '16px', fontWeight: '400', color: 'rgb(20, 16, 22)' }) };
const MAIN = { el: aria('e3', 'paragraph', 'Use real feedback from real audiences to understand what drives decisions and act with confidence.', { x: 496, y: 1648, width: 784, height: 68 }), facts: facts('p', 'Use real feedback from real audiences to understand what drives decisions and act with confidence.', { fontSize: '30px', fontWeight: '300' }) };
const STAT = { el: aria('e4', 'paragraph', '250000+', { x: 496, y: 1756, width: 243, height: 40 }), facts: facts('p', '250000+', { fontSize: '36px' }) };

const ctxOf = (...items: Array<{ el: AriaElement; facts: DomFacts }>) => buildTypeContext(items.map((i, order) => ({ ...i, order, owned: false })));

describe('B2 — the section\'s text hierarchy', () => {
  it('the dominant text is the largest NON-numeral text: the 36px stat never outranks the 30px heading', () => {
    expect(ctxOf(EYEBROW, DESC, MAIN, STAT).dominant).toMatchObject({ ref: 'e3', fontPx: 30, isHeading: false });
  });

  it('a real heading element wins a near-tie — the section already names its main heading', () => {
    const h2 = { el: aria('h', 'heading', 'Our Impact', { x: 0, y: 0, width: 300, height: 40 }), facts: facts('h2', 'Our Impact', { fontSize: '32px' }) };
    const lead = { el: aria('p', 'paragraph', 'A long standfirst sentence under the heading', { x: 0, y: 60, width: 600, height: 40 }), facts: facts('p', 'A long standfirst sentence under the heading', { fontSize: '31px' }) };
    expect(ctxOf(lead, h2).dominant).toMatchObject({ ref: 'h', isHeading: true });
  });

  it('nothing is dominant when no text is display-sized, and words inside an owner (a button label) never count', () => {
    expect(ctxOf(EYEBROW, DESC).dominant).toBeNull();
    const owned = buildTypeContext([{ ...MAIN, order: 0, owned: true }]);
    expect(owned.dominant).toBeNull();
  });
});

describe('B2 — eyebrow / supporting heading ≠ main heading', () => {
  const ctx = ctxOf(EYEBROW, DESC, MAIN, STAT);

  it('"ABOUT KEN SURVEY": an h2, but small, short, upper-case and before the 30px dominant text → an eyebrow, not a section heading', () => {
    const r = classifyCandidate(EYEBROW.el, EYEBROW.facts, { typeContext: ctx });
    expect(r?.componentType).toBe('eyebrow');
    expect(r?.headingRole).toBe('eyebrow');
    expect(r?.domSignals.join(' ')).toContain('does not make it a section heading');
  });

  it('the role does not depend on the tag: the same text as an h2, h3, p or span is the same eyebrow', () => {
    for (const tag of ['h2', 'h3', 'p', 'span']) {
      const role = tag.startsWith('h') ? 'heading' : tag === 'p' ? 'paragraph' : 'generic';
      const el = aria('e1', role, 'ABOUT KEN SURVEY', { x: 188, y: 1651, width: 140, height: 15 });
      const f = facts(tag, 'ABOUT KEN SURVEY', { fontSize: '10px', fontWeight: '500' });
      const r = classifyCandidate(el, f, { typeContext: ctx });
      expect(r?.componentType, tag).toBe('eyebrow');
      expect(r?.headingRole, tag).toBe('eyebrow');
    }
  });

  it('…but a small uppercase `<p>` with no dominant text after it is only text — no section context, no eyebrow', () => {
    const el = aria('e1', 'paragraph', 'NOVEMBER 4, 2024', { x: 0, y: 0, width: 120, height: 14 });
    expect(classifyCandidate(el, facts('p', 'NOVEMBER 4, 2024', { fontSize: '12px' }))?.componentType).toBe('paragraph');
  });

  it('CSS-uppercase / tracked small headings are eyebrows with no section context at all (the established rule is kept)', () => {
    const el = aria('e9', 'heading', 'Resources', { x: 0, y: 0, width: 80, height: 14 });
    expect(classifyCandidate(el, facts('h3', 'Resources', { fontSize: '12px', textTransform: 'uppercase' }))?.componentType).toBe('eyebrow');
    expect(classifyCandidate(el, facts('h3', 'Resources', { fontSize: '12px', letterSpacing: '1.5px' }))?.componentType).toBe('eyebrow');
  });

  it('a small heading with NO dominant text after it, and no uppercase treatment, is never forced into eyebrow — a 32px one stays a heading, a body-sized one is a label', () => {
    const el = aria('e9', 'heading', 'Pain Points', { x: 0, y: 0, width: 200, height: 30 });
    expect(classifyCandidate(el, facts('h2', 'Pain Points', { fontSize: '32px', fontWeight: '300' }))?.componentType).toBe('section-heading');
    // …and at body size it is not a SectionHeading either: below the DS heading range (H3 starts at 25px) a short heading-tagged text is a LABEL
    // (audited on the foundation rules like body text) — never an eyebrow, never forced into SectionHeading by its tag
    const small = classifyCandidate(el, facts('h3', 'Pain Points', { fontSize: '12px' }), { typeContext: ctxOf({ el, facts: facts('h3', 'Pain Points') }) });
    expect(small).toMatchObject({ componentType: 'paragraph', headingRole: 'label' });
    expect(small?.componentType).not.toBe('eyebrow');
  });

  it('a long sentence is not an eyebrow however small it is', () => {
    const text = 'This is a whole sentence that explains the survey in some detail.';
    const el = aria('e0', 'heading', text, { x: 0, y: 0, width: 400, height: 16 });
    expect(classifyCandidate(el, facts('h3', text, { fontSize: '12px' }), { typeContext: ctx })?.componentType).not.toBe('eyebrow');
  });
});

describe('B2 — main heading and description are found by role, not tag', () => {
  const ctx = ctxOf(EYEBROW, DESC, MAIN, STAT);

  it('the dominant 30px `<p>` is the section\'s MAIN heading: a section-heading judged by nearest size, flagged role=main', () => {
    const r = classifyCandidate(MAIN.el, MAIN.facts, { typeContext: ctx });
    expect(r?.componentType).toBe('section-heading');
    expect(r?.headingRole).toBe('main');
    expect(r?.domSignals.join(' ')).toContain('heading role: main');
  });

  it('…but never when a real heading already names the section, in a footer, or when it is not a phrase', () => {
    const h2 = { el: aria('h', 'heading', 'Our Impact', { x: 0, y: 0, width: 300, height: 40 }), facts: facts('h2', 'Our Impact', { fontSize: '32px' }) };
    expect(classifyCandidate(MAIN.el, MAIN.facts, { typeContext: ctxOf(h2, MAIN) })?.componentType).toBe('paragraph');
    expect(classifyCandidate(MAIN.el, MAIN.facts, { typeContext: ctx, inFooter: true })?.componentType).toBe('paragraph');
    const logo = { el: aria('l', 'paragraph', 'Ken', { x: 0, y: 0, width: 60, height: 40 }), facts: facts('p', 'Ken', { fontSize: '32px' }) };
    expect(classifyCandidate(logo.el, logo.facts, { typeContext: ctxOf(logo) })?.componentType).toBe('paragraph');
  });

  it('the stat numerals stay stats, not headings, even though they are the largest text', () => {
    expect(classifyCandidate(STAT.el, STAT.facts, { typeContext: ctx })?.componentType).toBe('stat');
  });

  it('"Built on Reach, Research, and Real Voices": an h3 used for 16px/400 body copy beside 30px dominant text → description (a paragraph), not SectionHeading', () => {
    const r = classifyCandidate(DESC.el, DESC.facts, { typeContext: ctx });
    expect(r?.componentType).toBe('paragraph');
    expect(r?.headingRole).toBe('description');
  });

  it('a card title (repeated unit) or a bold heading of the same size is NOT turned into a description', () => {
    const place = { context: { inNavigation: false, inFooter: false, clickableAncestor: null, repeatedUnit: { unit: 'card', twins: ['x'] } } };
    expect(classifyCandidate(DESC.el, DESC.facts, { typeContext: ctx, ...place })?.componentType).toBe('section-heading');
    expect(classifyCandidate(DESC.el, facts('h3', DESC.facts.text, { fontSize: '16px', fontWeight: '600' }), { typeContext: ctx })?.componentType).toBe('section-heading');
  });
});

describe('B4 — an eyebrow is Ken red on a light surface; red heading text elsewhere is still R1.2', () => {
  const style = (color: string) => ({ connected: true as const, raw: { color, 'font-size': '12.8px', 'font-family': 'DM Sans' }, rootFontSizePx: 16, box: { width: 100, height: 16 } });
  const ctx = {
    tokens: new Map(), ruleTitles: new Map([['R1.2', 'Brand Red is for CTAs ONLY']]), sansFamilies: new Set(['dm sans']), serifFamilies: new Set(['noto serif']),
    textSizesPx: [], radiiPx: [], spacingPx: [], brandRed: 'rgb(176, 31, 36)',
  };
  const check = (componentType: string) => checkFoundationRules({ componentType, headingLevel: 2, hasText: true, style: style('rgb(176, 31, 36)'), ctx });

  it('a red h2 eyebrow raises no R1.2 — the heading tag does not make it heading text', () => {
    expect(check('eyebrow').some((v) => v.ruleId === 'R1.2')).toBe(false);
  });
  it('a red section heading still does', () => {
    expect(check('section-heading').some((v) => v.ruleId === 'R1.2')).toBe(true);
  });
});

describe('B3 — DS first: the role picks the family, then the family picks the values', () => {
  let registry: DsRegistry;
  let index: DsIndex;
  let tokens: Map<string, string>;
  beforeAll(async () => {
    registry = await loadDsRegistry(loadConfig().designSystemPath);
    index = await dsIndex(registry);
    tokens = effectiveTokenMap(registry, 'editorial-light');
  });

  let seq = 0;
  function component(type: string, tag: string, raw: Record<string, string>, surface: 'light' | 'dark', headingRole?: 'eyebrow' | 'main'): DetectedComponent {
    seq += 1;
    const box = { width: 140, height: 15 };
    return {
      elId: `el-${seq}`, ref: `e${seq}`, sectionId: 's', sectionName: 'S', captureState: 'default', componentType: type, label: 'x', domSignals: [], visualSignals: '',
      instanceGroupKey: `${type}:${seq}`, detectionConfidence: 0.8, confidenceOutOfContract: false, ...(headingRole ? { headingRole } : {}),
      fingerprint: { structuralPath: `h2:nth-of-type(${seq})`, role: 'heading', accessibleName: '', textPrefix: '', box: { x: 0, y: 0, ...box } }, findingId: `f${seq}`,
      style: { connected: true, raw, rootFontSizePx: 16, box }, signature: `sig-${seq}`, containsPlaceholder: false, screenshots: { element: null, context: null }, evidenceClipped: false, href: null,
      domFacts: {
        tag, classes: [], roleAttr: null, cursor: 'auto', text: 'ABOUT KEN SURVEY', hasSvg: false, hasImg: false, ownText: true, childElementCount: 0,
        style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: '', fontWeight: '', display: '', opacity: '', visibility: 'visible', textTransform: '', letterSpacing: '' },
        box: { x: 0, y: 0, ...box },
        context: { surface, surfaceEvidence: 'test', current: false, expanded: false, breadcrumb: false, subtitleCandidate: false },
      } as unknown as DetectedComponent['domFacts'],
    } as DetectedComponent;
  }
  const RAW = { color: 'rgb(70, 68, 73)', 'font-size': '10px', 'font-weight': '500', 'letter-spacing': 'normal', 'text-transform': 'none', 'font-family': 'DM Sans', display: 'block' };
  const brandRed = () => (resolveToken('--color-brand-red', tokens) ?? resolveToken('--brand-red', tokens))!.trim();

  it('an eyebrow written as an <h2> is matched to the DS eyebrow family (not SectionHeading, not undecided), and its expected colour is Ken red', () => {
    const m = decideMatch(component('eyebrow', 'h2', RAW, 'light', 'eyebrow'), index, registry, 1440);
    expect(m.dsComponent).toMatch(/OverheadText|SectionLabel/);
    expect(m.dsComponent).not.toBe('SectionHeading');
    expect(m.foundationOnly).toBeUndefined();
    const colour = m.observed?.find((o) => o.property === 'color');
    expect(colour?.expected?.toLowerCase()).toBe(brandRed().toLowerCase());
  });

  it('on a DARK surface the red-only OverheadText is not offered — the DS inverse treatment (SectionLabel) applies', () => {
    const m = decideMatch(component('eyebrow', 'h2', RAW, 'dark', 'eyebrow'), index, registry, 1440);
    expect(m.dsComponent).not.toBe('OverheadText');
  });

  it('a promoted main heading that is a <p> is judged as SectionHeading by nearest rendered size (30px → level 3, 31.25px), the tag proxy only breaking ties', () => {
    const m = decideMatch(component('section-heading', 'p', { 'font-size': '30px', 'font-weight': '300', 'font-family': 'Noto Serif', 'letter-spacing': 'normal' }, 'light', 'main'), index, registry, 1440);
    expect(m.dsComponent).toBe('SectionHeading');
    expect(m.dsVariant).toBe('level 3');
    expect(m.visualSlot).toBeDefined();
    // what the match SAYS about the tag is the tag the element really has — the h2 slot was only the tie-break proxy
    expect(m.typography).toMatchObject({ semanticTag: 'p', followsSemanticLevel: true, variant: 'level 3' });
    expect(m.rationale).toContain('promoted to a heading by its role, not its tag');
    expect(m.rationale).not.toMatch(/actual h2 child|tag stays h2|not the h2/);
  });

  it('a real <h2> keeps its own semantic level in what the match says (the proxy wording is for a promoted <p> only)', () => {
    const m = decideMatch(component('section-heading', 'h2', { 'font-size': '32px', 'font-weight': '300', 'font-family': 'Noto Serif', 'letter-spacing': 'normal' }, 'light'), index, registry, 1440);
    expect(m.dsVariant).toBe('level 3'); // nearest size — and it stays an h2
    expect(m.typography).toMatchObject({ semanticTag: 'h2', followsSemanticLevel: false });
    expect(m.rationale).toContain('actual h2 child');
  });

  it('a section-heading `<p>` that was NOT promoted by B2 gets no heading slot from its tag (no silent promotion in B3)', () => {
    const m = decideMatch(component('section-heading', 'p', { 'font-size': '30px' }, 'light'), index, registry, 1440);
    expect(m.contextSlot).toBeUndefined();
  });
});
