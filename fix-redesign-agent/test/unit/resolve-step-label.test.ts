import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import { propertiesOf } from '../../src/resolution/resolve.ts';

const P = (property: string, expected: string | null, expectedToken: string | null = null) => ({ property, actual: 'x', expected, expectedToken, source: 'atoms/SectionLabel.tsx', status: 'DIFFERENT', note: null });
const step = (label: string): Finding =>
  ({ identity: { findingId: 'S' }, component: { dsComponent: 'SectionLabel', productionLabel: label }, comparison: { mismatches: [], properties: [P('color', 'rgba(0, 0, 0, 0.80)', '--surface-text-muted'), P('font-size', '0.8rem', '--typography-size-xs'), P('letter-spacing', '0.2em'), P('text-transform', 'uppercase')] } }) as unknown as Finding;

describe('Step labels (user instruction 2026-10-23): not upper-cased, small', () => {
  it('replaces the all-caps / tracked SectionLabel targets, keeps the DS colour', () => {
    const out = propertiesOf(step('Step 01'));
    expect(out.map((p) => p.property)).toEqual(['color', 'font-size', 'text-transform']);
    expect(out.find((p) => p.property === 'text-transform')).toMatchObject({ expected: 'none' });
    expect(out.find((p) => p.property === 'font-size')).toMatchObject({ expected: '0.6875rem', expectedToken: '--typography-size-2xs' });
    expect(out.find((p) => p.property === 'color')).toMatchObject({ expected: 'rgba(0, 0, 0, 0.80)' });
  });
  it('leaves other labels alone', () => {
    expect(propertiesOf(step('CHAPTER ONE')).find((p) => p.property === 'text-transform')).toMatchObject({ expected: 'uppercase' });
  });
});
