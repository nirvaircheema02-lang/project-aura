import { describe, expect, it } from 'vitest';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { applyFidelityToTargets } from '../../src/fidelity/verify.ts';
import type { CapturedElement, DesignBaseline, DesignCapture, SectionDesign } from '../../src/fidelity/types.ts';
import type { Exemption, ResolvedTarget } from '../../src/resolution/schema.ts';
import { base, cap, el, hoverState, resolutionOf, sec, target } from '../helpers/fidelity-captures.ts';

/**
 * A preserve decision is `preserved-verified` ONLY on positive evidence: the same element, part, property, state and viewport were
 * compared and agree. A removed element is a failure; missing evidence (skipped section, uncaptured state, unmeasured property) is
 * `unverified` with the specific reason. The cases are built from capture literals so they run without a browser.
 */

const BLACK = { color: 'rgb(0, 0, 0)', 'font-size': '16px' };
const WHITE = { color: 'rgb(255, 255, 255)', 'font-size': '16px' };
/** The finding F1's element (key '0') plus the always-present, unchanged section B, so "nothing was compared at all" never explains a result. */
const finding = (over: Partial<CapturedElement> = {}): CapturedElement => el('0', { tag: 'a', label: 'Buy now', textHash: 'buy', roles: ['finding', 'interactive', 'text'], findingIds: ['F1'], style: BLACK, ...over });
const A = (viewport: 'desktop' | 'mobile', elements: CapturedElement[] | null, over: Partial<SectionDesign> = {}): SectionDesign =>
  sec({ sectionId: 'A', viewport, elements: elements ?? [el(''), finding()], ...over });
const B = (viewport: 'desktop' | 'mobile'): SectionDesign => sec({ sectionId: 'B', viewport, elements: [el(''), el('0', { roles: ['interactive', 'text'], label: 'other', textHash: 'o' }), el('1', { roles: ['text'], label: 'x', textHash: 'x' })] });
const sections = (a: (v: 'desktop' | 'mobile') => SectionDesign): SectionDesign[] => [a('desktop'), a('mobile'), B('desktop'), B('mobile')];

function verdictOf(t: ResolvedTarget, baseline: DesignBaseline, observed: DesignCapture, exemptions: Exemption[] = [], overrideIds?: ReadonlySet<string>) {
  const resolution = resolutionOf(t);
  const report = compareDesign({ baseline, observed, exemptions, ...(overrideIds ? { overrideSectionIds: overrideIds } : {}) });
  applyFidelityToTargets(resolution, report, baseline, exemptions, overrideIds);
  return { status: resolution.targets[0]!.status.verification, detail: resolution.targets[0]!.status.verificationDetail ?? '', report };
}
/** `over` shapes the OUTPUT only; the original is always the plain section. */
const unchanged = (t: ResolvedTarget, over?: (v: 'desktop' | 'mobile') => SectionDesign) => verdictOf(t, base(sections((v) => A(v, null))), cap(sections(over ?? ((v) => A(v, null)))));
/** The same section on both sides (states and parts that exist on the original and are unchanged in the output). */
const same = (t: ResolvedTarget, make: (v: 'desktop' | 'mobile') => SectionDesign) => verdictOf(t, base(sections(make)), cap(sections(make)));

describe('an unchanged measured element', () => {
  it('is preserved-verified, and the detail cites THIS target\'s evidence (not the global element count)', () => {
    const r = unchanged(target());
    expect(r.status).toBe('preserved-verified');
    expect(r.detail).toMatch(/A \(desktop, mobile\)/);
    expect(r.detail).not.toMatch(/\(\d+ element\(s\) compared\)/);
  });

  it('is verified in the default, hover and keyboard-focus states and on the label part, when each was captured and agrees', () => {
    const hov = (s: typeof BLACK) => ({ hover: hoverState(s), 'focus-visible': { subtree: { '': s }, focusVisibleMatched: true, effect: true } });
    const withStates = (v: 'desktop' | 'mobile') => A(v, [el(''), finding({ states: v === 'desktop' ? hov(WHITE) : {} })]);
    expect(same(target({ state: 'hover' }), withStates).status).toBe('preserved-verified');
    expect(same(target({ state: 'hover' }), withStates).detail).toMatch(/mobile.*not applicable|hover.*desktop only/i);
    expect(same(target({ state: 'focus-visible' }), withStates).status).toBe('preserved-verified');
    expect(same(target({ state: 'focus' }), withStates).status).toBe('preserved-verified'); // plain focus is approximated by keyboard focus
    const withLabel = (v: 'desktop' | 'mobile') => A(v, [el(''), finding({ partKeys: { label: ['0/0'], descendants: ['0/0'], named: {} } }), el('0/0', { roles: ['text'], textHash: 'l', label: 'Buy now' })]);
    const r = same(target({ part: 'label' }), withLabel);
    expect(r.status).toBe('preserved-verified');
  });
});

describe('a REMOVED element', () => {
  const gone = (v: 'desktop' | 'mobile') => A(v, [el('')]);

  it('is a failure, not preserved-verified — the report knew, the target must too', () => {
    const r = unchanged(target(), gone);
    expect(r.report.differences.some((d) => d.category === 'element-unmatched' && d.classification === 'regression')).toBe(true);
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/removed/i);
  });

  it('removed on MOBILE only fails an "any" viewport target and names the mobile viewport', () => {
    const r = unchanged(target(), (v) => (v === 'mobile' ? gone(v) : A(v, null)));
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/mobile/);
  });

  it('an element that exists only in the desktop baseline is verified on desktop alone', () => {
    const b = base([A('desktop', null), A('mobile', [el('')]), B('desktop'), B('mobile')]);
    const r = verdictOf(target(), b, cap([A('desktop', null), A('mobile', [el('')]), B('desktop'), B('mobile')]));
    expect(r.status).toBe('preserved-verified');
    expect(r.detail).toMatch(/desktop only/);
  });

  it('is only "moved" (unverified, not failed) when the same finding turns up at another position', () => {
    const r = unchanged(target(), (v) => A(v, [el(''), el('1', { tag: 'a', label: 'Buy now', textHash: 'buy', roles: ['finding', 'interactive', 'text'], findingIds: ['F1'], style: BLACK })]));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/moved|another position/i);
  });

  it('an output that hit the element cap cannot confirm a removal: unverified', () => {
    expect(unchanged(target(), (v) => A(v, [el('')], { capped: { dropped: 12 } })).status).toBe('unverified');
  });
});

describe('missing evidence is never a pass', () => {
  it('a hover target whose hover was captured on the original but not on the output is unverified', () => {
    const b = base(sections((v) => A(v, [el(''), finding({ states: v === 'desktop' ? { hover: hoverState(WHITE) } : {} })])));
    const r = verdictOf(target({ state: 'hover' }), b, cap(sections((v) => A(v, null))));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/hover/);
  });

  it('a hover target the original never captured (not interactive, over the cap, unsettled) is unverified', () => {
    expect(unchanged(target({ state: 'hover' })).status).toBe('unverified');
  });

  it('a focus-visible target whose :focus-visible matched differently on the two sides is unverified', () => {
    const fv = (m: boolean) => ({ 'focus-visible': { subtree: { '': WHITE }, focusVisibleMatched: m, effect: true } });
    const b = base(sections((v) => A(v, [el(''), finding({ states: v === 'desktop' ? fv(true) : {} })])));
    const o = cap(sections((v) => A(v, [el(''), finding({ states: v === 'desktop' ? fv(false) : {} })])));
    expect(verdictOf(target({ state: 'focus-visible' }), b, o).status).toBe('unverified');
  });

  it('states the verifier never captures (active, disabled, selected, expanded, error) are unverified', () => {
    for (const state of ['active', 'disabled', 'selected', 'expanded', 'error'] as const) {
      const r = unchanged(target({ state }));
      expect(r.status, state).toBe('unverified');
      expect(r.detail).toMatch(/not captured/);
    }
  });

  it('an explicitly MOBILE hover target is unverified (touch devices have no hover)', () => {
    expect(unchanged(target({ state: 'hover', viewport: { name: 'mobile', width: 390 } })).status).toBe('unverified');
  });

  it('an element in a SKIPPED (hand-authored) section is unverified and never cites other sections\' counts', () => {
    const o = (v: 'desktop' | 'mobile') => A(v, [el(''), finding({ style: WHITE })]);
    const r = verdictOf(target(), base(sections((v) => A(v, null))), cap(sections(o)), [], new Set(['A']));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/hand-authored/);
    expect(r.detail).not.toMatch(/\(\d+ element\(s\) compared\)/);
  });

  it('a section the original could not locate is unverified', () => {
    const b = base([A('desktop', [], { located: false }), A('mobile', [], { located: false }), B('desktop'), B('mobile')]);
    expect(verdictOf(target(), b, cap(sections((v) => A(v, null)))).status).toBe('unverified');
  });

  it('an element whose tag or text changed was not compared and is unverified', () => {
    expect(unchanged(target(), (v) => A(v, [el(''), finding({ tag: 'button' })])).status).toBe('unverified');
    expect(unchanged(target(), (v) => A(v, [el(''), finding({ textHash: 'changed' })])).status).toBe('unverified');
  });

  it('a property the verifier does not measure at all (margin, z-index, grid-template-columns) is unverified', () => {
    for (const property of ['margin-top', 'z-index', 'grid-template-columns']) {
      const r = unchanged(target({ property }));
      expect(r.status, property).toBe('unverified');
      expect(r.detail).toMatch(/not measured/);
    }
  });

  it('no baseline at all: unverified', () => {
    const resolution = resolutionOf(target());
    applyFidelityToTargets(resolution, compareDesign({ baseline: null, observed: null, exemptions: [] }), null);
    expect(resolution.targets[0]!.status.verification).toBe('unverified');
  });
});

describe('a measured difference', () => {
  it('on a preserved property is a failure naming the change', () => {
    const r = unchanged(target(), (v) => A(v, [el(''), finding({ style: WHITE })]));
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/color/);
  });

  it('under an authorization for ANOTHER target is neither verified nor failed: the value did change, so the preserve claim is unverified, with the authorizing target named', () => {
    const ex: Exemption = { findingId: 'F1', property: 'color', part: 'self', state: '*', viewport: 'any', targetId: 'island:F1:color', reason: 'a design-system Button is mounted' };
    const r = verdictOf(target(), base(sections((v) => A(v, null))), cap(sections((v) => A(v, [el(''), finding({ style: WHITE })]))), [ex]);
    expect(r.report.differences.some((d) => d.property === 'color' && d.classification === 'intentional')).toBe(true);
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/island:F1:color/);
  });

  it('a regression on the label part is attributed to a label target, and is NOT blamed on an unrelated part', () => {
    const tree = (v: 'desktop' | 'mobile', labelStyle: typeof BLACK) => A(v, [el(''), finding({ partKeys: { label: ['0/0'], descendants: ['0/0'], named: {} } }), el('0/0', { roles: ['text'], textHash: 'l', label: 'Buy now', style: labelStyle })]);
    const b = base(sections((v) => tree(v, BLACK)));
    const o = cap(sections((v) => tree(v, WHITE)));
    expect(verdictOf(target({ part: 'label' }), b, o).status).toBe('failed');
    expect(verdictOf(target({ part: 'descendant:.x > span' }), b, o).status).toBe('unverified'); // a part the verifier cannot map to a captured element
  });
});

describe('width and height are measured from the box, as evidence only', () => {
  const boxed = (w: number, h: number, over: Partial<CapturedElement> = {}) => (v: 'desktop' | 'mobile') => A(v, [el(''), finding({ box: { w, h }, ...over })]);
  const run = (property: string, o: (v: 'desktop' | 'mobile') => SectionDesign, exemptions: Exemption[] = [], b = boxed(200, 40)) =>
    verdictOf(target({ property }), base(sections(b)), cap(sections(o)), exemptions);
  const pad: Exemption = { findingId: 'F1', property: 'padding', part: 'self', state: 'default', viewport: 'any', targetId: 't-pad', reason: 'resolved target: padding' };

  it('an unchanged box is positive evidence for width and for height', () => {
    expect(run('width', boxed(200, 40)).status).toBe('preserved-verified');
    expect(run('height', boxed(200, 40)).status).toBe('preserved-verified');
    expect(run('width', boxed(200.4, 40)).status).toBe('preserved-verified'); // within the tolerance
  });

  it('a box that changed with no authorized layout change is a failure', () => {
    const r = run('width', boxed(260, 40));
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/from 200px to about 264px/); // the observed 260px is bucketed to 8px (round 2: raw observed boxes stay out of the hashed report)
    expect(run('height', boxed(200, 70)).status).toBe('failed');
  });

  it('a box change that an authorized layout-affecting change on the same element explains is unverified (explained, not attributable)', () => {
    const r = run('width', boxed(260, 40), [pad]);
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/t-pad/);
  });

  it('a baseline captured before box evidence existed cannot be verified: unverified with the reason', () => {
    const r = run('width', boxed(200, 40), [], (v) => A(v, null));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/box/);
  });

  it('box differences are evidence only: they never appear as regressions in the report', () => {
    expect(run('width', boxed(260, 40)).report.differences.filter((d) => d.classification === 'regression')).toEqual([]);
  });
});
