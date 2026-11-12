import type { StateName } from '../resolution/schema.ts';

/**
 * Design & interaction FIDELITY — what the original page looks like and does, captured BEFORE any
 * edit, and what the generated preview looks like and does, captured the same way.
 *
 * Implementation (see docs/ARCHITECTURE.md §8d):
 *   - capture   `capture.ts` + `lib.ts`: one measuring routine, evaluated in the pre-edit snapshot AND in the
 *               running preview, so both sides are measured by exactly the same code under the same
 *               viewport, scroll position, hover/focus target and settling time.
 *   - compare   `compare.ts`: value-level differences, classified `intentional` (an authorized target,
 *               identified by finding + property + part + state) or `regression`.
 *   - feedback  `feedback.ts`: a regression becomes an actionable record routed to the stage that can fix it.
 *   - loop      `loop.ts`: one bounded verify → correct → recheck loop with an honest stop reason.
 * B1 (behaviour of the live production page) stays the source for script-driven behaviour; this module
 * owns the CSS-driven design states, composition, alignment and sticky pin/release.
 */

export const FIDELITY_SCHEMA_VERSION = 1 as const;

export type FidelityViewportName = 'desktop' | 'mobile';
export interface FidelityViewport {
  name: FidelityViewportName;
  width: number;
  height: number;
}

/** Computed values (kebab-case property → value) of the canonical property set. */
export type StyleRecord = Record<string, string>;

export type CapturedRole = 'root' | 'finding' | 'interactive' | 'group-item' | 'group-parent' | 'text' | 'design';

export interface ElementFlags {
  disabled?: boolean;
  expanded?: string;
  selected?: string;
  current?: string;
  invalid?: string;
  checked?: boolean;
}

/** Styles recorded while one element was hovered/focused: the target and (for hover) its descendants. */
export interface StateCapture {
  /**
   * path key → computed styles, for the target (key '' relative to itself is the target) and descendants. A key ending in `::before` / `::after` holds
   * the PSEUDO-ELEMENT of the member in front of it ('' + '::after' = the target's own ::after), recorded with `PSEUDO_PROPERTIES` (lib.ts).
   */
  subtree: Record<string, StyleRecord>;
  /** For focus: whether `:focus-visible` actually matched (conditions are identical on both sides, so equal values are still comparable). */
  focusVisibleMatched?: boolean;
  /** True when this state changed ANY recorded style of the target or its captured descendants relative to the default state. A state with no effect cannot be "lost". */
  effect: boolean;
  /** Hover only: descendants that qualified for the subtree but lay beyond `maxDescendants`, so were never recorded. Absent when nothing was cut. */
  truncated?: number;
  /** For each `::before` / `::after` key of `subtree`: the box its size resolves against in THIS state (a card may change its size on hover). Absent in baselines captured before it existed. */
  pseudoRef?: Record<string, PseudoRef>;
}

/**
 * The box a generated `::before` / `::after` is SIZED from, as laid out when it was captured (whole px; EVIDENCE ONLY, never in the report): an absolutely positioned pseudo (an `inset: 0`
 * stretched link or ring, a `width: 100%` underline) resolves against its CONTAINING BLOCK's padding box (the nearest positioned ancestor, or the owner itself when that is positioned; the
 * viewport for `position: fixed`), an in-flow one against the content box of the nearest block container (the owner's own for a block). `box` is null when no box could be measured (the
 * containing block lies outside the section, or is an inline element).
 */
export interface PseudoRef {
  from: 'containing-block' | 'content-box';
  box: { w: number; h: number } | null;
}

export interface CapturedElement {
  /** Path of logical-child indices from the section root, e.g. "2/0/1" ('' = the root). Design-system island wrappers are transparent. */
  key: string;
  tag: string;
  label: string;
  /** Hash of the element's visible text — proves the two sides compare the same logical element. */
  textHash: string;
  /** `data-fra-element` stamp (pre-edit snapshot) — the join to the audit's mapping. */
  stamp: string | null;
  findingIds: string[];
  roles: CapturedRole[];
  flags: ElementFlags;
  style: StyleRecord;
  /** Horizontal alignment of the element's box inside its container, measured from geometry (not from CSS). */
  hAlign: 'left' | 'center' | 'right' | 'full' | 'none';
  /** Where the element's TEXT renders inside it (measured from the rendered text, however the alignment is produced). */
  tAlign: 'left' | 'center' | 'right' | 'full' | 'none';
  /** Width as a fraction of the section root's width. */
  widthRatio: number;
  states: { hover?: StateCapture; 'focus-visible'?: StateCapture };
  /** Default-state style of the element's `::before` / `::after` (only a generated one — `content` other than none/normal — is recorded). Absent in baselines captured before pseudo-elements were measured (see `SectionDesign.pseudoCaptured`). */
  pseudo?: { before?: StyleRecord; after?: StyleRecord };
  /** The box each recorded pseudo-element's size resolves against (see `PseudoRef`). Absent in baselines captured before it existed: a pseudo size change cannot then be judged (`pseudo-size-box-unavailable`). */
  pseudoRef?: { before?: PseudoRef; after?: PseudoRef };
  /**
   * Finding elements only: keys of the parts an exemption may name. `truncated` says how much the capture cut (label / descendants beyond their caps,
   * `walk` = nodes under the element whose children the walk never entered because of the depth / node limit): a part that was cut is never proven.
   */
  partKeys?: {
    label: string[];
    descendants: string[];
    named: Record<string, string[]>;
    truncated?: { label?: number; descendants?: number; walk?: number };
    /** Members listed above that qualified as captured elements but were DROPPED by the per-section element cap (they are in the lists, yet no element record exists for them). Absent = none. A member that is in a list without being here is a role-less wrapper. */
    capDropped?: { label?: string[]; descendants?: string[] };
  };
  /** The element really took keyboard focus in a focus trial made by the capture (desktop only; an <a> without href does not, a contenteditable does) — what keyboard-focus eligibility follows, not a tag list. Absent in older baselines. */
  focusable?: true;
  /** Preview side only: this element is a design-system component mounted in place of the original. */
  island?: boolean;
  /** Preview side only: the user style rule's declarations on this element ("border-radius:0"), see src/preview/user-style-rules.ts. */
  userStyle?: string;
  /** Preview side only: a structural DS rule restyled this element (an eyebrow label: DS SectionLabel style, icon dropped), see src/preview/structural.ts. */
  structural?: 'eyebrow' | 'indicator';
  /**
   * Border-box size as laid out (rounded to whole px, so sub-pixel layout jitter never reaches the hashed report). EVIDENCE ONLY: it is deliberately not in `style`, so it never feeds the global per-property
   * comparison; it is read for width/height preserve decisions. Absent in baselines captured before box evidence existed.
   */
  box?: { w: number; h: number };
  /** What the capture did with each interaction state of this element (desktop only) — so "not captured" is never silent. Absent in older baselines. */
  stateAttempt?: { hover?: StateAttempt; 'focus-visible'?: StateAttempt };
}

/**
 * `captured`; `unsettled` (kept changing); `not-hoverable` (GENUINELY not hoverable or focusable: pointer-events none, covered, not rendered, no handle);
 * `interrupted` (the hover failed twice for a reason that is not one of those — a transient, e.g. an element that kept moving); `budget-stopped`;
 * `sample-cap` (beyond the sampling cap, never tried).
 */
export type StateAttempt = 'captured' | 'unsettled' | 'not-hoverable' | 'interrupted' | 'budget-stopped' | 'sample-cap';

export interface GroupComposition {
  parentKey: string;
  childKeys: string[];
  columns: number;
  rows: number;
  /** Child indexes in visual reading order (top→bottom, left→right). */
  visualOrder: number[];
  /** First-row children's top offsets relative to the first child (the card stagger), rounded to 2px. */
  topOffsets: number[];
  /** Child widths as a fraction of the group parent's width. */
  widthRatios: number[];
}

export interface StickyTrace {
  key: string;
  top: string;
  /** The document was padded identically on both sides while tracing, so every section-relative position is reachable wherever the section sits on the page. Absent in older baselines. */
  padded?: boolean;
  positions: Array<{ requestedScroll: number; actualScroll: number; reachable: boolean; rectTop: number | null }>;
}

export interface SectionDesign {
  sectionId: string;
  viewport: FidelityViewportName;
  located: boolean;
  elements: CapturedElement[];
  groups: GroupComposition[];
  sticky: StickyTrace[];
  /** Elements beyond the per-section cap that were not captured — stated, never silent. */
  capped: { dropped: number } | null;
  coverage: { hover: { attempted: number; captured: number }; focusVisible: { attempted: number; captured: number } };
  notes: string[];
  /** The capture stopped before reaching this section because the overall verification budget was exhausted (it is unverified, not "not rendered"). */
  stopped?: 'budget';
  /** Interactive elements that were eligible for hover / keyboard focus before the sampling cap. */
  eligible?: { hover: number; focusVisible: number };
  /** Composition groups beyond the 12-group cap, never captured. */
  groupsDropped?: number;
  /** `position: sticky` candidates beyond the cap, never traced — a required gap. */
  stickyDropped?: number;
  /** `position: sticky` elements that can never pin (top, bottom, left and right all `auto`): not traced, disclosed. */
  stickyInert?: number;
  /** Elements in the section with a CSS animation (frozen at a fixed frame before the default-state capture, on both sides). */
  animationsFrozen?: number;
  /** Nodes whose children the walk did not enter (depth / node limit): everything below them was not captured. Finding elements are never among what is cut. */
  walkCut?: number;
  /** Present when `walkCut > 0`: what the cut hid that a REQUIRED check needs — controls / group items the probe lists, nodes holding an unobserved group of children, sticky elements. 0 everywhere = only decoration was cut. */
  walkHidden?: { controls: number; groups: number; sticky: number };
  /** The capture records which members of a finding's `label` / `descendants` part the element cap dropped (`partKeys.capDropped`). Absent in baselines from before, where a capped section cannot tell a dropped member from a role-less wrapper. */
  capLossRecorded?: true;
  /** The capture measured `::before` / `::after` (default state and hovered subtree). Absent in baselines from before, which are therefore not compared on them. */
  pseudoCaptured?: true;
  /** The capture ran the real focus trial on this (desktop) section. Absent in baselines from before it, whose tag-list capture never tried some focusable elements (see `baseline-legacy-focus`). */
  focusTrial?: true;
}

export interface DesignCapture {
  schemaVersion: typeof FIDELITY_SCHEMA_VERSION;
  capturedAt: string;
  source: { kind: 'pre-edit-snapshot' | 'preview'; htmlSha256: string | null; url: string | null };
  viewports: FidelityViewport[];
  /** Elements captured per section are bounded; the limits that were in force are recorded. */
  limits: { maxElements: number; maxHoverTargets: number; maxFocusTargets: number; maxDescendants: number };
  /** States this capture does NOT attempt, with the reason — disclosed in every report. */
  statesNotCaptured: string[];
  sections: SectionDesign[];
}

/** The immutable pre-edit baseline: write-once, hash-bound. A correction cycle never replaces it. */
export interface DesignBaseline extends DesignCapture {
  baselineSha256: string;
}

// ── comparison ──────────────────────────────────────────────────────────────────────────────

export type DifferenceClass = 'intentional' | 'regression' | 'not-checkable';
export type DifferenceCategory = 'default-style' | 'hover' | 'focus-visible' | 'alignment' | 'composition' | 'sticky' | 'element-unmatched' | 'state-unavailable';

export interface FidelityDifference {
  /** Stable id over (section, viewport, element key, category, state, property) — the same defect keeps the same id across cycles. */
  id: string;
  sectionId: string;
  viewport: FidelityViewportName;
  elementKey: string;
  elementLabel: string;
  category: DifferenceCategory;
  state: StateName;
  property: string | null;
  baseline: string | null;
  observed: string | null;
  classification: DifferenceClass;
  /** Findings whose element contains/is this element (attribution). */
  findingIds: string[];
  /** The resolved target that authorizes an `intentional` difference. */
  exemptionTargetId: string | null;
  detail: string;
}

// ── coverage: ONE ledger of what the verifier set out to check ──────────────────────────────

/** The kinds of check the verifier runs. Every unit of work is exactly one of verified, failed or unverified (or disclosed as not required). */
export type CoverageFamily = 'section' | 'element' | 'hover' | 'focus-visible' | 'composition' | 'sticky';
export const COVERAGE_FAMILIES: readonly CoverageFamily[] = ['section', 'element', 'hover', 'focus-visible', 'composition', 'sticky'];

/** Why a check could not be run. A reason is a stable code: reports group by it and tests assert on it. */
export type UnverifiedReason =
  | 'section-not-located-on-original'
  | 'section-not-captured-budget'
  | 'hand-authored-override'
  | 'output-element-cap'
  | 'tag-mismatch'
  | 'text-mismatch'
  | 'missing-in-output-structural'
  | 'inside-component'
  | 'state-unsettled-on-original'
  | 'state-not-hoverable-on-original'
  | 'state-interrupted-on-original'
  | 'state-budget-stopped'
  | 'state-not-sampled-cap'
  | 'state-uncaptured-on-output'
  | 'focus-visible-mismatch'
  | 'group-not-detected-in-output'
  | 'sticky-no-comparable-position'
  | 'sticky-partial'
  | 'sticky-candidate-cap'
  | 'baseline-legacy-counters'
  | 'baseline-legacy-sampling'
  | 'state-not-attempted'
  | 'state-subtree-member-missing-in-output'
  | 'state-subtree-member-gained-in-output'
  | 'state-reveal-gained-in-output'
  | 'baseline-legacy-focus'
  | 'state-subtree-capped'
  | 'walk-cut'
  | 'pseudo-size-box-unavailable';

export interface CoverageGap {
  family: CoverageFamily;
  sectionId: string;
  viewport: FidelityViewportName;
  elementKey: string | null;
  label: string;
  state: StateName;
  reason: UnverifiedReason;
  /** A required gap keeps the verdict from being `pass`; a non-required one is disclosed sampling that does not block. */
  required: boolean;
  findingIds: string[];
  detail: string;
}

/** Invariant: `required === verified + failed + unverified`. `notRequired` counts disclosed gaps that do not block. */
export interface CoverageCell {
  required: number;
  verified: number;
  failed: number;
  unverified: number;
  notRequired: number;
  reasons: Partial<Record<UnverifiedReason, number>>;
}

/** What happened to one element on the original (the per-element evidence a preserve decision is judged on). Only for elements a finding names or owns. */
export type ElementOutcome = 'compared' | 'removed' | 'moved' | 'tag-changed' | 'text-changed' | 'capped-output' | 'inside-component';
export type StateEvidence = 'compared' | 'not-captured-on-original' | 'unsettled-on-original' | 'not-captured-in-output' | 'focus-visible-mismatch' | 'not-applicable';
export interface ElementEvidence {
  sectionId: string;
  viewport: FidelityViewportName;
  elementKey: string;
  tag: string;
  label: string;
  findingIds: string[];
  outcome: ElementOutcome;
  /** When `moved`: the key at which the same finding / identical text was found in the output. */
  relocatedTo?: string;
  /** The finding ids the output element at the same key carries — identity: the same position is the same element only if the finding id is still on it. */
  observedFindingIds?: string[];
  states: { default: StateEvidence; hover: StateEvidence; 'focus-visible': StateEvidence };
  /** Relative keys of captured state-subtree members that could NOT be compared (absent from the output's state capture, or inside a component). */
  stateSkipped?: { hover?: string[]; 'focus-visible'?: string[] };
  /**
   * `equal` = the verdict per axis within the comparison tolerance (null: the output has no box). The OBSERVED box is deliberately not stored — the report is hashed
   * into the G2 fingerprint, and a layout that straddles a rounding boundary between two runs (200.49px vs 200.51px) must not change it. `changedTo` is only
   * present for an axis that changed, bucketed to 8 px.
   */
  box?: { baseline: { w: number; h: number } | null; equal: { w: boolean; h: boolean } | null; changedTo?: { w?: number; h?: number } };
}
export type SectionOutcome = 'compared' | 'override' | 'baseline-not-located' | 'output-not-rendered' | 'capture-stopped';
export interface SectionEvidence {
  sectionId: string;
  viewport: FidelityViewportName;
  outcome: SectionOutcome;
  elementsCompared: number;
  /** Keys of design-system components mounted in the output section (they change the box of what they replace). */
  islandKeys: string[];
}

export interface CoverageSampling {
  hoverEligible: number;
  hoverSampled: number;
  focusEligible: number;
  focusSampled: number;
  /** Elements beyond the per-section cap that the ORIGINAL did not capture. */
  elementsDropped: number;
  groupsDropped: number;
  stickyDropped: number;
  stickyInert: number;
  /** Elements inside mounted design-system components: the component's own design, not compared. */
  islandInternal: number;
  /** Elements with a CSS animation that were frozen at a fixed frame in the default-state capture. */
  animationsFrozen: number;
  /** Nodes the original's walk did not enter (depth / node limit). */
  walkCut: number;
  /** Hover-subtree members beyond `maxDescendants` that the original never recorded. */
  hoverSubtreeDropped: number;
}

export interface FidelityCoverage {
  families: Record<CoverageFamily, CoverageCell>;
  requiredTotal: number;
  requiredVerified: number;
  requiredFailed: number;
  requiredUnverified: number;
  /** Of `requiredUnverified`: gaps nothing in the pipeline can ever clear (a hand-authored section, a state the original could not be captured in). The rest are actionable. Absent in older reports. */
  requiredByDesign?: number;
  /** Required gaps first, then disclosed ones; sorted (no clocks) so the report hashes the same on a bare re-run. Capped; the remainder is counted. */
  gaps: CoverageGap[];
  gapsTruncated: number;
  sampling: CoverageSampling;
  elements: ElementEvidence[];
  sections: SectionEvidence[];
}

export interface FidelityReport {
  schemaVersion: typeof FIDELITY_SCHEMA_VERSION;
  generatedAt: string;
  baselineSha256: string | null;
  baselineHtmlSha256: string | null;
  observedSource: string | null;
  differences: FidelityDifference[];
  /** What could not be checked, and why — never turned into a pass. A readable projection of the required gaps in `coverage`. */
  unavailable: string[];
  /** States/behaviours this verifier does not capture at all. */
  statesNotCaptured: string[];
  summary: {
    sections: number;
    sectionsCompared: number;
    elementsCompared: number;
    statesCompared: { default: number; hover: number; 'focus-visible': number };
    intentional: number;
    regressions: number;
    notCheckable: number;
  };
  /** Verified / failed / unverified for every check the verifier set out to run, with reason codes. Absent in reports written before it existed. */
  coverage?: FidelityCoverage;
  /**
   * `fail`: at least one regression. `not-checked`: nothing could be compared. `incomplete`: nothing regressed but at least one REQUIRED check is
   * unverified (see `coverage`). `pass`: only when every required check was run and held.
   */
  verdict: 'pass' | 'fail' | 'incomplete' | 'not-checked';
}

/** The compact fidelity state `verification.json` carries so the G2 decision (and anyone reading only that file) is never silent about unverified required checks. */
export interface FidelityVerdictSummary {
  verdict: FidelityReport['verdict'];
  requiredTotal: number;
  requiredVerified: number;
  requiredFailed: number;
  requiredUnverified: number;
  /** Unverified required checks a correction, the planner or the user could still clear. */
  actionable: number;
  /** Unverified required checks that are permanent by design (hand-authored sections, states the original could not be captured in). */
  byDesign: number;
  /** The `required.open` lines (bounded). */
  open: string[];
}

/** The verdict of one preserve decision, from positive evidence only. */
export interface PreserveResult {
  targetId: string;
  findingId: string;
  property: string;
  state: StateName;
  verification: 'preserved-verified' | 'failed' | 'unverified';
  detail: string;
  /** A short, stable phrase the unverified / failed decisions are grouped by in reports. */
  reason: string;
  /** What was compared, where. */
  evidence: Array<{ sectionId: string; viewport: FidelityViewportName; elementKey: string; state: string; outcome: 'compared-equal' | 'changed' | 'removed' | 'not-compared'; reason: string }>;
}

export interface PreserveSummary {
  total: number;
  verified: number;
  failed: number;
  unverified: number;
  /** Of `unverified`: decisions that can never be verified by this verifier (an unmeasured property, an uncaptured state or theme, a hand-authored section). */
  byDesign?: number;
  reasons: Array<{ reason: string; count: number }>;
  /** The failed decisions, then the first unverified ones (bounded). */
  worst: Array<{ targetId: string; findingId: string; property: string; state: StateName; verification: 'failed' | 'unverified'; detail: string }>;
}

// ── feedback & correction ───────────────────────────────────────────────────────────────────

export type CorrectionAction =
  /** Re-emit this finding's edit of `property` so it no longer applies in hover/focus/active states. */
  | { type: 'state-guard'; findingId: string; property: string }
  /** Keep the original element instead of the design-system component (the component changes something no authorized target covers). */
  | { type: 'drop-island'; findingId: string; reason: string }
  /** Stop replaying an edit that cannot be made safe; the finding is reported unresolved with the reason. */
  | { type: 'drop-edit'; findingId: string; property: string; reason: string }
  /** Ask the planner to re-plan these findings with the feedback as a hard constraint. */
  | { type: 'replan'; findingIds: string[]; constraint: string };

export type CorrectionRoute = 'preview-generator' | 'planner' | 'override' | 'none';

export interface CorrectionFeedback {
  /** Same as the underlying difference id (or a `target:`-prefixed id for an unmet target) — the loop's progress measure. */
  id: string;
  kind: 'state-regression' | 'default-regression' | 'composition-regression' | 'alignment-regression' | 'sticky-regression' | 'element-regression' | 'target-not-met' | 'preserve-broken';
  sectionId: string;
  viewport: FidelityViewportName | 'any';
  elementKey: string;
  elementLabel: string;
  state: StateName;
  property: string | null;
  expected: string | null;
  observed: string | null;
  findingIds: string[];
  /** One sentence naming the element, state, viewport, expected behaviour and the observed difference. */
  message: string;
  responsible: CorrectionRoute;
  /** What the pipeline can do about it automatically; null = it cannot (reported as blocked, never as passed). */
  action: CorrectionAction | null;
  blockedReason: string | null;
  /** The resolved target this feedback is about (target-not-met / preserve-broken) and its part: what the planner needs to reopen exactly that target. Absent for a fidelity difference. */
  targetId?: string;
  part?: string;
}

/**
 * The part of a planner-routed {@link CorrectionFeedback} the planner itself needs, kept structured so R3 can REOPEN the finding
 * (whatever R5 measured on the live page), plan only the failing property and state, and say why. Persisted with the correction state.
 */
export interface PlannerFeedbackItem {
  /** The CorrectionFeedback id — stable across cycles, the loop's progress measure. */
  id: string;
  kind: 'target-not-met' | 'default-regression' | 'preserve-broken';
  findingIds: string[];
  /** The failed resolved target; null for a fidelity regression (no target authorizes the property). */
  targetId: string | null;
  property: string;
  /** The target's part (`self`, `label`, …); null for a fidelity regression. */
  part: string | null;
  state: StateName;
  viewport: FidelityViewportName | 'any';
  /** The value the preview must show; for default-regression the ORIGINAL value, for preserve-broken null (the original value is not recorded). */
  expected: string | null;
  observed: string | null;
  elementLabel: string;
  sectionId: string;
  /** The one-sentence constraint the strings channel carries for the same defect. */
  constraint: string;
}

