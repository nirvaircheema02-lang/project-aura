import { describe, expect, it } from 'vitest';
import {
  classFingerprintCheck,
  classifyDeterministic,
  evaluateChecks,
  identityCheck,
  iou,
  textCheck,
} from '../../src/mapping/objective-checks.ts';
import type { Box } from '../../src/mapping/types.ts';

/** §6.4's five objective checks — pure, no browser needed. */

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });

describe('iou', () => {
  it('is 1 for an identical box, 0 for no overlap', () => {
    expect(iou(box(0, 0, 100, 100), box(0, 0, 100, 100))).toBe(1);
    expect(iou(box(0, 0, 10, 10), box(200, 200, 10, 10))).toBe(0);
  });
  it('computes partial overlap by the intersection/union formula', () => {
    // a=[0,10]x[0,10], b=[5,15]x[0,10]: intersection 5x10=50, union 100+100-50=150
    expect(iou(box(0, 0, 10, 10), box(5, 0, 10, 10))).toBeCloseTo(1 / 3, 10);
  });
  it('is 0 for a degenerate (zero-area) union', () => {
    expect(iou(box(0, 0, 0, 0), box(0, 0, 0, 0))).toBe(0);
  });
});

describe('textCheck (Dice coefficient)', () => {
  it('passes on a perfect match and on both-empty regardless of floor', () => {
    expect(textCheck({ auditText: 'Talk to a Strategy Expert', liveText: 'Talk to a Strategy Expert', floor: 0.9 })).toBe(true);
    expect(textCheck({ auditText: '   ', liveText: '', floor: 0.99 })).toBe(true);
  });
  it('fails on no token overlap', () => {
    expect(textCheck({ auditText: 'apple banana', liveText: 'cherry date', floor: 0.5 })).toBe(false);
  });
  it('passes at the floor, fails just below it', () => {
    // {apple,banana} vs {apple,cherry}: overlap 1, dice = 2*1/(2+2) = 0.5
    expect(textCheck({ auditText: 'apple banana', liveText: 'apple cherry', floor: 0.5 })).toBe(true);
    expect(textCheck({ auditText: 'apple banana', liveText: 'apple cherry', floor: 0.51 })).toBe(false);
  });
  it('is case- and whitespace-insensitive', () => {
    expect(textCheck({ auditText: '  Buy   NOW ', liveText: 'buy now', floor: 1 })).toBe(true);
  });
});

describe('classFingerprintCheck (Jaccard)', () => {
  it('returns null — never false — when the audit recorded no classes', () => {
    expect(classFingerprintCheck({ auditClasses: [], liveClasses: ['btn', 'btn-primary'] })).toBeNull();
    expect(classFingerprintCheck({ auditClasses: [], liveClasses: [] })).toBeNull();
  });
  it('fails when the audit recorded classes but the live element has none', () => {
    expect(classFingerprintCheck({ auditClasses: ['btn'], liveClasses: [] })).toBe(false);
  });
  it('passes at the 0.5 floor, fails below it', () => {
    // union {a,b,c,d}=4, overlap {a,b}=2 -> 0.5
    expect(classFingerprintCheck({ auditClasses: ['a', 'b'], liveClasses: ['a', 'b', 'c', 'd'] })).toBe(true);
    // union {a,b,c}=3, overlap {a}=1 -> 0.333
    expect(classFingerprintCheck({ auditClasses: ['a', 'b'], liveClasses: ['a', 'c'] })).toBe(false);
  });
  it('passes on a full match', () => {
    expect(classFingerprintCheck({ auditClasses: ['btn', 'btn-primary'], liveClasses: ['btn-primary', 'btn'] })).toBe(true);
  });
});

describe('identityCheck', () => {
  it('passes on matching tag and role, case-insensitively', () => {
    expect(identityCheck({ auditTagName: 'BUTTON', liveTagName: 'button', auditRole: 'Button', liveRole: 'button' })).toBe(true);
  });
  it('treats a null audit tag or role as "not recorded" — never a mismatch', () => {
    expect(identityCheck({ auditTagName: null, liveTagName: 'a', auditRole: 'button', liveRole: 'button' })).toBe(true);
    expect(identityCheck({ auditTagName: 'button', liveTagName: 'button', auditRole: null, liveRole: 'link' })).toBe(true);
  });
  it('treats a null live role as "not recorded" too', () => {
    expect(identityCheck({ auditTagName: 'button', liveTagName: 'button', auditRole: 'button', liveRole: null })).toBe(true);
  });
  it('fails on a genuine tag mismatch even when role matches', () => {
    expect(identityCheck({ auditTagName: 'button', liveTagName: 'a', auditRole: 'button', liveRole: 'button' })).toBe(false);
  });
  it('fails on a genuine role mismatch', () => {
    expect(identityCheck({ auditTagName: 'div', liveTagName: 'div', auditRole: 'button', liveRole: 'presentation' })).toBe(false);
  });
});

describe('evaluateChecks', () => {
  const identity: Parameters<typeof evaluateChecks>[0]['identity'] = { auditTagName: 'button', liveTagName: 'button', auditRole: null, liveRole: null };

  it('passes every check on a perfect match; classFingerprint counts toward passedCount when non-null', () => {
    const result = evaluateChecks({
      auditBox: box(0, 0, 100, 100),
      liveBox: box(0, 0, 100, 100),
      iouFloor: 0.6,
      text: { auditText: 'Buy now', liveText: 'Buy now', floor: 0.7 },
      identity,
      classes: { auditClasses: ['btn'], liveClasses: ['btn'] },
    });
    expect(result).toEqual({ geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 });
  });

  it('excludes a null classFingerprint from passedCount rather than counting it as a fail', () => {
    const result = evaluateChecks({
      auditBox: box(0, 0, 100, 100),
      liveBox: box(0, 0, 100, 100),
      iouFloor: 0.6,
      text: { auditText: 'Buy now', liveText: 'Buy now', floor: 0.7 },
      identity,
      classes: { auditClasses: [], liveClasses: ['btn'] },
    });
    expect(result.classFingerprint).toBeNull();
    expect(result.passedCount).toBe(3);
  });

  it('geometry passes exactly at iouFloor, fails just below it', () => {
    // overlap width 75 of two 100x100 boxes -> iou exactly 0.6
    const passing = evaluateChecks({
      auditBox: box(0, 0, 100, 100),
      liveBox: box(25, 0, 100, 100),
      iouFloor: 0.6,
      text: { auditText: '', liveText: 'x', floor: 0.7 },
      identity: { auditTagName: null, liveTagName: 'div', auditRole: null, liveRole: null },
      classes: { auditClasses: [], liveClasses: [] },
    });
    expect(passing.geometry).toBe(true);
    // overlap width 74 -> iou 7400/12600 = 0.5873...
    const failing = evaluateChecks({
      auditBox: box(0, 0, 100, 100),
      liveBox: box(26, 0, 100, 100),
      iouFloor: 0.6,
      text: { auditText: '', liveText: 'x', floor: 0.7 },
      identity: { auditTagName: null, liveTagName: 'div', auditRole: null, liveRole: null },
      classes: { auditClasses: [], liveClasses: [] },
    });
    expect(failing.geometry).toBe(false);
  });

  it('no checks pass -> passedCount 0', () => {
    const result = evaluateChecks({
      auditBox: box(0, 0, 10, 10),
      liveBox: box(500, 500, 10, 10),
      iouFloor: 0.6,
      text: { auditText: 'apple', liveText: 'orange', floor: 0.5 },
      identity: { auditTagName: 'button', liveTagName: 'a', auditRole: 'button', liveRole: 'link' },
      classes: { auditClasses: ['btn'], liveClasses: [] },
    });
    expect(result).toEqual({ geometry: false, identity: false, text: false, classFingerprint: false, passedCount: 0 });
  });
});

describe('classifyDeterministic', () => {
  it('exactly one candidate at or above 2 checks -> confirmed', () => {
    expect(classifyDeterministic([3, 1, 0])).toBe('confirmed');
    expect(classifyDeterministic([2])).toBe('confirmed');
  });
  it('more than one candidate at or above 2 checks -> needs-model', () => {
    expect(classifyDeterministic([2, 3])).toBe('needs-model');
    expect(classifyDeterministic([4, 2, 2])).toBe('needs-model');
  });
  it('nothing reaches 2 checks -> absent', () => {
    expect(classifyDeterministic([1, 0, 1])).toBe('absent');
    expect(classifyDeterministic([])).toBe('absent');
  });
  it('the boundary is >= 2, not > 2', () => {
    expect(classifyDeterministic([1])).toBe('absent');
    expect(classifyDeterministic([2])).toBe('confirmed');
  });
});
