import type { Classification, Mismatch, Severity } from './s0-result-contract.ts';

/**
 * S5 — Compliance Classification (v1.0 §9 statuses, §13 scoring). The
 * classification decision itself is deterministic given the evidence: a
 * model supplies the expectation and any rule interpretation, this file
 * turns evidence into a status and a severity.
 */

export interface ClassifyInput {
  hasDsMatch: boolean;
  mismatches: Mismatch[];
  ruleViolations: Array<{ ruleId: string; title: string; why: string; severity?: Severity | undefined }>;
  /** Only meaningful when there is no DS match — B6's verdict. */
  newComponentVerdict?: 'NEW_COMPONENT' | 'DS_CANDIDATE' | 'NEEDS_REVIEW';
  /** A matched component on which nothing could be compared and no rule was violated (Decision Log #23/#31). */
  nothingCompared?: boolean;
  /**
   * The Design System's foundation rules (fonts, type scale, radius scale…)
   * govern every element, so a PROVEN violation stands even when the DS
   * component itself could not be determined (Decision Log #31).
   */
  foundationRulesApply?: boolean;
}

/**
 * v1.0 §9:
 *  - MATCH     — the DS component exists and is implemented correctly.
 *  - DEVIATION — the right DS component, but one or more properties differ.
 *  - INCORRECT — an approved DS solution/rule exists and production used an
 *                unapproved or incorrect implementation (a rule violation,
 *                not merely a differing value).
 *  - NEW_COMPONENT / DS_CANDIDATE — no DS equivalent exists (B6's call).
 *  - NEEDS_REVIEW — the status cannot be decided without semantic judgment.
 *  - UNVERIFIED   — a matched component on which nothing could be compared.
 */
export function classify(input: ClassifyInput): Classification {
  if (!input.hasDsMatch) {
    if (input.foundationRulesApply && input.ruleViolations.length > 0) return 'INCORRECT';
    return input.newComponentVerdict ?? 'NEW_COMPONENT';
  }
  if (input.ruleViolations.length > 0) return 'INCORRECT';
  if (input.mismatches.length > 0) return 'DEVIATION';
  if (input.nothingCompared) return 'UNVERIFIED';
  return 'MATCH';
}

/** Property groups whose drift is most visible/impactful, used by the severity rubric. */
const BRAND_CRITICAL = /^(color|background-color|border-top-color|text-decoration-color)$/;
const LAYOUT = /(width|height|padding|margin|gap)/;
const TYPOGRAPHY = /(font-family|font-size|font-weight|line-height|letter-spacing|text-transform)/;

/**
 * Deterministic severity rubric. Magnitude-aware so a 1px drift and a 20px
 * drift are not both "HIGH": the reviewer's queue is only useful if severity
 * means something.
 */
const SEVERITY_ORDER: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const worse = (a: Severity, b: Severity): Severity => (SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a);

/** Magnitude-aware severity of measured property differences (LOW when there are none). */
function mismatchSeverity(mismatches: Mismatch[]): Severity {
  let worst: Severity = 'LOW';
  for (const m of mismatches) {
    if (BRAND_CRITICAL.test(m.property)) {
      const delta = m.delta ?? 0;
      worst = worse(worst, delta > 10 ? 'HIGH' : 'MEDIUM'); // ΔE > 10 is an obviously different color, not a near-miss
    } else if (TYPOGRAPHY.test(m.property)) {
      if (m.property === 'font-family') worst = worse(worst, 'HIGH'); // wrong typeface is a whole-brand miss
      else worst = worse(worst, Math.abs(m.delta ?? 0) >= 4 ? 'MEDIUM' : 'LOW');
    } else if (LAYOUT.test(m.property)) {
      worst = worse(worst, Math.abs(m.delta ?? 0) >= 8 ? 'MEDIUM' : 'LOW');
    } else {
      worst = worse(worst, 'LOW');
    }
  }
  return worst;
}

export function severityFor(input: ClassifyInput & { classification: Classification }): Severity {
  if (input.classification === 'MATCH') return 'INFO';
  // Not a confirmed defect in either direction — the reviewer's queue, not the issue list.
  if (input.classification === 'NEW_COMPONENT' || input.classification === 'DS_CANDIDATE' || input.classification === 'NEEDS_REVIEW' || input.classification === 'UNVERIFIED') return 'INFO';

  if (input.classification === 'INCORRECT') {
    // A measured breach carries its own impact (Decision Log #31): the worst breach, or the
    // worst measured property difference alongside it, whichever is worse.
    const measured = input.ruleViolations.map((r) => r.severity).filter((x): x is Severity => x !== undefined);
    if (measured.length === input.ruleViolations.length && measured.length > 0) {
      const rules = measured.reduce(worse);
      return input.mismatches.length > 0 ? worse(rules, mismatchSeverity(input.mismatches)) : rules;
    }
    // A brand rule (e.g. R1.2 "brand red is for CTAs only") being broken is the
    // most damaging thing this audit can find — it is visible, systematic and on-brand-identity.
    const brandRule = input.ruleViolations.some((r) => /^R1\./.test(r.ruleId));
    return brandRule ? 'CRITICAL' : 'HIGH';
  }

  return mismatchSeverity(input.mismatches);
}
