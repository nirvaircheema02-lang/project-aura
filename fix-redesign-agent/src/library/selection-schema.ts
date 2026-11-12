import { z } from 'zod';
import { parseWith } from '../audit-link/parse.ts';

/**
 * This repo's OWN New Component Plan export — `review/component-selection.json`
 * (ARCHITECTURE.md §2.2, the second of the two plan sources). Produced by a client-side
 * download from `component-review.html` (§10a) — the export itself IS the G3 decision, no
 * separate chat confirmation. Named deliberately differently from audit-agent's
 * `new-component-plan.json` so neither file can overwrite the other (Decision Log #26).
 *
 * Unlike the upstream file (one entry per finding), this is PATTERN-keyed: a card in the
 * checklist is one pattern (one `component.signature`), covering every instance at once,
 * because the checklist reviews reusable components, not individual findings.
 */

export const SELECTION_KINDS = ['global-shared', 'new-component'] as const;
export type SelectionKind = (typeof SELECTION_KINDS)[number];

export const SelectionEntrySchema = z.object({
  patternId: z.string().min(1),
  findingIds: z.array(z.string()).min(1),
  selection: z.enum(SELECTION_KINDS),
  /** The suggestion the checklist showed for this pattern, echoed back — so a later merge can see whether the human agreed with it. */
  suggestion: z.string().nullable(),
  note: z.string().nullable(),
});
export type SelectionEntry = z.infer<typeof SelectionEntrySchema>;

/** A component the checklist's manual "add candidate" row created — not backed by any audit finding. */
export const ManualCandidateSchema = z.object({
  sectionId: z.string(),
  label: z.string().min(1),
  selection: z.enum(SELECTION_KINDS),
  note: z.string().nullable(),
});
export type ManualCandidate = z.infer<typeof ManualCandidateSchema>;

export const ComponentSelectionSchema = z.object({
  schemaVersion: z.literal(1),
  redesignRunId: z.string().min(1),
  sourceRun: z.object({ runId: z.string().min(1), projectName: z.string().min(1) }),
  dsRegistryVersion: z.string().min(1),
  exportedAt: z.string().min(1),
  decidedBy: z.string().nullable(),
  selections: z.array(SelectionEntrySchema),
  manualCandidates: z.array(ManualCandidateSchema),
  /** Header/footer components, selected separately in the checklist's own section (§8.3). */
  globalCandidates: z.array(SelectionEntrySchema),
});
export type ComponentSelection = z.infer<typeof ComponentSelectionSchema>;

export function parseComponentSelection(json: unknown, path: string): ComponentSelection {
  return parseWith(ComponentSelectionSchema, json, 'component-selection.json', path);
}

/** True when nothing was actually selected — an export with no rows checked, refused by the importer just like an empty Fix Plan is meaningless. */
export function isEmptySelection(selection: ComponentSelection): boolean {
  return selection.selections.length === 0 && selection.manualCandidates.length === 0 && selection.globalCandidates.length === 0;
}
