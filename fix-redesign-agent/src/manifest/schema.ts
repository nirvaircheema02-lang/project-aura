import { z } from 'zod';

/**
 * R6 Component Review's manifest — ARCHITECTURE.md §8.6 (R6), §13's `review/component-manifest.json`.
 * Covers EVERY detected component on the page, changed or not (Decision Log #16). Zod-first
 * because this file is read back by later stages (L1) and by a human via `component-review.html`,
 * so its shape is worth validating rather than trusted blindly, same posture as the plan files.
 */

export const LIBRARY_BUCKETS = ['existing-correct', 'existing-needs-update', 'new-component', 'page-fix-only', 'unresolved'] as const;
export type LibraryBucket = (typeof LIBRARY_BUCKETS)[number];

export const CROSS_RUN_BASIS = ['ds-match', 'signals', 'label', 'type-only'] as const;
export type CrossRunBasis = (typeof CROSS_RUN_BASIS)[number];

export const CrossRunSightingSchema = z.object({
  runId: z.string(),
  displayName: z.string(),
  url: z.string(),
  findingIds: z.array(z.string()),
  basis: z.enum(CROSS_RUN_BASIS),
  score: z.number(),
});
export type CrossRunSighting = z.infer<typeof CrossRunSightingSchema>;

export const SuggestionSchema = z.object({
  bucket: z.enum(LIBRARY_BUCKETS),
  /** The decision-table rule id that produced this bucket (`R1`…`R8`) — the checklist must show its reasoning, never a bare verdict (Decision Log #24). */
  rule: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const ManifestComponentSchema = z.object({
  findingId: z.string(),
  signature: z.string(),
  instanceIndex: z.number().nullable(),
  instanceCount: z.number(),
  relatedFindingIds: z.array(z.string()),
  sectionId: z.string().nullable(),
  sectionName: z.string(),
  scope: z.enum(['content', 'excluded', 'unselected']),
  productionType: z.string(),
  productionLabel: z.string(),
  auditClassification: z.string(),
  severity: z.string(),
  ds: z.object({
    dsComponent: z.string().nullable(),
    dsVariant: z.string().nullable(),
    dsFile: z.string().nullable(),
    possibleMatches: z.array(z.object({ dsComponent: z.string(), dsFile: z.string(), dsVariant: z.string().nullable(), score: z.number(), why: z.string() })),
    registryUpdateRef: z.string().nullable(),
    dsCandidateNote: z.string().nullable(),
  }),
  mismatchProperties: z.array(z.string()),
  mismatchClass: z.enum(['none', 'cosmetic', 'structural']),
  tokens: z.array(z.object({ token: z.string(), property: z.string(), source: z.enum(['mismatch', 'edit']), value: z.string() })),
  fixPlan: z.object({ decision: z.enum(['fix', 'skip', 'keep_for_review', 'undecided']), note: z.string().nullable() }),
  redesign: z.object({
    requested: z.boolean(),
    planned: z.boolean(),
    applied: z.boolean(),
    verified: z.boolean(),
    swappedTo: z.object({ dsComponent: z.string(), dsVariant: z.string().nullable() }).nullable(),
    unaddressedReason: z.string().nullable(),
  }),
  location: z.object({
    located: z.boolean(),
    method: z.enum(['objective', 'objective+model', 'text-identity']).nullable(),
    stamp: z.string().nullable(),
    tagName: z.string().nullable(),
    auditBox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
    liveBox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
  }),
  crops: z.object({ before: z.string().nullable(), after: z.string().nullable() }),
  auditEvidence: z.array(z.object({ kind: z.string(), ref: z.string(), note: z.string().nullable() })),
  states: z.object({ captured: z.array(z.string()), missing: z.array(z.string()) }),
  crossRun: z.object({
    sightings: z.array(CrossRunSightingSchema),
    reuse: z.enum(['multi-page', 'repeated-on-page', 'single']),
  }),
  suggestion: SuggestionSchema,
});
export type ManifestComponent = z.infer<typeof ManifestComponentSchema>;

export const ManifestSectionSchema = z.object({
  sectionId: z.string(),
  name: z.string(),
  scope: z.enum(['content', 'excluded', 'unselected']),
  excludedReason: z.string().nullable(),
  order: z.number(),
  wrapper: z.object({ located: z.boolean(), stamp: z.string().nullable(), tagName: z.string().nullable() }),
  memberFindingIds: z.array(z.string()),
  bucketCounts: z.record(z.string(), z.number()),
});
export type ManifestSection = z.infer<typeof ManifestSectionSchema>;

export const ComponentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  redesignRunId: z.string(),
  createdAt: z.string(),
  pageId: z.string(),
  auditAiMode: z.string().nullable(),
  auditDsRegistryVersion: z.string(),
  designSystem: z.object({ path: z.string(), dsRegistryVersion: z.string(), changedSinceAudit: z.boolean() }),
  viewport: z.object({ width: z.number(), height: z.number() }),
  scope: z.object({
    contentSectionIds: z.array(z.string()),
    excludedSectionIds: z.array(z.string()),
  }),
  sections: z.array(ManifestSectionSchema),
  components: z.array(ManifestComponentSchema),
  counts: z.object({
    findings: z.number(),
    located: z.number(),
    unlocated: z.number(),
    excluded: z.number(),
    fixRequested: z.number(),
    fixApplied: z.number(),
    fixVerified: z.number(),
    byBucket: z.record(z.string(), z.number()),
    otherPageFindings: z.number(),
  }),
});
export type ComponentManifest = z.infer<typeof ComponentManifestSchema>;
