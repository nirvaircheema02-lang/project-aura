import { describe, expect, it } from 'vitest';
import { lengthToPx } from '../../src/t-layer/computed-style.ts';
import { formatPx, NEAREST_TIE_EPSILON_PX, pickNearestSize, type SizeCandidate } from '../../src/skills/nearest-typography.ts';

/**
 * Nearest typography match — the audit's permanent rule for which Design System size a rendered
 * font-size is compared against. Pure arithmetic: no browser, no DS files. The DS heading sizes
 * used here are the real ones at a desktop viewport (SectionHeading: level 1 3.052rem, level 2
 * 2.441rem, level 3 1.953rem — px after the same rem normalisation the comparator uses).
 */

const REM = (rem: number, root = 16) => lengthToPx(`${rem}rem`, root) as number;

/** SectionHeading at a desktop viewport, as B3 builds it. */
const LEVELS: Array<SizeCandidate<string>> = [
  { id: 'h1', sizePx: REM(3.052), semanticLevel: 1, payload: 'level 1' },
  { id: 'h2', sizePx: REM(2.441), semanticLevel: 2, payload: 'level 2' },
  { id: 'h3', sizePx: REM(1.953), semanticLevel: 3, payload: 'level 3' },
];

describe('px / rem normalisation — what the distances are measured in', () => {
  it('px is taken as is, rem is relative to the PAGE root font size, em to the element', () => {
    expect(lengthToPx('32px', 16)).toBe(32);
    expect(REM(1.953)).toBeCloseTo(31.248, 3); // 1.953rem × 16
    expect(REM(2.441)).toBeCloseTo(39.056, 3);
    expect(lengthToPx('1.953rem', 18)).toBeCloseTo(35.154, 3); // a page whose root is 18px has bigger rems
    expect(lengthToPx('2em', 16, 20)).toBe(40); // em × the element's own size
  });

  it('a value that is not a plain length is not a size — it cannot become a candidate', () => {
    expect(lengthToPx('clamp(2rem, 4vw, 3rem)', 16)).toBeNull();
    expect(lengthToPx('auto', 16)).toBeNull();
  });

  it('display values keep at most two decimals: 31.248 → 31.25px, 7.056 → 7.06px, 32 → 32px', () => {
    expect(formatPx(REM(1.953))).toBe('31.25px');
    expect(formatPx(Math.abs(32 - REM(2.441)))).toBe('7.06px');
    expect(formatPx(Math.abs(32 - REM(1.953)))).toBe('0.75px');
    expect(formatPx(32)).toBe('32px');
  });
});

describe('nearest wins — regression 1/2/3: the semantic level is never the first rule', () => {
  it('actual 32px with DS 31.25px and 39.06px → 31.25px (0.75px away, not 7.06px)', () => {
    const pick = pickNearestSize(32, [LEVELS[1]!, LEVELS[2]!])!;
    expect(pick.chosen.id).toBe('h3');
    expect(pick.distancePx).toBeCloseTo(0.752, 3);
    expect(pick.decidedBy).toBe('distance');
    expect(pick.tied).toEqual([]);
    expect(pick.ranked.map((r) => r.candidate.id)).toEqual(['h3', 'h2']); // nearest first
  });

  it('actual 38px → 39.06px, the nearest, whichever heading level the element happens to be', () => {
    for (const semanticLevel of [1, 2, 3]) {
      const pick = pickNearestSize(38, LEVELS, { semanticLevel })!;
      expect(pick.chosen.id, `semantic level ${semanticLevel}`).toBe('h2');
      expect(pick.distancePx).toBeCloseTo(1.056, 3);
      expect(pick.decidedBy).toBe('distance');
    }
  });

  it('an h2 (semantic level 2) rendered at 32px is audited against level 3 — the tag does not pull it to level 2', () => {
    const pick = pickNearestSize(32, LEVELS, { semanticLevel: 2 })!;
    expect(pick.chosen.payload).toBe('level 3');
    expect(pick.decidedBy).toBe('distance'); // decided by distance alone: the tag was never consulted
  });

  it('candidate order never matters — the nearest wins from any position', () => {
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2]]) {
      expect(pickNearestSize(32, order.map((i) => LEVELS[i]!))!.chosen.id).toBe('h3');
    }
  });

  it('far above or below the whole scale, the nearest end of it is still the answer', () => {
    expect(pickNearestSize(80, LEVELS)!.chosen.id).toBe('h1');
    expect(pickNearestSize(12, LEVELS)!.chosen.id).toBe('h3');
  });
});

describe('regression 5: an exact DS size is preserved', () => {
  it('rendering exactly a DS size → distance 0 and that candidate, whatever the tag says', () => {
    for (const level of LEVELS) {
      const pick = pickNearestSize(level.sizePx, LEVELS, { semanticLevel: 2 })!;
      expect(pick.chosen.id).toBe(level.id);
      expect(pick.distancePx).toBe(0);
      expect(pick.decidedBy).toBe('distance');
    }
  });
});

describe('regression 4: equal-distance candidates are separated by evidence, in the order the user set', () => {
  // 35 is exactly between 30 and 40: both are 5px away.
  const low = (over: Partial<SizeCandidate<string>> = {}): SizeCandidate<string> => ({ id: 'low', sizePx: 30, semanticLevel: 3, payload: 'low', ...over });
  const high = (over: Partial<SizeCandidate<string>> = {}): SizeCandidate<string> => ({ id: 'high', sizePx: 40, semanticLevel: 2, payload: 'high', ...over });

  it('tier 1 — contextual/component evidence: the candidate whose OTHER properties the element already fits', () => {
    const pick = pickNearestSize(35, [low({ context: 0.5 }), high({ context: 1 })], { semanticLevel: 3 })!;
    expect(pick.chosen.id).toBe('high'); // even though the element's own level (3) is `low`'s
    expect(pick.decidedBy).toBe('context');
    expect(pick.tied.map((t) => t.id)).toEqual(['low']);
    expect(pickNearestSize(35, [low({ context: 1 }), high({ context: 0.5 })], { semanticLevel: 2 })!.chosen.id).toBe('low');
  });

  it('tier 2 — visual hierarchy: the candidate that keeps the element\'s rank among the page\'s headings', () => {
    // Page headings: 48, 40, 40, 30. The element (35) sits below the 40s and above the 30: rank 2 (two larger sizes).
    // Promoting it to 40 would make it equal to the 40s (rank 1); 30 keeps it at rank 2.
    const pick = pickNearestSize(35, [low(), high()], { semanticLevel: 2, pageHeadingSizesPx: [48, 40, 40, 30] })!;
    expect(pick.chosen.id).toBe('low'); // the hierarchy outranks the element's own level (2 = `high`)
    expect(pick.decidedBy).toBe('hierarchy');
  });

  it('context evidence that is the SAME for both does not decide — it passes on to the hierarchy', () => {
    const pick = pickNearestSize(35, [low({ context: 0.5 }), high({ context: 0.5 })], { pageHeadingSizesPx: [48, 40, 40, 30] })!;
    expect(pick.decidedBy).toBe('hierarchy');
    expect(pick.chosen.id).toBe('low');
  });

  it('tier 3 — semantic heading level: only now, as the tie-breaker, closest to the element\'s own level', () => {
    expect(pickNearestSize(35, [low(), high()], { semanticLevel: 2 })!.chosen.id).toBe('high');
    expect(pickNearestSize(35, [low(), high()], { semanticLevel: 3 })!.chosen.id).toBe('low');
    expect(pickNearestSize(35, [low(), high()], { semanticLevel: 3 })!.decidedBy).toBe('semantic-level');
  });

  it('when nothing separates them the larger size wins — an element is never demoted on a coin-flip', () => {
    const pick = pickNearestSize(35, [low({ semanticLevel: null }), high({ semanticLevel: null })])!;
    expect(pick.chosen.id).toBe('high');
    expect(pick.decidedBy).toBe('order');
    expect(pickNearestSize(35, [high({ semanticLevel: null }), low({ semanticLevel: null })])!.chosen.id).toBe('high'); // not input order
  });

  it('a tier that cannot tell them apart (missing evidence on one side) is skipped, never guessed from', () => {
    // `low` has no context score at all: comparing 1.0 with "unknown" would be a guess.
    const pick = pickNearestSize(35, [low({ context: null }), high({ context: 1 })], { semanticLevel: 3 })!;
    expect(pick.decidedBy).toBe('semantic-level');
    expect(pick.chosen.id).toBe('low');
  });

  it('three-way tie: a tier may narrow the field and the next one finishes it', () => {
    const mid = (): SizeCandidate<string> => ({ id: 'mid', sizePx: 35, semanticLevel: 4, payload: 'mid' });
    // 35 is exactly `mid`; make `low`/`high` irrelevant by making `mid`'s distance 0 — no tie at all.
    expect(pickNearestSize(35, [low(), mid(), high()])!.chosen.id).toBe('mid');
    // Tie between three candidates at the same distance from 35: 30, 40 and a second 40-sized one.
    const a: SizeCandidate<string> = { id: 'a', sizePx: 30, context: 1, semanticLevel: 1, payload: 'a' };
    const b: SizeCandidate<string> = { id: 'b', sizePx: 40, context: 1, semanticLevel: 2, payload: 'b' };
    const c: SizeCandidate<string> = { id: 'c', sizePx: 40, context: 0.5, semanticLevel: 3, payload: 'c' };
    const pick = pickNearestSize(35, [a, b, c], { semanticLevel: 2 })!;
    expect(pick.chosen.id).toBe('b'); // context removes c; then the element's own level (2) separates a from b
    expect(pick.decidedBy).toBe('semantic-level');
  });

  it(`distances closer than ${NEAREST_TIE_EPSILON_PX}px are rounding noise — still a tie, not a "nearest"`, () => {
    const pick = pickNearestSize(35, [low({ sizePx: 30.004 }), high({ sizePx: 39.996 })], { semanticLevel: 3 })!;
    expect(pick.decidedBy).toBe('semantic-level');
    // …while a real difference is never a tie.
    expect(pickNearestSize(35, [low({ sizePx: 30 }), high({ sizePx: 39.9 })], { semanticLevel: 2 })!.decidedBy).toBe('distance');
  });
});

describe('never guesses', () => {
  it('a single candidate is the answer and says so', () => {
    const pick = pickNearestSize(32, [LEVELS[2]!])!;
    expect(pick.chosen.id).toBe('h3');
    expect(pick.decidedBy).toBe('only-candidate');
  });

  it('nothing to compare → null, so the caller keeps its own (semantic) fallback instead of inventing a size', () => {
    expect(pickNearestSize(32, [])).toBeNull();
    expect(pickNearestSize(Number.NaN, LEVELS)).toBeNull();
    expect(pickNearestSize(0, LEVELS)).toBeNull();
    expect(pickNearestSize(32, [{ id: 'x', sizePx: Number.NaN, payload: 'x' }])).toBeNull();
  });
});
