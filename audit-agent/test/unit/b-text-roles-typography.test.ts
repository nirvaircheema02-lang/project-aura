import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { buildTypeContext, classifyCandidate } from '../../src/agents/b2-component-detector/deterministic.ts';
import type { DomFacts } from '../../src/agents/b2-component-detector/deterministic.ts';
import { buildFoundationContext, checkFoundationRules, verifiedTextRows } from '../../src/agents/b4-compliance-auditor/foundation-rules.ts';
import type { AriaElement } from '../../src/t-layer/element-registry.ts';
import type { ExtractedStyle } from '../../src/t-layer/computed-style.ts';

/**
 * ROLE FIRST, then the DS rule, then the typography. The role of a text is decided from the section (its geometry, its repeated
 * pattern, its tag AND its size together — never one of them alone); the role names the DS contract that applies; only then is the
 * size compared:
 *   - a CARD TITLE (a title over a smaller description, repeated across the section's cards) → the DS card-title contract, R4.3.5 /
 *     R1.4 "H4 card titles": --text-base 20px (4+ cards) or --text-lg 25px (2–3), DM Sans 500;
 *   - a LABEL (a short heading-tagged text below the DS heading range) → the foundation rules like body text, never SectionHeading;
 *   - any other text → the generic R1.3 scale (the DS Major Third steps + R1.3's documented exceptions).
 * And a clean text element says FOUNDATION checks passed — with each verified property recorded as a verified MATCH.
 */

type Box = { x: number; y: number; width: number; height: number };
const aria = (ref: string, role: string, text: string, box: Box): AriaElement => ({
  ref, role, name: role === 'heading' ? text : '', depth: 1, parentRef: null, box,
  line: `- ${role}${role === 'heading' ? ` "${text}"` : ''} [ref=${ref}] [box=${box.x},${box.y},${box.width},${box.height}]${role === 'heading' ? '' : `: ${text}`}`,
});
function facts(tag: string, text: string, style: Partial<DomFacts['style']>, box: Box): DomFacts {
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
type Item = { el: AriaElement; facts: DomFacts };
const item = (ref: string, role: string, tag: string, text: string, style: Partial<DomFacts['style']>, box: Box): Item => ({ el: aria(ref, role, text, box), facts: facts(tag, text, style, box) });
const ctxOf = (...items: Item[]) => buildTypeContext(items.map((i, order) => ({ ...i, order, owned: false })));

// "What's Impacting Your Dealers": a 32px section heading, then TWO cards whose titles are 18px/500 <p> over 14px/400 copy.
const HEADING = item('h', 'heading', 'h2', 'What’s Impacting Your Dealers', { fontSize: '32px', fontWeight: '300' }, { x: 160, y: 2600, width: 700, height: 44 });
const T1 = item('t1', 'paragraph', 'p', 'What It Means for the Brand', { fontSize: '18px', fontWeight: '500' }, { x: 760, y: 2632, width: 180, height: 56 });
const D1 = item('d1', 'paragraph', 'p', 'Overstocking ties up capital while understocking leads to missed sales and dealer frustration.', { fontSize: '14px', fontWeight: '400' }, { x: 760, y: 2696, width: 180, height: 90 });
const T2 = item('t2', 'paragraph', 'p', 'How Ken Solves It', { fontSize: '18px', fontWeight: '500' }, { x: 960, y: 2632, width: 180, height: 28 });
const D2 = item('d2', 'paragraph', 'p', 'Identify inventory pressure points and act on them early.', { fontSize: '14px', fontWeight: '400' }, { x: 960, y: 2668, width: 180, height: 70 });
const LABEL = item('l', 'heading', 'h2', 'Pain Points', { fontSize: '16px', fontWeight: '400' }, { x: 188, y: 2688, width: 92, height: 24 });

const decide = (it: Item, ctx: ReturnType<typeof ctxOf>) => classifyCandidate(it.el, it.facts, { typeContext: ctx });

describe('B2 — a card title is found by ROLE evidence together: a title over a smaller description, repeated across the section', () => {
  const ctx = ctxOf(HEADING, T1, D1, T2, D2, LABEL);

  it('the section reads each title\'s description from GEOMETRY (the smaller text directly beneath it), and which title-over-description pairs repeat', () => {
    expect(ctx.beneath?.get('t1')).toMatchObject({ fontPx: 14, weight: 400 });
    expect(ctx.beneath?.get('t2')).toMatchObject({ fontPx: 14, weight: 400 });
    expect([...(ctx.titlePairs ?? [])].sort()).toEqual(['t1', 't2']);
  });

  it('"What It Means for the Brand" — a <p> at 18px/500 — is a CARD TITLE (typed paragraph, role card-title): neither the p tag nor 18px alone says so', () => {
    for (const t of [T1, T2]) {
      const c = decide(t, ctx);
      expect(c).toMatchObject({ componentType: 'paragraph', headingRole: 'card-title' });
      expect(c?.domSignals.some((s) => s.startsWith('heading role: card-title'))).toBe(true);
    }
  });

  it('the SAME text with only ONE such pair in the section is not a card title (a lone bold lead-in over a caption is not a card grid)', () => {
    expect(decide(T1, ctxOf(HEADING, T1, D1))?.headingRole).toBeUndefined();
  });

  it('weight and tag both count: a regular-weight <p> over smaller copy, repeated, is body text — a heading-tagged title of the same shape is still a card title', () => {
    const light = (i: Item, ref: string) => ({ ...i, el: { ...i.el, ref }, facts: { ...i.facts, style: { ...i.facts.style, fontWeight: '400' } } });
    const ctxLight = ctxOf(HEADING, light(T1, 'a1'), { ...D1, el: { ...D1.el, ref: 'b1' } }, light(T2, 'a2'), { ...D2, el: { ...D2.el, ref: 'b2' } });
    expect(decide(light(T1, 'a1'), ctxLight)?.headingRole).toBeUndefined();
    const h3 = (ref: string, text: string, y: number) => item(ref, 'heading', 'h3', text, { fontSize: '20px', fontWeight: '400' }, { x: 100, y, width: 200, height: 28 });
    const ctxH = ctxOf(HEADING, h3('x1', 'Card one', 3000), { ...D1, el: { ...D1.el, ref: 'y1' }, facts: { ...D1.facts, box: { x: 100, y: 3036, width: 200, height: 60 } } }, h3('x2', 'Card two', 3200), { ...D2, el: { ...D2.el, ref: 'y2' }, facts: { ...D2.facts, box: { x: 100, y: 3236, width: 200, height: 60 } } });
    expect(decide(h3('x1', 'Card one', 3000), ctxH)).toMatchObject({ componentType: 'paragraph', headingRole: 'card-title' });
  });

  it('a card title never leaves the DS title range: a 40px bold <p> over smaller copy, repeated, is not one', () => {
    const big = (ref: string, y: number) => item(ref, 'paragraph', 'p', 'Heroic', { fontSize: '40px', fontWeight: '700' }, { x: 100, y, width: 200, height: 48 });
    const below = (ref: string, y: number) => item(ref, 'paragraph', 'p', 'Some smaller supporting copy here', { fontSize: '14px' }, { x: 100, y, width: 200, height: 40 });
    const c = ctxOf(HEADING, big('b1', 3000), below('c1', 3056), big('b2', 3200), below('c2', 3256));
    expect(decide(big('b1', 3000), c)?.headingRole).not.toBe('card-title');
  });
});

describe('B2 — a short heading-tagged text BELOW the DS heading range is a LABEL, not a SectionHeading', () => {
  const ctx = ctxOf(HEADING, T1, D1, T2, D2, LABEL);

  it('"Pain Points" — an h2 at 16px, 2 words, no description beneath it — is a LABEL: typed paragraph (foundation rules), not forced into SectionHeading by its tag', () => {
    const c = decide(LABEL, ctx);
    expect(c).toMatchObject({ componentType: 'paragraph', headingRole: 'label' });
    expect(c?.domSignals.some((s) => /^heading role: label — a short h2 at 16px, below the DS heading range \(H3 starts at 25px\)/.test(s))).toBe(true);
  });

  it('tag AND size together: the same h2 at 32px is a section heading; a 6+-word h2 at 16px is not a label; a clickable small one is a UI label, a clickable display-size one keeps the doubt path', () => {
    const big = item('b', 'heading', 'h2', 'Pain Points', { fontSize: '32px', fontWeight: '300' }, { x: 0, y: 0, width: 200, height: 40 });
    expect(decide(big, ctxOf(big))?.componentType).toBe('section-heading');
    const long = item('lg', 'heading', 'h2', 'Why dealer issues often surface so late in the cycle', { fontSize: '16px' }, { x: 0, y: 0, width: 400, height: 24 });
    expect(decide(long, ctxOf(long))?.headingRole).not.toBe('label');
    // A CLICKABLE short heading below the heading range is a UI label too (a selector / index entry) — never a SectionHeading
    const clickable = { ...LABEL, facts: { ...LABEL.facts, cursor: 'pointer' } };
    const clicked = classifyCandidate(clickable.el, clickable.facts, { typeContext: ctx });
    expect(clicked).toMatchObject({ componentType: 'paragraph', headingRole: 'label' });
    expect(clicked?.domSignals.some((s) => s.includes('clickable (a selector / index / list entry)'))).toBe(true);
    // …but a clickable one at DISPLAY size keeps the existing doubt path
    const bigClick = { ...LABEL, facts: { ...LABEL.facts, cursor: 'pointer', style: { ...LABEL.facts.style, fontSize: '32px' } } };
    expect(classifyCandidate(bigClick.el, bigClick.facts, { typeContext: ctx })?.componentType).toBe('section-heading');
  });

  it('an eyebrow is still an eyebrow (the eyebrow rules come first) and supporting copy is still a description', () => {
    const eyebrow = item('e', 'heading', 'h2', 'ABOUT KEN SURVEY', { fontSize: '10px', fontWeight: '500', textTransform: 'uppercase' }, { x: 0, y: 0, width: 140, height: 15 });
    expect(decide(eyebrow, ctxOf(eyebrow))?.componentType).toBe('eyebrow');
  });
});

describe('B4 — the role names the DS contract; the typography is compared against THAT', () => {
  let registry: DsRegistry;
  beforeAll(async () => { registry = await loadDsRegistry(loadConfig().designSystemPath); }, 120_000);

  const style = (raw: Record<string, string>): ExtractedStyle => ({ connected: true, raw: { 'font-family': '"DM Sans", "DM Sans Fallback", sans-serif', 'font-size': '16px', 'font-weight': '400', color: 'rgb(10, 10, 10)', ...raw }, rootFontSizePx: 16, box: { x: 0, y: 0, width: 100, height: 20 } } as unknown as ExtractedStyle);
  const check = (role: string | null, raw: Record<string, string>) => checkFoundationRules({ componentType: 'paragraph', headingLevel: null, hasText: true, style: style(raw), ctx: buildFoundationContext(registry), role });

  it('a card title at 18px/500 is judged against R4.3.5: the nearest card-title size is 20px (--text-base) — a single recommendation, never "18px is fine"', () => {
    const [v, ...rest] = check('card-title', { 'font-size': '18px', 'font-weight': '500' });
    expect(rest).toEqual([]);
    expect(v).toMatchObject({ ruleId: 'R4.3', property: 'font-size', actual: '18px', expected: '20px', severity: 'MEDIUM' });
    expect(v?.why).toContain('R4.3.5');
    // …and it is NOT also cited by the generic R1.3 (one citation per property)
    expect(check('card-title', { 'font-size': '18px', 'font-weight': '500' }).filter((x) => x.ruleId === 'R1.3')).toEqual([]);
  });

  it('20px/500 (4+ cards) and 25px/500 (2–3 cards) are both the documented card-title sizes; weight must be 500 and the face DM Sans', () => {
    expect(check('card-title', { 'font-size': '20px', 'font-weight': '500' })).toEqual([]);
    expect(check('card-title', { 'font-size': '25.008px', 'font-weight': '500' })).toEqual([]);
    expect(check('card-title', { 'font-size': '20px', 'font-weight': '400' }).map((v) => [v.ruleId, v.property, v.expected])).toEqual([['R1.4', 'font-weight', '500']]);
    expect(check('card-title', { 'font-size': '20px', 'font-weight': '500', 'font-family': '"Noto Serif", serif' }).some((v) => v.property === 'font-family')).toBe(true);
  });

  it('"Pain Points" as a LABEL at 16px/400 DM Sans passes the foundation rules — nothing is recommended', () => {
    expect(check('label', {})).toEqual([]);
  });

  it('plain body text at 18px has no role contract: it is judged by the generic scale — off-scale, nearest 20px, and the message says 18px is the legacy --text-md', () => {
    const [v] = check(null, { 'font-size': '18px' });
    expect(v).toMatchObject({ ruleId: 'R1.3', expected: '20px' });
    expect(v?.why).toMatch(/it equals --text-md, a legacy remap token/);
  });

  it('12px is not a DS size (the documented micro size is 11px; 12px appears only as a CSS fallback): off-scale, nearest 12.8px — and 11px / 14px / 10px are the documented exceptions', () => {
    expect(check(null, { 'font-size': '12px' })[0]).toMatchObject({ ruleId: 'R1.3', expected: '12.8px' });
    for (const ok of ['11px', '14px', '10px', '12.8px']) expect(check(null, { 'font-size': ok }), ok).toEqual([]);
  });
});

describe('B4 — what a clean foundation check VERIFIED is shown as verified, with the DS value it was verified against', () => {
  let registry: DsRegistry;
  beforeAll(async () => { registry = await loadDsRegistry(loadConfig().designSystemPath); }, 120_000);
  const st = (raw: Record<string, string>): ExtractedStyle => ({ connected: true, raw: { 'font-family': '"DM Sans", "DM Sans Fallback", sans-serif', 'font-size': '16px', 'font-weight': '400', color: 'rgb(10, 10, 10)', ...raw }, rootFontSizePx: 16, box: { x: 0, y: 0, width: 100, height: 20 } } as unknown as ExtractedStyle);

  it('font-family, font-size and colour of a clean 16px paragraph are three verified MATCH rows, each with its DS token', () => {
    const rows = verifiedTextRows({ componentType: 'paragraph', hasText: true, style: st({}), ctx: buildFoundationContext(registry), role: 'label', broken: new Set() });
    expect(rows.map((r) => r.property)).toEqual(['font-family', 'font-size', 'color']);
    const size = rows.find((r) => r.property === 'font-size')!;
    expect(size).toMatchObject({ expected: '1rem', expectedToken: '--text-sm', rule: 'R1.3' });
    expect(size.note).toMatch(/a step of the DS type scale \(--text-sm\)/);
    expect(rows.find((r) => r.property === 'font-family')).toMatchObject({ expectedToken: '--font-sans', rule: 'R1.4' });
    expect(rows.find((r) => r.property === 'color')?.rule).toBe('R1.1');
  });

  it('a card title\'s size is verified against the CARD-TITLE contract, and a property that broke a rule is never listed as verified', () => {
    const ok = verifiedTextRows({ componentType: 'paragraph', hasText: true, style: st({ 'font-size': '20px', 'font-weight': '500' }), ctx: buildFoundationContext(registry), role: 'card-title', broken: new Set() });
    expect(ok.find((r) => r.property === 'font-size')).toMatchObject({ rule: 'R4.3', expectedToken: '--text-base' });
    expect(ok.find((r) => r.property === 'font-size')?.note).toContain('card title');
    const broken = verifiedTextRows({ componentType: 'paragraph', hasText: true, style: st({ 'font-size': '18px' }), ctx: buildFoundationContext(registry), role: null, broken: new Set(['font-size']) });
    expect(broken.map((r) => r.property)).toEqual(['font-family', 'color']);
  });
});

describe('FAQ questions and clickable labels — judged by their DS contract, never forced into SectionHeading (engine r11)', () => {
  const FAQ = 'How do I know which survey is right for my business?';
  const faq = (extra: Partial<DomFacts['style']> = {}, tag = 'h3', cursor = 'pointer') => {
    const it = item('q', 'heading', tag, FAQ, { fontSize: '14px', fontWeight: '500', ...extra }, { x: 0, y: 0, width: 710, height: 20 });
    return { ...it, facts: { ...it.facts, cursor } };
  };

  it('an FAQ question — a clickable heading phrased as a question, below the heading range — is role `question`: typed paragraph, never section-heading', () => {
    const q = faq();
    const out = classifyCandidate(q.el, q.facts, { typeContext: ctxOf(q) });
    expect(out).toMatchObject({ componentType: 'paragraph', headingRole: 'question' });
    expect(out?.domSignals.some((s) => s.startsWith('heading role: question') && s.includes('AccordionItem'))).toBe(true);
  });

  it('role needs ALL the evidence: not clickable, not phrased as a question, or at display size → it is not a `question`', () => {
    const plain = faq({}, 'h3', 'auto');
    expect(classifyCandidate(plain.el, plain.facts, { typeContext: ctxOf(plain) })?.headingRole).not.toBe('question');
    const noQ = item('n', 'heading', 'h3', 'Our approach to survey design', { fontSize: '14px', fontWeight: '500' }, { x: 0, y: 0, width: 400, height: 20 });
    const noQc = { ...noQ, facts: { ...noQ.facts, cursor: 'pointer' } };
    expect(classifyCandidate(noQc.el, noQc.facts, { typeContext: ctxOf(noQc) })?.headingRole).not.toBe('question');
    // an article / card title that merely ends in a question mark is NOT an FAQ question: 20px+ is the card-title range
    const article = faq({ fontSize: '20px', fontWeight: '600' });
    expect(classifyCandidate(article.el, article.facts, { typeContext: ctxOf(article) })?.headingRole).not.toBe('question');
    const big = faq({ fontSize: '32px' });
    expect(classifyCandidate(big.el, big.facts, { typeContext: ctxOf(big) })?.componentType).toBe('section-heading');
  });

  it('"Employee Engagement" — a clickable 14px/400 index entry — is a LABEL (foundation rules), not a SectionHeading with a 31.25px recommendation', () => {
    const it = item('l', 'heading', 'h3', 'Employee Engagement', { fontSize: '14px', fontWeight: '400', letterSpacing: '0.48px', color: 'rgb(101, 101, 101)' }, { x: 0, y: 0, width: 175, height: 20 });
    const clickable = { ...it, facts: { ...it.facts, cursor: 'pointer' } };
    expect(classifyCandidate(clickable.el, clickable.facts, { typeContext: ctxOf(clickable) })).toMatchObject({ componentType: 'paragraph', headingRole: 'label' });
  });

  describe('B4 — the question is judged against the DS AccordionItem (--text-sm 16px, weight 500): the NEAREST DS match', () => {
    let registry: DsRegistry;
    beforeAll(async () => { registry = await loadDsRegistry(loadConfig().designSystemPath); }, 120_000);
    const st = (raw: Record<string, string>): ExtractedStyle => ({ connected: true, raw: { 'font-family': '"DM Sans", "DM Sans Fallback", sans-serif', 'font-size': '16px', 'font-weight': '500', color: 'rgb(10, 10, 10)', ...raw }, rootFontSizePx: 16, box: { x: 0, y: 0, width: 100, height: 20 } } as unknown as ExtractedStyle);
    const check = (role: string | null, raw: Record<string, string>) => checkFoundationRules({ componentType: 'paragraph', headingLevel: 3, hasText: true, style: st(raw), ctx: buildFoundationContext(registry), role });

    it('18px/500 → nearest accepted size is 16px (--text-sm) — one recommendation, and never the 31.25px SectionHeading size', () => {
      const out = check('question', { 'font-size': '18px' });
      expect(out.map((v) => [v.ruleId, v.property, v.actual, v.expected])).toEqual([['R1.3', 'font-size', '18px', '16px']]);
      expect(out[0]?.why).toContain('AccordionItem');
      expect(JSON.stringify(out)).not.toMatch(/31\.25|1\.953/);
    });

    it('14px/500 is ACCEPTED: 14px is a documented R1.3 compact-text exception (--text-compact / --text-nav), a DS size too', () => {
      expect(check('question', { 'font-size': '14px' })).toEqual([]);
      expect(check('question', { 'font-size': '12px' }).map((v) => [v.ruleId, v.expected])).toEqual([['R1.3', '14px']]);
    });

    it('16px/500 passes; a wrong weight is a LOW R1.4 finding against the AccordionItem weight', () => {
      expect(check('question', {})).toEqual([]);
      const w = check('question', { 'font-weight': '400' });
      expect(w.map((v) => [v.ruleId, v.property, v.actual, v.expected, v.severity])).toEqual([['R1.4', 'font-weight', '400', '500', 'LOW']]);
    });

    it('plain body text keeps the generic scale (the role changes the contract, nothing else): 14px is a documented R1.3 exception, 18px is off-scale', () => {
      expect(check(null, { 'font-size': '14px' })).toEqual([]);
      const out = check(null, { 'font-size': '18px' });
      expect(out.map((v) => v.ruleId)).toEqual(['R1.3']);
      expect(out[0]?.why).not.toContain('AccordionItem');
    });
  });
});
