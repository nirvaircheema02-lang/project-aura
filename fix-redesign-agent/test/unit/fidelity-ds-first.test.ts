import { describe, expect, it } from 'vitest';
import { compareDesign } from '../../src/fidelity/compare.ts';
import type { CapturedElement, DesignBaseline, DesignCapture, FidelityReport } from '../../src/fidelity/types.ts';
import { base, cap, el, sec } from '../helpers/fidelity-captures.ts';

/**
 * DS-first (user instruction 2026-10-14): a mounted design-system component owns its design. Before this, every property the audit
 * had not named counted as a regression, so the correction loop dropped the component and kept the production markup with CSS patches.
 */
const ORIGINAL = { color: 'rgb(0, 0, 0)', 'font-size': '12px', 'background-color': 'rgb(255, 255, 255)', 'border-top-left-radius': '10px' };
const DS_BUTTON = { color: 'rgb(255, 255, 255)', 'font-size': '16px', 'background-color': 'rgb(176, 31, 36)', 'border-top-left-radius': '5px' };
const cta = (style: Record<string, string>, island = false): CapturedElement => el('0', { tag: 'a', label: 'Get Pricing', textHash: 'cta', roles: ['finding', 'interactive'], findingIds: ['F1'], style, ...(island ? { island: true } : {}) });
const section = (e: CapturedElement) => sec({ elements: [el(''), e] });
const run = (b: DesignBaseline, o: DesignCapture, dsFirst: boolean): FidelityReport => compareDesign({ baseline: b, observed: o, exemptions: [], ...(dsFirst ? { dsFirst: true } : {}), now: () => new Date(0) });
const classes = (r: FidelityReport) => [...new Set(r.differences.filter((d) => d.elementKey === '0').map((d) => d.classification))];

describe('DS-first fidelity classification', () => {
  const b = () => base([section(cta(ORIGINAL))]);
  const o = () => cap([section(cta(DS_BUTTON, true))]);

  it('without DS-first, a mounted component that differs from the original in properties nobody authorized is a regression (the old behaviour)', () => {
    expect(classes(run(b(), o(), false))).toEqual(['regression']);
  });

  it('REGRESSION: with DS-first the same differences are intentional — the component IS the design — and they are still listed with the reason', () => {
    const r = run(b(), o(), true);
    expect(classes(r)).toEqual(['intentional']);
    expect(r.differences.filter((d) => d.elementKey === '0').every((d) => d.exemptionTargetId === 'ds-first:component' && /design-system component owns this element/.test(d.detail))).toBe(true);
    expect(r.summary.regressions).toBe(0);
  });

  it('DS-first does not excuse an element that is NOT a mounted component: the same differences stay regressions', () => {
    const r = run(b(), cap([section(cta(DS_BUTTON, false))]), true);
    expect(classes(r)).toEqual(['regression']);
  });
});
