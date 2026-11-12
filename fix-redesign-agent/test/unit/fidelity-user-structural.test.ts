import { describe, expect, it } from 'vitest';
import { compareDesign } from '../../src/fidelity/compare.ts';
import type { CapturedElement, DesignBaseline, DesignCapture, FidelityReport, SectionDesign, StyleRecord } from '../../src/fidelity/types.ts';
import { base, cap, el, sec } from '../helpers/fidelity-captures.ts';

/** A user style rule and the structural eyebrow rule are authorized differences — named, listed, and limited to what they restyle. */

const run = (b: DesignBaseline, o: DesignCapture): FidelityReport => compareDesign({ baseline: b, observed: o, exemptions: [], now: () => new Date(0) });
const ROUND: StyleRecord = { 'border-top-left-radius': '10px', 'border-bottom-right-radius': '10px', color: 'rgb(0, 0, 0)', 'font-size': '16px' };
const SQUARE: StyleRecord = { ...ROUND, 'border-top-left-radius': '0px', 'border-bottom-right-radius': '0px' };
const one = (e: CapturedElement) => sec({ sectionId: 's', elements: [el(''), e] });
const card = (style: StyleRecord, extra: Partial<CapturedElement> = {}): CapturedElement => el('0', { tag: 'div', label: 'Card', textHash: 'c', roles: ['finding'], findingIds: ['F1'], style, ...extra });
const regressions = (r: FidelityReport) => r.differences.filter((d) => d.classification === 'regression').map((d) => d.property);

describe('user style rule — fidelity', () => {
  it('REGRESSION (brand-perception run): a radius the user set to 0 differs from the original 10px and is a regression without the rule', () => {
    expect(regressions(run(base([one(card(ROUND))]), cap([one(card(SQUARE))])))).toEqual(['border-top-left-radius', 'border-bottom-right-radius']);
  });

  it('with the rule on the element, the radius difference is intentional and says which rule', () => {
    const r = run(base([one(card(ROUND))]), cap([one(card(SQUARE, { userStyle: 'border-radius:0' }))]));
    expect(regressions(r)).toEqual([]);
    const d = r.differences.filter((x) => x.property === 'border-top-left-radius');
    expect(d.map((x) => [x.classification, x.exemptionTargetId])).toEqual([['intentional', 'user-style-rule']]);
  });

  it('the rule authorizes only what it names: a colour change on the same element is still a regression', () => {
    const r = run(base([one(card(ROUND))]), cap([one(card({ ...SQUARE, color: 'rgb(255, 0, 0)' }, { userStyle: 'border-radius:0' }))]));
    expect(regressions(r)).toEqual(['color']);
  });
});

describe('user colour rule — what follows from it (cndp run: #141016 -> DS ink)', () => {
  const OLD = 'rgb(20, 16, 22)', INK = 'rgb(23, 23, 23)';
  const ink = (c: string, extra: StyleRecord = {}): StyleRecord => ({ ...ROUND, color: c, 'text-decoration-color': c, 'outline-color': c, ...extra });
  const text = (key: string, style: StyleRecord, extra: Partial<CapturedElement> = {}): CapturedElement => el(key, { tag: 'p', label: 'Text', textHash: key, roles: [], findingIds: [], style, ...extra });
  const two = (parent: CapturedElement, child: CapturedElement) => sec({ sectionId: 's', elements: [el(''), parent, child] });
  const RULE = 'color:var(--black-900)';

  it('the ruled element\'s currentcolor properties (text-decoration-color, outline-color) follow its ruled colour', () => {
    expect(regressions(run(base([one(text('0', ink(OLD)))]), cap([one(text('0', ink(INK), { userStyle: RULE }))])))).toEqual([]);
    expect(regressions(run(base([one(text('0', ink(OLD)))]), cap([one(text('0', ink(INK)))]))).sort()).toEqual(['color', 'outline-color', 'text-decoration-color']);
  });

  it('a descendant that INHERITS the ruled colour changes with it (and its own currentcolor properties)', () => {
    const r = run(base([two(text('0', ink(OLD)), text('0/0', ink(OLD)))]), cap([two(text('0', ink(INK), { userStyle: RULE }), text('0/0', ink(INK)))]));
    expect(regressions(r)).toEqual([]);
  });

  it('REGRESSION guard: a descendant that sets its OWN colour is still compared, and a decoration colour that was not the text colour stays a regression', () => {
    const own = run(base([two(text('0', ink(OLD)), text('0/0', ink('rgb(0, 128, 0)')))]), cap([two(text('0', ink(INK), { userStyle: RULE }), text('0/0', ink(INK)))]));
    expect(regressions(own)).toContain('color');
    const odd = run(base([one(text('0', ink(OLD, { 'text-decoration-color': 'rgb(0, 0, 255)' })))]), cap([one(text('0', ink(INK), { userStyle: RULE }))]));
    expect(regressions(odd)).toEqual(['text-decoration-color']);
  });
});

describe('eyebrow structural rule — fidelity', () => {
  const label = (style: StyleRecord, extra: Partial<CapturedElement> = {}): CapturedElement => el('0', { tag: 'h2', label: 'ABOUT KEN SURVEY', textHash: 'a', roles: [], findingIds: [], style, ...extra });
  const BEFORE: StyleRecord = { color: 'rgb(70, 68, 73)', 'font-size': '10px', 'font-weight': '500', 'text-transform': 'none', display: 'block', 'background-color': 'rgba(0, 0, 0, 0)' };
  const AFTER: StyleRecord = { ...BEFORE, color: 'rgb(176, 31, 36)', 'font-size': '12.8px', 'font-weight': '700', 'text-transform': 'uppercase', display: 'flex' };

  it('the eyebrow\'s type and colour changes are intentional only on a label the rule marked', () => {
    expect(regressions(run(base([one(label(BEFORE))]), cap([one(label(AFTER))]))).length).toBeGreaterThan(0);
    expect(regressions(run(base([one(label(BEFORE))]), cap([one(label(AFTER, { structural: 'eyebrow' }))])))).toEqual([]);
  });

  it('REGRESSION (brand-perception run): the label\'s wider share of the row follows from the rule — not a composition regression', () => {
    const wide = (ratio: number, extra: Partial<CapturedElement> = {}) => label(BEFORE, { widthRatio: ratio, ...extra });
    expect(regressions(run(base([one(wide(0.065))]), cap([one(wide(0.107))])))).toEqual(['width-ratio']);
    expect(regressions(run(base([one(wide(0.065))]), cap([one(wide(0.107, { structural: 'eyebrow' }))])))).toEqual([]);
  });

  it('an unrelated property of a marked label (its background) is still a regression', () => {
    const r = run(base([one(label(BEFORE))]), cap([one(label({ ...AFTER, 'background-color': 'rgb(1, 2, 3)' }, { structural: 'eyebrow' }))]));
    expect(regressions(r)).toEqual(['background-color']);
  });
});

describe('carousel indicator bars — fidelity', () => {
  const bar = (style: StyleRecord, extra: Partial<CapturedElement> = {}): CapturedElement => el('0', { tag: 'div', label: '', textHash: '', roles: [], findingIds: [], style, ...extra });
  const B: StyleRecord = { 'background-color': 'rgb(113, 82, 213)', width: '80px', opacity: '1', 'border-top-width': '0px' };
  const A: StyleRecord = { ...B, 'background-color': 'rgba(255, 255, 255, 0.92)', width: '28px' };

  it('the DS colour and width of a marked bar are intentional; an unmarked bar with the same change is a regression; other properties stay regressions', () => {
    expect(regressions(run(base([one(bar(B))]), cap([one(bar(A))]))).sort()).toEqual(['background-color', 'width']);
    expect(regressions(run(base([one(bar(B))]), cap([one(bar(A, { structural: 'indicator' }))])))).toEqual([]);
    expect(regressions(run(base([one(bar(B))]), cap([one(bar({ ...A, 'border-top-width': '3px' }, { structural: 'indicator' }))])))).toEqual(['border-top-width']);
  });
});
