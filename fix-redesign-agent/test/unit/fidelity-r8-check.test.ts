import { describe, expect, it } from 'vitest';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { fidelityCheckOf, summarizeCoverage, unverifiedByFamily } from '../../src/fidelity/coverage.ts';
import type { FidelityReport } from '../../src/fidelity/types.ts';
import { base, cap, sec, sticky } from '../helpers/fidelity-captures.ts';

/** R8's `fidelity.design-state` check and the one-line coverage summary every consumer shares. */

const dead = sticky([false, false, false, false, false]);
const incomplete = (): FidelityReport => compareDesign({ baseline: base([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), observed: cap([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), exemptions: [] });
const pass = (): FidelityReport => compareDesign({ baseline: base([sec({ sectionId: 'ok' })]), observed: cap([sec({ sectionId: 'ok' })]), exemptions: [] });

describe('fidelityCheckOf', () => {
  it('pass -> pass; a regression -> fail', () => {
    expect(fidelityCheckOf(pass()).status).toBe('pass');
    const failing = compareDesign({ baseline: base([sec({ sectionId: 'ok' })]), observed: cap([sec({ sectionId: 'ok', elements: [sec().elements[0]!, { ...sec().elements[1]!, style: { color: 'rgb(255, 0, 0)' } }] })]), exemptions: [] });
    expect(fidelityCheckOf(failing).status).toBe('fail');
  });

  it('incomplete -> not-checked, and the detail starts INCOMPLETE and names the unverified required checks (not just unavailable[0..2])', () => {
    const c = fidelityCheckOf(incomplete());
    expect(c.status).toBe('not-checked');
    expect(c.detail).toMatch(/^INCOMPLETE - /);
    expect(c.detail).toMatch(/1 unverified/);
    expect(c.detail).toMatch(/sticky/);
  });

  it('nothing compared keeps today\'s not-checked detail', () => {
    const none = compareDesign({ baseline: null, observed: null, exemptions: [] });
    expect(fidelityCheckOf(none)).toMatchObject({ status: 'not-checked' });
    expect(fidelityCheckOf(none).detail).toMatch(/baseline was not captured/);
  });
});

describe('coverage summaries', () => {
  it('summarizeCoverage is one short line with the verified / failed / unverified numbers and the families', () => {
    const s = summarizeCoverage(incomplete());
    expect(s.length).toBeLessThanOrEqual(240);
    expect(s).toMatch(/required \d+\/\d+ verified, 0 failed, 1 unverified: sticky 1/);
  });

  it('unverifiedByFamily lists each family with its count, the total and the reason codes', () => {
    expect(unverifiedByFamily(incomplete())).toEqual([{ family: 'sticky', count: 1, of: 1, reasons: { 'sticky-no-comparable-position': 1 }, examples: [expect.stringMatching(/sticky/)] }]);
    expect(unverifiedByFamily(pass())).toEqual([]);
  });
});
