import type { Box, ObjectiveChecks } from './types.ts';

/**
 * §6.4's five objective checks — computed, reproducible, no model involved. Pure functions so
 * every threshold decision is unit-testable without a browser.
 */

/** Intersection-over-union of two page-absolute boxes, 0..1. */
export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = ix * iy;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokens(s: string): Set<string> {
  return new Set(normalizeText(s).split(/[^a-z0-9]+/).filter(Boolean));
}

/** Dice coefficient over word tokens, 0..1 — simple, deterministic, symmetric. */
function diceSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return (2 * overlap) / (ta.size + tb.size);
}

export interface TextComparison {
  auditText: string;
  liveText: string;
  floor: number;
}

/** §6.4: "normalised text or accessible name similarity is above textSimilarityFloor, or both are empty". */
export function textCheck(input: TextComparison): boolean {
  const a = normalizeText(input.auditText);
  const b = normalizeText(input.liveText);
  if (a === '' && b === '') return true;
  return diceSimilarity(a, b) >= input.floor;
}

export interface ClassComparison {
  auditClasses: string[];
  liveClasses: string[];
}

/** Jaccard overlap of class lists — null (never counted as pass/fail) when the audit recorded no class list to compare against. */
export function classFingerprintCheck(input: ClassComparison): boolean | null {
  if (input.auditClasses.length === 0) return null;
  const a = new Set(input.auditClasses);
  const b = new Set(input.liveClasses);
  if (b.size === 0) return false;
  let overlap = 0;
  for (const c of a) if (b.has(c)) overlap++;
  const union = new Set([...a, ...b]).size;
  return union > 0 && overlap / union >= 0.5;
}

export interface IdentityComparison {
  auditTagName: string | null;
  liveTagName: string;
  auditRole: string | null;
  liveRole: string | null;
}

/** Tag and role agree with the audit's record — a null audit value (older runs) is treated as "not recorded", never a mismatch. */
export function identityCheck(input: IdentityComparison): boolean {
  const tagOk = input.auditTagName === null || input.auditTagName.toLowerCase() === input.liveTagName.toLowerCase();
  const roleOk = input.auditRole === null || input.liveRole === null || input.auditRole.toLowerCase() === input.liveRole.toLowerCase();
  return tagOk && roleOk;
}

export interface EvaluateChecksInput {
  auditBox: Box;
  liveBox: Box;
  iouFloor: number;
  text: TextComparison;
  identity: IdentityComparison;
  classes: ClassComparison;
}

export function evaluateChecks(input: EvaluateChecksInput): ObjectiveChecks {
  const geometry = iou(input.auditBox, input.liveBox) >= input.iouFloor;
  const identity = identityCheck(input.identity);
  const text = textCheck(input.text);
  const classFingerprint = classFingerprintCheck(input.classes);
  const passedCount = [geometry, identity, text, ...(classFingerprint === null ? [] : [classFingerprint])].filter(Boolean).length;
  return { geometry, identity, text, classFingerprint, passedCount };
}

/**
 * §6.4's confidence-class table, applied to one finding's candidate set:
 *  - exactly one candidate passes uniqueness (only one candidate has passedCount >= 2) → confirmed
 *  - several candidates pass, and a model selection among them itself passes → probable
 *  - several candidates pass and nothing selects one, or the model's pick fails a check → ambiguous
 *  - nothing passes → absent
 * This function only computes the DETERMINISTIC half (confirmed / needs-model / absent) —
 * the `probable` vs `ambiguous` split after a model call is `resolveModelProposal` in `model.ts`.
 */
export function classifyDeterministic(candidatesPassedCount: number[]): 'confirmed' | 'needs-model' | 'absent' {
  const passing = candidatesPassedCount.filter((n) => n >= 2);
  if (passing.length === 1) return 'confirmed';
  if (passing.length > 1) return 'needs-model';
  return 'absent';
}
