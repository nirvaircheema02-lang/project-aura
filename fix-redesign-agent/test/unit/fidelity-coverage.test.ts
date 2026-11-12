import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baselineHashOf, readBaseline } from '../../src/fidelity/capture.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import type { CoverageFamily, DesignBaseline, DesignCapture, FidelityReport, SectionDesign } from '../../src/fidelity/types.ts';
import { requiredChecksOpen } from '../../src/preview/correct.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';
import { base, cap, el, hoverState, sec, sticky } from '../helpers/fidelity-captures.ts';

/**
 * ONE coverage model: every check the verifier sets out to run is verified, failed or unverified, and `pass` exists only when no
 * REQUIRED check is unverified. These cases are built from capture literals (no browser) and use only the public entry points.
 */

const verification = (): PreviewVerification => ({
  schemaVersion: 1, generatedAt: 't', url: 'http://x', mode: 'full-page', expectedSectionIds: ['s'], renderedSectionIds: ['s'], checks: [], findings: [], interactions: [], unavailable: [], simulated: [],
  summary: { passed: 1, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass',
});

const run = (b: DesignBaseline, o: DesignCapture, extra: { overrideSectionIds?: ReadonlySet<string> } = {}) => compareDesign({ baseline: b, observed: o, exemptions: [], now: () => new Date(0), ...extra });
const FAMILIES: CoverageFamily[] = ['section', 'element', 'hover', 'focus-visible', 'composition', 'sticky'];
/** A second, fully compared section so that "nothing was compared" never masks the case under test. */
const ok = (id = 'ok'): SectionDesign => sec({ sectionId: id });
const open = (r: FidelityReport) => requiredChecksOpen(verification(), r, null);

describe('sticky pin/release', () => {
  const dead = sticky([false, false, false, false, false]);

  it('a trace that could not be measured on either page is NEVER a fully verified result', () => {
    const r = run(base([ok(), sec({ sticky: [dead] })]), cap([ok(), sec({ sticky: [dead] })]));
    expect(r.unavailable.join(' ')).toMatch(/sticky element .* could not be traced/);
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.sticky).toMatchObject({ required: 1, verified: 0, failed: 0, unverified: 1, reasons: { 'sticky-no-comparable-position': 1 } });
    expect(open(r).join(' ')).toMatch(/INCOMPLETE.*sticky/i);
  });

  it('a trace with only some comparable positions is unverified (sticky-partial), not verified', () => {
    const part = sticky([false, true, true, false, false]);
    const r = run(base([ok(), sec({ sticky: [part] })]), cap([ok(), sec({ sticky: [part] })]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.sticky).toMatchObject({ required: 1, verified: 0, unverified: 1, reasons: { 'sticky-partial': 1 } });
  });

  it('a comparable position that DIFFERS is a failure of that check (not unverified); the verified checks of other families stay counted', () => {
    const r = run(base([ok(), sec({ sticky: [sticky([false, true, true, false, false], [0, 24, 24, 0, 0])] })]), cap([ok(), sec({ sticky: [sticky([false, true, true, false, false], [0, 24, 300, 0, 0])] })]));
    expect(r.verdict).toBe('fail');
    expect(r.coverage!.families.sticky).toMatchObject({ required: 1, verified: 0, failed: 1, unverified: 0 });
    expect(r.coverage!.families.element.verified).toBeGreaterThan(0);
  });

  it('five comparable, equal positions are verified and the result is a pass (no over-reporting)', () => {
    const r = run(base([ok(), sec({ sticky: [sticky()] })]), cap([ok(), sec({ sticky: [sticky()] })]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.families.sticky).toMatchObject({ required: 1, verified: 1, failed: 0, unverified: 0 });
    expect(open(r)).toEqual([]);
  });

  it('an element that never pins (every inset auto) was dropped at capture and is disclosed, not required', () => {
    const r = run(base([ok(), sec({ sticky: [], stickyInert: 2 } as Partial<SectionDesign>)]), cap([ok(), sec({ sticky: [] })]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.sampling.stickyInert).toBe(2);
  });

  it('a pin candidate dropped by the capture cap is a required gap', () => {
    const r = run(base([ok(), sec({ stickyDropped: 3 } as Partial<SectionDesign>)]), cap([ok(), sec()]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.sticky.reasons).toMatchObject({ 'sticky-candidate-cap': 1 });
  });
});

describe('group composition', () => {
  const group = { parentKey: '', childKeys: ['0', '1', '2'], columns: 3, rows: 1, visualOrder: [0, 1, 2], topOffsets: [0, 0, 0], widthRatios: [0.3, 0.3, 0.3] };

  it('a baseline group that is not detected in the output is an unverified composition check', () => {
    const r = run(base([ok(), sec({ groups: [group] })]), cap([ok(), sec()]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.composition).toMatchObject({ required: 1, verified: 0, unverified: 1, reasons: { 'group-not-detected-in-output': 1 } });
  });

  it('a group inside a mounted design-system component is the component\'s own design: disclosed, not required', () => {
    const b = base([ok(), sec({ elements: [el(''), el('1'), el('1/0')], groups: [{ ...group, parentKey: '1/0' }] })]);
    const o = cap([ok(), sec({ elements: [el(''), el('1', { island: true }), el('1/0')] })]);
    const r = run(b, o);
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.families.composition).toMatchObject({ required: 0, notRequired: 1 });
  });

  it('a detected, identical group is verified; a changed one is a failure', () => {
    const same = run(base([ok(), sec({ groups: [group] })]), cap([ok(), sec({ groups: [group] })]));
    expect(same.coverage!.families.composition).toMatchObject({ required: 1, verified: 1 });
    expect(same.verdict).toBe('pass');
    const changed = run(base([ok(), sec({ groups: [group] })]), cap([ok(), sec({ groups: [{ ...group, columns: 1, rows: 3 }] })]));
    expect(changed.verdict).toBe('fail');
    expect(changed.coverage!.families.composition).toMatchObject({ required: 1, failed: 1, unverified: 0 });
  });
});

describe('hover and keyboard focus', () => {
  const withAttempt = (hover: 'captured' | 'unsettled' | 'not-hoverable' | 'sample-cap' | 'budget-stopped', findingIds: string[] = []) =>
    sec({ elements: [el(''), el('0', { roles: findingIds.length ? ['finding', 'interactive'] : ['interactive'], findingIds, stateAttempt: { hover } } as never)], coverage: { hover: { attempted: 1, captured: 0 }, focusVisible: { attempted: 0, captured: 0 } } });
  const observedPlain = (findingIds: string[] = []) => sec({ elements: [el(''), el('0', { roles: findingIds.length ? ['finding', 'interactive'] : ['interactive'], findingIds })] });

  it('a finding element whose hover could not be settled on the ORIGINAL leaves the required hover check unverified', () => {
    const r = run(base([ok(), withAttempt('unsettled', ['F1'])]), cap([ok(), observedPlain(['F1'])]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover).toMatchObject({ required: 1, unverified: 1, reasons: { 'state-unsettled-on-original': 1 } });
  });

  it('the same gap on an element no finding touches is disclosed (with numbers) but does not block, and is still listed', () => {
    const r = run(base([ok(), withAttempt('unsettled')]), cap([ok(), observedPlain()]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.families.hover).toMatchObject({ required: 0, notRequired: 1 });
    expect(r.coverage!.gaps.filter((g) => !g.required).map((g) => g.reason)).toEqual(['state-unsettled-on-original']);
  });

  it('beyond the sampling cap is sampling for ordinary elements, and a required gap for a finding element', () => {
    expect(run(base([ok(), withAttempt('sample-cap')]), cap([ok(), observedPlain()])).verdict).toBe('pass');
    const r = run(base([ok(), withAttempt('sample-cap', ['F1'])]), cap([ok(), observedPlain(['F1'])]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'state-not-sampled-cap': 1 });
  });

  it('a legacy baseline (counters only) with attempted > captured cannot say which element: one aggregate required gap', () => {
    const legacy = sec({ coverage: { hover: { attempted: 2, captured: 1 }, focusVisible: { attempted: 0, captured: 0 } } });
    const r = run(base([ok(), legacy]), cap([ok(), sec()]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'baseline-legacy-counters': 1 });
  });

  it('a state captured on the original but not on the output stays a not-checkable difference and leaves the check unverified', () => {
    const b = sec({ elements: [el(''), el('0', { roles: ['interactive'], states: { hover: hoverState({ color: 'rgb(255, 255, 255)' }) } })] });
    const r = run(base([ok(), b]), cap([ok(), observedPlain()]));
    expect(r.differences.some((d) => d.category === 'state-unavailable' && d.classification === 'not-checkable')).toBe(true);
    expect(r.unavailable.join(' ')).toMatch(/not claimed as preserved/);
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'state-uncaptured-on-output': 1 });
  });

  it('a state with NO effect on the original that is missing on the output fails closed too (a gained effect cannot be ruled out)', () => {
    const b = sec({ elements: [el(''), el('0', { roles: ['interactive'], states: { hover: hoverState({ color: 'rgb(0, 0, 0)' }, false) } })] });
    expect(run(base([ok(), b]), cap([ok(), observedPlain()])).verdict).toBe('incomplete');
  });

  it('a hover captured on both sides and equal is verified; the verified results are kept next to an unverified focus-visible', () => {
    const states = (matched: boolean) => ({ hover: hoverState({ color: 'rgb(255, 255, 255)' }), 'focus-visible': { subtree: { '': { color: 'rgb(0, 0, 0)' } }, focusVisibleMatched: matched, effect: true } });
    const r = run(base([ok(), sec({ elements: [el(''), el('0', { roles: ['interactive'], states: states(true) })] })]), cap([ok(), sec({ elements: [el(''), el('0', { roles: ['interactive'], states: states(false) })] })]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover).toMatchObject({ required: 1, verified: 1, unverified: 0 });
    expect(r.coverage!.families['focus-visible']).toMatchObject({ required: 1, verified: 0, unverified: 1, reasons: { 'focus-visible-mismatch': 1 } });
  });
});

describe('elements, sections and hand-authored overrides', () => {
  const finding = (over: Partial<ReturnType<typeof el>> = {}) => el('0', { roles: ['finding', 'interactive'], findingIds: ['F1'], ...over });
  const one = (e: ReturnType<typeof el>, extra: Partial<SectionDesign> = {}) => sec({ elements: [el(''), e], ...extra });

  it('a required element at a position whose tag changed is unverified (tag-mismatch), not silently passed', () => {
    const r = run(base([ok(), one(finding())]), cap([ok(), one(finding({ tag: 'button' }))]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.element.reasons).toMatchObject({ 'tag-mismatch': 1 });
  });

  it('a required element whose text changed is unverified (text-mismatch) — previously not recorded at all', () => {
    const r = run(base([ok(), one(finding())]), cap([ok(), one(finding({ textHash: 'other' }))]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.element.reasons).toMatchObject({ 'text-mismatch': 1 });
  });

  it('a plain text element whose text changed is only disclosed', () => {
    const r = run(base([ok(), one(el('0', { roles: ['text'] }))]), cap([ok(), one(el('0', { roles: ['text'], textHash: 'other' }))]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.families.element.notRequired).toBe(1);
  });

  it('an element the capped output did not capture is unverified (output-element-cap)', () => {
    const r = run(base([ok(), one(finding())]), cap([ok(), sec({ elements: [el('')], capped: { dropped: 9 } })]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.element.reasons).toMatchObject({ 'output-element-cap': 1 });
  });

  it('an interactive/group element that is simply gone from the output is unverified structurally, not skipped', () => {
    const r = run(base([ok(), sec({ elements: [el(''), el('0', { roles: ['group-item'] })] })]), cap([ok(), sec({ elements: [el('')] })]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.element.reasons).toMatchObject({ 'missing-in-output-structural': 1 });
  });

  it('a section that could not be located on the original is a required gap next to a compared one', () => {
    const r = run(base([ok(), sec({ sectionId: 'b', located: false, elements: [] })]), cap([ok(), sec({ sectionId: 'b' })]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.section.reasons).toMatchObject({ 'section-not-located-on-original': 1 });
  });

  it('a hand-authored section is a required unverified gap on BOTH viewports (its own checks cover it; this verifier did not)', () => {
    const r = run(base([ok(), sec({ sectionId: 'h' }), sec({ sectionId: 'h', viewport: 'mobile' })]), cap([ok(), sec({ sectionId: 'h' }), sec({ sectionId: 'h', viewport: 'mobile' })]), { overrideSectionIds: new Set(['h']) });
    expect(r.unavailable.join(' ')).toMatch(/h: a hand-authored section/);
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.section.reasons).toMatchObject({ 'hand-authored-override': 2 });
  });

  it('a capture stopped by the verification BUDGET is unverified, never a "not rendered" regression', () => {
    const stopped = sec({ sectionId: 'b', located: false, elements: [], notes: ['capture stopped: the overall verification budget was exhausted'], stopped: 'budget' } as Partial<SectionDesign>);
    const r = run(base([ok(), sec({ sectionId: 'b' })]), cap([ok(), stopped]));
    expect(r.differences.filter((d) => d.classification === 'regression')).toEqual([]);
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.section.reasons).toMatchObject({ 'section-not-captured-budget': 1 });
  });

  it('a section that is simply not rendered stays a regression', () => {
    const r = run(base([ok(), sec({ sectionId: 'b' })]), cap([ok()]));
    expect(r.verdict).toBe('fail');
    expect(r.coverage!.families.section).toMatchObject({ failed: 1 });
  });
});

describe('the ledger is one model', () => {
  const dead = sticky([false, false, false, false, false]);
  const mixed = () => {
    const b = base([ok(), sec({ elements: [el(''), el('0', { roles: ['interactive'], style: { color: 'rgb(0, 0, 0)' } })], sticky: [dead] })]);
    const o = cap([ok(), sec({ elements: [el(''), el('0', { roles: ['interactive'], style: { color: 'rgb(200, 0, 0)' } })], sticky: [dead] })]);
    return run(b, o);
  };

  it('verified, failed and unverified are mutually exclusive and add up, per family and in total; a regression wins the verdict but the gap stays listed', () => {
    const r = mixed();
    expect(r.verdict).toBe('fail');
    const c = r.coverage!;
    for (const f of FAMILIES) expect(c.families[f].required).toBe(c.families[f].verified + c.families[f].failed + c.families[f].unverified);
    const sum = (k: 'required' | 'verified' | 'failed' | 'unverified') => FAMILIES.reduce((n, f) => n + c.families[f][k], 0);
    expect(c).toMatchObject({ requiredTotal: sum('required'), requiredVerified: sum('verified'), requiredFailed: sum('failed'), requiredUnverified: sum('unverified') });
    expect(c.families.element.failed).toBe(1);
    expect(c.families.sticky.unverified).toBe(1);
    expect(c.gaps.some((g) => g.family === 'sticky' && g.required)).toBe(true);
  });

  it('is deterministic: no clocks, sorted gaps, identical JSON on a repeat', () => {
    expect(JSON.stringify(mixed().coverage)).toBe(JSON.stringify(mixed().coverage));
  });

  it('`pass` always means zero required-unverified (the invariant every consumer relies on)', () => {
    for (const r of [run(base([ok()]), cap([ok()])), run(base([ok(), sec({ sticky: [sticky()] })]), cap([ok(), sec({ sticky: [sticky()] })]))]) {
      expect(r.verdict).toBe('pass');
      expect(r.coverage!.requiredUnverified).toBe(0);
    }
  });

  it('the gap list is capped, with the remainder counted', () => {
    const many = Array.from({ length: 230 }, (_v, i) => el(String(i), { roles: ['group-item'] }));
    const r = run(base([ok(), sec({ elements: [el(''), ...many] })]), cap([ok(), sec({ elements: [el('')] })]));
    expect(r.coverage!.requiredUnverified).toBe(230);
    expect(r.coverage!.gaps.length).toBe(200);
    expect(r.coverage!.gapsTruncated).toBe(30);
  });
});

describe('a baseline captured before this model existed', () => {
  // no `padded`, no `box`, no `stateAttempt`, no `eligible`: the shape every baseline written so far has
  const legacy = () => {
    const c = cap([sec({ sectionId: 'ok' }), sec({ sticky: [sticky([false, true, true, false, false])], coverage: { hover: { attempted: 3, captured: 2 }, focusVisible: { attempted: 0, captured: 0 } } })]);
    return { ...c, baselineSha256: baselineHashOf(c) };
  };

  it('still loads and verifies against its own hash (FIDELITY_SCHEMA_VERSION is unchanged)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fra-legacy-')), 'design-baseline.json');
    writeFileSync(path, JSON.stringify(legacy()));
    expect(await readBaseline(path)).not.toBeNull();
  });

  it('is compared honestly: the evidence it lacks yields unverified gaps (never a pass), with the reason', () => {
    const b = legacy();
    const r = compareDesign({ baseline: b, observed: cap([sec({ sectionId: 'ok' }), sec({ sticky: [sticky([false, true, true, false, false])] })]), exemptions: [], now: () => new Date(0) });
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.sticky.reasons).toMatchObject({ 'sticky-partial': 1 });
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'baseline-legacy-counters': 1 });
    expect(r.unavailable.join(' ')).toMatch(/captured without scroll padding/);
  });
});
