import { createHash } from 'node:crypto';

/**
 * S8 — Confidence & Escalation Policy (ARCHITECTURE.md §3 + §2.4). ONE place
 * for the bands, the calibration sample rate, and the failure/confidence
 * escalation rules — every node imports it rather than hardcoding thresholds.
 */

export const BANDS = { HIGH: 0.85, MEDIUM: 0.5 } as const;

export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW';

export function bandOf(confidence: number): ConfidenceBand {
  if (confidence >= BANDS.HIGH) return 'HIGH';
  if (confidence >= BANDS.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * §3 calibration: a fraction of HIGH-confidence auto-proceeds are pulled into
 * the Publish Gate review anyway, so overconfidence gets caught by humans
 * already in the loop (`RESEARCH-REFERENCES.md #52`). Deterministic by
 * finding id rather than Math.random: the same finding samples identically on
 * a re-run, so a reviewer's queue doesn't churn between runs of the same page.
 */
export const CALIBRATION_SAMPLE_RATE = 0.05;

export function isCalibrationSample(findingId: string, rate = CALIBRATION_SAMPLE_RATE): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const hash = createHash('sha256').update(`calibration:${findingId}`).digest();
  // First 4 bytes as a uniform [0,1) value.
  const value = hash.readUInt32BE(0) / 0x1_0000_0000;
  return value < rate;
}

export type EscalationReason =
  | 'LOW_CONFIDENCE'
  | 'NODE_FAILURE'
  | 'PLACEHOLDER_VALUE'
  | 'VISUAL_FALSE_POSITIVE'
  | 'VISUAL_UNCERTAIN'
  | 'CALIBRATION_SAMPLE'
  | 'PARTIAL_CAPTURE'
  /** A matched DS component on which nothing could actually be compared — excluded from the score (S0). */
  | 'NOT_COMPARED'
  /** The model answered for other refs but left this one out, even after a follow-up ask. */
  | 'MODEL_OMITTED'
  /** The model returned a confidence outside the 0..1 contract; the number is not trusted. */
  | 'OUT_OF_CONTRACT_CONFIDENCE'
  /** Set by S7: this component had an open issue last run and could not be compared this run — its status is unknown. */
  | 'PRIOR_ISSUE_UNVERIFIED'
  /** No deterministic decision was possible without semantic judgment (Decision Log #31) — a human decides. */
  | 'NEEDS_REVIEW';

export interface EscalationDecision {
  escalate: boolean;
  reasons: EscalationReason[];
}

/**
 * Model-supplied confidence, checked against the S0 0..1 contract. An
 * out-of-range or non-numeric value is NOT clamped to the nearest bound —
 * clamping 90 to 1.0 would publish it as HIGH. It is forced into the LOW band
 * instead, so it escalates, and the violation is reported.
 */
export function normalizeConfidence(value: number): { value: number; outOfContract: boolean } {
  if (!Number.isFinite(value) || value < 0 || value > 1) return { value: 0.4, outOfContract: true };
  return { value, outOfContract: false };
}

/**
 * The single decision point for whether a finding goes to the escalation
 * queue rather than being published as an auto-classified result.
 */
export function escalationFor(input: {
  findingId: string;
  confidence: number;
  visualVerdict?: 'CONFIRMED' | 'FALSE_POSITIVE' | 'UNCERTAIN' | 'NOT_CHECKED';
  containsPlaceholderValue?: boolean;
  capturePartiallySettled?: boolean;
  notCompared?: boolean;
  modelOmitted?: boolean;
  outOfContractConfidence?: boolean;
  needsReview?: boolean;
}): EscalationDecision {
  const reasons: EscalationReason[] = [];
  if (input.needsReview) reasons.push('NEEDS_REVIEW');
  if (input.notCompared) reasons.push('NOT_COMPARED');
  if (input.modelOmitted) reasons.push('MODEL_OMITTED');
  if (input.outOfContractConfidence) reasons.push('OUT_OF_CONTRACT_CONFIDENCE');
  if (bandOf(input.confidence) === 'LOW') reasons.push('LOW_CONFIDENCE');
  // §2.7: a value still matching the placeholder signature after settling is never
  // reported as a real measurement — it goes to a human instead.
  if (input.containsPlaceholderValue) reasons.push('PLACEHOLDER_VALUE');
  if (input.visualVerdict === 'FALSE_POSITIVE') reasons.push('VISUAL_FALSE_POSITIVE');
  if (input.visualVerdict === 'UNCERTAIN') reasons.push('VISUAL_UNCERTAIN');
  if (input.capturePartiallySettled) reasons.push('PARTIAL_CAPTURE');
  if (reasons.length === 0 && isCalibrationSample(input.findingId)) reasons.push('CALIBRATION_SAMPLE');
  return { escalate: reasons.length > 0, reasons };
}

/**
 * §3: B3's routing rule. A match below MEDIUM is not a shaky Match/Deviation —
 * it goes down the B6 "no DS match" branch instead.
 */
export function routesToNewComponentEvaluator(match: { dsComponent: string | null; confidence: number; foundationOnly?: boolean | undefined }): boolean {
  if (match.foundationOnly === true) return false; // body text / stat numerals: foundation rules only, never a new-component question
  return match.dsComponent === null || bandOf(match.confidence) === 'LOW';
}
