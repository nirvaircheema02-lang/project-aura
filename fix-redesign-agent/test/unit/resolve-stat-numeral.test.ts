import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import { propertiesOf, withStatNumeralTargets } from '../../src/resolution/resolve.ts';

const R12 = { ruleId: 'R1.2', title: 'brand red', why: 'stat numeral painted in brand red (a gradient with a brand-red stop) — R1.2: brand red is for CTAs only, "NEVER for … body text · decoration"', severity: 'MEDIUM' };
const R13 = (closest = '39.06') => ({ ruleId: 'R1.3', title: 'type scale', why: `font-size 36px is not a step of the Design System type scale (closest: ${closest}px, 3.06px away)`, severity: 'LOW' });
const finding = (ruleViolations: unknown[], properties: unknown[] | null = null): Finding =>
  ({ identity: { findingId: 'F' }, component: { dsComponent: null }, comparison: { mismatches: [], ruleViolations, ...(properties ? { properties } : {}) } }) as unknown as Finding;
const unresolved = (property: string, actual: string) => ({ property, actual, expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: 'Observed value; no verified DS requirement for this property/part.' });

describe('stat numerals (R1.2 / R1.3) — docs/REDESIGN_RULES.md "Stat numerals and counters"', () => {
  it('a stat numeral gets the neutral ink and the audit\'s closest type-scale step as expected values', () => {
    const f = finding([R13(), R12], [unresolved('color', 'rgb(176, 31, 36)'), unresolved('font-size', '36px')]);
    const out = propertiesOf(f);
    expect(out.find((p) => p.property === 'color')).toMatchObject({ status: 'DIFFERENT', expected: '#171717', expectedToken: '--black-900', actual: 'rgb(176, 31, 36)' });
    expect(out.find((p) => p.property === 'font-size')).toMatchObject({ status: 'DIFFERENT', expected: '2.441rem', expectedToken: '--typography-size-2xl', actual: '36px' });
  });

  it('REGRESSION: a stat numeral flagged only by R1.1 (grey, not brand red) gets the ink too — not the audit\'s "closest grey" #737373', () => {
    const r11 = { ruleId: 'R1.1', title: 'colour', why: 'stat numeral colour rgb(101, 101, 101) is not a Design System colour (closest: --color-ramp-black-500 #737373, ΔE 4) — R1.1: text is drawn from the foundation palette', severity: 'LOW' };
    const out = propertiesOf(finding([r11], [unresolved('color', 'rgb(101, 101, 101)')]));
    expect(out.find((p) => p.property === 'color')).toMatchObject({ expected: '#171717', expectedToken: '--black-900', source: 'foundation rule R1.2' });
  });

  it('adds the properties when the per-property record lacks them', () => {
    const out = propertiesOf(finding([R13(), R12], [unresolved('width', '80px')]));
    expect(out.map((p) => p.property)).toEqual(['width', 'color', 'font-size']);
  });

  it('REGRESSION: a body-text R1.2/R1.3 violation (not a stat numeral) is untouched', () => {
    const body = { ...R12, why: 'body text painted in brand red — R1.2: brand red is for CTAs only' };
    const props = [unresolved('color', 'rgb(176, 31, 36)')] as never[];
    expect(withStatNumeralTargets(finding([body, R13()]), props)).toBe(props);
  });

  it('never overrides a colour or size the audit already resolved', () => {
    const resolved = { ...unresolved('color', 'x'), status: 'DIFFERENT', expected: '#b01f24', expectedToken: '--brand-red' };
    const f = finding([R12, R13()], [resolved, { ...unresolved('font-size', '36px'), status: 'DIFFERENT', expected: '2rem', expectedToken: '--x' }]);
    const out = withStatNumeralTargets(f, f.comparison.properties as never);
    expect(out.find((p) => p.property === 'color')).toMatchObject({ expected: '#b01f24' });
    expect(out.find((p) => p.property === 'font-size')).toMatchObject({ expected: '2rem' });
  });

  it('a size that is not a DS step is not invented: only the colour is derived', () => {
    const out = propertiesOf(finding([R12, R13('44.00')], [unresolved('font-size', '36px')]));
    expect(out.find((p) => p.property === 'font-size')!.status).toBe('UNRESOLVED');
    expect(out.find((p) => p.property === 'color')!.expected).toBe('#171717');
  });
});
