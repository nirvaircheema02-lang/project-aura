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
import type { Finding, PageResult, PossibleMatch } from '../skills/s0-result-contract.ts';

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
}

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
  /** The model's detection confidence was outside 0..1 — not trusted, forced LOW (S8). */
  confidenceOutOfContract: boolean;
  fingerprint: ElementFingerprint;
  /** The element's finding id — one per element whatever its outcome, unique on the page (B2 assigns it). */
  findingId: string;
  style: ExtractedStyle;
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

/** B3's answer for one ref, resolved against the catalog (never a raw model string). */
export interface DsMatch {
  /** Human-facing DS component name (`Button`), or null when there is no DS equivalent. */
  dsComponent: string | null;
  /** The exact DS file the name resolved to — B4 reads THIS file, never a lookup by name. */
  dsFile: string | null;
  dsVariant: string | null;
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
}

export interface B1Output {
  sections: SectionInfo[];
  ariaElements: AriaElement[];
  domHash: string;
  tiles: Array<{ path: string; scrollY: number }>;
  coverage: PageResult['coverage'];
}

export interface B2Output extends B1Output {
  components: DetectedComponent[];
}

export interface B3Output extends B2Output {
  matches: Map<string, DsMatch>;
  matched: DetectedComponent[];
  unmatched: DetectedComponent[];
}

export interface B4Output extends B3Output {
  findings: Finding[];
}

export type B5Output = B4Output;
export type B6Output = B4Output;
