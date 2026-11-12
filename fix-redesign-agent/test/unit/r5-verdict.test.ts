import { describe, expect, it } from 'vitest';
import { computeIterationOutcome } from '../../src/agents/r5-compare/verdict.ts';
import type { FindingCheck, StructuralDiff } from '../../src/agents/types.ts';

const check = (findingId: string, fixed: boolean): FindingCheck => ({ findingId, fixed, detail: fixed ? 'all properties match' : 'padding-left still 12px (expected 28px)', measured: [] });
const intact: StructuralDiff = { ok: true, lostInteractive: [], lostText: [], note: 'inventory unchanged' };

describe('computeIterationOutcome — Q9, three distinct states (Decision Log #10)', () => {
  it('PASS: every finding fixed, structure intact, vision CONFIRMED', () => {
    expect(computeIterationOutcome({ checks: [check('a', true), check('b', true)], structural: intact, vision: 'CONFIRMED', visionIssues: [] })).toEqual({ overall: 'PASS', failedChecks: [] });
  });

  it('PASS also when the vision step was not run or uncertain but raised no CRITICAL/HIGH issue', () => {
    expect(computeIterationOutcome({ checks: [check('a', true)], structural: intact, vision: 'NOT_CHECKED', visionIssues: [] }).overall).toBe('PASS');
    expect(computeIterationOutcome({ checks: [check('a', true)], structural: intact, vision: 'UNCERTAIN', visionIssues: [{ description: 'slightly tight spacing', severity: 'LOW' }] }).overall).toBe('PASS');
  });

  it('PARTIAL: some but not all findings fixed — never reported as PASS, never bucketed as FAIL', () => {
    const r = computeIterationOutcome({ checks: [check('a', true), check('b', false)], structural: intact, vision: 'CONFIRMED', visionIssues: [] });
    expect(r.overall).toBe('PARTIAL');
    expect(r.failedChecks).toEqual(['finding b: padding-left still 12px (expected 28px)']);
  });

  it('PARTIAL: everything measured fixed but the vision verdict is REJECTED or carries a HIGH issue — the check is listed', () => {
    const rejected = computeIterationOutcome({ checks: [check('a', true)], structural: intact, vision: 'REJECTED', visionIssues: [] });
    expect(rejected.overall).toBe('PARTIAL');
    expect(rejected.failedChecks[0]).toMatch(/vision: verdict REJECTED/);
    const high = computeIterationOutcome({ checks: [check('a', true)], structural: intact, vision: 'CONFIRMED', visionIssues: [{ description: 'CTA now overlaps the nav', severity: 'HIGH' }] });
    expect(high.overall).toBe('PARTIAL');
    expect(high.failedChecks).toEqual(['vision (HIGH): CTA now overlaps the nav']);
  });

  it('FAIL: content/functionality loss, whatever else passed — with exactly what was lost', () => {
    const r = computeIterationOutcome({ checks: [check('a', true)], structural: { ok: false, lostInteractive: ['button "Sign up"'], lostText: [], note: '' }, vision: 'CONFIRMED', visionIssues: [] });
    expect(r.overall).toBe('FAIL');
    expect(r.failedChecks).toEqual(['structural: interactive element lost — button "Sign up"']);
  });

  it('FAIL: nothing fixed (including zero checks)', () => {
    expect(computeIterationOutcome({ checks: [check('a', false)], structural: intact, vision: 'CONFIRMED', visionIssues: [] }).overall).toBe('FAIL');
    expect(computeIterationOutcome({ checks: [], structural: intact, vision: 'CONFIRMED', visionIssues: [] }).overall).toBe('FAIL');
  });
});
