import { describe, expect, it } from 'vitest';
import { propertyMatchesExpected } from '../../src/style/compare-expected.ts';

/**
 * Replays audit-agent's own comparison method (§8.9's re-measurement) — pure, no browser
 * needed. ΔE values below are real culori CIEDE2000 outputs for the given hex pairs, not
 * hand-derived, so the 2-unit floor is exercised against the actual implementation.
 */

describe('propertyMatchesExpected: exact', () => {
  it('matches on identical strings and ignores surrounding whitespace', () => {
    expect(propertyMatchesExpected('exact', 'flex', 'flex')).toEqual({ matches: true, note: '"flex" vs expected "flex"' });
    expect(propertyMatchesExpected('exact', '  16px ', '16px')).toEqual({ matches: true, note: '"  16px " vs expected "16px"' });
  });
  it('fails on any other difference', () => {
    expect(propertyMatchesExpected('exact', 'flex', 'grid').matches).toBe(false);
  });
});

describe('propertyMatchesExpected: color-deltaE', () => {
  it('passes when ΔE <= 2 (perceptually indistinguishable), including an exact match', () => {
    expect(propertyMatchesExpected('color-deltaE', '#b01f24', '#b01f24')).toEqual({ matches: true, note: 'ΔE 0.00 ("#b01f24" vs "#b01f24")' });
    // real ΔE ~0.60 for this pair
    const close = propertyMatchesExpected('color-deltaE', '#b01f24', '#b21f26');
    expect(close.matches).toBe(true);
    expect(close.note).toBe('ΔE 0.60 ("#b01f24" vs "#b21f26")');
  });
  it('fails when ΔE > 2', () => {
    // real ΔE ~3.30 for this pair — a visible hue/lightness shift, not a rounding difference
    const far = propertyMatchesExpected('color-deltaE', '#b01f24', '#a01f24');
    expect(far.matches).toBe(false);
    expect(far.note).toBe('ΔE 3.30 ("#b01f24" vs "#a01f24")');
    expect(propertyMatchesExpected('color-deltaE', '#000000', '#ffffff').matches).toBe(false);
  });
  it('fails, never assumes a match, when a color cannot be parsed', () => {
    const result = propertyMatchesExpected('color-deltaE', '#b01f24', 'not-a-color');
    expect(result).toEqual({ matches: false, note: 'could not parse one of the colors ("#b01f24" / "not-a-color")' });
  });
});

describe('propertyMatchesExpected: length-px', () => {
  it('matches within the ±1px tolerance, including unit conversion (rem -> px at 16px root)', () => {
    expect(propertyMatchesExpected('length-px', '16px', '16px')).toEqual({ matches: true, note: '16px vs expected 16px' });
    expect(propertyMatchesExpected('length-px', '16.4px', '16px').matches).toBe(true); // delta 0.4
    expect(propertyMatchesExpected('length-px', '1rem', '16px')).toEqual({ matches: true, note: '16px vs expected 16px' });
  });
  it('fails outside the ±1px tolerance', () => {
    const result = propertyMatchesExpected('length-px', '17.5px', '16px'); // delta 1.5
    expect(result).toEqual({ matches: false, note: '17.5px vs expected 16px' });
  });
  it('fails, never assumes a match, when a length cannot be parsed', () => {
    const result = propertyMatchesExpected('length-px', 'auto', '16px');
    expect(result).toEqual({ matches: false, note: 'could not parse one of the lengths ("auto" / "16px")' });
  });
});

describe('propertyMatchesExpected: unsupported', () => {
  it('never assumes a match without a defined comparison', () => {
    expect(propertyMatchesExpected('unsupported', 'anything', 'anything')).toEqual({
      matches: false,
      note: 'unsupported comparison method — never assumed to match without a defined comparison',
    });
  });
});
