import type { Finding } from '../audit-link/index.ts';
import type { LibraryBucket, Suggestion } from './schema.ts';

/**
 * §9.1's connection point — R6's decision table (Decision Log #24): a pure function with a
 * rule id and confidence on every answer, `unresolved` a legitimate outcome, never forced.
 * First match wins.
 */

const COSMETIC_PROPERTIES = new Set([
  'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'text-transform', 'text-decoration-line', 'text-decoration-color',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'row-gap', 'column-gap',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'border-top-color', 'box-shadow', 'opacity',
]);

export type MismatchClass = 'none' | 'cosmetic' | 'structural';

export function classifyMismatches(mismatches: Array<{ property: string }>): MismatchClass {
  if (mismatches.length === 0) return 'none';
  return mismatches.every((m) => COSMETIC_PROPERTIES.has(m.property)) ? 'cosmetic' : 'structural';
}

export interface SuggestInput {
  finding: Finding;
  instanceCount: number;
  verified: boolean;
  plausibilityBar: number;
  reuse: 'multi-page' | 'repeated-on-page' | 'single';
}

export function suggestBucket(input: SuggestInput): Suggestion {
  const { finding, instanceCount, verified, plausibilityBar, reuse } = input;
  const mismatchClass = classifyMismatches(finding.comparison.mismatches);
  const topScore = Math.max(0, ...(finding.review?.possibleMatches.map((m) => m.score) ?? [0]));

  if (finding.action.registryUpdateRef || finding.classification === 'DS_CANDIDATE' || finding.classification === 'NEW_COMPONENT') {
    return bucket('new-component', 'R1', 'high', 'the audit already proposed this as a registry candidate or new component');
  }
  if (finding.classification === 'MATCH') {
    return bucket('existing-correct', 'R2', 'high', 'the audit measured this as a compliant match');
  }
  if ((finding.classification === 'DEVIATION' || finding.classification === 'INCORRECT') && finding.component.dsComponent) {
    if (verified || mismatchClass !== 'structural') {
      return bucket('page-fix-only', 'R3', verified ? 'high' : 'medium', verified ? 'the redesign verified this finding fixed against its matched DS component' : 'only cosmetic properties differ from the matched DS component — no structural change needed');
    }
    return bucket('existing-needs-update', 'R4', instanceCount >= 2 ? 'medium' : 'low', `structural mismatch against the matched DS component, unverified${instanceCount >= 2 ? ` (repeats ${instanceCount}×)` : ''}`);
  }
  if (finding.classification === 'UNVERIFIED' && finding.component.dsComponent) {
    return bucket('existing-correct', 'R5', 'low', 'a DS component match exists but nothing could be compared — treated as likely correct, low confidence');
  }
  if (topScore >= plausibilityBar) {
    return bucket('existing-needs-update', 'R6', 'medium', `top possible match scores ${topScore.toFixed(2)}, at or above the plausibility bar (${plausibilityBar})`);
  }
  if (instanceCount >= 2 || reuse === 'multi-page') {
    return bucket('new-component', 'R7', 'medium', `no plausible DS match, but the pattern ${reuse === 'multi-page' ? 'recurs on other audited pages' : `repeats ${instanceCount}× on this page`}`);
  }
  return bucket('unresolved', 'R8', 'low', 'single instance, no plausible DS match — a human should decide');
}

function bucket(bucket: LibraryBucket, rule: string, confidence: Suggestion['confidence'], reason: string): Suggestion {
  return { bucket, rule, confidence, reason };
}
