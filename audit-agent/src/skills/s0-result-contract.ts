import { z } from 'zod';

/**
 * S0 — Audit Result Contract (v1.0 §12). The mandatory schema every finding
 * uses, so A, B, C, Excel, Figma and the dashboard all work from one data
 * model. Field groups are exactly the spec's: Identity, Location, Component,
 * Classification, Comparison, Quality, Action, History — plus the v1.1
 * additive fields (`confidence_band`, `escalation_status`,
 * `registry_update_ref`, ARCHITECTURE.md §3).
 */

export const ClassificationSchema = z.enum([
  'MATCH',
  'DEVIATION',
  'INCORRECT',
  'NEW_COMPONENT',
  'DS_CANDIDATE',
  /**
   * Additive (Decision Log #31). The component's status could not be decided
   * without semantic judgment — e.g. it resembles several DS components, or
   * none closely enough to audit against. Never a guess in either direction:
   * excluded from the compliance score and queued for a human, with the
   * reason and the possible DS matches in `review`.
   */
  'NEEDS_REVIEW',
  /**
   * Additive (Decision Log #31). A matched DS component on which nothing could
   * actually be compared (no usable expectation, element detached, every
   * token unresolvable). Excluded from the score, queued for review. Older
   * records express the same state as MATCH + the NOT_COMPARED reason;
   * `isNotCompared` reads both.
   */
  'UNVERIFIED',
]);
export type Classification = z.infer<typeof ClassificationSchema>;

export const SeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConfidenceBandSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export const EscalationStatusSchema = z.enum(['NONE', 'QUEUED', 'IN_REVIEW', 'RESOLVED']);
export const ReAuditDeltaSchema = z.enum(['NEW_ISSUE', 'STILL_OPEN', 'RESOLVED', 'REGRESSION', 'UNCHANGED_COMPLIANT']);
export type ReAuditDelta = z.infer<typeof ReAuditDeltaSchema>;

/** One measurable property difference. Produced deterministically — never by a model's arithmetic (v1.0 §7 engineering rule). */
export const MismatchSchema = z.object({
  property: z.string(),
  actual: z.string(),
  expected: z.string(),
  /** The DS token the expected value came from, when it came from one. */
  expectedToken: z.string().nullable(),
  /** How the comparison was made, so a reviewer can audit the audit. */
  comparison: z.enum(['exact', 'color-deltaE', 'length-px', 'unsupported']),
  /** Perceptual color distance or px delta, when applicable. */
  delta: z.number().nullable(),
});
export type Mismatch = z.infer<typeof MismatchSchema>;

export const EvidenceRefSchema = z.object({
  kind: z.enum(['element-screenshot', 'context-screenshot', 'page-tile', 'computed-style', 'aria-line', 'console-message', 'ds-source']),
  ref: z.string(),
  note: z.string().nullable(),
  /**
   * Page-absolute geometry of the element this evidence is about, when known.
   * C3 places numbered issue markers from THIS, never from a model's guess at
   * where something sits on a screenshot (ARCHITECTURE.md §16).
   */
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(),
});

/** A DS component a NEEDS_REVIEW / UNVERIFIED finding might be, and how well it fits. */
export const PossibleMatchSchema = z.object({
  dsComponent: z.string(),
  dsFile: z.string(),
  dsVariant: z.string().nullable(),
  /** 0..1 — how strongly the evidence points at this component. */
  score: z.number(),
  why: z.string(),
});
export type PossibleMatch = z.infer<typeof PossibleMatchSchema>;

/**
 * Additive (Decision Log #31): why the system could not make a deterministic
 * decision, and what a reviewer needs to make it. Present on NEEDS_REVIEW and
 * UNVERIFIED findings, and on any finding whose DS component was not
 * determined (its proven rule violations still stand).
 */
export const ReviewSchema = z.object({
  status: z.enum(['NEEDS_REVIEW', 'UNVERIFIED']),
  /** Plain-language reason no deterministic decision was possible. */
  reason: z.string(),
  /** The node that could not decide (B3 matching, B4 comparison, B6 evaluation). */
  node: z.string(),
  /** What was detected on the element: roles, tags, classes, style facts. */
  signals: z.array(z.string()),
  possibleMatches: z.array(PossibleMatchSchema),
  /** Measured values next to the closest DS candidate's expected values, when one exists. */
  observed: z.array(z.object({ property: z.string(), actual: z.string(), expected: z.string().nullable(), expectedToken: z.string().nullable() })),
});
export type Review = z.infer<typeof ReviewSchema>;

/** The top-level structural regions of a page (B7 ownership): global chrome first, then the page's own content. */
export type StructuralRegion = 'global-header' | 'page-content' | 'global-footer';

export const FindingSchema = z.object({
  // ── Identity ───────────────────────────────────────────────────────────
  identity: z.object({
    auditId: z.string(),
    runId: z.string(),
    findingId: z.string(),
    timestamp: z.string(),
    dsRegistryVersion: z.string(),
    /** S8/S9 policy snapshot — so a REGRESSION is never confused with a policy change (§2.2). */
    policyVersion: z.string(),
  }),
  // ── Location ───────────────────────────────────────────────────────────
  location: z.object({
    url: z.string(),
    pageId: z.string(),
    pageName: z.string(),
    templateFamily: z.string().nullable(),
    section: z.string(),
    sectionId: z.string().optional(),
    /**
     * Additive (B7, engine r9): the page's top-level structural region this finding belongs to — global chrome is
     * identified BEFORE the page's own sections: `global-header` (the site header: its navigation, menus, search,
     * account controls and every overlay opened from it), `page-content` (the page's own sections, the hero included)
     * or `global-footer`. Absent on a finding that sits outside every section, and on a run that predates r9.
     */
    region: z.enum(['global-header', 'page-content', 'global-footer']).optional(),
    /** Additive (B7, engine r9): the sub-group inside a Global Header finding — `Base Navigation`, `<Label> Menu`, `Search`, `Account/User Menu`. */
    group: z.string().optional(),
    /** Which capture state this was observed in (default, or an expanded disclosure). */
    captureState: z.string(),
  }),
  // ── Component ──────────────────────────────────────────────────────────
  component: z.object({
    productionType: z.string(),
    productionLabel: z.string(),
    dsComponent: z.string().nullable(),
    dsVariant: z.string().nullable(),
    /** Content-addressed signature (§2.5 rule 3) — groups repeated instances and dedupes DS candidates. */
    signature: z.string(),
  }),
  // ── Classification ─────────────────────────────────────────────────────
  classification: ClassificationSchema,
  // ── Comparison ─────────────────────────────────────────────────────────
  comparison: z.object({
    properties: z.array(z.object({
      property: z.string(), actual: z.string().nullable(), expected: z.string().nullable(),
      expectedToken: z.string().nullable(), source: z.string().nullable(),
      status: z.enum(['MATCH', 'DIFFERENT', 'UNRESOLVED']), note: z.string().nullable(),
    })).optional(),
    coverageNotes: z.array(z.string()).optional(),
    /**
     * Additive (engine r10): WHAT the comparison was made against. `ds-component`: a Design System component / variant was matched
     * and the element compared with its contract. `foundation-only`: no component applies (body text, a card title, a label,
     * supporting copy) — only the foundation rules were checked, so a MATCH here means "no foundation issue", never "matches a
     * component". Absent on an element nothing could be compared for, and on a run that predates r10.
     */
    basis: z.enum(['ds-component', 'foundation-only']).optional(),
    mismatches: z.array(MismatchSchema),
    /** Rule ids from D5 (e.g. "R1.2") this finding violates, when any. */
    ruleViolations: z.array(
      z.object({
        ruleId: z.string(),
        title: z.string(),
        why: z.string(),
        /**
         * Additive (Decision Log #31): the impact of THIS breach when it was
         * measured deterministically (an off-scale radius is not a brand-red
         * misuse). Absent → S5's rubric decides from the rule id.
         */
        severity: SeveritySchema.optional(),
      }),
    ),
  }),
  // ── Quality ────────────────────────────────────────────────────────────
  quality: z.object({
    severity: SeveritySchema,
    confidence: z.number().min(0).max(1),
    confidenceBand: ConfidenceBandSchema,
    escalationStatus: EscalationStatusSchema,
    escalationReasons: z.array(z.string()),
    evidence: z.array(EvidenceRefSchema),
    /** B5's verdict on whether a DOM/CSS-derived finding survives visual inspection. */
    visualVerdict: z.enum(['CONFIRMED', 'FALSE_POSITIVE', 'UNCERTAIN', 'NOT_CHECKED']),
  }),
  // ── Action ─────────────────────────────────────────────────────────────
  action: z.object({
    recommendation: z.string(),
    rootCauseRef: z.string().nullable(),
    dsCandidateNote: z.string().nullable(),
    registryUpdateRef: z.string().nullable(),
  }),
  // ── History ────────────────────────────────────────────────────────────
  history: z.object({
    previousStatus: ClassificationSchema.nullable(),
    currentStatus: ClassificationSchema,
    delta: ReAuditDeltaSchema.nullable(),
    previousRunId: z.string().nullable(),
    /**
     * Additive (v1.1-style): set on the RESOLVED record S7 writes for a prior
     * issue whose element was not found on this run. It exists so the fix is
     * visible in the re-audit history — it is NOT a component on the page, so
     * it is never scored or counted as checked.
     */
    absentThisRun: z.boolean().optional(),
    /**
     * Additive: set when what this element was compared AGAINST changed since
     * the previous run — the Design System, the audit policy / browser, or the
     * DS component B3 matched. A status change across such a change is not a
     * page change, so S7 never calls it a REGRESSION or RESOLVED; this says why.
     */
    baselineChanged: z.array(z.string()).optional(),
    /**
     * Additive (Decision Log #31, third-pass review CH-1): the identity of the
     * run that ACTUALLY measured `previousStatus` — carried through every
     * undecided (NOT_COMPARED / NEEDS_REVIEW) run in between. Without this, a
     * baseline-change check on an undecided record's OWN identity compares the
     * wrong two runs (the undecided one, not the one that measured), so a mode
     * switch (or DS/policy change) that happens to straddle an undecided run is
     * invisible and a later status change is misread as a REGRESSION/RESOLVED.
     */
    baselineOf: z
      .object({
        runId: z.string(),
        dsRegistryVersion: z.string(),
        policyVersion: z.string(),
        dsComponent: z.string().nullable(),
        dsVariant: z.string().nullable(),
      })
      .optional(),
  }),
  // ── Review ─────────────────────────────────────────────────────────────
  review: ReviewSchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** v1.0 §13: only these three count toward compliance; NEW_COMPONENT, DS_CANDIDATE, NEEDS_REVIEW and UNVERIFIED are excluded. */
export const COMPLIANCE_DENOMINATOR: Classification[] = ['MATCH', 'DEVIATION', 'INCORRECT'];

export interface ComplianceScore {
  match: number;
  deviation: number;
  incorrect: number;
  newComponent: number;
  dsCandidate: number;
  /** Components whose status could not be decided without semantic judgment — excluded from the score. */
  needsReview: number;
  /**
   * Matched DS components that nothing could actually be COMPARED on (no
   * usable expectation, element detached, every token unresolvable). Neither
   * compliant nor non-compliant — excluded from the score, queued for review.
   */
  unverified: number;
  /** The same count as `unverified`, under its pre-v1.1 name — kept so older readers and reports still work. */
  notCompared: number;
  /** MATCH / (MATCH + DEVIATION + INCORRECT) × 100, or null when the denominator is empty. */
  compliancePercent: number | null;
}

/** The escalation reason that marks a MATCH as "not actually compared" (S8). */
export const NOT_COMPARED = 'NOT_COMPARED';

/** True for S7's record of a prior issue whose element is gone this run — history only, never scored. */
export function isAbsentThisRun(f: { history?: { absentThisRun?: boolean | undefined } }): boolean {
  return f.history?.absentThisRun === true;
}

/** S7's reason for a present element whose prior DEVIATION/INCORRECT this run could not re-verify. */
export const PRIOR_ISSUE_UNVERIFIED = 'PRIOR_ISSUE_UNVERIFIED';

/** True when a still-open prior issue rides on this finding unverified. */
export function isPriorIssueUnverified(f: { quality?: { escalationReasons: string[] } }): boolean {
  return f.quality?.escalationReasons.includes(PRIOR_ISSUE_UNVERIFIED) ?? false;
}

/**
 * The re-audit column, worded once for every output (dashboard, Excel, Figma)
 * so none of them can describe the same history differently.
 */
export function reAuditLabel(f: Pick<Finding, 'history' | 'quality'>): string {
  if (isAbsentThisRun(f)) return 'RESOLVED — not on page';
  if (isPriorIssueUnverified(f)) return f.history.baselineChanged?.length
    ? 'Previous issue used a different comparison; current result needs verification'
    : `prior ${f.history.previousStatus ?? 'issue'} unverified`;
  const base = f.history.delta ?? '—';
  return f.history.baselineChanged?.length ? `${base} (baseline changed)` : base;
}

/**
 * True for a matched component that was never verified — it must not count as
 * compliant. Reads both forms: the UNVERIFIED classification, and the older
 * MATCH + NOT_COMPARED record still present in earlier runs' history.
 */
export function isNotCompared(f: { classification: Classification; quality?: { escalationReasons: string[] } }): boolean {
  if (f.classification === 'UNVERIFIED') return true;
  return f.classification === 'MATCH' && (f.quality?.escalationReasons.includes(NOT_COMPARED) ?? false);
}

/**
 * The one status every output shows for a finding — so the dashboard, Excel,
 * Figma and C2's counts can never bucket the same finding differently.
 * RESOLVED is S7's record of a prior issue whose element is gone.
 */
export type FindingStatus = 'MATCH' | 'DEVIATION' | 'INCORRECT' | 'NEW_COMPONENT' | 'DS_CANDIDATE' | 'NEEDS_REVIEW' | 'UNVERIFIED' | 'RESOLVED';

export const FINDING_STATUSES: readonly FindingStatus[] = ['MATCH', 'DEVIATION', 'INCORRECT', 'DS_CANDIDATE', 'NEW_COMPONENT', 'NEEDS_REVIEW', 'UNVERIFIED', 'RESOLVED'];

export function findingStatus(f: { classification: Classification; quality?: { escalationReasons: string[] }; history?: { absentThisRun?: boolean | undefined } }): FindingStatus {
  if (isAbsentThisRun(f)) return 'RESOLVED';
  if (isNotCompared(f)) return 'UNVERIFIED';
  return f.classification;
}

/** Human label for a status, worded once for every output. */
export function statusLabel(status: FindingStatus): string {
  switch (status) {
    case 'DS_CANDIDATE':
      return 'DS CANDIDATE';
    case 'NEW_COMPONENT':
      return 'NEW COMPONENT';
    case 'NEEDS_REVIEW':
      return 'NEEDS REVIEW';
    case 'RESOLVED':
      return 'RESOLVED — not on page';
    default:
      return status;
  }
}

export function scoreCompliance(
  all: Array<{ classification: Classification; quality?: { escalationReasons: string[] }; history?: { absentThisRun?: boolean | undefined } }>,
): ComplianceScore {
  // An issue that is gone with its element is history, not a component on the page.
  const findings = all.filter((f) => !isAbsentThisRun(f));
  const count = (c: Classification) => findings.filter((f) => f.classification === c).length;
  const unverified = findings.filter(isNotCompared).length;
  // A MATCH nothing was compared on is not evidence of compliance (v1.0 §13 counts compared outcomes only).
  const legacyNotCompared = findings.filter((f) => f.classification === 'MATCH' && isNotCompared(f)).length;
  const match = count('MATCH') - legacyNotCompared;
  const deviation = count('DEVIATION');
  const incorrect = count('INCORRECT');
  const denominator = match + deviation + incorrect;
  return {
    match,
    deviation,
    incorrect,
    newComponent: count('NEW_COMPONENT'),
    dsCandidate: count('DS_CANDIDATE'),
    needsReview: count('NEEDS_REVIEW'),
    unverified,
    notCompared: unverified,
    compliancePercent: denominator === 0 ? null : Math.round((match / denominator) * 1000) / 10,
  };
}

/**
 * B7 — the final coverage ledger (Decision Log #45). B7 discovers every meaningful item on the RENDERED page
 * by its own evidence (DOM, accessibility tree, visible text, computed style, geometry, interaction state),
 * independent of B2's candidate list, and every item ends in exactly ONE of these states. `UNACCOUNTED` is
 * the only state that is not an answer: the Coverage Gate passes only when none remains.
 */
export const COVERAGE_STATES = ['AUDITED', 'EXCLUDED_WITH_REASON', 'NEEDS_REVIEW', 'CAPTURE_FAILED'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];
export type CoverageItemState = CoverageState | 'UNACCOUNTED';

/** What kind of thing an item is, decided from the element itself (never from B2's typing). */
export type CoverageItemKind = 'heading' | 'text' | 'control' | 'form-field' | 'badge' | 'card';

/** The semantic role of a text item, decided from the section's whole text hierarchy — `h1`–`h3` is one signal, never the identity. */
export type CoverageTextRole = 'eyebrow' | 'main-heading' | 'heading' | 'description' | 'paragraph' | 'stat' | 'label' | 'card-title' | 'question';

export interface CoverageItem {
  /** Stable within one run's page: `b7-<n>` in document order. */
  id: string;
  kind: CoverageItemKind;
  /** The independent role B7 gave a text item (absent for controls, fields, badges and cards). */
  role?: CoverageTextRole;
  /** The item's visible text / accessible name, shortened. */
  label: string;
  section: string;
  box: { x: number; y: number; width: number; height: number };
  /** Where the item lives, when that matters for finding it again: listing, faq, carousel, tab-panel, faded (hover / scroll-in layer), collapsed, off-canvas. */
  where: string[];
  state: CoverageItemState;
  /** Why it is in that state — for AUDITED, which finding accounts for it. */
  reason: string;
  /** The finding that accounts for the item, when one does. */
  findingId?: string;
  /** Corrective passes B7 spent on this item (0..2). */
  passes: number;
}

export interface CoverageGate {
  /** True only when `unaccounted === 0`. */
  passed: boolean;
  discovered: number;
  audited: number;
  excluded: number;
  needsReview: number;
  captureFailed: number;
  unaccounted: number;
}

/** B7's gate across every audited page (`AuditData.coverageSummary.gate`). Passes only when every page has a ledger and none has an unaccounted item. */
export interface CoverageGateSummary {
  passed: boolean;
  pages: number;
  /** Pages with no ledger (a result reused from a run that predates B7): the audit cannot claim them accounted for. */
  pagesWithoutLedger: number;
  discovered: number;
  audited: number;
  excluded: number;
  needsReview: number;
  captureFailed: number;
  unaccounted: number;
  /** Exactly what is missing, page by page. */
  incomplete: Array<{ pageUrl: string; unaccounted: CoverageItem[] }>;
}

export type CoverageRoute = 'B2' | 'B3' | 'B4' | 'B6' | 'state';

export interface CoverageAction {
  pass: number;
  route: CoverageRoute;
  itemId: string;
  label: string;
  outcome: 'resolved' | 'needs_review' | 'failed';
  reason: string;
}

/**
 * What B7's recovery LOOP did for the page — every unaccounted item is sent back through the normal audit stages, the
 * manifest is rebuilt and reconciled again, and so on until nothing is unaccounted or the loop has converged.
 */
export interface CoverageRecovery {
  /** Recovery rounds run (0: the first reconciliation found nothing to recover). */
  passes: number;
  /** Items that were not accounted for when B7 first reconciled the page. */
  found: number;
  /** …of which went back through B2 → B3 → B4 | B6 and are now audited. */
  recovered: number;
  /** …settled into an explicit state after repeated attempts (excluded with a reason, needs review, capture failed). */
  settled: number;
  /** …still unaccounted when the loop stopped (the gate fails while this is above 0). */
  remaining: number;
  /** Why it stopped: nothing to recover · everything recovered or settled · no further progress possible · a safety limit. */
  stopped: 'not-needed' | 'complete' | 'converged' | 'limit';
}

/** The live state of the recovery loop — what the CLI prints while B7 re-checks a page. */
export interface CoverageProgress {
  round: number;
  discovered: number;
  accounted: number;
  remaining: number;
}

export interface CoverageLedger {
  schemaVersion: 1;
  gate: CoverageGate;
  /** The independent evidence the manifest was built from. */
  sources: string[];
  byKind: Record<string, { discovered: number; audited: number; excluded: number; needsReview: number; captureFailed: number; unaccounted: number }>;
  /** Every exclusion, grouped by its stated reason (with a few examples) — never an unexplained drop. */
  excludedByReason: Array<{ reason: string; count: number; examples: string[] }>;
  /** Listed IN FULL: these are exactly what a human has to look at, or what is missing. */
  needsReview: CoverageItem[];
  captureFailed: CoverageItem[];
  unaccounted: CoverageItem[];
  /** Was each item audited under the right ROLE? */
  roleChecks: { checked: number; inconsistent: number; corrected: number; unresolved: number };
  actions: CoverageAction[];
  /** Recovery rounds run (0 = nothing needed correcting). An item gets at most 2 attempts; the rounds continue while progress is made. */
  passes: number;
  /** The recovery loop's own account of itself (absent from a ledger written before the loop existed). */
  recovery?: CoverageRecovery;
  /** Stated boundaries of the manifest itself (an iframe's content, content with no revealing control, …). */
  notes: string[];
}

/** The per-page result the C layer consumes (v1.0 §14 level 3). */
export interface PageResult {
  sections?: Array<{ id: string; name: string; note: string; region?: StructuralRegion }>;
  runId: string;
  pageId: string;
  url: string;
  pageName: string;
  templateFamily: string | null;
  domHash: string;
  dsRegistryVersion: string;
  policyVersion: string;
  findings: Finding[];
  compliance: ComplianceScore;
  /** Named, explicit scope boundaries — never silent (§2.7 personalization/listing/tab coverage). */
  coverage: {
    sectionsAnalyzed: number;
    componentsDetected: number;
    excludedPersonalized: number;
    excludedOffDomain: number;
    sampledListings: Array<{ section: string; sampled: number; totalObserved: number }>;
    unexpandedStates: Array<{ kind: string; label: string; reason: string }>;
    /** Model-cited refs that did not resolve (hallucinated or malformed) — recorded, never dropped silently. */
    droppedRefs: Array<{ node: string; ref: string; reason: string }>;
    /** Anything a capture or a prompt could not include in full — a stated boundary, not a silent one. */
    truncation: Array<{ what: string; detail: string }>;
    /**
     * Additive (Decision Log #45): B7's final coverage ledger — every meaningful item discovered on the
     * rendered page and the one state it ended in, with the Coverage Gate. Absent on a page whose result
     * was reused (§4.4) from a run that predates it, or restored from the database.
     */
    ledger?: CoverageLedger;
  };
  capture: {
    settled: boolean;
    httpStatus: number | null;
    consoleSummary: string;
    criticalFailures: number;
    /**
     * Additive: the page's MEASURED root font size in px (what its `rem` lengths resolve against —
     * `t-layer/capture.ts`). Context for reports only: they convert an expected `rem` to the px it renders
     * at on this page with it (`src/output/display-values.ts`); it decides nothing in matching or status.
     * Absent when it was not measured (a record written before it existed, or restored from the database).
     */
    rootFontSizePx?: number;
  };
  /** Set when §4.4 reused an unchanged page's previous findings instead of re-auditing it. */
  reusedFromRunId?: string;
}
