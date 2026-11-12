import { readFile } from 'node:fs/promises';
import { writeJsonFile } from '../output/redesign-store.ts';
import { fingerprintOf } from './fingerprint.ts';
import type { Gate, GateOutcome } from './types.ts';

/**
 * `decisions.json` — every gate decision and every "ask" answer, each with a fingerprint,
 * actor, timestamp and note (ARCHITECTURE.md §5.3, §11.3). Append-only: a gate can be
 * decided more than once across a run's lifetime (a rejection round, a re-ask after drift),
 * and the full history is kept, never overwritten — `latestDecisionFor` is what callers use
 * to find the CURRENT answer.
 */

export interface DecisionRecord {
  gate: Gate;
  outcome: GateOutcome;
  /** The §11.3 fingerprint of exactly what was approved/decided — null for gates with no fingerprinted content (e.g. G0). */
  fingerprint: string | null;
  /** Set for G4/G5, which are per-component — null for run-level gates. */
  unitId: string | null;
  by: string;
  at: string;
  note: string | null;
}

export interface DecisionsFile {
  schemaVersion: 1;
  redesignRunId: string;
  decisions: DecisionRecord[];
}

export function emptyDecisionsFile(redesignRunId: string): DecisionsFile {
  return { schemaVersion: 1, redesignRunId, decisions: [] };
}

export async function readDecisions(decisionsJsonPath: string, fallbackRedesignRunId: string): Promise<DecisionsFile> {
  try {
    return JSON.parse(await readFile(decisionsJsonPath, 'utf-8')) as DecisionsFile;
  } catch {
    return emptyDecisionsFile(fallbackRedesignRunId);
  }
}

export async function recordDecision(decisionsJsonPath: string, redesignRunId: string, record: DecisionRecord): Promise<DecisionsFile> {
  const existing = await readDecisions(decisionsJsonPath, redesignRunId);
  const updated: DecisionsFile = { ...existing, decisions: [...existing.decisions, record] };
  await writeJsonFile(decisionsJsonPath, updated);
  return updated;
}

/** The most recent decision for a gate (and, for G4/G5, a specific unit) — null if never decided. */
export function latestDecisionFor(file: DecisionsFile, gate: Gate, unitId: string | null = null): DecisionRecord | null {
  const matches = file.decisions.filter((d) => d.gate === gate && d.unitId === unitId);
  return matches.at(-1) ?? null;
}

/**
 * §11.1 rule 3 / §11.3: an approval is reused only when the recomputed fingerprint over the
 * SAME content is identical to what was approved. Any difference means re-ask, never a
 * silent carry-forward — a rebuilt component or a changed export invalidates its own
 * approval, and only its own (§11.4 rule 5).
 */
export function isApprovalReusable(file: DecisionsFile, gate: Gate, unitId: string | null, currentFingerprint: string): boolean {
  const latest = latestDecisionFor(file, gate, unitId);
  if (!latest || latest.fingerprint === null) return false;
  // 'resolved' is G1's OWN outcome (its type, G1Outcome, has no other value) — never valid for
  // any other gate, so including it here can never wrongly validate one of THEIR outcomes.
  // Found live: without it, G1's acknowledgement half could never be reused — a run with any
  // acknowledgement-requiring conflict (§8.2's name/landmark mismatch, an `expectation-changed`
  // finding, …) would re-ask "resolved?" forever, on every single invocation, no matter how many
  // times `decide --gate G1` recorded the identical answer.
  const approvalOutcomes: GateOutcome[] = ['approve', 'approve-and-push', 'approve-design', 'resolved'];
  return approvalOutcomes.includes(latest.outcome) && latest.fingerprint === currentFingerprint;
}

export function computeFingerprint(content: unknown): string {
  return fingerprintOf(content);
}
