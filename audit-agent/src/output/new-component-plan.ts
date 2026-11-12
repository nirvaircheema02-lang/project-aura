import { z } from 'zod';

/**
 * A reviewer's selection of NEW_COMPONENT/DS_CANDIDATE findings proposed for Design System
 * addition — a SIDECAR file, deliberately separate from `fix-plan.ts`'s Fix Plan. Selecting a
 * candidate here is not a Fix/Skip/Keep-for-Review decision; there is no such decision to make
 * about a new component, only whether to propose it.
 *
 * B6 (`src/agents/b6-new-component-evaluator`) already fully classifies every finding here as
 * NEW_COMPONENT or DS_CANDIDATE — this file adds nothing to that classification, it only records
 * which already-classified candidates a human chose to hand off. `data.json` is never mutated by
 * it, exactly like the Fix Plan.
 */
export const NEW_COMPONENT_PLAN_CLASSIFICATIONS = ['NEW_COMPONENT', 'DS_CANDIDATE'] as const;
export type NewComponentPlanClassification = (typeof NEW_COMPONENT_PLAN_CLASSIFICATIONS)[number];

/**
 * Additive: distinguishes a candidate B6 already classifies from the element's CURRENT state
 * (`current_state`) from one surfaced only because correcting its already-known audit findings
 * would make it eligible (`post_fix`, `b6-new-component-evaluator/post-fix-opportunity.ts`).
 * Defaults to `current_state` so every plan exported before this field existed still parses.
 */
export const NEW_COMPONENT_PLAN_CANDIDATE_SOURCES = ['current_state', 'post_fix'] as const;
export type NewComponentPlanCandidateSource = (typeof NEW_COMPONENT_PLAN_CANDIDATE_SOURCES)[number];

export const NewComponentPlanEntrySchema = z.object({
  /** The ONLY join key — never any other Finding field, never duplicated finding content. */
  findingId: z.string().min(1, 'findingId must not be empty'),
  /** Display convenience already present on the Finding itself (`f.classification`) — not new information. */
  classification: z.enum(NEW_COMPONENT_PLAN_CLASSIFICATIONS),
  /** ISO 8601, client-set at selection time. */
  selectedAt: z.string().min(1, 'selectedAt must not be empty'),
  /** Free-text rationale, optional. */
  note: z.string().nullable(),
  candidateSource: z.enum(NEW_COMPONENT_PLAN_CANDIDATE_SOURCES).default('current_state'),
  /** post_fix only: the other repeated instances' findingIds — stable references, never duplicated content. */
  relatedFindingIds: z.array(z.string()).optional(),
});

export const NewComponentPlanSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1, 'runId must not be empty'),
  /** Stamped by a future import command at write time; a browser export leaves it null. */
  updatedAt: z.string().nullable(),
  entries: z.array(NewComponentPlanEntrySchema),
});

export type NewComponentPlan = z.infer<typeof NewComponentPlanSchema>;
export type NewComponentPlanEntry = z.infer<typeof NewComponentPlanEntrySchema>;

/** A valid, empty plan — nothing selected yet. */
export function emptyNewComponentPlan(runId: string): NewComponentPlan {
  return { schemaVersion: 1, runId, updatedAt: null, entries: [] };
}

/**
 * Parses and validates an untrusted plan, formatting issues the same way `parseFixPlan` /
 * `loadConfig` do, so every validation failure in this repo reads identically.
 */
export function parseNewComponentPlan(raw: unknown): { ok: true; plan: NewComponentPlan } | { ok: false; issues: string } {
  const result = NewComponentPlanSchema.safeParse(raw);
  if (result.success) return { ok: true, plan: result.data };
  return { ok: false, issues: result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n') };
}
