import { z } from 'zod';

/**
 * The reviewer's decisions about an audit run's findings — a SIDECAR file, never a `data.json`
 * change. `data.json` stays the canonical, complete audit truth; this file only records what a
 * human decided to do about it.
 *
 * Zod-schema-first (unlike the plain-interface `RunMeta` in `run-store.ts`) because this file
 * crosses a trust boundary: it is downloaded by a browser, possibly hand-edited, then imported
 * back. It gets runtime validation; `RunMeta`, which only this repo ever writes, does not.
 *
 * Decisions are lowercase deliberately — visually distinct from every `SCREAMING_SNAKE_CASE`
 * canonical status, so a reader immediately knows "lowercase = a human decided this, not audit
 * truth."
 */
export const FIX_PLAN_DECISIONS = ['fix', 'skip', 'keep_for_review'] as const;
export type FixPlanDecision = (typeof FIX_PLAN_DECISIONS)[number];

/** Where a decision was made. Both surfaces render from the same `renderRun()`, so both are first-class. */
export const FIX_PLAN_SOURCES = ['html-report', 'dashboard'] as const;

export const FixPlanEntrySchema = z.object({
  /** The ONLY join key — never any other Finding field, never duplicated finding content. */
  findingId: z.string().min(1, 'findingId must not be empty'),
  decision: z.enum(FIX_PLAN_DECISIONS),
  /** ISO 8601, client-set at decision time. */
  decidedAt: z.string().min(1, 'decidedAt must not be empty'),
  /** Free-typed reviewer name/email, optional. */
  decidedBy: z.string().nullable(),
  /** Free-text rationale, optional. */
  note: z.string().nullable(),
  source: z.enum(FIX_PLAN_SOURCES),
});

export const FixPlanSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1, 'runId must not be empty'),
  /** Stamped by the CLI at write time; a browser export leaves it null. */
  updatedAt: z.string().nullable(),
  /**
   * SPARSE — the absence of an entry IS the neutral "undecided" default. This is what keeps
   * `data.json`'s findings array the complete original set no matter how many decisions exist:
   * there is nothing here to subtract from it, and "skip" is one enum value in a separate file
   * rather than a deletion.
   */
  entries: z.array(FixPlanEntrySchema),
});

export type FixPlan = z.infer<typeof FixPlanSchema>;
export type FixPlanEntry = z.infer<typeof FixPlanEntrySchema>;

/** A valid, empty plan — what `readFixPlan` returns for a run that has no decisions yet. */
export function emptyFixPlan(runId: string): FixPlan {
  return { schemaVersion: 1, runId, updatedAt: null, entries: [] };
}

/**
 * Parses and validates an untrusted plan, formatting issues the same way `loadConfig` does
 * (`src/config/index.ts`) so every validation failure in this repo reads identically.
 */
export function parseFixPlan(raw: unknown): { ok: true; plan: FixPlan } | { ok: false; issues: string } {
  const result = FixPlanSchema.safeParse(raw);
  if (result.success) return { ok: true, plan: result.data };
  return { ok: false, issues: result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n') };
}

/**
 * Upsert-by-findingId merge. Entries already on disk that the incoming file does not mention are
 * PRESERVED — the safer default for "multiple reviewers, multiple partial exports over time,"
 * matching this repo's established "never silently lose state" ethos. Wholesale replacement is
 * `--replace`, an explicit, loudly-logged choice, because merge semantics deliberately cannot
 * represent retraction.
 */
export function mergeFixPlans(existing: FixPlan, incoming: FixPlan): FixPlan {
  const byId = new Map<string, FixPlanEntry>(existing.entries.map((e) => [e.findingId, e]));
  for (const entry of incoming.entries) byId.set(entry.findingId, entry);
  return { ...existing, runId: existing.runId, entries: [...byId.values()] };
}

/**
 * Splits incoming entries by whether their `findingId` actually exists in this run's `data.json`.
 * Unknown ids are reported and dropped, never silently written — and an all-unknown file is the
 * signature of an import aimed at the wrong run, which the CLI refuses outright.
 */
export function partitionByKnownFindings(entries: FixPlanEntry[], knownFindingIds: Set<string>): { known: FixPlanEntry[]; unknown: FixPlanEntry[] } {
  const known: FixPlanEntry[] = [];
  const unknown: FixPlanEntry[] = [];
  for (const entry of entries) (knownFindingIds.has(entry.findingId) ? known : unknown).push(entry);
  return { known, unknown };
}

/** Counts by decision, for the CLI's `figma-plan`-style summary line. */
export function countByDecision(plan: FixPlan): Record<FixPlanDecision, number> {
  const counts = { fix: 0, skip: 0, keep_for_review: 0 } satisfies Record<FixPlanDecision, number>;
  for (const entry of plan.entries) counts[entry.decision]++;
  return counts;
}
