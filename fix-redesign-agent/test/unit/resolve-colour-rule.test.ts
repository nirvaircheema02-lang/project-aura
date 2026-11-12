import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import { propertiesOf, withColourRuleTargets } from '../../src/resolution/resolve.ts';

const R11 = (colour: string, token: string, hex: string, what = 'body text') => ({ ruleId: 'R1.1', title: '92-5-3 Color Hierarchy', why: `${what} colour ${colour} is not a Design System colour (closest: ${token} ${hex}, ΔE 4) — R1.1: text is drawn from the foundation palette`, severity: 'MEDIUM' });
const finding = (ruleViolations: unknown[], properties: unknown[] | null = null): Finding =>
  ({ identity: { findingId: 'F' }, component: { dsComponent: null }, comparison: { mismatches: [], ruleViolations, ...(properties ? { properties } : {}) } }) as unknown as Finding;
const UNRESOLVED = { property: 'color', actual: 'rgb(70, 68, 73)', expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: 'Observed value; no verified DS requirement for this property/part.' };

describe('R1.1 — the audit names the Design System colour a text colour should be', () => {
  it('REGRESSION: an UNRESOLVED color with an R1.1 violation becomes an expected value (the closest DS token and its hex), so the colour is applied', () => {
    const f = finding([R11('rgb(70, 68, 73)', '--color-ramp-black-700', '#404040')], [UNRESOLVED]);
    const color = propertiesOf(f).find((p) => p.property === 'color')!;
    expect(color).toMatchObject({ status: 'DIFFERENT', expected: '#404040', expectedToken: '--color-ramp-black-700', actual: 'rgb(70, 68, 73)', source: 'foundation rule R1.1' });
  });

  it('adds the property when the per-property record has no color entry (stat numerals are the exception: see resolve-stat-numeral.test.ts)', () => {
    const f = finding([R11('rgb(101, 101, 101)', '--color-ramp-black-500', '#737373', 'caption text')], [{ property: 'font-size', actual: '16px', expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: null }]);
    const out = propertiesOf(f);
    expect(out.map((p) => p.property)).toEqual(['font-size', 'color']);
    expect(out[1]).toMatchObject({ expected: '#737373', expectedToken: '--color-ramp-black-500' });
  });

  it('never overrides a color the audit already resolved (DIFFERENT with its own expected value, or MATCH)', () => {
    const resolved = { ...UNRESOLVED, status: 'DIFFERENT', expected: '#b01f24', expectedToken: '--brand-red' };
    const f = finding([R11('rgb(70, 68, 73)', '--color-ramp-black-700', '#404040')], [resolved]);
    expect(propertiesOf(f).find((p) => p.property === 'color')).toMatchObject({ expected: '#b01f24', expectedToken: '--brand-red' });
    const matched = { ...UNRESOLVED, status: 'MATCH' };
    expect(propertiesOf(finding([R11('rgb(70, 68, 73)', '--color-ramp-black-700', '#404040')], [matched])).find((p) => p.property === 'color')!.status).toBe('MATCH');
  });

  it('REGRESSION: a neutral grey is never tinted — the audit\'s "closest" warm-ramp beige (#c8bcb8 for rgb(189,189,189)) is NOT applied, the colour stays unresolved', () => {
    const f = finding([R11('rgb(189, 189, 189)', '--color-ramp-warm-700', '#c8bcb8')], [{ ...UNRESOLVED, actual: 'rgb(189, 189, 189)' }]);
    const props = [{ ...UNRESOLVED, actual: 'rgb(189, 189, 189)' }] as never[];
    expect(withColourRuleTargets(f, props)).toBe(props);
    expect(propertiesOf(f).find((p) => p.property === 'color')!.status).toBe('UNRESOLVED');
  });

  it('a near-neutral text colour still moves to the neutral ramp (rgb(70,68,73) → #404040)', () => {
    const f = finding([R11('rgb(70, 68, 73)', '--color-ramp-black-700', '#404040')], [UNRESOLVED]);
    expect(propertiesOf(f).find((p) => p.property === 'color')!.expected).toBe('#404040');
  });

  it('ignores other rules (spacing/typography/brand-red) and violations without a closest token: nothing is invented, nothing structural changes', () => {
    const others = [
      { ruleId: 'R3.5', title: 'Spacing', why: 'margin 10px is not a step of the Design System spacing scale (nearest: 12px, 2px away)', severity: 'LOW' },
      { ruleId: 'R1.2', title: 'brand red', why: 'body text painted in brand red — R1.2: brand red is for CTAs only', severity: 'MEDIUM' },
      { ruleId: 'R1.1', title: 'colour', why: 'body text colour rgb(1, 2, 3) is not a Design System colour', severity: 'MEDIUM' },
    ];
    const props = [UNRESOLVED] as never[];
    expect(withColourRuleTargets(finding(others), props)).toBe(props);
  });
});
