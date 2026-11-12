import { colorDeltaEWithAlpha, lengthToPx } from '../t-layer/computed-style.ts';

/**
 * Replays audit-agent's OWN comparison method for one finding's mismatch (§8.9's
 * re-measurement) — `mismatch.comparison` already says HOW to compare, so this never
 * re-derives a judgment call, only executes the one the audit already made.
 */
export interface PropertyComparison {
  matches: boolean;
  note: string;
}

export function propertyMatchesExpected(comparisonMethod: 'exact' | 'color-deltaE' | 'length-px' | 'unsupported', actual: string, expected: string): PropertyComparison {
  switch (comparisonMethod) {
    case 'exact':
      return { matches: actual.trim() === expected.trim(), note: `"${actual}" vs expected "${expected}"` };
    case 'color-deltaE': {
      const delta = colorDeltaEWithAlpha(actual, expected);
      if (delta === null) return { matches: false, note: `could not parse one of the colors ("${actual}" / "${expected}")` };
      // ΔE ≤ 2 is the conventional "perceptually indistinguishable" floor — matches the
      // severity intent audit-agent's own ΔE-based classification already uses.
      return { matches: delta <= 2, note: `ΔE ${delta.toFixed(2)} ("${actual}" vs "${expected}")` };
    }
    case 'length-px': {
      const a = lengthToPx(actual);
      const e = lengthToPx(expected);
      if (a === null || e === null) return { matches: false, note: `could not parse one of the lengths ("${actual}" / "${expected}")` };
      return { matches: Math.abs(a - e) <= 1, note: `${a}px vs expected ${e}px` };
    }
    default:
      return { matches: false, note: 'unsupported comparison method — never assumed to match without a defined comparison' };
  }
}
