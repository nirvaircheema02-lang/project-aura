import { describe, expect, it } from 'vitest';
import { interpolate } from '../../templates/react-preview/src/runtime/scrollEffects.ts';

// measured on the production page: translateY of the hero card stack against scroll offset
const HERO: Array<[number, number]> = [[0, 20], [60, -4.38], [120, -35.55], [200, -76.6], [300, -128.7], [400, -184.87], [500, -242.55], [600, -300.79], [700, -350]];

describe('interpolate (scroll-linked effect replay)', () => {
  it('returns the recorded values exactly at the sample offsets', () => {
    for (const [y, v] of HERO) expect(interpolate(HERO, y)).toBeCloseTo(v, 5);
  });
  it('is piecewise-linear between samples', () => {
    expect(interpolate(HERO, 30)).toBeCloseTo((20 + -4.38) / 2, 5);
    expect(interpolate(HERO, 250)).toBeCloseTo((-76.6 + -128.7) / 2, 5);
  });
  it('REGRESSION: starts at the original\'s scroll-0 position (+20px), not at a state frozen at some other scroll offset', () => {
    expect(interpolate(HERO, 0)).toBe(20);
    expect(interpolate(HERO, -50)).toBe(20);
  });
  it('clamps at the last sample (the original stops at -350px) and handles empty input', () => {
    expect(interpolate(HERO, 700)).toBe(-350);
    expect(interpolate(HERO, 5000)).toBe(-350);
    expect(interpolate([], 100)).toBe(0);
  });
});
