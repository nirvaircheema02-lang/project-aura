import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import { buildExemptions } from '../../src/fidelity/exemptions.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { FIDELITY_SCHEMA_VERSION, type CapturedElement, type DesignBaseline, type DesignCapture, type SectionDesign, type StyleRecord } from '../../src/fidelity/types.ts';
import type { Exemption } from '../../src/resolution/schema.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

/**
 * What an authorized change drags along with it. These cases are the ones a real run on the Deals page produced: a typeface change
 * on a button label's container, a font-size change moving line-height, a colour change moving currentcolor borders. Each rule must
 * cover exactly the consequence — and still flag a descendant that sets its own value, or a ratio that really changed.
 */

const el = (key: string, style: StyleRecord, over: Partial<CapturedElement> = {}): CapturedElement => ({
  key, tag: key === '' ? 'section' : key === '0' ? 'a' : 'span', label: key || 'root', textHash: `t${key}`, stamp: null, findingIds: [], roles: [], flags: {}, style,
  hAlign: 'none', tAlign: 'none', widthRatio: 0, states: {}, ...over,
});

const section = (elements: CapturedElement[]): SectionDesign => ({
  sectionId: 's', viewport: 'desktop', located: true, elements, groups: [], sticky: [], capped: null,
  coverage: { hover: { attempted: 0, captured: 0 }, focusVisible: { attempted: 0, captured: 0 } }, notes: [],
});

const capture = (elements: CapturedElement[]): DesignCapture => ({
  schemaVersion: FIDELITY_SCHEMA_VERSION, capturedAt: 't', source: { kind: 'pre-edit-snapshot', htmlSha256: 'h', url: null },
  viewports: [{ name: 'desktop', width: 1440, height: 900 }], limits: { maxElements: 160, maxHoverTargets: 20, maxFocusTargets: 16, maxDescendants: 40 }, statesNotCaptured: [], sections: [section(elements)],
});

const baselineOf = (elements: CapturedElement[]): DesignBaseline => ({ ...capture(elements), baselineSha256: 'b'.repeat(64) });
const ex = (property: string, over: Partial<Exemption> = {}): Exemption => ({ findingId: 'F', property, part: 'self', state: 'default', viewport: 'any', targetId: `t-${property}`, reason: 'authorized', ...over });

/** root > 0 (the finding element) > 0/0 (inherits) and 0/1 (sets its own value). */
// (the finding element's hover was captured with nothing recorded to compare: every finding element is hovered by the capture, and a never-attempted one is a required gap)
const tree = (a: StyleRecord, inherits: StyleRecord, own: StyleRecord) => [
  el('', {}), el('0', a, { findingIds: ['F'], roles: ['finding'], stateAttempt: { hover: 'captured' }, states: { hover: { subtree: {}, effect: false } } }), el('0/0', inherits), el('0/1', own),
];

const regressions = (baseline: CapturedElement[], observed: CapturedElement[], exemptions: Exemption[]) =>
  compareDesign({ baseline: baselineOf(baseline), observed: capture(observed), exemptions }).differences.filter((d) => d.classification === 'regression');

describe('inheritance', () => {
  const before = tree({ 'font-family': 'Manrope' }, { 'font-family': 'Manrope' }, { 'font-family': 'Georgia' });

  it('a descendant that inherits the authorized property changes with it — intentional, not a regression', () => {
    const after = tree({ 'font-family': 'DM Sans' }, { 'font-family': 'DM Sans' }, { 'font-family': 'Georgia' });
    const report = compareDesign({ baseline: baselineOf(before), observed: capture(after), exemptions: [ex('font-family')] });
    expect(report.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(report.differences.filter((d) => d.classification === 'intentional').map((d) => d.elementKey).sort()).toEqual(['0', '0/0']);
    expect(report.verdict).toBe('pass');
  });

  it('a descendant that sets its OWN value is still compared: changing it is a regression', () => {
    const after = tree({ 'font-family': 'DM Sans' }, { 'font-family': 'DM Sans' }, { 'font-family': 'Courier' });
    const r = regressions(before, after, [ex('font-family')]);
    expect(r.map((d) => d.elementKey)).toEqual(['0/1']);
  });

  it('a descendant that stops inheriting (diverges from the changed element) is not covered', () => {
    const after = tree({ 'font-family': 'DM Sans' }, { 'font-family': 'Courier' }, { 'font-family': 'Georgia' });
    expect(regressions(before, after, [ex('font-family')]).map((d) => d.elementKey)).toEqual(['0/0']);
  });

  it('only the exempted property is covered: an unrelated change on the inheriting descendant is a regression', () => {
    const b = tree({ 'font-family': 'Manrope', 'font-weight': '400' }, { 'font-family': 'Manrope', 'font-weight': '400' }, {});
    const a = tree({ 'font-family': 'DM Sans', 'font-weight': '400' }, { 'font-family': 'DM Sans', 'font-weight': '700' }, {});
    expect(regressions(b, a, [ex('font-family')]).map((d) => `${d.elementKey}:${d.property}`)).toEqual(['0/0:font-weight']);
  });

  it('a state-specific exemption does not cover other states', () => {
    const after = tree({ 'font-family': 'DM Sans' }, { 'font-family': 'DM Sans' }, { 'font-family': 'Georgia' });
    expect(regressions(before, after, [ex('font-family', { state: 'hover' })]).length).toBeGreaterThan(0);
  });

  it('a non-inheritable property is never carried to descendants', () => {
    const b = tree({ 'border-top-left-radius': '4px' }, { 'border-top-left-radius': '4px' }, {});
    const a = tree({ 'border-top-left-radius': '8px' }, { 'border-top-left-radius': '8px' }, {});
    expect(regressions(b, a, [ex('border-top-left-radius')]).map((d) => d.elementKey)).toEqual(['0/0']);
  });
});

describe('line-height follows an authorized font-size', () => {
  const b = tree({ 'font-size': '14px', 'line-height': '21px' }, {}, {});
  it('when its ratio to the font size is unchanged', () => {
    expect(regressions(b, tree({ 'font-size': '16px', 'line-height': '24px' }, {}, {}), [ex('font-size')])).toEqual([]);
  });
  it('but not when the line-height really changed', () => {
    expect(regressions(b, tree({ 'font-size': '16px', 'line-height': '40px' }, {}, {}), [ex('font-size')]).map((d) => d.property)).toEqual(['line-height']);
  });
  it('and not without an authorized font-size', () => {
    expect(regressions(b, tree({ 'font-size': '16px', 'line-height': '24px' }, {}, {}), [ex('letter-spacing')]).map((d) => d.property).sort()).toEqual(['font-size', 'line-height']);
  });
});

describe('currentcolor follows an authorized colour', () => {
  const b = tree({ color: 'rgb(51, 51, 51)', 'text-decoration-color': 'rgb(51, 51, 51)', 'outline-color': 'rgb(51, 51, 51)' }, {}, {});
  it('text-decoration and outline colours that equalled the colour follow it', () => {
    const a = tree({ color: 'rgb(176, 31, 36)', 'text-decoration-color': 'rgb(176, 31, 36)', 'outline-color': 'rgb(176, 31, 36)' }, {}, {});
    expect(regressions(b, a, [ex('color')])).toEqual([]);
  });
  it('an explicit different decoration colour is a regression', () => {
    const a = tree({ color: 'rgb(176, 31, 36)', 'text-decoration-color': 'rgb(0, 0, 255)', 'outline-color': 'rgb(176, 31, 36)' }, {}, {});
    expect(regressions(b, a, [ex('color')]).map((d) => d.property)).toEqual(['text-decoration-color']);
  });
  it('without an authorized colour they are regressions', () => {
    const a = tree({ color: 'rgb(176, 31, 36)', 'text-decoration-color': 'rgb(176, 31, 36)', 'outline-color': 'rgb(176, 31, 36)' }, {}, {});
    expect(regressions(b, a, []).length).toBe(3);
  });
});

describe('text alignment', () => {
  const withAlign = (a: CapturedElement['tAlign']) => [el('', {}), el('0', {}, { tAlign: a, roles: ['text'] })];
  it("'full' (the text spans the whole container) cannot be told apart from left/center/right — never a regression by itself", () => {
    expect(regressions(withAlign('left'), withAlign('full'), [])).toEqual([]);
    expect(regressions(withAlign('center'), withAlign('full'), [])).toEqual([]);
  });
  it('a real change between left, center and right is still a regression', () => {
    expect(regressions(withAlign('center'), withAlign('left'), []).map((d) => d.property)).toEqual(['text-alignment']);
  });
});

describe('buildExemptions — rule-driven authorization', () => {
  const typeface = (): Finding => {
    const f = makeFinding({ findingId: 'F', mismatches: [] });
    f.comparison.ruleViolations = [{ ruleId: 'R1.4', title: 'Two-font pairing', severity: 'HIGH', why: 'Text is set in "Manrope" (Manrope, sans-serif), which is not a design-system typeface.' } as unknown as Finding['comparison']['ruleViolations'][number]];
    return f;
  };
  it('an R1.4 typeface violation authorizes font-family for THAT finding in every state — nothing else', () => {
    const out = buildExemptions({ resolution: null, findings: [typeface(), makeFinding({ findingId: 'G', mismatches: [] })], islandFindingIds: new Set() });
    expect(out.map((e) => `${e.findingId}:${e.property}:${e.part}:${e.state}`)).toEqual(['F:font-family:self:*']);
  });
});
