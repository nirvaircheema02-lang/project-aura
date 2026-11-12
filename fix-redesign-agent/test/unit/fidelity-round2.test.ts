import { describe, expect, it } from 'vitest';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { BY_DESIGN_GAP_REASONS, gapSplit } from '../../src/fidelity/coverage.ts';
import { summarizePreserve } from '../../src/fidelity/accounting.ts';
import { evaluatePreserveTargets, applyFidelityToTargets } from '../../src/fidelity/verify.ts';
import type { CapturedElement, DesignBaseline, DesignCapture, FidelityReport, SectionDesign } from '../../src/fidelity/types.ts';
import { checkG2Approval } from '../../src/preview/g2-guard.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';
import type { Exemption } from '../../src/resolution/schema.ts';
import { base, cap, el, hoverState, resolutionOf, sec, target } from '../helpers/fidelity-captures.ts';

/**
 * Round 2 of the fidelity re-review, built from capture literals (no browser). The cases that need a real page are in test/integration/fidelity-round2.test.ts.
 */

const run = (b: DesignBaseline, o: DesignCapture, exemptions: Exemption[] = []): FidelityReport => compareDesign({ baseline: b, observed: o, exemptions, now: () => new Date(0) });
const ok = (id = 'ok'): SectionDesign => sec({ sectionId: id });
const BLACK = { color: 'rgb(0, 0, 0)', 'font-size': '16px' };
const WHITE = { color: 'rgb(255, 255, 255)', 'font-size': '16px' };
const stable = (r: FidelityReport): string => JSON.stringify({ ...r, generatedAt: '' });

describe('round 2 · 1 — a walk cut is a required gap only when it hid something a required check needs', () => {
  const cut = (over: Partial<SectionDesign>) => sec({ walkCut: 5, ...over });

  it('a cut that hid a control: required gap walk-cut, verdict incomplete, classed by-design (the original\'s own shape)', () => {
    const s = cut({ walkHidden: { controls: 1, groups: 0, sticky: 0 } });
    const r = run(base([ok(), s]), cap([ok(), s]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.gaps.find((g) => g.reason === 'walk-cut')).toMatchObject({ required: true, family: 'section' });
    expect(BY_DESIGN_GAP_REASONS.has('walk-cut')).toBe(true);
    expect(gapSplit(r)).toEqual({ actionable: 0, byDesign: 1 });
  });

  it('a cut that hid only decoration is the disclosed sampling count, not a gap', () => {
    const s = cut({ walkHidden: { controls: 0, groups: 0, sticky: 0 } });
    const r = run(base([ok(), s]), cap([ok(), s]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.gaps.some((g) => g.reason === 'walk-cut')).toBe(false);
    expect(r.coverage!.sampling.walkCut).toBe(5);
  });

  it('a baseline from before the cut was counted cannot say what was hidden: required as well (fail closed)', () => {
    const s = cut({});
    const r = run(base([ok(), s]), cap([ok(), s]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.gaps.find((g) => g.reason === 'walk-cut')!.detail).toMatch(/does not say what they hid/);
  });
});

describe('round 2 · 2 — pseudo-elements are compared like element styles, and the sibling limit is disclosed', () => {
  const RED = { content: '""', display: 'block', 'background-color': 'rgb(176, 31, 36)', color: 'rgb(0, 0, 0)', 'border-top-color': 'rgb(0, 0, 0)' };
  const CLEAR = { ...RED, 'background-color': 'rgba(0, 0, 0, 0)' };
  const owner = (over: Partial<CapturedElement> = {}) => el('0', { tag: 'a', label: 'Tile', textHash: 'tile', roles: ['finding', 'interactive'], findingIds: ['F1'], stateAttempt: { hover: 'captured' }, ...over });
  const section = (e: CapturedElement) => sec({ elements: [el(''), e], pseudoCaptured: true });

  it('a default-state ::before that the output lost is a regression on "<key>::before" (property content)', () => {
    const r = run(base([ok(), section(owner({ pseudo: { before: RED } }))]), cap([ok(), section(owner())]));
    expect(r.verdict).toBe('fail');
    expect(r.differences.find((d) => d.classification === 'regression')).toMatchObject({ elementKey: '0::before', category: 'default-style', property: 'content', baseline: '""', observed: 'none' });
  });

  it('a hover ::after whose background was lost is a hover regression on "<key>::after"', () => {
    const hov = (bg: typeof RED) => ({ hover: { subtree: { '': BLACK, '::after': bg }, effect: true } });
    const r = run(base([ok(), section(owner({ pseudo: { after: CLEAR }, states: hov(RED) }))]), cap([ok(), section(owner({ pseudo: { after: CLEAR }, states: hov(CLEAR) }))]));
    expect(r.verdict).toBe('fail');
    expect(r.differences.find((d) => d.classification === 'regression')).toMatchObject({ elementKey: '0::after', category: 'hover', state: 'hover', property: 'background-color' });
  });

  describe('a ::before that paints with the owner\'s colour', () => {
    const ex: Exemption = { findingId: 'F1', property: 'color', part: 'self', state: 'default', viewport: 'any', targetId: 't-color', reason: 'fix the colour' };
    const BRAND = 'rgb(176, 31, 36)';
    const before = (colour: string, fill: string) => ({ ...RED, color: colour, 'border-top-color': colour, 'background-color': fill });
    const pair = (fillB: string, fillO: string) => [
      base([ok(), section(owner({ style: BLACK, pseudo: { before: before('rgb(0, 0, 0)', fillB) } }))]),
      cap([ok(), section(owner({ style: { ...BLACK, color: BRAND }, pseudo: { before: before(BRAND, fillO) } }))]),
    ] as const;

    it('follows an authorized colour change of the owner (a consequence, not a defect); its own fixed fill is untouched', () => {
      const [b, o] = pair('rgb(176, 31, 36)', 'rgb(176, 31, 36)');
      const r = run(b, o, [ex]);
      expect(r.differences.filter((d) => d.classification === 'regression')).toEqual([]);
      expect(r.differences.filter((d) => d.classification === 'intentional' && d.elementKey === '0::before').map((d) => d.property).sort()).toEqual(['border-top-color', 'color']);
    });

    it('a fill that was currentcolor follows too', () => {
      const [b, o] = pair('rgb(0, 0, 0)', BRAND);
      expect(run(b, o, [ex]).differences.filter((d) => d.classification === 'regression')).toEqual([]);
    });

    it('without the authorization the same differences are regressions', () => {
      const [b, o] = pair('rgb(0, 0, 0)', BRAND);
      expect(run(b, o).differences.filter((d) => d.classification === 'regression' && d.elementKey === '0::before').map((d) => d.property).sort()).toEqual(['background-color', 'border-top-color', 'color']);
    });

    it('a fill that changed to something else than the owner\'s colour is a regression even with the authorization', () => {
      const [b, o] = pair('rgb(0, 0, 0)', 'rgb(10, 200, 10)');
      expect(run(b, o, [ex]).differences.filter((d) => d.classification === 'regression').map((d) => d.property)).toEqual(['background-color']);
    });
  });

  it('a mounted component owns its pseudo-elements: no pseudo comparison on an island', () => {
    const r = run(base([ok(), section(owner({ pseudo: { before: RED } }))]), cap([ok(), section(owner({ island: true }))]));
    expect(r.differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
  });

  it('a baseline from before pseudo-elements were measured is not compared on them, and the report says so', () => {
    const legacy = sec({ elements: [el(''), owner()] });
    const r = run(base([ok(), legacy]), cap([ok(), section(owner({ pseudo: { after: RED } }))]));
    expect(r.differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
    expect(r.statesNotCaptured.join(' ')).toMatch(/baseline was captured before pseudo-elements were measured/);
    const current = run(base([section(owner())]), cap([section(owner())]));
    expect(current.statesNotCaptured.join(' ')).not.toMatch(/captured before pseudo-elements/);
  });

  it('every report names the sibling / non-descendant hover limit, whatever baseline it was built on', () => {
    const r = run(base([ok(), ok('b')]), cap([ok(), ok('b')]));
    expect(r.statesNotCaptured.join(' ')).toMatch(/:hover \+ \.x, :hover ~ \.x/);
    expect(r.statesNotCaptured.join(' ')).toMatch(/::before \/ ::after/);
    expect(run(null as unknown as DesignBaseline, cap([ok()])).statesNotCaptured.join(' ')).toMatch(/sibling/);
  });
});

describe('round 2 · 4 — a hover-subtree member gained in the output is disclosed, not required; a missing one stays required', () => {
  const sub = (keys: string[]) => ({ subtree: Object.fromEntries(keys.map((k) => [k, k === '' ? BLACK : { 'background-color': 'rgba(0, 0, 0, 0)' }])), effect: true });
  const card = (keys: string[]) => el('0', { tag: 'a', label: 'Tile', textHash: 'tile', roles: ['finding', 'interactive'], findingIds: ['F1'], stateAttempt: { hover: 'captured' }, states: { hover: sub(keys) } });
  const section = (c: CapturedElement) => sec({ elements: [el(''), c] });

  it('gained: verdict pass, a non-required gap, the hover unit still verified', () => {
    const r = run(base([ok(), section(card(['']))]), cap([ok(), section(card(['', '0']))]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.gaps.find((g) => g.reason === 'state-subtree-member-gained-in-output')).toMatchObject({ required: false });
    expect(r.coverage!.families.hover).toMatchObject({ verified: 1, unverified: 0, notRequired: 1 });
  });

  it('missing: still a required gap', () => {
    const r = run(base([ok(), section(card(['', '0']))]), cap([ok(), section(card(['']))]));
    expect(r.verdict).toBe('incomplete');
  });
});

describe('round 2 · 5 — a preserve decision on a part needs evidence for the CAPTURED members only', () => {
  // <ul F1><li><a>A</a></li><li><a>B</a></li></ul>: the li wrappers have no text, design or role, so only the anchors are captured elements
  const list = (style = BLACK) => (v: 'desktop' | 'mobile') => sec({
    sectionId: 'A', viewport: v,
    elements: [el(''), el('0', { tag: 'ul', label: 'A B', textHash: 'ab', roles: ['finding'], findingIds: ['F1'], style, partKeys: { label: ['0/0/0', '0/1/0'], descendants: ['0/0', '0/0/0', '0/1', '0/1/0'], named: {} } }),
      el('0/0/0', { roles: ['interactive', 'text'], label: 'A', textHash: 'a', style }), el('0/1/0', { roles: ['interactive', 'text'], label: 'B', textHash: 'b', style })],
  });
  const verdictOf = (t: ReturnType<typeof target>, mk = list()) => {
    const b = base([mk('desktop'), mk('mobile'), ok('B')]), o = cap([mk('desktop'), mk('mobile'), ok('B')]);
    const resolution = resolutionOf(t);
    const report = compareDesign({ baseline: b, observed: o, exemptions: [] });
    return { results: evaluatePreserveTargets({ resolution, report, baseline: b, exemptions: [] }), report };
  };

  it('descendants: preserved-verified on the captured members, with the uncaptured wrappers stated as a limit (was: unverified "no comparison available")', () => {
    const { results } = verdictOf(target({ part: 'descendants' }));
    expect(results[0]!.verification).toBe('preserved-verified');
    expect(results[0]!.detail).toMatch(/2 role-less wrapper member\(s\)/);
    expect(results[0]!.evidence.every((e) => e.outcome === 'compared-equal')).toBe(true);
  });

  it('a measured change on a captured member still fails it', () => {
    const b = base([list()('desktop'), list()('mobile'), ok('B')]);
    const o = cap([list()('desktop'), list(WHITE)('mobile'), ok('B')]);
    const resolution = resolutionOf(target({ part: 'descendants' }));
    const report = compareDesign({ baseline: b, observed: o, exemptions: [] });
    const [r] = evaluatePreserveTargets({ resolution, report, baseline: b, exemptions: [] });
    expect(r!.verification).toBe('failed');
  });

  it('a part none of whose members is a captured element, and a part the capture cannot map, stay unverified and are classed BY-DESIGN in the split', () => {
    const wrappersOnly = (v: 'desktop' | 'mobile') => sec({ sectionId: 'A', viewport: v, elements: [el(''), el('0', { tag: 'ul', label: 'A', textHash: 'a', roles: ['finding'], findingIds: ['F1'], partKeys: { label: [], descendants: ['0/0'], named: {} } })] });
    const none = verdictOf(target({ part: 'descendants' }), wrappersOnly).results;
    const unknown = verdictOf(target({ part: 'icon' })).results;
    expect([none[0]!.verification, unknown[0]!.verification]).toEqual(['unverified', 'unverified']);
    expect(none[0]!.reason).toBe('part cannot be mapped');
    expect(unknown[0]!.reason).toBe('part cannot be mapped');
    const s = summarizePreserve([...none, ...unknown]);
    expect(s).toMatchObject({ unverified: 2, byDesign: 2 });
  });

  it('"no comparison available" is by-design too', () => {
    const b = base([list()('desktop'), list()('mobile'), ok('B')]);
    const report = compareDesign({ baseline: b, observed: cap([list()('desktop'), list()('mobile'), ok('B')]), exemptions: [] });
    delete (report as { coverage?: unknown }).coverage;
    const results = evaluatePreserveTargets({ resolution: resolutionOf(target()), report, baseline: b, exemptions: [] });
    expect(results[0]).toMatchObject({ verification: 'unverified', reason: 'no comparison available' });
    expect(summarizePreserve(results).byDesign).toBe(1);
  });
});

describe('round 2 · 6 — the hashed report does not flap on a rounding boundary', () => {
  const pill = (box: { w: number; h: number }) => (v: 'desktop' | 'mobile') => sec({ sectionId: 'A', viewport: v, elements: [el(''), el('0', { tag: 'a', label: 'Pill', textHash: 'pill', roles: ['finding', 'interactive'], findingIds: ['F1'], box })] });
  const reportFor = (observed: { w: number; h: number }) => compareDesign({ baseline: base([pill({ w: 200, h: 40 })('desktop'), pill({ w: 200, h: 40 })('mobile')]), observed: cap([pill(observed)('desktop'), pill(observed)('mobile')]), exemptions: [], now: () => new Date(0) });

  it('200 vs 201 (a 200.49px and a 200.51px layout) hash identically, and the evidence keeps only the verdict beside the baseline box', () => {
    const [a, b] = [reportFor({ w: 200, h: 40 }), reportFor({ w: 201, h: 40 })];
    expect(stable(a)).toBe(stable(b));
    const ev = a.coverage!.elements.find((e) => e.elementKey === '0')!;
    expect(ev.box).toEqual({ baseline: { w: 200, h: 40 }, equal: { w: true, h: true } });
  });

  it('a changed width carries the observed size bucketed to 8px, and the preserve detail says "about"', () => {
    const b = base([pill({ w: 200, h: 40 })('desktop'), pill({ w: 200, h: 40 })('mobile')]);
    const o = cap([pill({ w: 297, h: 40 })('desktop'), pill({ w: 297, h: 40 })('mobile')]);
    const report = compareDesign({ baseline: b, observed: o, exemptions: [] });
    expect(report.coverage!.elements.find((e) => e.elementKey === '0')!.box).toEqual({ baseline: { w: 200, h: 40 }, equal: { w: false, h: true }, changedTo: { w: 296 } });
    const [r] = evaluatePreserveTargets({ resolution: resolutionOf(target({ property: 'height' })), report, baseline: b, exemptions: [] });
    expect(r!.verification).toBe('preserved-verified'); // the height held
    const [w] = evaluatePreserveTargets({ resolution: resolutionOf(target({ property: 'width' })), report, baseline: b, exemptions: [] });
    expect(w!.verification).toBe('failed');
    expect(w!.detail).toMatch(/from 200px to about 296px/);
  });
});

describe('round 2 · 7 — the G2 approval note', () => {
  const verification = (over: Partial<PreviewVerification> = {}): PreviewVerification => ({
    schemaVersion: 1, generatedAt: 't', url: 'http://x', mode: 'full-page', expectedSectionIds: ['s'], renderedSectionIds: ['s'], checks: [], findings: [], interactions: [], unavailable: [], simulated: [],
    summary: { passed: 1, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
  });
  const opts = { acceptPreviewFailures: true, note: null as string | null, verificationPath: '/v.json', redesignRunId: 'r' };
  const fid = (over: Partial<NonNullable<PreviewVerification['fidelity']>>): NonNullable<PreviewVerification['fidelity']> => ({ verdict: 'fail', requiredTotal: 40, requiredVerified: 38, requiredFailed: 2, requiredUnverified: 0, actionable: 0, byDesign: 0, open: [], ...over });

  it('a fidelity FAIL with nothing unverified never says "0 of N ... unverified"', () => {
    const r = checkG2Approval(verification({ verdict: 'fail', checks: [{ id: 'fidelity.design-state', group: 'fidelity', name: 'n', status: 'fail', detail: 'd' }], fidelity: fid({ open: ['design/state fidelity: 2 regression(s)'] }) }), opts);
    const note = r.ok ? (r.note ?? '') : '';
    expect(note).toMatch(/ACCEPTED FAILED PREVIEW CHECKS: fidelity.design-state/);
    expect(note).not.toMatch(/UNVERIFIED/);
    expect(note).not.toMatch(/0 of 40/);
  });

  it('open required lines with nothing unverified in the coverage are still acknowledged as unverified required checks (one label for every unverified requirement), without a zero count', () => {
    const r = checkG2Approval(verification({ fidelity: fid({ verdict: 'pass', requiredFailed: 0, requiredVerified: 40, open: ['1 of 1 resolved target(s) not verified'] }) }), opts);
    const note = r.ok ? (r.note ?? '') : '';
    expect(note).toMatch(/ACKNOWLEDGED UNVERIFIED REQUIRED CHECKS: 1 required check\(s\) not verified/);
    expect(note).toMatch(/1 of 1 resolved target/);
    expect(note).not.toMatch(/0 of 40/);
  });

  it('unverified checks keep the counts and the split', () => {
    const r = checkG2Approval(verification({ fidelity: fid({ verdict: 'incomplete', requiredFailed: 0, requiredVerified: 37, requiredUnverified: 3, actionable: 2, byDesign: 1, open: ['x'] }) }), opts);
    expect(r.ok && r.note).toMatch(/3 of 40 required fidelity check\(s\) unverified \(2 actionable \/ 1 by-design\)/);
  });
});

describe('round 2 · 10 — a removed LABEL whose successor slid into its key', () => {
  const finding = (v: 'desktop' | 'mobile', kids: CapturedElement[]) => sec({
    sectionId: 'A', viewport: v,
    elements: [el(''), el('0', { tag: 'a', label: 'Buy Now', textHash: 'bn', roles: ['finding', 'interactive'], findingIds: ['F1'], partKeys: { label: ['0/0', '0/1'], descendants: ['0/0', '0/1'], named: {} } }), ...kids],
  });
  const label = (key: string, text: string, tag = 'span') => el(key, { tag, label: text, textHash: `h-${text}`, roles: ['text'] });
  const b = (v: 'desktop' | 'mobile') => finding(v, [label('0/0', 'Buy'), label('0/1', 'Now')]);
  const check = (out: (v: 'desktop' | 'mobile') => SectionDesign, part = 'label') => {
    const baseline = base([b('desktop'), b('mobile'), ok('B')]);
    const observed = cap([out('desktop'), out('mobile'), ok('B')]);
    const resolution = resolutionOf(target({ part }));
    const report = compareDesign({ baseline, observed, exemptions: [] });
    applyFidelityToTargets(resolution, report, baseline, []);
    return { report, status: resolution.targets[0]!.status.verification, detail: resolution.targets[0]!.status.verificationDetail ?? '' };
  };

  it('the finding element is still there but nothing under it has the label text: a confirmed removal (failed), and a regression (was: unverified "element text changed")', () => {
    const r = check((v) => finding(v, [label('0/0', 'Sale'), label('0/1', 'Now')]));
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/removed/i);
    expect(r.report.differences.some((d) => d.category === 'element-unmatched' && d.elementKey === '0/0' && d.classification === 'regression')).toBe(true);
  });

  it('the text turned up elsewhere under the finding: it only moved, so it stays unverified', () => {
    const r = check((v) => finding(v, [label('0/0', 'Sale'), label('0/1', 'Now'), label('0/2', 'Buy')]));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/text of/);
    expect(r.report.differences.some((d) => d.elementKey === '0/0' && d.classification === 'regression')).toBe(false);
  });

  it('the finding element itself is gone from the output: not judged here (unverified)', () => {
    const r = check((v) => sec({ sectionId: 'A', viewport: v, elements: [el(''), el('0', { tag: 'div', label: 'x', textHash: 'x', roles: ['design'] }), label('0/0', 'Sale'), label('0/1', 'Now')] }));
    expect(r.report.differences.some((d) => d.elementKey === '0/0' && d.classification === 'regression')).toBe(false);
  });

  it('an output that hit the element cap cannot confirm it', () => {
    const r = check((v) => ({ ...finding(v, [label('0/0', 'Sale'), label('0/1', 'Now')]), capped: { dropped: 3 } }));
    expect(r.status).toBe('unverified');
  });
});
