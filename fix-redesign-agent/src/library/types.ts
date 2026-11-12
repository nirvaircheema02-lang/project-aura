import type { LlmUsage } from '../agents/types.ts';
import type { NewComponentPlan } from './new-component-plan-schema.ts';
import type { ComponentSelection } from './selection-schema.ts';

/**
 * Workflow B (component workflow) node contracts — ARCHITECTURE.md §9, §12. L1 merges the
 * two plan sources and resolves each pattern; L2 builds on a local DS branch; L2b integrates
 * shared files serially; L3 verifies; L4 previews; L5 publishes only behind approval.
 */

export const RESOLUTIONS = ['reuse', 'update', 'new', 'ambiguous'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const COMPONENT_SCOPES = ['page-local', 'multi-page', 'global'] as const;
export type ComponentScope = (typeof COMPONENT_SCOPES)[number];

export interface PlanEntryOrigin {
  origin: 'upstream' | 'checklist' | 'reused-checklist';
  patternId: string;
  findingIds: string[];
  classification: string | null;
  selection: string | null;
  note: string | null;
}

/** L1's merge of both New Component Plan sources (§2.2), one row per distinct pattern. */
export interface ResolvedComponentPlan {
  schemaVersion: 1;
  redesignRunId: string;
  entries: PlanEntryOrigin[];
  /** The same pattern selected inconsistently by the two sources — an ask, never silent precedence (§2.2). */
  disagreements: Array<{ patternId: string; upstream: string; checklist: string }>;
}

export interface ReferenceResolution {
  /** Which reference this candidate builds against, in priority order (§9.2). */
  source: 'verified-corrected-this-run' | 'verified-corrected-prior-run' | 'live-capture';
  priorRunId: string | null;
  elementStamp: string;
  cropPath: string | null;
}

export interface ComponentSpec {
  schemaVersion: 1;
  componentId: string;
  patternId: string;
  resolution: Resolution;
  /** Present only for `update` — the existing component file being additively changed. */
  updateTarget: { dsFile: string; dsComponent: string } | null;
  name: string;
  category: string;
  scope: ComponentScope;
  /** True when `scope` is asserted by the reviewer without supporting cross-run evidence (§9.3) — honoured, but flagged. */
  scopeEvidenceMissing: boolean;
  reference: ReferenceResolution;
  anatomy: string;
  variantAxes: Array<{ name: string; values: string[] }>;
  tokens: string[];
  statesObserved: string[];
  statesToDesign: string[];
  postFixPrerequisite: { relatedFindingIds: string[]; satisfied: boolean } | null;
  /** Files this component's build is confined to (§9.4) — a write outside this set is rejected. */
  writeSet: string[];
  /** Declared shared-file changes L2b will apply after the parallel builds join (§7.4). */
  declaredSharedChanges: {
    barrelEntries: Array<{ barrelFile: string; exportLine: string }>;
    tokenAdditions: Array<{ name: string; value: string }>;
  };
  dependsOn: { findings: string[]; components: string[] };
  constraints: string[];
}

export interface L1Output {
  resolvedPlan: ResolvedComponentPlan;
  specs: ComponentSpec[];
  /** Specs that could not be resolved automatically — reported, never guessed (§9.1's `ambiguous`). */
  ambiguous: Array<{ patternId: string; reason: string }>;
  /** Specs blocked on an unsatisfied dependency (§9.2, §7.6). */
  blocked: Array<{ componentId: string; reason: string }>;
}

export type ComponentUnitStatus = 'PASS' | 'PARTIAL' | 'FAIL';

export interface AcceptanceResult {
  area: 'responsive' | 'interaction-states' | 'keyboard' | 'accessibility';
  check: string;
  evidenceClass: 'observed' | 'missing-evidence' | 'proposed';
  passed: boolean;
  detail: string;
}

export interface L2Output {
  componentId: string;
  filesWritten: string[];
  /** True only when every written path was inside the spec's own write set (§9.4, §7.6). */
  writeSetRespected: boolean;
  violatingPaths: string[];
  usage: LlmUsage | null;
}

export interface L3Output {
  componentId: string;
  dsChecks: { typecheck: boolean; lint: boolean; verify: boolean; storyBuild: boolean; detail: string[] };
  acceptance: AcceptanceResult[];
  visionVerdict: 'CONFIRMED' | 'UNCERTAIN' | 'REJECTED' | 'NOT_CHECKED';
  status: ComponentUnitStatus;
  failedChecks: string[];
  usage: LlmUsage | null;
}

export interface ComponentIterationRecord {
  iteration: number;
  build: L2Output;
  verify: L3Output;
}

export interface L4Output {
  componentId: string;
  previewHtmlPath: string;
  previewPngPaths: string[];
  inContextRendered: boolean;
}

export interface PackageFile {
  path: string;
  blobSha256: string;
}

export interface AssembledPackage {
  approvedComponentIds: string[];
  files: PackageFile[];
  branch: string;
}

export interface PackageValidationResult {
  ok: boolean;
  dsChecks: { typecheck: boolean; lint: boolean; verify: boolean; storyBuild: boolean };
  acceptance: AcceptanceResult[];
  invalidatedComponentIds: string[];
  detail: string[];
}

export interface PublishResult {
  committed: boolean;
  commitSha: string | null;
  pushed: boolean;
  pushedRemote: string | null;
  prUrl: string | null;
  reason: string | null;
}
