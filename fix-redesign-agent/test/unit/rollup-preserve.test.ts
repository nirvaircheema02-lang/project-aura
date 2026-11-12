import { describe, expect, it } from 'vitest';
import { rollupFinding } from '../../src/resolution/schema.ts';
import { resolutionOf, target } from '../helpers/fidelity-captures.ts';

describe('rollupFinding — preserve decisions', () => {
  const withVerification = (verification: 'preserved-verified' | 'unverified' | 'failed' | 'not-run') =>
    resolutionOf(target({ id: 'r', outcome: 'resolved-target', property: 'border-top-left-radius', target: { value: '8px', comparison: 'length-px', token: null }, status: { design: 'resolved', implementation: 'applied', verification: 'verified-resolved-target', implementationDetail: null, verificationDetail: null } }),
      target({ id: 'p', status: { design: 'preserved', implementation: 'not-applicable', verification, implementationDetail: null, verificationDetail: null } }));

  it('allRequiredVerified requires EVERY preserve decision to be preserved-verified (its own doc comment), and exposes the counters', () => {
    expect(rollupFinding(withVerification('preserved-verified'), 'F1')).toMatchObject({ allRequiredVerified: true, preservedVerified: 1, preservedFailed: 0, preservedUnverified: 0 });
    expect(rollupFinding(withVerification('unverified'), 'F1')).toMatchObject({ allRequiredVerified: false, preservedUnverified: 1 });
    expect(rollupFinding(withVerification('not-run'), 'F1')).toMatchObject({ allRequiredVerified: false, preservedUnverified: 1 });
    expect(rollupFinding(withVerification('failed'), 'F1')).toMatchObject({ allRequiredVerified: false, preservedFailed: 1 });
  });
});
