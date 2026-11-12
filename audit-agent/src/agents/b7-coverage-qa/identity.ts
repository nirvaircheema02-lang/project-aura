import type { Finding } from '../../skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent } from '../types.ts';

/**
 * CANONICAL ELEMENT IDENTITY — one physical element, one finding.
 *
 * The bug this exists for: "How We Capture Dealer Needs" appeared twice in one section under two finding ids. A
 * finding id is a hash of the element's FINGERPRINT (DOM path, role, name, text) with the box deliberately left out, so
 * when B7's recovery captured an element the audit already held — the page had re-rendered the node and the audit's
 * stamp was gone, or layout had shifted it past the box tolerance a twin lookup allows — the shared fingerprint read as
 * a COLLISION and `assignElementFindingIds` minted a numbered second id: a second finding for the same element.
 *
 * Identity is therefore decided from combined evidence, never from one of its parts:
 *
 *   the same DOM path · the same DOM role · the same normalised words · the same section
 *   (+ geometry, to tell genuine look-alikes apart; + whether the earlier audit's element is still on the page)
 *
 * The things that must NOT merge, and why they do not:
 *   - the same words in different sections      → the section is part of the identity;
 *   - repeated list items                       → each is a different DOM node, so its `nth-of-type` path differs;
 *   - look-alikes with an identical path (shadow roots) → both are on the page at different places: the boxes differ and
 *     the earlier audit's element is still live, so the later capture is a different element, not a rediscovery.
 *
 * One mechanism for single-page, full-site and re-audit runs; no per-page, per-tag or per-section special case.
 */

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').replace(/…$/, '').trim();

/** An element the audit's second look captured (B5's recovery or B7's) — the first pass never held it. */
export const isRecoveredComponent = (c: Pick<DetectedComponent, 'elId'>): boolean => /-recovered-/.test(c.elId);

/** How far apart two boxes of ONE element may be (px): layout settles, fonts load, rows animate. */
export const SAME_ELEMENT_BOX_TOLERANCE_PX = 12;

const boxOf = (c: DetectedComponent) => c.domFacts?.box ?? c.fingerprint?.box ?? { x: 0, y: 0, width: 0, height: 0 };
const sameBox = (a: DetectedComponent, b: DetectedComponent): boolean => {
  const x = boxOf(a);
  const y = boxOf(b);
  const t = SAME_ELEMENT_BOX_TOLERANCE_PX;
  return Math.abs(x.x - y.x) <= t && Math.abs(x.y - y.y) <= t && Math.abs(x.width - y.width) <= t + 4 && Math.abs(x.height - y.height) <= t + 4;
};

/** The canonical identity of an audited element: path + DOM role + normalised words (the section is compared separately). */
export function canonicalIdentity(c: Pick<DetectedComponent, 'fingerprint' | 'label'>): { path: string; role: string; text: string } {
  const fp = c.fingerprint as DetectedComponent['fingerprint'] | undefined; // a captured component always has one
  return { path: fp?.structuralPath ?? '', role: (fp?.role ?? '').toLowerCase(), text: norm(fp?.textPrefix || c.label || '').slice(0, 48) };
}

export interface SameElementOptions {
  /** Final validation: two findings only ever merge inside ONE section. Recovery: a re-discovered element may carry a different section label than the first pass gave it. */
  requireSameSection: boolean;
  /** The `data-audit-el` stamps currently on the page. An earlier audit's element that is still LIVE cannot be the one B7 just re-discovered. Absent: the conservative reading (box proximity is always required). */
  liveElIds?: ReadonlySet<string> | undefined;
}

/**
 * Are `a` (the earlier-audited component) and `b` the same physical element?
 *
 * Same path + same DOM role + same words + (same section) is the identity. On top of it, two elements that are BOTH
 * live and apart on the page are look-alikes, not one element: so unless the pair is "an original audit element that is
 * gone from the page, and its re-discovery", the boxes must also agree.
 */
export function sameElement(a: DetectedComponent, b: DetectedComponent, opts: SameElementOptions): boolean {
  if (a.elId === b.elId) return false;
  const x = canonicalIdentity(a);
  const y = canonicalIdentity(b);
  if (x.path === '' || x.path !== y.path || x.role !== y.role || x.text === '' || x.text !== y.text) return false;
  if (opts.requireSameSection && a.sectionId !== b.sectionId) return false;
  const rediscovery = isRecoveredComponent(a) !== isRecoveredComponent(b);
  if (rediscovery) {
    const original = isRecoveredComponent(a) ? b : a;
    if (opts.liveElIds !== undefined && !opts.liveElIds.has(original.elId)) return true; // the original is gone from the page: this IS it, found again
  }
  return sameBox(a, b);
}

// ── Merging two findings of one element ───────────────────────────────────────────────────────────

const DECISIVE: ReadonlySet<Finding['classification']> = new Set(['MATCH', 'DEVIATION', 'INCORRECT', 'DS_CANDIDATE', 'NEW_COMPONENT']);
/** How firmly a decisive classification speaks (a measured breach outranks a pass). */
const RANK: Record<string, number> = { INCORRECT: 4, DEVIATION: 3, NEW_COMPONENT: 2, DS_CANDIDATE: 2, MATCH: 1 };

function unionBy<T>(first: readonly T[] | undefined, second: readonly T[] | undefined, keyOf: (t: T) => string): T[] {
  const out = new Map<string, T>();
  for (const t of first ?? []) out.set(keyOf(t), t);
  for (const t of second ?? []) out.set(keyOf(t), t); // the later reading of a property replaces the earlier one
  return [...out.values()];
}

/**
 * ONE finding from the two the audit wrote for the same element. Deterministic:
 *  - the surviving finding keeps the EARLIER one's identity (its finding id, its history, the section it was first
 *    held in) — recovery never mints a second id for an element;
 *  - the classification is the strongest VALID one: a decisive result beats NEEDS_REVIEW / UNVERIFIED, between two
 *    decisive results the firmer one (INCORRECT > DEVIATION > candidates > MATCH) stands, and between equals the
 *    later reading does;
 *  - every property comparison, mismatch, rule violation and piece of evidence either reading found is kept (the
 *    later reading of one property replacing the earlier).
 */
export function mergeFindingPair(earlier: Finding, later: Finding): Finding {
  const eD = DECISIVE.has(earlier.classification);
  const lD = DECISIVE.has(later.classification);
  const laterWins = lD && (!eD || (RANK[later.classification] ?? 0) >= (RANK[earlier.classification] ?? 0));
  const base = laterWins ? later : earlier;
  const other = laterWins ? earlier : later;
  const merged: Finding = {
    ...base,
    identity: earlier.identity,
    location: earlier.location,
    history: earlier.history,
    comparison: {
      ...base.comparison,
      properties: unionBy(earlier.comparison.properties, later.comparison.properties, (p) => p.property),
      mismatches: unionBy(earlier.comparison.mismatches, later.comparison.mismatches, (m) => m.property),
      ruleViolations: unionBy(earlier.comparison.ruleViolations, later.comparison.ruleViolations, (v) => v.ruleId),
      ...(earlier.comparison.coverageNotes || later.comparison.coverageNotes ? { coverageNotes: [...new Set([...(earlier.comparison.coverageNotes ?? []), ...(later.comparison.coverageNotes ?? [])])] } : {}),
    },
    quality: {
      ...base.quality,
      evidence: unionBy(earlier.quality.evidence, later.quality.evidence, (e) => `${e.kind}|${e.ref}`),
      escalationReasons: [...new Set([...earlier.quality.escalationReasons, ...later.quality.escalationReasons])],
    },
  };
  // A decisive result the other reading could not reach keeps its own review question out of the way; when neither is decisive the base's stands.
  if (!(DECISIVE.has(base.classification)) && other.review && !base.review) merged.review = other.review;
  return merged;
}

export interface MergedElement {
  kept: { elId: string; findingId: string };
  dropped: { elId: string; findingId: string };
  label: string;
}

export interface DuplicateReconciliation {
  state: B4Output;
  merged: MergedElement[];
}

/**
 * Reconciles every pair of audited components that are the same physical element into ONE component and ONE finding.
 * Run when B7 writes a recovered finding (before it is kept) and once more, as a final validation, before the report
 * is generated. Pure: the caller re-stamps the page and re-points its own records from `merged`.
 *
 * The surviving component is the one the FIRST pass (or the earlier recovery) held, so ids and history stay put.
 */
export function reconcileDuplicates(state: B4Output, opts: SameElementOptions): DuplicateReconciliation {
  const findingById = new Map(state.findings.map((f) => [f.identity.findingId, f]));
  // originals first, then recoveries, each in document order — an original always survives its re-discovery
  const order = state.components.map((c, i) => ({ c, i })).sort((p, q) => Number(isRecoveredComponent(p.c)) - Number(isRecoveredComponent(q.c)) || p.i - q.i);
  const survivors: DetectedComponent[] = [];
  const dropped = new Map<string, DetectedComponent>(); // dropped elId → survivor
  const merged: MergedElement[] = [];
  const replaced = new Map<string, Finding>(); // survivor finding id → merged finding
  for (const { c } of order) {
    const twin = survivors.find((s) => sameElement(s, c, opts));
    const cf = findingById.get(c.findingId);
    const sf = twin ? replaced.get(twin.findingId) ?? findingById.get(twin.findingId) : undefined;
    if (!twin || !sf) {
      survivors.push(c);
      continue;
    }
    // a capture that never produced a finding adds nothing to merge; one that did is folded into the survivor's
    replaced.set(twin.findingId, cf ? mergeFindingPair(sf, cf) : sf);
    dropped.set(c.elId, twin);
    merged.push({ kept: { elId: twin.elId, findingId: twin.findingId }, dropped: { elId: c.elId, findingId: c.findingId }, label: c.label });
  }
  if (merged.length === 0) return { state, merged };

  const keptFindingIds = new Set(merged.map((m) => m.kept.findingId));
  const droppedFindingIds = new Set(merged.map((m) => m.dropped.findingId).filter((id) => !keptFindingIds.has(id)));
  const droppedRefs = new Set(state.components.filter((c) => dropped.has(c.elId)).map((c) => c.ref));
  return {
    state: {
      ...state,
      components: state.components.filter((c) => !dropped.has(c.elId)),
      matches: new Map([...state.matches].filter(([ref]) => !droppedRefs.has(ref))),
      matched: state.matched.filter((c) => !dropped.has(c.elId)),
      findings: state.findings.filter((f) => !droppedFindingIds.has(f.identity.findingId)).map((f) => replaced.get(f.identity.findingId) ?? f),
    },
    merged,
  };
}
