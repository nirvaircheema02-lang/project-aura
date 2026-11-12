import { describe, expect, it } from 'vitest';
import { toPlannerFeedback, type AttributionContext } from '../../src/fidelity/feedback.ts';
import { emptyCoverage } from '../../src/fidelity/coverage.ts';
import { guardKey } from '../../src/fidelity/guard.ts';
import { BudgetTracker } from '../../src/fidelity/loop.ts';
import type { FidelityDifference, FidelityReport } from '../../src/fidelity/types.ts';
import { correctionsFrom, correctionsToJson, emptyCorrections, feedbackOf, requiredChecksOpen, verifyAndCorrect, type CorrectionSet } from '../../src/preview/correct.ts';
import type { FindingOutcome, PreviewVerification } from '../../src/preview/types.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { base as baselineOf, cap as captureOf, sec, sticky } from '../helpers/fidelity-captures.ts';

/**
 * The bounded correction loop with the verification injected: each stop reason (passed / blocked / no progress / budget / planner)
 * is reached by a real sequence of verify → feedback → correct → recheck, and "nothing left to correct" is never mistaken for "verified".
 */

const diff = (over: Partial<FidelityDifference> = {}): FidelityDifference => ({
  id: 'd-hover-bg', sectionId: 'cards', viewport: 'desktop', elementKey: 'a:0', elementLabel: 'Alpha card', category: 'hover', state: 'hover', property: 'background-color',
  baseline: 'rgb(255, 255, 255)', observed: 'rgb(17, 17, 17)', classification: 'regression', findingIds: ['f1'], exemptionTargetId: null, detail: 'x', ...over,
});

function report(differences: FidelityDifference[], over: Partial<FidelityReport> = {}): FidelityReport {
  const regressions = differences.filter((d) => d.classification === 'regression').length;
  return {
    schemaVersion: 1, generatedAt: 't', baselineSha256: 'b'.repeat(64), baselineHtmlSha256: null, observedSource: null, differences, unavailable: [], statesNotCaptured: [],
    summary: { sections: 1, sectionsCompared: 1, elementsCompared: 12, statesCompared: { default: 12, hover: 4, 'focus-visible': 2 }, intentional: 0, regressions, notCheckable: 0 },
    // a hand-built report carries the (empty) coverage a real comparison always records: a `pass` without any is treated as incomplete (fail closed)
    verdict: regressions ? 'fail' : 'pass', coverage: emptyCoverage(), ...over,
  };
}

const finding = (over: Partial<FindingOutcome> = {}): FindingOutcome => ({ findingId: 'f1', section: 'cards', type: 'card', label: 'Alpha card', status: 'fixed-verified', route: 'css-edit', detail: 'ok', ...over });

function verification(over: Partial<PreviewVerification> = {}): PreviewVerification {
  return {
    schemaVersion: 1, generatedAt: 't', url: 'http://x', mode: 'full-page', expectedSectionIds: ['cards'], renderedSectionIds: ['cards'], checks: [], findings: [finding()], interactions: [], unavailable: [], simulated: [],
    summary: { passed: 1, failed: 0, notChecked: 0, findingsVerified: 1, findingsTotal: 1, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
  };
}

const attribution = (over: Partial<AttributionContext> = {}): AttributionContext => ({ editsByFinding: new Map([['f1', [{ property: 'background-color', kind: 'style' }]]]), islandFindingIds: new Set(), overrideSectionIds: new Set(), ...over });

const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  id: 't1', findingId: 'f1', property: 'border-top-left-radius', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
  audit: { status: 'DIFFERENT', actual: '4px', expected: '8px', expectedToken: null, note: null, source: 'atoms/Card.tsx' }, reason: 'audit-expected-present', outcome: 'resolved-target',
  target: { value: '8px', comparison: 'length-px', token: null }, provenance: { kind: 'audit-expected', ds: null, reference: null, evidence: [] }, decisionReason: 'audit', route: 'css-edit', acceptance: [],
  status: { design: 'resolved', implementation: 'applied', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
});

const resolutionOf = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });

const budget = (maxCycles = 2, maxVerifications = 4) => new BudgetTracker({ maxCycles, maxVerifications, maxDurationMs: null });

interface Attempt { corrections: CorrectionSet }

/** `outcomeFor` decides what the (injected) rendered preview looks like under the corrections in force. */
function harness(outcomeFor: (c: CorrectionSet, run: number) => { fidelity: FidelityReport; verification?: PreviewVerification; attribution?: AttributionContext }) {
  const seen: CorrectionSet[] = [];
  let run = 0;
  return {
    seen,
    args: (b: BudgetTracker, resolution: ResolutionFile | null = null) => ({
      initial: emptyCorrections(), budget: b, resolution,
      produce: async (c: CorrectionSet): Promise<Attempt> => { seen.push({ stateGuards: new Set(c.stateGuards), droppedEdits: new Set(c.droppedEdits), droppedIslands: new Set(c.droppedIslands) }); return { corrections: c }; },
      verify: async (a: Attempt) => { const o = outcomeFor(a.corrections, ++run); return { verification: o.verification ?? verification(), fidelity: o.fidelity, attribution: o.attribution ?? attribution() }; },
    }),
  };
}

describe('verifyAndCorrect — the loop', () => {
  it('a hover regression from a replayed edit is routed to a state guard, re-rendered and rechecked until it passes', async () => {
    const h = harness((c) => ({ fidelity: report(c.stateGuards.has(guardKey('f1', 'background-color')) ? [] : [diff()]) }));
    const b = budget();
    const out = await verifyAndCorrect(h.args(b));
    expect(out.stopReason).toBe('passed');
    expect(out.cycles).toHaveLength(1);
    expect(out.cycles[0]!.applied).toEqual(['state-guard f1/background-color']);
    expect(correctionsToJson(out.corrections).stateGuards).toEqual(['f1|background-color']);
    expect(h.seen).toHaveLength(2); // rendered once, corrected, rendered again
    expect(h.seen[0]!.stateGuards.size).toBe(0);
    expect(out.final!.fidelity.verdict).toBe('pass');
    expect(b.cycles).toBe(1);
    expect(b.verifications).toBe(2);
  });

  it('stops on NO PROGRESS when a correction does not remove what was open, and reports what is still open', async () => {
    const h = harness(() => ({ fidelity: report([diff()]) }));
    const out = await verifyAndCorrect(h.args(budget(5, 9)));
    expect(out.stopReason).toBe('no-progress');
    expect(out.cycles).toHaveLength(1); // one attempt, then it recognised the same defect
    expect(out.open.map((o) => o.id)).toEqual(['d-hover-bg']);
    expect(out.final!.fidelity.verdict).toBe('fail'); // never relabelled
  });

  it('stops when the BUDGET is exhausted — with the reason — even while new items keep appearing', async () => {
    const h = harness((c) => ({ fidelity: report([diff({ id: `d-${c.stateGuards.size}-${c.droppedIslands.size}`, property: c.stateGuards.size === 0 ? 'background-color' : 'color' })], {}), attribution: attribution({ editsByFinding: new Map([['f1', [{ property: 'background-color', kind: 'style' }, { property: 'color', kind: 'style' }]]]) }) }));
    const out = await verifyAndCorrect(h.args(budget(1, 9)));
    expect(out.stopReason).toBe('budget-exhausted');
    expect(out.budgetReason).toBe('cycles');
    expect(out.cycles).toHaveLength(1);
    expect(out.open.length).toBeGreaterThan(0);
  });

  it('the verification budget caps re-rendering too', async () => {
    const h = harness((c) => ({ fidelity: report([diff({ id: `d${c.stateGuards.size}`, property: ['background-color', 'color', 'border-top-color'][c.stateGuards.size % 3]! })]), attribution: attribution({ editsByFinding: new Map([['f1', ['background-color', 'color', 'border-top-color'].map((property) => ({ property, kind: 'style' }))]]) }) }));
    const b = budget(9, 2);
    const out = await verifyAndCorrect(h.args(b));
    expect(out.stopReason).toBe('budget-exhausted');
    expect(out.budgetReason).toBe('verifications');
    expect(b.verifications).toBe(2);
  });

  it('what only the planner can fix is returned for it, with element, state, expected and observed — no preview cycle is spent', async () => {
    const h = harness(() => ({ fidelity: report([diff({ id: 'd-default-radius', category: 'default-style', state: 'default', property: 'border-top-left-radius', baseline: '12px', observed: '4px' })], {}), attribution: attribution({ editsByFinding: new Map([['f1', [{ property: 'border-radius', kind: 'style' }]]]) }) }));
    const b = budget();
    const out = await verifyAndCorrect(h.args(b));
    expect(out.stopReason).toBe('planner-needed');
    expect(out.cycles).toHaveLength(0);
    expect(b.cycles).toBe(0);
    const fb = out.plannerFeedback[0]!;
    expect(fb).toMatchObject({ responsible: 'planner', state: 'default', viewport: 'desktop', property: 'border-top-left-radius', expected: '12px', observed: '4px', findingIds: ['f1'] });
    expect(fb.action).toMatchObject({ type: 'replan', findingIds: ['f1'] });
    expect(fb.message).toMatch(/Alpha card.*border-top-left-radius should be 12px.*but is 4px/);
  });

  it('a regression nothing can correct is BLOCKED with the concrete reason, and stays open', async () => {
    const h = harness(() => ({ fidelity: report([diff({ findingIds: [] })]), attribution: attribution({ editsByFinding: new Map() }) }));
    const out = await verifyAndCorrect(h.args(budget()));
    expect(out.stopReason).toBe('blocked');
    expect(out.open[0]!.action).toBeNull();
    expect(out.open[0]!.blockedReason).toMatch(/generator itself|no authorized/);
    expect(out.cycles).toHaveLength(0);
  });

  it('a design-system component that does not measure up is dropped for the original element, then rechecked', async () => {
    const failing = verification({ findings: [finding({ route: 'island', status: 'unresolved', detail: 'padding not matching the expected value' })] });
    const h = harness((c) => ({ fidelity: report([]), verification: c.droppedIslands.has('f1') ? verification() : failing }));
    const out = await verifyAndCorrect(h.args(budget()));
    expect(out.stopReason).toBe('passed');
    expect(out.cycles[0]!.applied).toEqual(['drop-island f1']);
    expect(correctionsToJson(out.corrections).droppedIslands).toEqual(['f1']);
  });

  it('corrections already decided are the starting point of a resumed run', async () => {
    const h = harness(() => ({ fidelity: report([]) }));
    const out = await verifyAndCorrect({ ...h.args(budget()), initial: correctionsFrom({ stateGuards: ['f1|background-color'], droppedEdits: [], droppedIslands: [] }) });
    expect(out.stopReason).toBe('passed');
    expect(h.seen[0]!.stateGuards.has('f1|background-color')).toBe(true);
    expect(out.cycles).toHaveLength(0);
  });
});

describe('feedbackOf — resolved targets', () => {
  const failedTarget = (verified: 'failed' | 'verified-resolved-target') => ({ ...verification(), targetResults: [{ targetId: 't1', findingId: 'f1', verification: verified, detail: 'rendered 4px, expected 8px' }] });

  it('a resolved target that measured NOT met becomes a planner re-plan with the measured value', () => {
    const fb = feedbackOf({ attempt: null, verification: failedTarget('failed'), fidelity: report([]), attribution: attribution() }, resolutionOf(target()));
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ id: 'target:t1', kind: 'target-not-met', property: 'border-top-left-radius', expected: '8px', responsible: 'planner' });
    expect(fb[0]!.action).toMatchObject({ type: 'replan' });
    expect(fb[0]!.observed).toMatch(/4px/);
  });

  it('a met target produces no feedback', () => {
    expect(feedbackOf({ attempt: null, verification: failedTarget('verified-resolved-target'), fidelity: report([]), attribution: attribution() }, resolutionOf(target()))).toEqual([]);
  });

  it('a target with no live-DOM representation is reported as blocked, not looped on', () => {
    const t = target({ status: { design: 'resolved', implementation: 'blocked', verification: 'failed', implementationDetail: 'a hover target has no reliable selector', verificationDetail: null } });
    const fb = feedbackOf({ attempt: null, verification: failedTarget('failed'), fidelity: report([]), attribution: attribution() }, resolutionOf(t));
    expect(fb[0]).toMatchObject({ responsible: 'none', action: null, blockedReason: 'a hover target has no reliable selector' });
  });
});

describe('requiredChecksOpen — "nothing left to correct" is not "verified"', () => {
  const resolved = (verification: ResolvedTarget['status']['verification']) => resolutionOf(target({ status: { design: 'resolved', implementation: 'applied', verification, implementationDetail: null, verificationDetail: null } }));

  it('is empty only when checks pass, fidelity passed and every resolved target is verified', () => {
    expect(requiredChecksOpen(verification(), report([]), resolved('verified-resolved-target'))).toEqual([]);
    expect(requiredChecksOpen(verification(), report([]), resolved('verified-original-target'))).toEqual([]);
  });

  it('an unavailable comparison (fidelity NOT checked) can never read as a pass', () => {
    const open = requiredChecksOpen(verification(), report([], { verdict: 'not-checked', unavailable: ['no design baseline of the original was captured'] }), resolved('verified-resolved-target'));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatch(/NOT verified.*no design baseline/);
    expect(requiredChecksOpen(verification(), null, null)[0]).toMatch(/not compared/);
  });

  it('a resolved target nobody measured, or that failed, stays open', () => {
    expect(requiredChecksOpen(verification(), report([]), resolved('unverified'))[0]).toMatch(/1 of 1 resolved target\(s\) not verified/);
    expect(requiredChecksOpen(verification(), report([]), resolved('failed'))[0]).toMatch(/1 failed/);
    expect(requiredChecksOpen(verification(), report([]), resolved('not-run'))).toHaveLength(1);
  });

  it('failed verification checks and fidelity regressions stay open', () => {
    const v = verification({ checks: [{ id: 'scope.x', group: 'scope', name: 'n', status: 'fail', detail: 'd' }], verdict: 'fail' });
    const open = requiredChecksOpen(v, report([diff()]), null);
    expect(open.join(' ')).toMatch(/1 verification check\(s\) failed: scope\.x/);
    expect(open.join(' ')).toMatch(/1 regression/);
  });

  it('a property that must stay as the original but changed stays open', () => {
    const preserved = target({ id: 'p1', outcome: 'preserve-existing', target: null, status: { design: 'preserved', implementation: 'not-applicable', verification: 'failed', implementationDetail: null, verificationDetail: 'width changed' } });
    expect(requiredChecksOpen(verification(), report([]), resolutionOf(preserved))[0]).toMatch(/must stay as the original changed/);
  });
});

/** A real comparison whose only gap is an unmeasurable sticky trace: no regression, one required check unverified. */
function incompleteReport(): FidelityReport {
  const dead = sticky([false, false, false, false, false]);
  return compareDesign({ baseline: baselineOf([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), observed: captureOf([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), exemptions: [] });
}

describe('requiredChecksOpen — INCOMPLETE fidelity coverage', () => {
  it('an incomplete comparison is open, with the verified / failed / unverified numbers and the first required gap', () => {
    const r = incompleteReport();
    expect(r.verdict).toBe('incomplete');
    const open = requiredChecksOpen(verification(), r, null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatch(/INCOMPLETE/);
    expect(open[0]).toMatch(/\d+ verified, 0 failed, 1 unverified/);
    expect(open[0]).toMatch(/sticky/);
  });

  it('fails closed on an inconsistent report: a `pass` that carries unverified required coverage is still open', () => {
    const r = incompleteReport();
    const lying: FidelityReport = { ...r, verdict: 'pass' };
    expect(requiredChecksOpen(verification(), lying, null).join(' ')).toMatch(/INCOMPLETE/);
  });

  it('a report with no coverage object at all (older reports, hand-built literals) and verdict pass FAILS CLOSED: nothing proves which required checks were run', () => {
    const { coverage: _none, ...noCoverage } = report([]);
    expect(requiredChecksOpen(verification(), noCoverage, null).join(' ')).toMatch(/INCOMPLETE.*no coverage/);
  });

  it('preserve decisions that could not be verified (insufficient evidence) are open, separately from the failed ones', () => {
    const unverified = target({ id: 'p1', outcome: 'preserve-existing', target: null, status: { design: 'preserved', implementation: 'not-applicable', verification: 'unverified', implementationDetail: null, verificationDetail: 'not measured by the verifier: margin-top' } });
    const failed = target({ id: 'p2', outcome: 'preserve-existing', target: null, status: { design: 'preserved', implementation: 'not-applicable', verification: 'failed', implementationDetail: null, verificationDetail: 'removed' } });
    const open = requiredChecksOpen(verification(), report([]), resolutionOf(unverified, failed));
    expect(open.join('\n')).toMatch(/1 property\(ies\) that must stay as the original changed/);
    expect(open.join('\n')).toMatch(/1 preserve decision\(s\) could not be verified.*not measured by the verifier/);
  });
});

describe('the correction loop does not treat unverified coverage as correctable', () => {
  it('feedbackOf an incomplete report is empty: nothing can be corrected automatically, so the loop stops `passed` — and the required check stays open', async () => {
    const r = incompleteReport();
    expect(feedbackOf({ attempt: null, verification: verification(), fidelity: r, attribution: attribution() }, null)).toEqual([]);
    const h = harness(() => ({ fidelity: r }));
    const out = await verifyAndCorrect(h.args(budget()));
    expect(out.stopReason).toBe('passed');
    expect(out.cycles).toHaveLength(0);
    expect(requiredChecksOpen(out.final!.verification, out.final!.fidelity, null)).not.toEqual([]);
  });
});

describe('feedbackOf — a failed preserve decision', () => {
  const preserveFailed = (over: Partial<ResolvedTarget> = {}) => target({ id: 'p1', property: 'width', outcome: 'preserve-existing', target: null, status: { design: 'preserved', implementation: 'not-applicable', verification: 'failed', implementationDetail: null, verificationDetail: 'the used width changed from 200px to 260px' }, ...over });
  const withPreserve = (): PreviewVerification => ({ ...verification(), targetResults: [{ targetId: 'p1', findingId: 'f1', verification: 'failed', detail: 'the used width changed from 200px to 260px' }] });

  it('that is not already a fidelity regression becomes feedback: blocked with the concrete reason when no edit touches the property', () => {
    const fb = feedbackOf({ attempt: null, verification: withPreserve(), fidelity: report([]), attribution: attribution({ editsByFinding: new Map() }) }, resolutionOf(preserveFailed()));
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ id: 'preserve:p1', kind: 'preserve-broken', responsible: 'none', action: null, property: 'width', findingIds: ['f1'] });
    expect(fb[0]!.blockedReason).toMatch(/width/);
  });

  it('goes back to the planner to restore the original when an edit of that property exists', () => {
    const fb = feedbackOf({ attempt: null, verification: withPreserve(), fidelity: report([]), attribution: attribution({ editsByFinding: new Map([['f1', [{ property: 'width', kind: 'style' }]]]) }) }, resolutionOf(preserveFailed()));
    expect(fb[0]).toMatchObject({ responsible: 'planner', action: { type: 'replan', findingIds: ['f1'] } });
  });

  it('is not reported twice when the same change is already a fidelity regression', () => {
    const regression = diff({ id: 'd-w', category: 'default-style', state: 'default', property: 'width', findingIds: ['f1'] });
    const fb = feedbackOf({ attempt: null, verification: withPreserve(), fidelity: report([regression]), attribution: attribution({ editsByFinding: new Map() }) }, resolutionOf(preserveFailed()));
    expect(fb.map((f) => f.id)).toEqual(['d-w']);
  });
});

describe('structured planner feedback (finding 1: a preview failure must reopen the finding)', () => {
  const failed = (id: string, detail = 'rendered 4px, expected 8px') => ({ ...verification(), targetResults: [{ targetId: id, findingId: 'f1', verification: 'failed' as const, detail }] });

  it('a failed resolved target carries its target id and part, not only an id string', () => {
    const fb = feedbackOf({ attempt: null, verification: failed('t1'), fidelity: report([]), attribution: attribution() }, resolutionOf(target({ part: 'label' })));
    expect(fb[0]).toMatchObject({ id: 'target:t1', targetId: 't1', part: 'label' });
  });

  it('toPlannerFeedback converts only replan items and keeps finding ids, target, property, part, state, viewport, expected and observed', () => {
    const targetFb = feedbackOf({ attempt: null, verification: failed('t1'), fidelity: report([]), attribution: attribution() }, resolutionOf(target()))[0]!;
    const regression = feedbackOf({ attempt: null, verification: verification(), fidelity: report([diff({ id: 'd-pl', category: 'default-style', state: 'default', property: 'padding-left', baseline: '12px', observed: '28px' })]), attribution: attribution({ editsByFinding: new Map([['f1', [{ property: 'padding', kind: 'style' }]]]) }) }, null)[0]!;
    const stateGuard = feedbackOf({ attempt: null, verification: verification(), fidelity: report([diff()]), attribution: attribution() }, null)[0]!;
    const blocked = feedbackOf({ attempt: null, verification: verification(), fidelity: report([diff({ id: 'd-x', category: 'default-style', state: 'default', property: 'color' })]), attribution: attribution({ editsByFinding: new Map() }) }, null)[0]!;
    expect(stateGuard.action?.type).toBe('state-guard');
    expect(blocked.action).toBeNull();

    const items = toPlannerFeedback([targetFb, regression, stateGuard, blocked]);
    expect(items).toEqual([
      { id: 'target:t1', kind: 'target-not-met', findingIds: ['f1'], targetId: 't1', property: 'border-top-left-radius', part: 'self', state: 'default', viewport: 'any', expected: '8px', observed: 'rendered 4px, expected 8px', elementLabel: 'Alpha card', sectionId: 'cards', constraint: expect.stringContaining('must measure 8px') },
      { id: 'd-pl', kind: 'default-regression', findingIds: ['f1'], targetId: null, property: 'padding-left', part: null, state: 'default', viewport: 'desktop', expected: '12px', observed: '28px', elementLabel: 'Alpha card', sectionId: 'cards', constraint: expect.stringContaining('must keep the original value 12px') },
    ]);
  });

  it('a preserve-broken replan has no concrete original value: expected is null', () => {
    const t = target({ id: 'p1', property: 'width', outcome: 'preserve-existing', target: null });
    const fb = feedbackOf({ attempt: null, verification: failed('p1', 'the used width changed from 200px to 260px'), fidelity: report([]), attribution: attribution({ editsByFinding: new Map([['f1', [{ property: 'width', kind: 'style' }]]]) }) }, resolutionOf(t));
    expect(toPlannerFeedback(fb)).toEqual([expect.objectContaining({ id: 'preserve:p1', kind: 'preserve-broken', targetId: 'p1', property: 'width', expected: null })]);
  });
});
