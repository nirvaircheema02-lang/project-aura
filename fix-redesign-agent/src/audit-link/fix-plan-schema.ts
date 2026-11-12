import { z } from 'zod';
import { parseWith } from './parse.ts';

/**
 * Read-side copy of the Fix Plan sidecar contract defined by the approved Part 1 plan
 * (audit-agent `src/output/fix-plan.ts`, `schemaVersion: 1`). `fix-plan.json` crosses a
 * trust boundary — a browser-exported, possibly hand-edited file — so it is validated
 * again HERE even though audit-agent's `fix-plan-import` already validated it: being at
 * the canonical path never by itself implies correctness (Part 1's own rule).
 *
 * `findingId` is the ONLY join key to data.json; `entries` is SPARSE — absence means
 * undecided. Decisions are lowercase on purpose: "lowercase = a human decided this".
 */
export const FIX_PLAN_DECISIONS = ['fix', 'skip', 'keep_for_review'] as const;
export type FixPlanDecision = (typeof FIX_PLAN_DECISIONS)[number];

export const FixPlanEntrySchema = z.object({
  findingId: z.string(),
  decision: z.enum(FIX_PLAN_DECISIONS),
  decidedAt: z.string(),
  decidedBy: z.string().nullable(),
  note: z.string().nullable(),
  source: z.enum(['html-report', 'dashboard']),
});
export const FixPlanSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  updatedAt: z.string().nullable(),
  entries: z.array(FixPlanEntrySchema),
});
export type FixPlan = z.infer<typeof FixPlanSchema>;
export type FixPlanEntry = z.infer<typeof FixPlanEntrySchema>;

export function parseFixPlan(json: unknown, path: string): FixPlan {
  return parseWith(FixPlanSchema, json, 'fix-plan.json', path);
}

/**
 * Splits a plan's entries into those whose `findingId` exists in data.json and those that
 * don't. Unknown ids are reported and dropped, never silently written — and an ALL-unknown
 * plan is refused by the caller as a likely wrong-run file (mirrors `fix-plan-import`).
 * A hand-edited file can repeat an id: the LAST entry wins (import's upsert semantics) and
 * the duplicate is reported.
 */
export function partitionFixPlanEntries(plan: FixPlan, knownFindingIds: ReadonlySet<string>): { known: FixPlanEntry[]; unknownIds: string[]; duplicateIds: string[] } {
  const byId = new Map<string, FixPlanEntry>();
  const duplicateIds: string[] = [];
  for (const entry of plan.entries) {
    if (byId.has(entry.findingId)) duplicateIds.push(entry.findingId);
    byId.set(entry.findingId, entry);
  }
  const known: FixPlanEntry[] = [];
  const unknownIds: string[] = [];
  for (const [id, entry] of byId) {
    if (knownFindingIds.has(id)) known.push(entry);
    else unknownIds.push(id);
  }
  return { known, unknownIds, duplicateIds };
}

export interface DecisionCounts {
  fix: number;
  skip: number;
  keep_for_review: number;
  /** Findings in data.json with no entry at all — the neutral default. */
  undecided: number;
}

export function countDecisions(known: FixPlanEntry[], totalFindings: number): DecisionCounts {
  const counts: DecisionCounts = { fix: 0, skip: 0, keep_for_review: 0, undecided: 0 };
  for (const e of known) counts[e.decision]++;
  counts.undecided = Math.max(0, totalFindings - known.length);
  return counts;
}
