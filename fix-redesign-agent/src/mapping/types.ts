import type { LlmUsage } from '../agents/types.ts';

/**
 * Element Mapper (C2) data model — ARCHITECTURE.md §6.4/§6.5, Decision Log #34–#37.
 *
 * `mapping.json` is ELEMENT-keyed, not finding-keyed (Decision Log #35): a single live
 * element commonly carries several findings (different rules, different properties, or a
 * repeated pattern with per-instance findings). A finding-keyed map would stamp the same
 * element repeatedly and hide that they are the same element.
 */

export type ConfidenceClass = 'confirmed' | 'probable' | 'ambiguous' | 'absent';
export type DriftClass = 'identical' | 'moved' | 'restyled' | 'content-changed' | 'absent' | 'ambiguous';
export type MappingScope = 'content' | 'excluded' | 'unselected';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * §6.4's five objective checks, computed and reproducible, no model involved. `uniqueness`
 * is evaluated over the WHOLE candidate set for a finding, not per-candidate, so it lives
 * alongside the per-candidate results rather than as a sixth boolean on each one.
 */
export interface ObjectiveChecks {
  geometry: boolean;
  identity: boolean;
  text: boolean;
  /** `null` when the audit recorded no class list to compare against (older/no-api runs) — never counted as a pass or a fail. */
  classFingerprint: boolean | null;
  /** How many of geometry/identity/text/classFingerprint passed (classFingerprint counts only when non-null). */
  passedCount: number;
}

/** One candidate element considered for a finding, before a confidence class is assigned. */
export interface MappingCandidate {
  /** A local id scoped to this mapping pass, e.g. "cand-3" — never confused with a DOM stamp or a findingId. */
  candidateId: string;
  tagName: string;
  role: string | null;
  text: string;
  classes: string[];
  box: Box;
  checks: ObjectiveChecks;
  /** Set only when C2's model sub-step proposed this candidate among several passing ones (§6.4's `probable` path). */
  modelProposed: boolean;
  modelConfidence: number | null;
}

export interface Affordances {
  tagName: string;
  role: string | null;
  href: string | null;
  type: string | null;
  tabIndex: number | null;
  ariaExpanded: string | null;
  ariaControls: string | null;
  ariaHaspopup: string | null;
  disabled: boolean;
  cursor: string | null;
  formAssociated: boolean;
}

/** One property whose live value differs from what `data.json` recorded as `actual` at audit time. */
export interface StyleDelta {
  property: string;
  auditActual: string;
  liveActual: string;
}

export interface DriftRecord {
  class: DriftClass;
  auditBox: Box | null;
  liveBox: Box | null;
  styleDeltas: StyleDelta[];
  note: string;
}

/** §6.1/§6.2: the DS component this element resolves against, and the source excerpt that justified it — never invented, always traced to a real DS file. */
export interface DsReference {
  dsComponent: string | null;
  dsFile: string | null;
  dsVariant: string | null;
  /** A short excerpt of the component's real source (via `readComponentSource`) that grounds the reference — null when there is no DS match to ground. */
  sourceExcerpt: string | null;
  basis: 'finding-match' | 'plausible-match' | 'none';
}

/**
 * One mapped live element. `resolution.confidence` is what authorizes downstream action
 * (§6.4's table): `confirmed` → edits/previews/specs; `probable` → edits only after a G1
 * acknowledgement; `ambiguous`/`absent` → never edited automatically.
 */
export interface MappingEntry {
  /** Local element id scoped to this run's mapping, e.g. "e17" — distinct from the DOM stamp attribute value, though they share the same string today. */
  element: string;
  /** The exact `data-fra-element` attribute value written to the live DOM for this element. */
  stamp: string;
  findingIds: string[];
  signature: string | null;
  instanceIndex: number | null;
  instanceCount: number | null;
  sectionId: string | null;
  scope: MappingScope;
  resolution: {
    method: 'objective' | 'objective+model' | 'text-identity';
    confidence: ConfidenceClass;
    checks: ObjectiveChecks;
    candidatesConsidered: number;
  };
  drift: DriftRecord;
  affordances: Affordances;
  dsReference: DsReference;
}

/** A finding C2 could not map to any live element at all — §6.5's `absent`/`ambiguous` drift classes, reported, never guessed. */
export interface UnmappedFinding {
  findingId: string;
  reason: string;
  candidatesConsidered: number;
}

/** §6.1's recorded-conflict discipline: every conflict is written down and surfaced at the next gate, never silently resolved. */
export interface MappingConflict {
  kind: 'expectation-changed' | 'ds-target-missing' | 'plan-source-disagreement';
  findingIds: string[];
  description: string;
  /** True for the conflicts that must appear in G1's acknowledgement half (§7.1, §11.2). */
  requiresAcknowledgement: boolean;
}

export interface MappingResult {
  entries: MappingEntry[];
  unmapped: UnmappedFinding[];
  conflicts: MappingConflict[];
  /** Set only when the hybrid model sub-step ran (§6.4's `probable` escalation). */
  usage: LlmUsage | null;
}

/**
 * §6.6: freshness is a capture fingerprint, not a DOM hash alone — DOM structure, every
 * stylesheet's URL and content hash, `@font-face` sources and hashes, in-scope asset URLs
 * and hashes, viewport, rendering policy. A typography fix is meaningless if the font or
 * stylesheet behind it changed, so those are first-class inputs, not an afterthought.
 */
export interface CaptureFingerprint {
  domHash: string;
  stylesheets: Array<{ url: string; contentHash: string }>;
  fonts: Array<{ src: string; contentHash: string | null }>;
  assets: Array<{ url: string; contentHash: string | null }>;
  viewport: { width: number; height: number };
  renderingPolicyHash: string;
}

export function captureFingerprintsEqual(a: CaptureFingerprint, b: CaptureFingerprint): boolean {
  if (a.domHash !== b.domHash || a.renderingPolicyHash !== b.renderingPolicyHash) return false;
  if (a.viewport.width !== b.viewport.width || a.viewport.height !== b.viewport.height) return false;
  // `contentHash` alone is not enough: it is routinely null for a cross-origin resource this
  // page context can't `fetch` (CORS) — comparing null===null would report two DIFFERENT
  // resources (different urls, both unhashable) as unchanged. The identifying field (url/src)
  // is compared too, so a swapped resource is caught even when neither side has a hash.
  const listEq = <T extends { contentHash: string | null }>(x: T[], y: T[], identity: (item: T) => string) =>
    x.length === y.length && x.every((xi, i) => y[i] !== undefined && identity(xi) === identity(y[i]!) && xi.contentHash === y[i]!.contentHash);
  return (
    listEq(a.stylesheets, b.stylesheets, (s) => s.url) &&
    listEq(a.fonts, b.fonts, (f) => f.src) &&
    listEq(a.assets, b.assets, (asset) => asset.url)
  );
}
