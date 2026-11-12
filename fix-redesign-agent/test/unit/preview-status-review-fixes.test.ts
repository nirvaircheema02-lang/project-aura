import { describe, expect, it } from 'vitest';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { fidelityCheckOf, fidelitySummaryOf } from '../../src/fidelity/coverage.ts';
import type { FidelityReport } from '../../src/fidelity/types.ts';
import { compareBehavior, type SectionBehavior } from '../../src/preview/behavior.ts';
import { renderPreviewMd } from '../../src/preview/report.ts';
import { applyOverallStatus, settleStatus, statusOf } from '../../src/preview/status.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';
import { contrastMeasuredCheck } from '../../src/preview/verify.ts';
import { base, cap, sec } from '../helpers/fidelity-captures.ts';

/** The review's findings on the overall preview status (issue 1): evidence that is missing is never read as a pass, and every limitation is visible. */

const v = (over: Partial<PreviewVerification> = {}): PreviewVerification => ({
  schemaVersion: 1, generatedAt: 't', url: 'http://127.0.0.1:4400/', mode: 'full-page', expectedSectionIds: ['s'], renderedSectionIds: ['s'], checks: [], findings: [], interactions: [], unavailable: [], simulated: [],
  summary: { passed: 4, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
});
const allVerified = (): FidelityReport => compareDesign({ baseline: base([sec({ sectionId: 'ok' })]), observed: cap([sec({ sectionId: 'ok' })]), exemptions: [] });
function settled(f: FidelityReport | null, over: Partial<PreviewVerification> = {}) {
  const ver = v(over);
  if (f) ver.checks.unshift(fidelityCheckOf(f));
  const gaps = settleStatus(ver, f, null);
  if (f) ver.fidelity = fidelitySummaryOf(f, gaps.map((x) => x.text));
  return ver;
}
const parityPass = { id: 'interaction.parity', group: 'interaction' as const, name: 'Probed interactions behave as on the original page', status: 'pass' as const, detail: '0 match, 0 not reproduced, 0 behave differently, out of 1' };

describe('interactions that were never probed', () => {
  const notLocated: SectionBehavior[] = [{ sectionId: 'pricing', located: false, note: 'section could not be located on the original page, so its behaviour was not probed', items: [], scroll: null, animations: [], sticky: [] }];

  it('a section that could not be located on the original page is an unverified REQUIRED gap (its behaviour was never compared): INCOMPLETE, not PASS', () => {
    const interactions = compareBehavior(notLocated, []);
    expect(interactions[0]).toMatchObject({ verdict: 'not-probed', probe: 'section' });
    const ver = settled(allVerified(), { checks: [parityPass], interactions });
    expect(ver.verdict).toBe('incomplete');
    expect(ver.status!.gaps).toHaveLength(1);
    expect(ver.status!.gaps[0]).toMatchObject({ kind: 'unverified', family: 'interaction:not-located' });
    expect(ver.status!.gaps[0]!.text).toMatch(/pricing/);
    expect(ver.checks.find((c) => c.id === 'interaction.parity')!.status).toBe('pass'); // the individual result is kept as measured
  });

  it('the controls of a hand-authored section are DISCLOSED (covered by its own checks), never silently counted and never a required gap', () => {
    const original: SectionBehavior[] = [{ sectionId: 'calc', located: true, items: [{ index: 0, kind: 'button', label: 'Add', href: null, probes: [{ probe: 'click', changed: true, effects: ['text'], delta: { added: [], removed: [] } } as never] } as never], scroll: null, animations: [], sticky: [] }];
    const preview: SectionBehavior[] = [{ sectionId: 'calc', located: true, items: [], scroll: null, animations: [], sticky: [] }];
    const interactions = compareBehavior(original, preview, { overrideSectionIds: new Set(['calc']) });
    expect(interactions.map((i) => i.verdict)).toEqual(['not-probed']);
    const ver = settled(allVerified(), { checks: [parityPass], interactions });
    expect(ver.verdict).toBe('pass');
    expect(ver.status!.disclosed.join('\n')).toMatch(/1 interaction\(s\).*hand-authored/);
  });
});

describe('a verification.json written before the fidelity summary existed', () => {
  it('with neither a fidelity summary nor a fidelity check, the missing comparison is the same unverified gap a fresh run gets (INCOMPLETE, not PASS)', () => {
    const old = v({ checks: [{ id: 'scope.sections', group: 'scope', name: 'n', status: 'pass', detail: 'd' }] });
    expect(old.status).toBeUndefined();
    const s = statusOf(old);
    expect(s.verdict).toBe('incomplete');
    expect(s.gaps[0]).toMatchObject({ kind: 'unverified', family: 'fidelity:not-compared' });
    expect(s.gaps[0]!.text).toMatch(/fidelity was not compared/);
    // exactly what a fresh run with no fidelity report says
    expect(settled(null, { checks: old.checks }).status!.gaps[0]!.text).toBe(s.gaps[0]!.text);
  });

  it('a file whose fidelity CHECK passed (no summary) stays PASS: the evidence exists', () => {
    const old = v({ checks: [{ id: 'fidelity.design-state', group: 'fidelity', name: 'n', status: 'pass', detail: '0 regression(s)' }] });
    expect(statusOf(old).verdict).toBe('pass');
  });
});

describe('Fix findings are counted beside the verdict', () => {
  const finding = (id: string, status: PreviewVerification['findings'][number]['status']) => ({ findingId: id, section: 's', type: 'button', label: id, status, route: 'css-edit' as const, detail: 'd' });

  it('findings that are not measured fixed are DISCLOSED with their statuses (the PASS never reads as "all fixed"), and still do not flip the verdict', () => {
    const ver = settled(allVerified(), {
      findings: [finding('a', 'not-represented'), finding('b', 'unresolved'), finding('c', 'fixed-verified')],
      summary: { passed: 4, failed: 0, notChecked: 0, findingsVerified: 1, findingsTotal: 3, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 },
    });
    expect(ver.verdict).toBe('pass');
    const line = ver.status!.disclosed.find((d) => /Fix finding/.test(d));
    expect(line).toMatch(/2 of 3 Fix finding\(s\) are not measured fixed/);
    expect(line).toMatch(/not-represented 1/);
    expect(line).toMatch(/unresolved 1/);
    expect(line).toMatch(/not claimed fixed/);
    // PREVIEW.md says it where it says the required checks are verified
    const md = renderPreviewMd({ runId: 'r', v: ver, g: { sectionIds: ['s'], generatedSections: ['s'], overriddenSections: [], sourceHash: 'h', assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 }, source: '/p', fidelity: allVerified() });
    expect(md).toMatch(/Every required check is verified\. 1 of 3 Fix finding\(s\) measured fixed/);
  });

  it('nothing is disclosed when every finding is measured fixed', () => {
    const ver = settled(allVerified(), { findings: [finding('c', 'fixed-verified')], summary: { passed: 4, failed: 0, notChecked: 0, findingsVerified: 1, findingsTotal: 1, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 } });
    expect(ver.status!.disclosed.some((d) => /Fix finding/.test(d))).toBe(false);
  });
});

describe('contrast.measured', () => {
  const report = (over: Partial<NonNullable<PreviewVerification['contrast']>>) => ({ gate: 'AA' as const, measuredRuns: 0, unmeasuredRuns: 0, failAA: 0, failAAA: 0, regressions: 0, inherited: 0, unbaselined: 0, mutedRuns: 0, mutedBelowAA: 0, mutedBelowAAA: 0, rows: [], ...over });

  it('a selection with no text at all has nothing to measure: a pass that says so', () => {
    expect(contrastMeasuredCheck(report({}), false, true)).toMatchObject({ status: 'pass', detail: expect.stringMatching(/no text/i) });
  });
  it('text that exists but could not be measured stays NOT-CHECKED and says how many runs', () => {
    const c = contrastMeasuredCheck(report({ unmeasuredRuns: 4 }), false, true);
    expect(c.status).toBe('not-checked');
    expect(c.detail).toMatch(/4 text run\(s\)/);
  });
  it('a measurement that failed to run, or a section that moved while measured, stays NOT-CHECKED with its own reason', () => {
    expect(contrastMeasuredCheck(undefined, false, true)).toMatchObject({ status: 'not-checked', detail: expect.stringMatching(/could not run/) });
    expect(contrastMeasuredCheck(report({ measuredRuns: 9 }), true, true)).toMatchObject({ status: 'not-checked', detail: expect.stringMatching(/moved/) });
  });
  it('measured runs pass, with the comparison noted when an original snapshot exists', () => {
    expect(contrastMeasuredCheck(report({ measuredRuns: 9 }), false, true)).toMatchObject({ status: 'pass', detail: expect.stringMatching(/9 text run\(s\) measured.*compared with the original/) });
    expect(contrastMeasuredCheck(report({ measuredRuns: 9, unmeasuredRuns: 2 }), false, false).detail).toMatch(/no original snapshot.*2 could not be measured/);
  });
});

describe('the budget gap is never cut by the cap', () => {
  it('stays in status.gaps even behind more than twelve other unverified gaps (failed ones still come first)', () => {
    const ver = v();
    const others = Array.from({ length: 14 }, (_, i) => ({ kind: 'unverified' as const, family: `custom:c${i}`, text: `check c${i} not checked` }));
    applyOverallStatus(ver, [...others, { kind: 'unverified', family: 'budget', text: 'verification budget exhausted: no new verification was allowed' }, { kind: 'failed', family: 'checks', text: '1 verification check(s) failed' }]);
    const families = ver.status!.gaps.map((g) => g.family);
    expect(families).toHaveLength(12);
    expect(families[0]).toBe('checks'); // a failure is first
    expect(families[1]).toBe('budget'); // then why the preview could not be (re)verified
    expect(ver.status!.gapsTruncated).toBe(4);
    expect(ver.status).toMatchObject({ failedRequired: 1, unverifiedRequired: 15 });
  });
});
