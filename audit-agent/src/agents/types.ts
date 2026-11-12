import type { Page } from 'playwright';
import type Database from 'better-sqlite3';
import type { Config } from '../config/index.ts';
import type { DsRegistry } from '../ds/d2-registry/index.ts';
import type { LlmClient } from '../llm/client.ts';
import type { AiMode } from '../llm/provider.ts';
import type { DomFacts } from '../t-layer/dom-facts.ts';
import type { PageCapture } from '../t-layer/capture.ts';
import type { PageObserver } from '../t-layer/render-settled.ts';
import type { AriaElement, ElementFingerprint } from '../t-layer/element-registry.ts';
import type { ExtractedStyle } from '../t-layer/computed-style.ts';
import type { CoverageProgress, Finding, PageResult, PossibleMatch } from '../skills/s0-result-contract.ts';
import type { ReferenceAssessment, ReferenceCatalog } from '../ds/reference-patterns.ts';

/**
 * State threaded through the B graph for one page. The live `page` handle is
 * part of it deliberately: B2's computed-style extraction and screenshots
 * must happen while the element is still resolvable in the state it was
 * detected in (§5.2's B2→B4 handoff contract — B4 consumes B2's resolved
 * reference and never re-derives a selector).
 */
export interface PageSession {
  page: Page;
  observer: PageObserver;
  capture: PageCapture;
  registry: DsRegistry;
  db: Database.Database;
  /** Which strategy every AI node runs (Decision Log #31). In no-api mode `llm` is a DisabledLlmClient. */
  aiMode: AiMode;
  llm: LlmClient;
  config: Config;
  runId: string;
  auditId: string;
  pageId: string;
  url: string;
  /** Set in full-site mode by A3 so findings carry their family without a join. */
  templateFamily: string | null;
  /** Where element/context screenshots for this page are written. */
  evidenceDir: string;
  /** The approved Project Aura reference evidence, when the audit has any (B3 consults it only when the DS cannot represent a role). */
  references?: ReferenceCatalog | undefined;
  /** B7's live "rechecking" state, once per recovery round — what the CLI prints while a page is being re-checked. */
  onCoverageProgress?: ((progress: CoverageProgress) => void) | undefined;
}

export interface SectionInfo {
  id: string;
  name: string;
  kind: string;
  rootRef: string;
  personalized: boolean;
  isListing: boolean;
  note: string;
  box: { x: number; y: number; width: number; height: number } | undefined;
  /**
   * no-api: candidates B1 assigned to this section by DOM ancestry although their boxes lie outside
   * `box`'s y-range — content the section owns but renders beyond its own box (a sticky scroll
   * stage's overflowing list, a clipped panel). B2 offers exactly these on top of the y-range's.
   */
  adoptedRefs?: string[];
  /**
   * B7's structural region for this section (ownership): the site header band is `global-header`, a footer
   * `global-footer`, every other section `page-content`. Set by B7's final pass; absent until then.
   */
  region?: 'global-header' | 'page-content' | 'global-footer';
}

/**
 * The ROLE B2 decides for a text from its whole section, before any DS rule or component is chosen (never the tag or the size
 * alone): `eyebrow` (supporting heading) · `main` (the section's dominant text) · `description` (body-sized supporting copy) ·
 * `card-title` (the title of a card: a title over a smaller description, repeated across the section's cards — judged by the DS's
 * documented card-title contract) · `label` (a short heading-tagged label whose size is below the DS heading range — an h2 used as
 * a diagram / UI label — audited on the foundation rules like body text, never as a SectionHeading).
 */
export type HeadingRole = 'eyebrow' | 'main' | 'description' | 'card-title' | 'label' | 'question';

/** One detected component plus every piece of evidence gathered while it was resolvable. */
export interface DetectedComponent {
  /** Run-scoped stamp id (`data-audit-el`), the handoff token between B2 and B4/B5. */
  elId: string;
  ref: string;
  sectionId: string;
  sectionName: string;
  captureState: string;
  componentType: string;
  label: string;
  domSignals: string[];
  visualSignals: string;
  instanceGroupKey: string;
  detectionConfidence: number;
  /**
   * no-api: the type was decided from the element's own visible structure (a bordered or filled text
   * leaf → badge; a repeated block with a card surface → card), not from a role or a click affordance
   * (`CandidateClassification.structural`). B3 may claim the Design System family such a pattern
   * defines even though `detectionConfidence` sits in the LOW band.
   */
  structural?: boolean;
  /**
   * no-api: the ROLE B2 decided for a heading-like text from its whole section — never from the h1–h3 tag
   * alone. `eyebrow`: a small supporting heading/overline before the main heading; `main`: the section's
   * visually dominant text, promoted to a section heading even when it is a `<p>`; `description`: a
   * heading-tagged element that is body-sized supporting copy.
   */
  headingRole?: HeadingRole;
  /** The model's detection confidence was outside 0..1 — not trusted, forced LOW (S8). */
  confidenceOutOfContract: boolean;
  fingerprint: ElementFingerprint;
  /** The element's finding id — one per element whatever its outcome, unique on the page (B2 assigns it). */
  findingId: string;
  style: ExtractedStyle;
  parts?: { label?: ExtractedStyle; icon?: ExtractedStyle };
  signature: string;
  /** Set when the element (or a descendant) still showed a placeholder value after settling (§2.7). */
  containsPlaceholder: boolean;
  screenshots: { element: string | null; context: string | null };
  /** The element was larger than one readable image; its crop shows the visible, bounded region only. */
  evidenceClipped: boolean;
  href: string | null;
  /**
   * The element's own DOM facts (tag, classes, key styles), read while it was
   * resolvable. The deterministic strategies classify and match from these —
   * the class list is what ties a production element to a DS component's
   * source. Null when the element could not be read.
   */
  domFacts: DomFacts | null;
}

/**
 * How a typographic size was matched to the Design System: the NEAREST valid DS size to what the
 * browser rendered (src/skills/nearest-typography.ts) — never the element's semantic level first.
 * B3/B4 carry it so a finding can show Actual / Closest DS value / Difference / DS source.
 */
export interface TypographyChoice {
  property: 'font-size';
  /** The rendered size and the chosen DS size, normalised to px (rem × the page's root font size). */
  actualPx: number;
  closestPx: number;
  /** The DS's own value for it (`1.953rem`) and the token it came from, when it came from one. */
  closestValue: string;
  closestToken: string | null;
  /** |actual − closest|, px. */
  differencePx: number;
  /** The variant whose size this is (`level 3`, `lg`). */
  variant: string;
  /** The element's own HTML tag (`h2`) — unchanged by the choice, which is only about its visual size. */
  semanticTag: string | null;
  /** True when the nearest visual variant is the one the semantic level would have named anyway. */
  followsSemanticLevel: boolean;
  decidedBy: 'only-candidate' | 'distance' | 'context' | 'hierarchy' | 'semantic-level' | 'order';
  /** Every DS size considered, nearest first. */
  considered: Array<{ variant: string; px: number; value: string; distancePx: number }>;
}

/**
 * no-api: HOW B3 reached its answer for one element — which Design System family it searched for the
 * element's type and on what basis it decided. B5's completeness pass verifies this record exists and
 * agrees with the element's type; without it "was the right family searched?" would not be checkable.
 */
export interface DsSearch {
  /**
   * The family the DS names for this type: the rule that names it (R4.x), the files the rule names
   * (searched first) and the deeper catalog components of the same family (searched when the rule's
   * own files cannot represent the element). Null when the DS has no family for the type — B6 then
   * has no existing component to send the element to.
   */
  family: { ruleId: string | null; files: string[]; deep: string[] } | null;
  /**
   * `class-fingerprint` / `rule-fit`: the element conforms to the matched component (built from it, or most
   * governed properties fit). `family-identity` / `single-component-family`: the element IS that family by
   * its type and structure whatever its styling looks like — its differences are deviations, never a new
   * component. `context-slot`: a compound slot decided by the element's context (a heading level, a
   * breadcrumb part). `undecided`: no existing family could represent it.
   */
  basis: 'class-fingerprint' | 'rule-fit' | 'family-identity' | 'single-component-family' | 'context-slot' | 'foundation-only' | 'undecided';
  /**
   * Why an `undecided` answer was left for B6 — so a reviewer (and B5's report) can tell "the DS has no family for
   * this type" from "the element's TYPE is only a low-confidence reading, so its family was not claimed" from "the
   * family was searched and none of it can represent the element".
   */
  undecidedBecause?: 'no-family' | 'type-not-trusted' | 'class-evidence-elsewhere' | 'family-cannot-represent';
}

/** B3's answer for one ref, resolved against the catalog (never a raw model string). */
export interface DsMatch {
  /** Human-facing DS component name (`Button`), or null when there is no DS equivalent. */
  dsComponent: string | null;
  /** The exact DS file the name resolved to — B4 reads THIS file, never a lookup by name. */
  dsFile: string | null;
  dsVariant: string | null;
  /** Compound child model, sourced from the parent's JSX rather than its root. */
  contextSlot?: 'link' | 'trigger' | 'combined-label' | 'heading' | 'subtitle';
  /**
   * `heading` slots only: the DS heading slot (`h1`/`h2`/`h3`) whose typography the element is
   * audited against — the one whose size is NEAREST the rendered size, which is not necessarily the
   * slot its own tag names. B4 reads THIS, never the tag.
   */
  visualSlot?: string;
  /** no-api: the nearest-size decision behind `dsVariant`, for the finding to show. */
  typography?: TypographyChoice;
  confidence: number;
  rationale: string;
  /** B3 returned nothing for this ref, even after a follow-up ask (S8 MODEL_OMITTED). */
  unanswered: boolean;
  confidenceOutOfContract: boolean;
  /** no-api: every DS component the evidence pointed at, best first — shown to a reviewer when no decision was possible. */
  possibleMatches?: PossibleMatch[];
  /** no-api: why no deterministic match was made (null/absent when matched). */
  undecidedReason?: string;
  /**
   * no-api: the variant/size/prop assignments of the DS component that fit the
   * element best (several when they fit equally well) — B4 compares against
   * these instead of re-deriving the variant.
   */
  assignments?: Array<Record<string, string>>;
  /** no-api: measured values next to the closest candidate's expected values. */
  observed?: Array<{ property: string; actual: string; expected: string | null; expectedToken: string | null }>;
  /** no-api: the family search behind this answer (see `DsSearch`). Absent on a model answer. */
  search?: DsSearch;
  /**
   * Body text and stat numerals: the DS has no component family for them, so they are audited against the
   * foundation rules only (colour, type scale, typeface) and are NEVER a B6 new-component question.
   */
  foundationOnly?: boolean;
  /**
   * What the approved Project Aura pages say about this element's role — present ONLY when the Design System
   * could not represent it (it was searched first) and the reference catalog holds evidence for the role. A
   * verdict, never a decision: a consistent pattern is a reference-backed DS candidate, anything less is review.
   */
  reference?: ReferenceAssessment;
}

export interface B1Output {
  sections: SectionInfo[];
  ariaElements: AriaElement[];
  domHash: string;
  tiles: Array<{ path: string; scrollY: number }>;
  coverage: PageResult['coverage'];
}

/** Why B2 did not audit one ref — the stated reason B7's coverage ledger records for an exclusion. */
export interface B2Decision {
  kind: 'sampled' | 'off-domain' | 'merged' | 'hidden' | 'not-candidate' | 'unresolvable';
  reason: string;
}

export interface B2Output extends B1Output {
  components: DetectedComponent[];
  /**
   * Every ref B2 has DECIDED about — audited, sampled out, excluded off-domain, merged into another
   * control, visually hidden, found not to be an audit candidate, or unresolvable. B5's completeness
   * pass treats all of them as accounted for and never re-captures what B2 declined by policy.
   * Optional and additive: absent (older state, model path) means "only the captured components".
   */
  decidedRefs?: string[];
  /**
   * The reason behind every ref in `decidedRefs` that was NOT audited (keyed by ref): sampled out of a
   * listing, an off-domain link, merged into another control, visually hidden, not an audit candidate, or
   * unresolvable. B7 records an exclusion only with its stated reason, so this is what it reads.
   */
  decisions?: Record<string, B2Decision>;
}

export interface B3Output extends B2Output {
  matches: Map<string, DsMatch>;
  matched: DetectedComponent[];
  unmatched: DetectedComponent[];
}

export interface B4Output extends B3Output {
  findings: Finding[];
}

/**
 * no-api only: the completeness/compliance verification report (src/agents/b5-visual-verifier/
 * completeness.ts) — what B5 found missing or incomplete from B2–B4's first pass, what it
 * corrected (within its 2-corrective-loop cap), what it legitimately did not audit (valid
 * non-candidates — informational), and what truly failed (capture failures and references that no
 * longer resolve — the only items that count as coverage errors). Optional and additive: a
 * B5Output is still a valid B4Output without it.
 */
export type B5Output = B4Output & { verification?: import('./b5-visual-verifier/completeness.ts').VerificationReport };
export type B6Output = B4Output;
