import { z } from 'zod';
import { parseWith } from '../audit-link/parse.ts';

/**
 * Read-side copy of audit-agent's New Component Plan contract (`src/output/new-component-plan.ts`,
 * `schemaVersion: 1`) — verified live against the upstream source 2026-09-22. This is the FIRST
 * of the two New Component Plan sources (ARCHITECTURE.md §2.2); the second is this repo's own
 * `component-selection.json` (`./selection-schema.ts`). The two are deliberately named
 * differently so neither file can overwrite the other (Decision Log #26).
 *
 * There is no import command for this file upstream yet — this repo validates it itself,
 * same posture as the Fix Plan: being at the canonical path never implies correctness.
 */

export const NEW_COMPONENT_PLAN_CLASSIFICATIONS = ['NEW_COMPONENT', 'DS_CANDIDATE'] as const;
export type NewComponentPlanClassification = (typeof NEW_COMPONENT_PLAN_CLASSIFICATIONS)[number];

/** `post_fix`: a repeated, unmatched pattern blocked only by a known, already-measured foundation-rule violation (audit-agent's `post-fix-opportunity.ts`). Defaults to `current_state` so plans exported before this field existed still parse. */
export const NEW_COMPONENT_PLAN_CANDIDATE_SOURCES = ['current_state', 'post_fix'] as const;
export type NewComponentPlanCandidateSource = (typeof NEW_COMPONENT_PLAN_CANDIDATE_SOURCES)[number];

export const NewComponentPlanEntrySchema = z.object({
  findingId: z.string().min(1),
  classification: z.enum(NEW_COMPONENT_PLAN_CLASSIFICATIONS),
  selectedAt: z.string().min(1),
  note: z.string().nullable(),
  candidateSource: z.enum(NEW_COMPONENT_PLAN_CANDIDATE_SOURCES).default('current_state'),
  relatedFindingIds: z.array(z.string()).optional(),
});
export type NewComponentPlanEntry = z.infer<typeof NewComponentPlanEntrySchema>;

export const NewComponentPlanSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  updatedAt: z.string().nullable(),
  entries: z.array(NewComponentPlanEntrySchema),
});
export type NewComponentPlan = z.infer<typeof NewComponentPlanSchema>;

export function parseNewComponentPlan(json: unknown, path: string): NewComponentPlan {
  return parseWith(NewComponentPlanSchema, json, 'new-component-plan.json', path);
}

export function emptyNewComponentPlan(runId: string): NewComponentPlan {
  return { schemaVersion: 1, runId, updatedAt: null, entries: [] };
}
