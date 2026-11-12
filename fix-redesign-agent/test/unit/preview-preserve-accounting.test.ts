import { describe, expect, it } from 'vitest';
import { preserveCheck, reconcilePreserve, summarizePreserve } from '../../src/fidelity/accounting.ts';
import type { PreserveResult } from '../../src/fidelity/types.ts';
import type { FindingOutcome } from '../../src/preview/types.ts';
import { resolutionOf, target } from '../helpers/fidelity-captures.ts';

/**
 * Property level, finding level and overall verification must agree: a finding that changes something and breaks something it was told
 * to keep is never `fixed-verified`; evidence-less preserve decisions are surfaced, not hidden; the rollup says the same thing.
 */

const result = (targetId: string, findingId: string, verification: PreserveResult['verification'], detail = 'x', over: Partial<PreserveResult> = {}): PreserveResult =>
  ({ targetId, findingId, property: 'width', state: 'default', verification, detail, reason: verification === 'unverified' ? 'not measured by the verifier' : verification, evidence: [], ...over });
const outcome = (findingId: string, status: FindingOutcome['status'], over: Partial<FindingOutcome> = {}): FindingOutcome =>
  ({ findingId, section: 's', type: 'button', label: findingId, status, route: 'css-edit', detail: 'ok', targets: { resolved: 1, verified: 1, failed: 0, unmeasurable: 0, preserved: 1, unresolved: 0 }, ...over });
const preserveTarget = (id: string, findingId: string) => target({ id, findingId, property: 'width' });

describe('reconcilePreserve — finding accounting from the preserve evidence', () => {
  const resolution = resolutionOf(preserveTarget('p-ok', 'F-ok'), preserveTarget('p-bad', 'F-bad'), preserveTarget('p-unv', 'F-unv'), preserveTarget('p-dec', 'F-dec'), preserveTarget('p-comp', 'F-comp'));
  const results = [result('p-ok', 'F-ok', 'preserved-verified'), result('p-bad', 'F-bad', 'failed', 'the used width changed from 200px to 260px'), result('p-unv', 'F-unv', 'unverified'), result('p-dec', 'F-dec', 'failed', 'removed'), result('p-comp', 'F-comp', 'failed', 'the used width changed')];
  const findings = (): FindingOutcome[] => [
    outcome('F-ok', 'fixed-verified'), outcome('F-bad', 'fixed-verified'), outcome('F-unv', 'component-verified'), outcome('F-dec', 'preserved-by-decision', { reported: 'resolver' }), outcome('F-comp', 'component-verified'),
  ];

  it('fills the tallies; a failed preserve downgrades fixed/component-verified to partially-verified and clears `reported`; unverified keeps the fix status but is surfaced', () => {
    const f = findings();
    reconcilePreserve(f, resolution, results);
    const by = Object.fromEntries(f.map((x) => [x.findingId, x]));
    expect(by['F-ok']).toMatchObject({ status: 'fixed-verified', targets: { preservedVerified: 1, preservedFailed: 0, preservedUnverified: 0 } });
    expect(by['F-bad']).toMatchObject({ status: 'partially-verified', targets: { preservedFailed: 1 } });
    expect(by['F-bad']!.detail).toMatch(/1 preserved propert.* changed.*width/);
    expect(by['F-bad']!.reported).toBeUndefined();
    expect(by['F-comp']!.status).toBe('partially-verified');
    expect(by['F-unv']).toMatchObject({ status: 'component-verified', targets: { preservedUnverified: 1 } });
    expect(by['F-unv']!.detail).toMatch(/1 preserve decision\(s\) not verified.*not measured by the verifier/);
    expect(by['F-dec']!.status).toBe('unresolved'); // "the Resolver changed nothing" is false when the original was removed
  });

  it('a preserve decision with no result at all counts as unverified, never as preserved', () => {
    const f = [outcome('F-ok', 'fixed-verified')];
    reconcilePreserve(f, resolution, []);
    expect(f[0]!.targets).toMatchObject({ preservedVerified: 0, preservedUnverified: 1 });
  });

  it('summarizePreserve counts and groups the reasons; preserveCheck is fail / not-checked / pass', () => {
    const s = summarizePreserve(results);
    expect(s).toMatchObject({ total: 5, verified: 1, failed: 3, unverified: 1 });
    expect(s.reasons).toEqual(expect.arrayContaining([{ reason: 'not measured by the verifier', count: 1 }]));
    expect(preserveCheck(s).status).toBe('fail');
    expect(preserveCheck(summarizePreserve([result('a', 'F', 'unverified'), result('b', 'F', 'preserved-verified')])).status).toBe('not-checked');
    expect(preserveCheck(summarizePreserve([result('b', 'F', 'preserved-verified')])).status).toBe('pass');
    expect(preserveCheck(summarizePreserve([])).status).toBe('pass');
  });
});
