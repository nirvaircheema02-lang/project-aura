import type { BrowserContext, Page } from 'playwright';
import type { AuditRunInfo, AuditRunRef, DecisionCounts, Finding, FixPlan, FixPlanEntry, Severity } from '../audit-link/index.ts';
import type { NewComponentPlan } from '../library/new-component-plan-schema.ts';
import type { DsRegistry } from '../ds/d2-registry/index.ts';
import type { TileCompositePlan } from '../imaging/tile-composite.ts';
import type { CaptureFingerprint, MappingResult } from '../mapping/types.ts';
import type { CompareVerdicts, RedesignPlan, TargetedEdit } from '../llm/schemas/r-nodes.ts';
import type { ComponentManifest } from '../manifest/schema.ts';
import type { NodeId } from '../node-id.ts';
import type { ResolutionFile, StateName } from '../resolution/schema.ts';
import type { DesignBaseline, FidelityReport, CorrectionFeedback, PlannerFeedbackItem } from '../fidelity/types.ts';
import type { UnverifiedFamily } from '../fidelity/coverage.ts';
import type { BudgetTracker, BudgetReset, BudgetUsage, CorrectionBudgetConfig, LoopCycle, StopReason, BudgetReason } from '../fidelity/loop.ts';
import type { RedesignPaths, SourceRunRef } from '../output/redesign-store.ts';
import type { DesignMode, RunType } from '../session/types.ts';
import type { PageCapture } from '../t-layer/capture.ts';
import type { PageObserver } from '../t-layer/render-settled.ts';
import type { Tile } from '../t-layer/screenshot.ts';

/**
 * Workflow A's typed node contracts — ARCHITECTURE.md §8.6, §12. "Graph-engineered" in the
 * sense that matters: typed nodes, explicit contracts, per-step tracing, deterministic flow
 * — run as a plain ordered async chain (`../pipeline.ts`), not a forked graph engine.
 *
 *   S0 → R1 → R2 → C2 → [ R3 → R4 → R5 ] × ≤ maxIterations (early exit on PASS) → R6 → R7
 *
 * R3 and R5 each take EVERY authorized finding in one batched call (chunked beyond a bound),
 * never one call per finding; R6 covers every DETECTED component, changed or not.
 */

export type { NodeId };

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

// ── R1 Resolve & Load ─────────────────────────────────────────────────────────────────────

export interface R1Input {
  /** Run ID or Run Name — never both, never individual file paths (Part 1's invocation contract). */
  runRef: AuditRunRef;
  /** §1.3: which half(es) to load. `components` needs no Fix Plan; `redesign`/`combined` need one with ≥1 `fix`. */
  runType: RunType;
}

export interface R1Output {
  sourceRun: SourceRunRef;
  audit: { schemaVersion: number; run: AuditRunInfo; findingCount: number };
  /** `data.json`'s own recorded targetUrl — the page the audit actually captured; R2 navigates here. */
  targetUrl: string;
  /** Every finding in data.json — context for R3/R5/R6 and the join source; never mutated. */
  findings: Finding[];
  /** The validated fix plan as read (sparse; absence = undecided). Empty (zero entries) for a `components`-only run with no Fix Plan file. */
  fixPlan: FixPlan;
  /** Entries with `decision === 'fix'` whose findingId exists in data.json. */
  fixEntries: FixPlanEntry[];
  /** The findings those entries point at — the ONLY findings Workflow A acts on. */
  fixFindings: Finding[];
  decisionCounts: DecisionCounts;
  /** Plan entries whose findingId is not in data.json — reported, dropped, never acted on. */
  droppedUnknownFindingIds: string[];
  /** The upstream New Component Plan, when the run folder has one (§2.2) — merged with the checklist export at L1. */
  newComponentPlan: NewComponentPlan | null;
  registry: DsRegistry;
  warnings: string[];
}

// ── R2 Capture ─────────────────────────────────────────────────────────────────────────────

/** One full-page capture: the raw viewport tiles plus (when there was at least one tile) the flattened composite. */
export interface PageShot {
  tiles: Tile[];
  totalHeight: number;
  /** `captureOverviewTiles` hit its tile cap before the page ended — stated, never silent. */
  truncated: boolean;
  composite: { path: string; plan: TileCompositePlan } | null;
}

/**
 * The LIVE page handle, kept open from R2 through the last R5 (§6.7's hydration note): R4
 * mutates THIS page in place and screenshots from THIS context — never a detached
 * HTML-string edit-and-reload round trip. `release()` closes the isolated context and is
 * idempotent; the orchestrator always calls it in `finally`.
 */
export interface CaptureSession {
  page: Page;
  context: BrowserContext;
  observer: PageObserver;
  capture: PageCapture;
  before: PageShot;
  viewport: { width: number; height: number };
  /** §6.6's freshness fingerprint, computed immediately after capture settles. */
  captureFingerprint: CaptureFingerprint;
  /** The whole document serialized right after C2 stamps every element/section, before any edit (§6.2, §8.5's `original.html`). Set by C2, not R2. */
  originalHtml: string | null;
  /** C2's mapping result — set by C2, null on the raw R2 output before C2 runs. */
  mapping: MappingResult | null;
  release: () => Promise<void>;
}
export type R2Output = CaptureSession;

// ── C2 Element Mapper ─────────────────────────────────────────────────────────────────────

export interface C2Input {
  r1: R1Output;
  session: CaptureSession;
}
export type C2Output = CaptureSession;

// ── RV Resolver ───────────────────────────────────────────────────────────────────────────

export interface RVInput {
  r1: R1Output;
  /** The live, pristine, stamped session: rendered evidence (inheritance, display, used gap, surface) is read from it; nothing is edited. */
  session: CaptureSession;
  paths: RedesignPaths;
  redesignRunId: string;
  mode: DesignMode;
  sectionIds: string[];
}

export interface RVOutput {
  resolution: ResolutionFile;
  /** Residual design questions put to a judgment (selected NEEDS_REVIEW / UNVERIFIED findings). */
  residualQuestions: number;
  counts: { targets: number; resolved: number; preserved: number; unresolved: number; byReason: Record<string, number> };
}

// ── R3 Redesign Plan ──────────────────────────────────────────────────────────────────────

export interface R3Input {
  /** The Resolver's derived targets. When present, R3 plans edits ONLY for authorized properties and no longer pre-filters findings the resolver can decide. */
  resolution?: ResolutionFile | null;
  r1: R1Output;
  session: CaptureSession;
  /** 1-based loop iteration. */
  iteration: number;
  /** The previous iteration's plan + what R5 found wrong with it — the "Fix" half of Build→Render→Compare→Fix. Null on iteration 1. */
  previous: IterationRecord | null;
  /** §7.1: G1's acknowledgement answers, folded in as R3 constraints — e.g. an `expectation-changed` finding the human confirmed should use the new value. */
  acknowledgedConstraints: string[];
  /** §8.1's design mode and, for `selected-sections`, the resolved in-scope section ids — R3 must never plan an edit for a finding in a section the reviewer did not select (§5.2a, §8.1's content-isolation guarantee). Full Page mode plans for every content-scope finding regardless, including one whose section wrapper could not be located (§8.2). */
  mode: DesignMode;
  sectionIds: string[];
  /**
   * Structured findings from the rendered React preview (R8): each names the finding(s), the failed target, property, state, viewport and the expected
   * and observed values. A finding named here is REOPENED whatever R5 measured on the live page, and its edits are restricted to the named property and state.
   */
  feedback?: PlannerFeedbackItem[];
  /** With `feedback`: the edits currently replayed into the preview (every iteration so far, later ones superseding earlier ones), so the planner sees what is on the page. */
  editsInForce?: TargetedEdit[];
}

export interface R3Output {
  iteration: number;
  plan: RedesignPlan;
  /** What R3 did with each resolved target (planned / cannot be represented by a DOM edit), recorded onto the targets' implementation status. */
  targetNotes?: Array<{ targetId: string; implementation: 'planned' | 'blocked'; detail: string | null }>;
  /** Edits R3 itself derived from a resolved target the model did not cover (the value comes from the target, never from the model). */
  synthesizedEdits?: number;
  /** How many batched model calls it took (1 unless the finding count exceeded the chunk bound). */
  chunks: number;
  usage: LlmUsage | null;
}

// ── R4 Apply & Render ─────────────────────────────────────────────────────────────────────

export interface AppliedEdit {
  edit: TargetedEdit;
  /** Elements the selector actually matched on the live page. */
  matched: number;
  applied: boolean;
  /** What the property/attribute/text held before — recorded so a later revert is possible; edits are cumulative across iterations (Decision Log #9). Also the idempotency key's value half: retrying an edit replays THIS, never re-reads a mutated DOM as if it were the original (§7.5). */
  previousValue: string | null;
  error: string | null;
}

export interface R4Input {
  resolution?: ResolutionFile | null;
  r1: R1Output;
  session: CaptureSession;
  plan: R3Output;
  iteration: number;
  /** Every prior iteration's applied edits, flattened — the idempotency key source (§7.5): a retried or re-planned edit on the SAME (findingId, property) reuses its recorded `previousValue` rather than re-measuring an already-mutated live value as if it were the original. */
  previousApplied: AppliedEdit[];
}

export interface R4Output {
  iteration: number;
  applied: AppliedEdit[];
  after: PageShot;
}

// ── R5 Compare ────────────────────────────────────────────────────────────────────────────

/** Tier (a): deterministic re-measurement of ONE finding's mismatched properties on the live page. */
export interface FindingCheck {
  findingId: string;
  fixed: boolean;
  detail: string;
  measured: Array<{ property: string; actual: string; expected: string; matches: boolean }>;
}

/** Tier (a): the structural diff catching accidental content/functionality loss. */
export interface StructuralDiff {
  ok: boolean;
  lostInteractive: string[];
  lostText: string[];
  note: string;
}

export type VisionVerdict = 'CONFIRMED' | 'UNCERTAIN' | 'REJECTED' | 'NOT_CHECKED';

export interface VisionIssue {
  description: string;
  severity: Severity;
}

/** §8.9's three distinct states — never collapsed into pass/fail. */
export type IterationOutcome = 'PASS' | 'PARTIAL' | 'FAIL';

export interface R5Input {
  resolution?: ResolutionFile | null;
  r1: R1Output;
  session: CaptureSession;
  plan: R3Output;
  applied: R4Output;
  iteration: number;
  /** Edits applied in EARLIER iterations: they are still on the live page, so a later iteration that plans nothing new for a finding must not lose its credit. */
  previousApplied?: AppliedEdit[];
}

export interface R5Output {
  iteration: number;
  checks: FindingCheck[];
  structural: StructuralDiff;
  vision: VisionVerdict;
  visionIssues: VisionIssue[];
  /** Tier (b)'s raw structured answer, when the vision call ran. */
  visionVerdicts: CompareVerdicts | null;
  overall: IterationOutcome;
  /** Exactly which checks failed and on which finding — FAIL is never reported without these. */
  failedChecks: string[];
  usage: LlmUsage | null;
}

// ── Loop record ───────────────────────────────────────────────────────────────────────────

export interface IterationRecord {
  iteration: number;
  plan: R3Output;
  applied: R4Output;
  validation: R5Output;
  /**
   * Set when this pass re-planned from rendered-preview feedback: an applied edit here REPLACES the earlier edits of the same finding, property and state (see `finalAppliedEdits`).
   * `part` is the failing target's part (`self`, `label`, …); null (a fidelity regression names no part) is NOT the element itself: only a `self` correction retires
   * the edit on the bare stamp, which a label, descendant or part-less correction leaves in force for the element's own target. A record without the field (older) means the element itself.
   */
  reopened?: Array<{ findingId: string; property: string; state: StateName; part?: string | null }>;
}

export type RedesignOutcome = IterationOutcome;

// ── R6 Component Review ──────────────────────────────────────────────────────────────────

export interface R6Input {
  r1: R1Output;
  session: CaptureSession;
  iterations: IterationRecord[];
  /** Read-only over every OTHER audit run under `auditAgentRepoRoot`'s documented layout (§6's cross-run evidence, Decision Log #23). */
  otherRunDataJsonPaths: string[];
}

export interface R6Output {
  manifest: ComponentManifest;
}

// ── R7 Assemble & Validate ───────────────────────────────────────────────────────────────

export interface R7Input {
  r1: R1Output;
  session: CaptureSession;
  iterations: IterationRecord[];
  outcome: RedesignOutcome;
  manifest: ComponentManifest;
  paths: RedesignPaths;
  redesignRunId: string;
  mode: DesignMode;
  /** Resolved content section ids for this run (§5.2a) — every one for Full Page, the chosen subset for Selected Sections. */
  sectionIds: string[];
}

export interface ExportValidationResult {
  file: string;
  ok: boolean;
  failures: string[];
}

export interface R7Output {
  originalHtml: string;
  redesignHtml: string;
  redesignContentHtml: string;
  sectionHtmlPaths: string[];
  htmlBytes: number;
  beforePng: string | null;
  afterPng: string | null;
  redesignPlanJson: string;
  validationResultsJson: string;
  exportValidationJson: string;
  changeListMd: string;
  componentManifestJson: string;
  componentReviewHtml: string;
  reviewIndexHtml: string;
  exportValidation: ExportValidationResult[];
  /** Assets inlined as data: URIs so every export opens with zero network, like report.html. */
  embeddedAssets: number;
  /** Assets that could not be read/inlined — reported, never silently dropped. */
  missingAssets: string[];
  /** Findings mapped in `context/mapping.json` but whose stamp could not be re-located at assembly time (§7.6). */
  unlocatedFindingIds: string[];
}

// ── B1 Behaviour capture ─────────────────────────────────────────────────────────────────

export interface B1Input {
  r1: R1Output;
  /** The still-pristine, stamped session: used only to locate each in-scope region so the same sections can be found on a fresh production page. */
  session: CaptureSession;
  paths: RedesignPaths;
  mode: DesignMode;
  sectionIds: string[];
}
export type B1Output = import('../preview/behavior.ts').BehaviorFile | null;

// ── R8 React Preview ─────────────────────────────────────────────────────────────────────

export interface R8Input {
  r1: R1Output;
  /** Any browser context: R8 uses it for offline extraction and to start its own verification contexts. */
  context: BrowserContext;
  /** C2's element mapping (element stamp ↔ finding ids ↔ DS reference). */
  entries: import('../mapping/types.ts').MappingEntry[];
  /** The edits R4 applied and that stay in force. */
  edits: import('../llm/schemas/r-nodes.ts').TargetedEdit[];
  /** The planner's own "unaddressed" reasons that are still in force (recorded conflicts) — a known, explained gap rather than a silent one. */
  unaddressed: Array<{ findingId: string; reason: string }>;
  paths: RedesignPaths;
  redesignRunId: string;
  mode: DesignMode;
  sectionIds: string[];
  behavior: import('../preview/behavior.ts').BehaviorFile | null;
  /** The Resolver's targets: measured in the rendered preview, and the source of every intentional-change exemption. */
  resolution?: ResolutionFile | null;
  /** The ORIGINAL page's design/state baseline (pre-edit, immutable). Null → fidelity is reported NOT verified, never passed. */
  baseline?: DesignBaseline | null;
  /** One budget for every retry after the preview exists, restored from and persisted to context/correction-state.json (`openCorrectionBudget`). The pipeline passes the same tracker to planner re-plans. Required: an R8 without it would bypass the persisted budget. */
  budget: BudgetTracker;
  /**
   * The pipeline's plain resume / judgment-submit continuation: when the earlier verification on disk was measured for exactly these inputs (plan, scope, design
   * decisions, hand-authored overrides, corrections, the engine and design system that produced it) and the preview source is unchanged, it is REUSED
   * without spending a verification. `preview --regenerate` leaves it off: it asks for a new verification and is held to the budget.
   */
  reuseEvidence?: boolean;
  /** Corrections already decided in an earlier pass (a resumed or re-planned run starts from them). */
  corrections?: { stateGuards: string[]; droppedEdits: string[]; droppedIslands: string[] };
}

export interface CorrectionSummary {
  stopReason: StopReason;
  budgetReason: BudgetReason | null;
  cycles: LoopCycle[];
  /** Feedback still open when the loop stopped — reported at G2, never hidden to end the loop. */
  open: CorrectionFeedback[];
  /** The part of it only the planner can correct. */
  plannerFeedback: CorrectionFeedback[];
  corrections: { stateGuards: string[]; droppedEdits: string[]; droppedIslands: string[] };
  verifications: number;
  /**
   * What the ONE correction budget had spent when this was written, its limits, and every intentional reset of it (the only way usage goes down).
   * `retained: true` = the budget allowed no verification on this invocation, so nothing was re-measured: everything here is the previous evidence
   * of the same plan plus the open item saying so; `retained: false` = there was no valid previous evidence to keep (every required check is unverified).
   * `reused: true` = nothing changed since the previous verification, so it was reused as measured without spending the budget (no open item is added).
   * Absent in logs written before it existed.
   */
  budget?: { used: BudgetUsage; max: CorrectionBudgetConfig; resets: BudgetReset[]; retained?: boolean; reused?: boolean };
  /**
   * `satisfied` only when every required check holds. "passed" above means no correctable item is left — NOT that the preview is verified.
   * `unverified` carries the required fidelity checks that could not be run, per family, so the report, the correction log and G2 say the same thing.
   */
  required: { satisfied: boolean; open: string[]; unverified?: UnverifiedFamily[]; unverifiedSplit?: { actionable: number; byDesign: number } };
}

export interface R8Output {
  /** Design & state fidelity of the rendered preview against the immutable original baseline. */
  fidelity?: FidelityReport | null;
  /** The bounded correction loop that ran before G2 (null when verification passed first time or fidelity was not checkable). */
  correction?: CorrectionSummary | null;
  url: string;
  port: number;
  previewDir: string;
  sourceHash: string;
  verificationJson: string;
  verification: import('../preview/types.ts').PreviewVerification;
  generation: import('../preview/scaffold.ts').GeneratedPreview;
}
