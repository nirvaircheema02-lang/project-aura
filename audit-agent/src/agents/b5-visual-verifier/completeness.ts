import { captureComponent, sectionElements, LISTING_SAMPLE_LIMIT } from '../b2-component-detector/index.ts';
import { classifyCandidate, isVisiblySized, selectCandidates, CARD_MIN_AREA, NO_CARD_SURFACE_REASON } from '../b2-component-detector/deterministic.ts';
import { dsIndex, decideMatch, familyOf, isInFamily, pageTypographyOf, type DsIndex } from '../b3-ds-matcher/deterministic.ts';
import { attachReference } from '../b3-ds-matcher/reference.ts';
import { buildFinding, deterministicEvaluations, filterFoundationViolations, matchedByIdentityOnly, policyVersionOf } from '../b4-compliance-auditor/index.ts';
import { evaluateUnmatched } from '../b6-new-component-evaluator/evaluate.ts';
import { assignElementFindingIds } from '../../t-layer/element-registry.ts';
import { readDomFacts, type DomFacts } from '../../t-layer/dom-facts.ts';
import { checkFoundationRules, buildFoundationContext } from '../b4-compliance-auditor/foundation-rules.ts';
import { classify, severityFor } from '../../skills/s5-compliance-classification.ts';
import { bandOf, escalationFor, routesToNewComponentEvaluator } from '../../skills/s8-confidence-escalation-policy.ts';
import type { AriaElement, ElementFingerprint } from '../../t-layer/element-registry.ts';
import type { Finding } from '../../skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent, DsMatch, PageSession, SectionInfo } from '../types.ts';

/**
 * B5 completeness/compliance verification — the final recheck before a page's results are
 * finalized (ARCHITECTURE.md's B1 → B2 → B3 → B4 → B5 routing, extended here per the review that
 * found "Our Approach"'s `6px` radius and off-token border colour invisible to the whole pipeline:
 * B2's detector only ever offered headings, form fields and clickables as candidates — a
 * non-interactive styled badge ("Phase 01") was never even a candidate, so no rule ever ran on it.
 * That root cause is fixed directly in B2 (`isBadgeCandidateShape`/`badgeSignal`,
 * b2-component-detector). This module is B5's OWN responsibility: a bounded, generic safety net
 * that re-examines what B1–B4 actually covered and, within a HARD cap of 2 corrective attempts per
 * item, routes a problem to whichever stage can fix it — never a third attempt, never a silent
 * guess.
 *
 * No new graph edges, no in-run cycle (Decision Log #13 — a `FeedbackEdge` is cross-run only, never
 * an in-run one). The "loop back to B2/B3/B4/B6" the spec describes is implemented as B5 calling those
 * stages' own exported functions directly, in-process, for just the items that need it —
 * `classifyCandidate` + `captureComponent` (B2), `decideMatch` (B3), `deterministicEvaluations` /
 * `buildFinding` (B4), `evaluateUnmatched` (B6) — the exact same functions the graph's own nodes call,
 * never a parallel reimplementation.
 *
 * THE RULE: an element B5 recovers takes the SAME path a first-pass element takes —
 *
 *     B5 finds it → B2 classifies + captures it → B3 searches the Design System family for its type
 *       ├─ an existing family represents it → B4 audits it against that component's full contract
 *       └─ no existing family represents it → B6 evaluates it
 *     → B5 verifies the result (at most 2 passes) → anything still unresolved is NEEDS_REVIEW.
 *
 * `Recovered ≠ New Component`. `Existing DS family + wrong styling ≠ New Component`. `Existing DS
 * family + uncertain variant ≠ B6`. B6 is only for a pattern no existing family represents.
 *
 * Three checks per pass, each routing to the stage that owns the problem:
 *  1. ELEMENT coverage → B2. Every meaningful element is audited, excluded with a reason, or
 *     explicitly unresolved. A repeated, sizeable, non-interactive block with a card surface (the
 *     testimonial-card shape) or a leftover badge-shaped leaf that slipped past B2's first pass is
 *     classified and captured, then routed on to B3.
 *  2. DS-MATCHING coverage → B3. B3 records which family it searched and on what basis (`DsMatch.search`);
 *     a recorded answer that is missing, searched the wrong family, or names a component outside the
 *     element's family without class evidence is re-asked of B3 and the element re-routed (B4 or B6).
 *  3. PROPERTY coverage → B4. Every matched component's foundation-rule coverage (R1.2–R1.4, R3.5, R3.6)
 *     AND its matched variant's full contract (every governed property B4's own evaluation produces) is
 *     recomputed fresh and compared with what the finding shows; a genuine gap is corrected by rebuilding
 *     the finding via B4's own `buildFinding`.
 */

export const MAX_CORRECTIVE_LOOPS = 2;

export interface VerificationAction {
  loop: number;
  stage: 'B2' | 'B3' | 'B4' | 'B6';
  ref: string;
  sectionId: string;
  outcome: 'resolved' | 'needs_review';
  reason: string;
}

export interface ReportedItem {
  ref: string;
  sectionId: string;
  reason: string;
  /** The type B2 would have given the candidate, when known (`badge`, `card`). */
  type?: string;
  /** `property`: the element has a finding whose property coverage would not stabilise; `element`: the element itself could not be captured or resolved. */
  kind?: 'element' | 'property';
}

/**
 * What B5 found and what it did. The lists are deliberately separate, because they mean different
 * things and only two of them are ever errors:
 *  - `excluded`        — valid non-candidates B5 looked at and legitimately did NOT audit (a plain
 *                        caption, stat number or label: no border, no fill; a repeated block with no
 *                        card surface: a layout column). Informational. Never an error.
 *  - `captureFailures` — an element that WAS an audit candidate whose evidence could not be captured. A real failure.
 *  - `unresolvedRefs`  — items the pipeline genuinely could not settle within its attempt cap: a
 *                        reference that no longer resolves on the page, or property coverage that would
 *                        not stabilise. A real, unresolved item.
 *  - `needsReview`     — recovered and audited (a finding exists) but with a question left for a
 *                        human, e.g. B6 could not tell whether the pattern is an existing DS component,
 *                        a one-off or a candidate. Visible on the finding itself; NOT a coverage error.
 * Only `captureFailures` and `unresolvedRefs` reach `coverage.droppedRefs` (and so the reports' error counts).
 *
 * How recovered and re-routed elements were routed:
 *  - `routedToB4`      — B3 found an existing DS family: the element was audited against that component's contract.
 *  - `routedToB6`      — B3 found NO existing family: B6's own evaluation produced the finding (B6 never saw it as a first-pass element).
 *  - `rematched`       — B5's matching-coverage check found B3's answer missing or inconsistent and re-asked B3.
 *  - `confirmedForB6`  — first-pass components B3 left for B6 whose recorded family search B5 verified (no family exists for the type, the family cannot represent the element, or its TYPE is too doubtful to claim a family): B6 is right for them.
 *  - `markedNeedsReview` — unresolved after the corrective passes: finalized as NEEDS_REVIEW with the reason; never dropped, never retried a third time.
 */
export interface VerificationReport {
  sectionsChecked: number;
  elementsConsidered: number;
  componentsRecovered: number;
  propertiesCorrected: number;
  /** Verification sweeps run — 1 when nothing needed correcting, at most MAX_CORRECTIVE_LOOPS. */
  passes: number;
  actions: VerificationAction[];
  excluded: ReportedItem[];
  captureFailures: ReportedItem[];
  unresolvedRefs: ReportedItem[];
  needsReview: ReportedItem[];
  routedToB4: ReportedItem[];
  routedToB6: ReportedItem[];
  rematched: ReportedItem[];
  confirmedForB6: ReportedItem[];
  markedNeedsReview: ReportedItem[];
}

export function emptyVerificationReport(sectionsChecked = 0): VerificationReport {
  return {
    sectionsChecked, elementsConsidered: 0, componentsRecovered: 0, propertiesCorrected: 0, passes: 0,
    actions: [], excluded: [], captureFailures: [], unresolvedRefs: [], needsReview: [],
    routedToB4: [], routedToB6: [], rematched: [], confirmedForB6: [], markedNeedsReview: [],
  };
}

/** The refs that count as coverage errors — the ONLY B5 items that may enter `coverage.droppedRefs`. */
export function coverageErrors(report: VerificationReport): ReportedItem[] {
  return [...report.captureFailures, ...report.unresolvedRefs];
}

/** How one element B5 tried to recover turned out — and whether it counts as an error (only the last two do). */
export type RecoveryOutcome =
  | { kind: 'recovered'; component: DetectedComponent; loop: number }
  | { kind: 'excluded'; reason: string; loop: number }
  | { kind: 'capture-failed'; reason: string; loop: number }
  | { kind: 'unresolved'; reason: string; loop: number };

/** What B2's `captureComponent` needs to know about a classified element (B2's own classification satisfies it). */
type Classification = Parameters<typeof captureComponent>[4];

/** What a recovery attempt does to the page — injected so every branch is testable without a browser. */
export interface RecoveryOps {
  /** The element's DOM facts, or null when its reference cannot be read (detached / replaced). */
  readFacts(ref: string): Promise<DomFacts | null>;
  /** B2's classification of the element — null when it is not an audit candidate. */
  classify(el: AriaElement, facts: DomFacts): Classification | null;
  capture(el: AriaElement, classification: Classification, facts: DomFacts): Promise<DetectedComponent | null>;
  /** Why a null classification is a valid exclusion, when the generic reason is not specific enough. */
  exclusionReason?(el: AriaElement): string;
}

const GENERIC_EXCLUSION = 'not an audit candidate — plain text with no border or fill, or not rendered (a caption, label or stat), the same rule B2 applies';

/**
 * One element, at most `MAX_CORRECTIVE_LOOPS` attempts, an honest verdict:
 *  - not an audit candidate (classification null) → `excluded`, decided on the first read, never retried and never an error;
 *  - a candidate whose evidence capture failed on every attempt → `capture-failed`;
 *  - a reference that could not be read on any attempt → `unresolved`.
 */
export async function attemptRecovery(el: AriaElement, ops: RecoveryOps): Promise<RecoveryOutcome> {
  let reached: 'unresolved' | 'capture-failed' = 'unresolved';
  for (let loop = 1; loop <= MAX_CORRECTIVE_LOOPS; loop++) {
    const facts = await ops.readFacts(el.ref);
    if (!facts) continue; // transient — worth the one retry the cap allows
    const classification = ops.classify(el, facts);
    if (!classification) return { kind: 'excluded', reason: ops.exclusionReason?.(el) ?? GENERIC_EXCLUSION, loop };
    reached = 'capture-failed';
    const component = await ops.capture(el, classification, facts);
    if (component) return { kind: 'recovered', component, loop };
  }
  return reached === 'unresolved'
    ? { kind: 'unresolved', reason: `reference no longer resolves on the page (detached or replaced since the snapshot) after ${MAX_CORRECTIVE_LOOPS} attempts`, loop: MAX_CORRECTIVE_LOOPS }
    : { kind: 'capture-failed', reason: `evidence capture failed after ${MAX_CORRECTIVE_LOOPS} attempts (the element changed or detached while being captured)`, loop: MAX_CORRECTIVE_LOOPS };
}

/** Boxes within this many px of each other count as the same size — same tolerance B2 itself uses for repeated-unit/duplicate-control geometry. */
const SAME_BOX_SLACK = 1;

function sameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs(a.width - b.width) <= SAME_BOX_SLACK && Math.abs(a.height - b.height) <= SAME_BOX_SLACK;
}

/**
 * Non-interactive, non-badge-shaped leftovers that are one of ≥2 same-size siblings and large
 * enough to be real content (`CARD_MIN_AREA` — the same threshold B2's own clickable-card
 * heuristic uses): the testimonial-card shape. Geometric only, cheap, and deliberately
 * conservative — a REPEATED large block is strong evidence of a real content pattern a grid/
 * carousel renders, not a one-off layout wrapper, which is what keeps this from flagging every
 * large `<section>`/`<div>` on the page. Whether such a block is a card at all (it has a visible
 * surface) is B2's decision once its styles are read (`classifyCandidate`, `repeatedBlock`).
 */
function repeatedBlockCandidates(elements: AriaElement[]): AriaElement[][] {
  const bySiblingAndSize: AriaElement[][] = [];
  const consumed = new Set<string>();
  for (const el of elements) {
    if (consumed.has(el.ref) || !el.box || el.role !== 'generic') continue;
    const area = el.box.width * el.box.height;
    if (area < CARD_MIN_AREA) continue;
    const group = elements.filter((o) => !consumed.has(o.ref) && o.ref !== el.ref && o.parentRef === el.parentRef && o.role === 'generic' && o.box && sameSize(o.box, el.box!));
    if (group.length === 0) continue;
    const all = [el, ...group].slice(0, LISTING_SAMPLE_LIMIT);
    for (const m of all) consumed.add(m.ref);
    bySiblingAndSize.push(all);
  }
  return bySiblingAndSize;
}

/**
 * Everything already accounted for by B2's first pass: captured as a component, or DECIDED about —
 * sampled out of a listing, excluded as an off-domain utility link, merged into another control,
 * visually hidden, found not to be an audit candidate, or unresolvable (`B2Output.decidedRefs`).
 * Only a ref in none of these is a genuine gap. Re-capturing a ref B2 declined by policy would undo
 * that policy (and contradict the coverage B2 reported), so it is never a gap.
 */
function alreadyAccountedFor(input: B4Output): Set<string> {
  return new Set([...input.components.map((c) => c.ref), ...(input.decidedRefs ?? [])]);
}

/** A component B5 itself captured (its stamped element id says so) — B5, not the B6 node, evaluates it when no family represents it. */
export function isRecovered(component: Pick<DetectedComponent, 'elId'>): boolean {
  return component.elId.includes('-recovered-');
}

/** What the verification pass asks of the other stages — injectable so the routing and the cap can be proven against a B3 that finds no family, or never settles. */
export interface VerificationOps {
  /** B3's decision for one element (default: `decideMatch`). */
  decide?: typeof decideMatch;
}

export interface Recovered {
  components: DetectedComponent[];
  matches: Map<string, DsMatch>;
  findings: Finding[];
  /** Recovered components B3 matched to an existing family (audited by B4)… */
  matched: DetectedComponent[];
  /** …and those it found NO family for (evaluated by B6's own evaluation). */
  unmatched: DetectedComponent[];
}

/**
 * ELEMENT coverage (→ B2), and the route the recovered elements then take (→ B3 → B4 | B6).
 * Finds the candidate-shaped elements nobody accounted for in each section, classifies and captures
 * them exactly as B2 would have, asks B3 which Design System family represents each, and — by B3's
 * answer — has B4 audit it against that component or B6 evaluate it. A valid non-candidate is
 * excluded with its reason; a candidate that cannot be captured is a failure, never a silent drop.
 */
export async function recoverMissingComponents(session: PageSession, input: B4Output, report: VerificationReport, ops: VerificationOps = {}): Promise<Recovered> {
  const decide = ops.decide ?? decideMatch;
  const claimed = alreadyAccountedFor(input);
  // What an earlier pass already settled (excluded, failed, unresolved) is never attempted again.
  for (const item of [...report.excluded, ...report.captureFailures, ...report.unresolvedRefs]) claimed.add(item.ref);
  const captured: Array<{ component: DetectedComponent; section: SectionInfo; loop: number }> = [];
  let considered = 0;
  // Neither touches session.page — computed lazily, on first actual use, so a page with nothing
  // left to recover (the common case) never needs a live page at all (tested directly: completeness
  // verification on an already-complete input must never require `session.page` to exist).
  let viewportWidth: number | undefined;

  for (const section of input.sections) {
    if (section.personalized) continue;
    const elements = sectionElements(input.ariaElements, section);
    const unclaimed = elements.filter((e) => !claimed.has(e.ref) && e.box && isVisiblySized(e.box));
    considered += unclaimed.length;
    if (unclaimed.length === 0) continue;

    viewportWidth ??= session.page.viewportSize()?.width ?? 1440;

    // Leftover badge-shaped leaves B2's first pass did not select (isBadgeCandidateShape runs
    // again here over just the leftovers — the SAME function, a genuine second pass).
    const { candidates: badgeCandidates } = selectCandidates(unclaimed, { viewportWidth, allElements: input.ariaElements });
    // Repeated large non-interactive blocks (testimonial-card shape) — a shape B2 does not select at all.
    const blockCandidates = repeatedBlockCandidates(unclaimed).flat();

    const toCapture = [...new Map([...badgeCandidates, ...blockCandidates].map((e) => [e.ref, e])).values()];
    for (const el of toCapture) {
      if (claimed.has(el.ref)) continue; // a badge candidate that is also part of a flagged block
      const isBlockMember = blockCandidates.some((b) => b.ref === el.ref);
      const elId = `${section.id}-recovered-${report.componentsRecovered + captured.length}`;
      const type = isBlockMember ? 'card' : 'badge';
      const outcome = await attemptRecovery(el, {
        readFacts: (ref) => readDomFacts(session.page.locator(`aria-ref=${ref}`)).catch(() => null),
        // B2's own classification — the same function its first pass runs. For a repeated block it asks
        // the one question B2 never had a reason to: does the block have a card SURFACE?
        classify: (e, facts) => classifyCandidate(e, facts, isBlockMember ? { repeatedBlock: true } : {}),
        ...(isBlockMember ? { exclusionReason: () => NO_CARD_SURFACE_REASON } : {}),
        capture: (e, classification, facts) =>
          captureComponent(session, section, elId, e.ref, classification, { groupKey: `${section.id}::recovered:${classification.componentType}`, href: e.url ?? null, facts }),
      });
      if (outcome.kind === 'excluded') {
        // A valid non-candidate: decided, informational, never an error and never a corrective action.
        claimed.add(el.ref);
        report.excluded.push({ ref: el.ref, sectionId: section.id, reason: outcome.reason, type });
        continue;
      }
      if (outcome.kind === 'capture-failed' || outcome.kind === 'unresolved') {
        claimed.add(el.ref); // settled: a failure is reported once and never retried
        const item: ReportedItem = { ref: el.ref, sectionId: section.id, reason: outcome.reason, type, kind: 'element' };
        (outcome.kind === 'capture-failed' ? report.captureFailures : report.unresolvedRefs).push(item);
        report.actions.push({ loop: outcome.loop, stage: 'B2', ref: el.ref, sectionId: section.id, outcome: 'needs_review', reason: outcome.reason });
        continue;
      }
      const { component, loop } = outcome;
      claimed.add(el.ref);
      captured.push({ component, section, loop });
      report.actions.push({ loop, stage: 'B2', ref: el.ref, sectionId: section.id, outcome: 'resolved', reason: `classified as ${component.componentType}${component.structural ? ' (from its visible structure)' : ''} and captured — not selected by B2's first pass` });
    }
  }
  report.elementsConsidered = Math.max(report.elementsConsidered, considered);
  report.componentsRecovered += captured.length;
  return routeCapturedComponents(session, input, captured, report, { decide });
}

/** One component some stage captured that still has to be routed — which section it sits in and which corrective pass found it. */
export interface CapturedForRouting {
  component: DetectedComponent;
  section: Pick<SectionInfo, 'id' | 'name'>;
  loop: number;
}

/**
 * THE shared routing of a freshly captured component — the one path every recovered element takes, whoever
 * captured it (B5's completeness pass, B7's final coverage pass): finding ids assigned over the FULL list of
 * fingerprints (so a twin of an existing element still gets a distinct id), then B3 searches the Design
 * System family for its type, and by B3's answer B4 audits it against that component's full contract or B6
 * evaluates it. Never a parallel reimplementation of B3/B4/B6 — their own functions, called in-process.
 */
export async function routeCapturedComponents(
  session: PageSession,
  input: B4Output,
  captured: CapturedForRouting[],
  report: VerificationReport,
  ops: VerificationOps = {},
): Promise<Recovered> {
  const decide = ops.decide ?? decideMatch;
  if (captured.length === 0) return { components: [], matches: new Map(), findings: [], matched: [], unmatched: [] };
  const viewportWidth = session.page.viewportSize()?.width ?? 1440;

  // One finding-id assignment over the FULL, combined fingerprint list — so a recovered element
  // that happens to share another's exact fingerprint (a sampled-out twin of an already-captured
  // repeated instance) still gets a correctly de-duplicated id, never a silent collision with an
  // existing finding. Already-assigned ids on the original components/findings are left exactly
  // as B4 published them — re-audit history must never shift under elements that did not change.
  const { ids } = assignElementFindingIds(session.pageId, [...input.components, ...captured.map((c) => c.component)].map((c) => c.fingerprint));
  const recovered = captured.map((c, i) => ({ ...c, component: { ...c.component, findingId: ids[input.components.length + i]! } }));
  const components = recovered.map((r) => r.component);
  const allComponents = [...input.components, ...components];

  // B3: which Design System family represents each recovered element?
  const index = await dsIndex(session.registry);
  const matches = new Map<string, DsMatch>();
  for (const r of recovered) {
    const match = attachReference(decide(r.component, index, session.registry, viewportWidth, pageTypographyOf(allComponents, r.component)), r.component, session.references);
    matches.set(r.component.ref, match);
    report.actions.push({
      loop: r.loop, stage: 'B3', ref: r.component.ref, sectionId: r.section.id, outcome: 'resolved',
      reason: match.dsComponent
        ? `family search (${match.search?.family?.ruleId ?? 'rule'}): matched ${match.dsFile}${match.dsVariant ? ` (${match.dsVariant})` : ''} — ${match.search?.basis ?? 'no recorded basis'}`
        : `family search (${match.search?.family?.ruleId ?? 'no family named'}): no existing Design System family represents it — ${match.undecidedReason ?? 'undecided'}`,
    });
  }
  const allMatches = new Map([...input.matches, ...matches]);

  // B4 for the ones an existing family represents; B6 for the ones none does.
  const toB6 = recovered.filter((r) => routesToNewComponentEvaluator(matches.get(r.component.ref)!));
  const toB4 = recovered.filter((r) => !routesToNewComponentEvaluator(matches.get(r.component.ref)!));
  const findings: Finding[] = [];
  if (toB4.length > 0) {
    const evaluations = await deterministicEvaluations(session, { ...input, components: allComponents, matches: allMatches, matched: toB4.map((r) => r.component) });
    for (const r of toB4) {
      const match = matches.get(r.component.ref)!;
      findings.push(buildFinding(session, r.component, match, evaluations.get(r.component.ref)!));
      report.routedToB4.push({ ref: r.component.ref, sectionId: r.section.id, reason: `audited against ${match.dsFile}${match.dsVariant ? ` (${match.dsVariant})` : ''} — ${match.search?.basis ?? 'matched'}` });
      report.actions.push({ loop: r.loop, stage: 'B4', ref: r.component.ref, sectionId: r.section.id, outcome: 'resolved', reason: `compared against ${match.dsFile}'s full contract` });
    }
  }
  if (toB6.length > 0) {
    const created = await evaluateUnmatched(session, { components: allComponents, matches: allMatches }, toB6.map((r) => r.component));
    for (const [i, r] of toB6.entries()) {
      const finding = created[i]!;
      findings.push(finding);
      report.routedToB6.push({ ref: r.component.ref, sectionId: r.section.id, reason: `no existing DS family represents it — B6 evaluated it: ${finding.classification}` });
      const open = finding.classification === 'NEEDS_REVIEW';
      if (open) report.needsReview.push({ ref: r.component.ref, sectionId: r.section.id, reason: finding.review?.reason ?? 'B6 could not decide' });
      report.actions.push({ loop: r.loop, stage: 'B6', ref: r.component.ref, sectionId: r.section.id, outcome: open ? 'needs_review' : 'resolved', reason: `evaluated as ${finding.classification}` });
    }
  }
  return { components, matches, findings, matched: toB4.map((r) => r.component), unmatched: toB6.map((r) => r.component) };
}

export type FamilyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * DS-MATCHING coverage for ONE component: does B3's recorded answer show that the right family was
 * searched, and is the answer consistent with it? Pure (no page): it checks the record B3 left
 * (`DsMatch.search`) against the family the DS names for the element's type.
 *  - A type the DS names no family for has nothing to verify — B6 is the right place for it.
 *  - No record, or a record of a DIFFERENT family, means the right search is not shown to have happened.
 *  - A component the element is audited against that lies outside the element's family, on a basis other
 *    than class evidence (an element built from another DS component carries that component's classes), is a
 *    wrong match.
 * A context slot (a heading level, a breadcrumb part) is decided by the element's context, not a family.
 */
export function verifyFamilySearch(component: Pick<DetectedComponent, 'componentType'>, match: DsMatch, index: DsIndex): FamilyVerdict {
  const family = familyOf(component.componentType, index);
  if (!family) return { ok: true };
  const search = match.search;
  if (!search) return { ok: false, reason: `no record that the ${family.ruleId} family (${family.files.join(', ')}) was searched for this ${component.componentType}` };
  if (search.basis === 'context-slot') return { ok: true };
  if (search.family?.ruleId !== family.ruleId) {
    return { ok: false, reason: `B3 searched ${search.family ? `the ${search.family.ruleId ?? 'unnamed'} family` : 'no family'}, but the DS names the ${family.ruleId} family (${family.files.join(', ')}) for a ${component.componentType}` };
  }
  const audited = match.dsComponent !== null && !routesToNewComponentEvaluator(match);
  if (audited && search.basis !== 'class-fingerprint' && !isInFamily(family, match.dsFile)) {
    return { ok: false, reason: `matched to ${match.dsFile}, which is not in the ${family.ruleId} family (${family.files.join(', ')}) and has no class evidence behind it` };
  }
  return { ok: true };
}

/**
 * PROPERTY coverage (→ B4). Two recomputations, each compared with what the finding already shows:
 *  1. every matched component's foundation-rule coverage (R1.2–R1.4, R3.5, R3.6) — a missed violation is added;
 *  2. the matched variant's FULL contract — every governed property B4's own evaluation produces (radius,
 *     border, background/colour, typography, padding/gap, size, …) — a property the finding does not
 *     show is restored by rebuilding the finding with B4's own `buildFinding`.
 * In today's pipeline both are normally no-ops — B4 already runs them unconditionally — but they are a
 * genuine, generic safety net: if a future change ever causes a governed property to be silently skipped
 * for some component, this catches it rather than letting the finding publish incomplete.
 */
export async function recheckPropertyCompleteness(
  session: PageSession,
  input: B4Output,
  report: VerificationReport,
  opts: { scope?: ReadonlySet<string> | null; loop?: number; touched?: Set<string> } = {},
): Promise<Finding[]> {
  const ctx = buildFoundationContext(session.registry);
  const byFindingId = new Map(input.components.map((c) => [c.findingId, c]));
  const findings = [...input.findings];
  const inScope = (c: DetectedComponent) => !opts.scope || opts.scope.has(c.ref);
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!;
    if (finding.classification === 'DS_CANDIDATE' || finding.classification === 'NEW_COMPONENT' || finding.classification === 'NEEDS_REVIEW') continue;
    const component = byFindingId.get(finding.identity.findingId);
    if (!component || !component.style.connected || !inScope(component)) continue;
    // A subtitle candidate deliberately gets NO foundation-rule check from B4 (deterministicEvaluations:
    // `subtitleCandidate ? [] : checkFoundationRules(...)`) — its heading-vs-paragraph role is itself
    // unresolved, so prescribing typography/rules would be premature, not merely incomplete. Respecting
    // that same exclusion here is not optional: without it, this recheck "corrects" a deliberate
    // suppression into a false INCORRECT (caught live — a subtitle's classification flipped
    // UNVERIFIED → INCORRECT before this guard was added).
    if (input.matches.get(component.ref)?.contextSlot === 'subtitle') continue;
    const headingLevel = /^h([1-6])$/.exec(component.domFacts?.tag ?? '')?.[1];
    let loop = 1;
    let current = finding;
    for (; loop <= MAX_CORRECTIVE_LOOPS; loop++) {
      const raw = checkFoundationRules({ componentType: component.componentType, headingLevel: headingLevel ? Number(headingLevel) : null, hasText: Boolean(component.domFacts?.ownText), style: component.style, ctx, role: component.headingRole ?? null });
      // B4's OWN filter, not a second one: a matched variant's exact contract outranks a foundation rule's generic
      // recommendation for the same property, and a prohibition (R1.2 brand red) is kept for an identity-only match.
      const passedProperties = (current.comparison.properties ?? []).filter((p) => p.status === 'MATCH').map((p) => p.property);
      const fresh = filterFoundationViolations(raw, passedProperties, current.comparison.mismatches, { keepProhibitions: matchedByIdentityOnly(input.matches.get(component.ref)) });
      const existingRuleIds = new Set(current.comparison.ruleViolations.map((v) => v.ruleId));
      const missed = fresh.filter((v) => !existingRuleIds.has(v.ruleId));
      if (missed.length === 0) break; // nothing missing — the common, expected case
      const ruleViolations = [...current.comparison.ruleViolations, ...missed];
      const classification = classify({ hasDsMatch: true, mismatches: current.comparison.mismatches, ruleViolations });
      const severity = severityFor({ hasDsMatch: true, mismatches: current.comparison.mismatches, ruleViolations, classification });
      current = { ...current, classification, comparison: { ...current.comparison, ruleViolations }, quality: { ...current.quality, severity } };
      report.propertiesCorrected += missed.length;
      opts.touched?.add(component.ref);
      report.actions.push({ loop, stage: 'B4', ref: component.ref, sectionId: component.sectionId, outcome: 'resolved', reason: `${missed.length} governed propert${missed.length === 1 ? 'y was' : 'ies were'} missing from the first pass (${missed.map((v) => v.ruleId).join(', ')}) — recomputed` });
    }
    if (loop > MAX_CORRECTIVE_LOOPS) {
      // Genuinely unresolved: the pipeline could not settle this finding's property coverage within its cap.
      report.unresolvedRefs.push({ ref: component.ref, sectionId: component.sectionId, reason: `property completeness could not stabilize after ${MAX_CORRECTIVE_LOOPS} corrective passes`, kind: 'property' });
    }
    findings[i] = current;
  }

  // (2) The matched variant's full contract. A plain family match only — a context slot (a heading level, a
  // breadcrumb part) has its own comparison, and a finding with no match has no contract to recompute.
  const contract: Array<{ index: number; component: DetectedComponent; match: DsMatch }> = [];
  for (const [i, finding] of findings.entries()) {
    const component = byFindingId.get(finding.identity.findingId);
    const match = component ? input.matches.get(component.ref) : undefined;
    if (!component || !match?.dsFile || match.contextSlot || routesToNewComponentEvaluator(match) || !component.style.connected || !inScope(component)) continue;
    if (finding.classification === 'DS_CANDIDATE' || finding.classification === 'NEW_COMPONENT' || finding.classification === 'NEEDS_REVIEW') continue;
    contract.push({ index: i, component, match });
  }
  if (contract.length > 0) {
    const fresh = await deterministicEvaluations(session, { ...input, matched: contract.map((c) => c.component) });
    for (const { index, component, match } of contract) {
      const evaluation = fresh.get(component.ref);
      const finding = findings[index]!;
      if (!evaluation) continue;
      const governed = new Set([...evaluation.passed, ...evaluation.mismatches.map((m) => m.property)]);
      const shown = new Set([...(finding.comparison.properties ?? []).filter((p) => p.status !== 'UNRESOLVED').map((p) => p.property), ...finding.comparison.mismatches.map((m) => m.property)]);
      const missing = [...governed].filter((p) => !shown.has(p));
      if (missing.length === 0) continue;
      findings[index] = buildFinding(session, component, match, evaluation);
      report.propertiesCorrected += missing.length;
      opts.touched?.add(component.ref);
      report.actions.push({ loop: opts.loop ?? 1, stage: 'B4', ref: component.ref, sectionId: component.sectionId, outcome: 'resolved', reason: `${missing.length} governed propert${missing.length === 1 ? 'y' : 'ies'} of ${match.dsFile} not shown by the first pass (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}) — B4 re-ran its comparison` });
    }
  }
  return findings;
}

/**
 * THE shared re-route of ONE component to a new B3 answer — used by B5's matching-coverage check and by
 * B7's final pass. Whatever finding the element had is REPLACED by the stage the new answer routes it to:
 * an existing family → B4 audits it against that component's full contract; no family → B6 evaluates it
 * (right here for an element a verification pass itself captured, or when no B6 node is left to run — `evaluateUnmatchedNow`;
 * the B6 node does it for a first-pass one).
 * `state.matches` must already hold `answer` for the component. Returns the new state; never mutates its input.
 */
export async function rerouteComponent(session: PageSession, state: B4Output, component: DetectedComponent, answer: DsMatch, report: VerificationReport, loop: number, opts: { evaluateUnmatchedNow?: boolean } = {}): Promise<B4Output> {
  const matches = new Map(state.matches);
  matches.set(component.ref, answer);
  let findings = state.findings.filter((f) => f.identity.findingId !== component.findingId);
  const matched = state.matched.filter((c) => c.ref !== component.ref);
  const unmatched = state.unmatched.filter((c) => c.ref !== component.ref);
  const full: B4Output = { ...state, matches, matched, unmatched, findings };
  if (!routesToNewComponentEvaluator(answer)) {
    matched.push(component);
    const evaluations = await deterministicEvaluations(session, { ...full, matched: [component] });
    findings = [...findings, buildFinding(session, component, answer, evaluations.get(component.ref)!)];
    report.routedToB4.push({ ref: component.ref, sectionId: component.sectionId, reason: `re-matched to ${answer.dsFile}${answer.dsVariant ? ` (${answer.dsVariant})` : ''} — audited against its full contract` });
    report.actions.push({ loop, stage: 'B4', ref: component.ref, sectionId: component.sectionId, outcome: 'resolved', reason: `compared against ${answer.dsFile}'s full contract` });
  } else if (isRecovered(component) || opts.evaluateUnmatchedNow === true) {
    // No B6 node is left to run (a pass that captured the element itself, or B7 — the last node): evaluate it here.
    const [created] = await evaluateUnmatched(session, { components: state.components, matches }, [component]);
    if (created) {
      findings = [...findings, created];
      report.routedToB6.push({ ref: component.ref, sectionId: component.sectionId, reason: `no existing DS family represents it — B6 evaluated it: ${created.classification}` });
      report.actions.push({ loop, stage: 'B6', ref: component.ref, sectionId: component.sectionId, outcome: created.classification === 'NEEDS_REVIEW' ? 'needs_review' : 'resolved', reason: `evaluated as ${created.classification}` });
    }
  } else {
    unmatched.push(component); // the B6 node evaluates it
  }
  return { ...state, matches, matched, unmatched, findings };
}

/**
 * DS-MATCHING coverage (→ B3), applied. For every component B3 answered about, the recorded family
 * search is verified (`verifyFamilySearch`); a flagged one is re-asked of B3 — at most
 * `MAX_CORRECTIVE_LOOPS` times per element — and re-routed by the new answer: an existing family →
 * B4 audits it; none → B6 evaluates it (B5 itself for an element it recovered, the B6 node for a
 * first-pass one). A component whose type the DS names no family for, and every first-pass component
 * B3 left without a family whose search is on record, is CONFIRMED for B6 — it is what B6 is for.
 */
export async function verifyMatchingCoverage(
  session: PageSession,
  state: B4Output,
  report: VerificationReport,
  loop: number,
  scope: ReadonlySet<string> | null,
  skip: ReadonlySet<string>,
  touched: Set<string>,
  decide: typeof decideMatch,
): Promise<B4Output> {
  let index: DsIndex | undefined;
  let viewportWidth: number | undefined;
  let { matches, matched, unmatched, findings } = { matches: new Map(state.matches), matched: [...state.matched], unmatched: [...state.unmatched], findings: [...state.findings] };
  for (const component of state.components) {
    if (skip.has(component.ref) || (scope && !scope.has(component.ref))) continue;
    const match = matches.get(component.ref);
    if (!match) continue; // B3 never routed this element: there is no answer to verify
    index ??= await dsIndex(session.registry);
    const verdict = verifyFamilySearch(component, match, index);
    if (verdict.ok) {
      if (routesToNewComponentEvaluator(match) && !isRecovered(component) && !report.confirmedForB6.some((c) => c.ref === component.ref)) {
        const ruleId = match.search?.family?.ruleId ?? '';
        const reason: Record<NonNullable<NonNullable<DsMatch['search']>['undecidedBecause']>, string> = {
          'no-family': `the DS names no family for a ${component.componentType} — B6 evaluates it`,
          'type-not-trusted': `the ${ruleId} family exists, but this element's type is only a low-confidence reading (detection ${component.detectionConfidence}), so B3 did not claim it — B6 evaluates it and a reviewer decides`,
          'class-evidence-elsewhere': `its classes point at a component outside the ${ruleId} family — B6 evaluates it`,
          'family-cannot-represent': `the ${ruleId} family was searched (${match.search?.family?.files.join(', ') ?? ''}${match.search?.family?.deep.length ? ' and its deeper members' : ''}) and none of it can represent this element — B6 evaluates it`,
        };
        report.confirmedForB6.push({ ref: component.ref, sectionId: component.sectionId, reason: reason[match.search?.undecidedBecause ?? 'no-family'] });
      }
      continue;
    }
    if (report.rematched.filter((r) => r.ref === component.ref).length >= MAX_CORRECTIVE_LOOPS) continue; // the cap: settled below as NEEDS_REVIEW
    viewportWidth ??= session.page.viewportSize()?.width ?? 1440;
    const answer = attachReference(decide(component, index, session.registry, viewportWidth, pageTypographyOf(state.components, component)), component, session.references);
    matches.set(component.ref, answer);
    touched.add(component.ref);
    report.rematched.push({ ref: component.ref, sectionId: component.sectionId, reason: `${verdict.reason} — B3 re-asked: ${answer.dsComponent ? `${answer.dsFile} (${answer.search?.basis})` : 'no existing family'}` });
    report.actions.push({ loop, stage: 'B3', ref: component.ref, sectionId: component.sectionId, outcome: 'resolved', reason: verdict.reason });

    // Whatever finding this element had is replaced by the stage the new answer routes it to.
    ({ matches, matched, unmatched, findings } = await rerouteComponent(session, { ...state, matches, matched, unmatched, findings }, component, answer, report, loop));
  }
  return { ...state, matches, matched, unmatched, findings };
}

/** A finding the pipeline could not settle: kept as it is measured, and marked for a human. A measured breach keeps its classification; a clean or unverified result becomes NEEDS_REVIEW. */
export function markNeedsReview(finding: Finding, reason: string, node: 'B5' | 'B7' = 'B5'): Finding {
  if (finding.review?.status === 'NEEDS_REVIEW') return finding;
  const classification = finding.classification === 'MATCH' || finding.classification === 'UNVERIFIED' ? 'NEEDS_REVIEW' : finding.classification;
  return {
    ...finding,
    classification,
    quality: {
      ...finding.quality,
      severity: classification === finding.classification ? finding.quality.severity : severityFor({ hasDsMatch: finding.component.dsComponent !== null, mismatches: finding.comparison.mismatches, ruleViolations: finding.comparison.ruleViolations, classification }),
      escalationStatus: 'QUEUED',
      escalationReasons: [...new Set([...finding.quality.escalationReasons, 'NEEDS_REVIEW' as const])],
    },
    history: { ...finding.history, currentStatus: classification },
    review: {
      status: 'NEEDS_REVIEW',
      reason: `${node} could not settle this within ${MAX_CORRECTIVE_LOOPS} corrective passes: ${reason}`,
      node,
      signals: finding.review?.signals ?? [],
      possibleMatches: finding.review?.possibleMatches ?? [],
      observed: finding.review?.observed ?? [],
    },
  };
}

/** The aria-path of an element — roles and names up to the root, the stand-in for a DOM path when the element can no longer be read. */
function ariaPathOf(el: AriaElement, byRef: Map<string, AriaElement>): string {
  const parts: string[] = [];
  for (let node: AriaElement | undefined = el; node; node = node.parentRef ? byRef.get(node.parentRef) : undefined) parts.unshift(`${node.role}${node.name ? `[${node.name.slice(0, 24)}]` : ''}`);
  return `aria:${parts.join(' > ')}`;
}

/**
 * An element B5 could not capture or resolve is not dropped: it becomes a NEEDS_REVIEW finding that
 * says exactly why, with the element's accessibility-tree line as its only evidence. (The same item
 * also stays in `coverage.droppedRefs` — the explicit, counted list of what could not be audited.)
 */
/** What a NEEDS_REVIEW finding for an element that could not be audited is built from — the accessibility-tree element B5 knew, or the manifest item B7 discovered. */
export interface UnresolvedSubject {
  /** The element's own words / accessible name — the label a reviewer recognises it by. */
  label: string;
  role: string;
  /** The accessibility-tree line (or a synthetic one for an item the tree never listed) — the finding's only evidence. */
  line: string;
  box?: { x: number; y: number; width: number; height: number } | undefined;
}

export function subjectOf(el: AriaElement, item: Pick<ReportedItem, 'type'>): UnresolvedSubject {
  return { label: el.name || /\]:\s*(.+)$/.exec(el.line)?.[1]?.trim() || `(unlabelled ${item.type ?? el.role})`, role: el.role, line: el.line, ...(el.box ? { box: el.box } : {}) };
}

export function unresolvedFinding(session: PageSession, section: Pick<SectionInfo, 'id' | 'name'> | undefined, subject: UnresolvedSubject, item: ReportedItem, findingId: string, node: 'B5' | 'B7' = 'B5'): Finding {
  const label = subject.label;
  const confidence = 0.3;
  const classification = 'NEEDS_REVIEW' as const;
  const reason = `${item.reason} — ${node} made ${MAX_CORRECTIVE_LOOPS} attempts and could not audit this element; it is marked for a human instead of being dropped`;
  const escalation = escalationFor({ findingId, confidence, needsReview: true, capturePartiallySettled: !session.capture.renderSettled.settled });
  return {
    identity: { auditId: session.auditId, runId: session.runId, findingId, timestamp: new Date().toISOString(), dsRegistryVersion: session.registry.version.dsRegistryVersion, policyVersion: policyVersionOf(session) },
    location: { url: session.url, pageId: session.pageId, pageName: session.capture.canonical.pageUrl, templateFamily: session.templateFamily, section: section?.name ?? item.sectionId, sectionId: item.sectionId, captureState: 'default+expanded-disclosures' },
    component: { productionType: item.type ?? 'unknown', productionLabel: label.length > 60 ? `${label.slice(0, 59)}…` : label, dsComponent: null, dsVariant: null, signature: `unresolved:${item.ref}` },
    classification,
    comparison: { mismatches: [], ruleViolations: [], properties: [], coverageNotes: [reason] },
    quality: {
      severity: severityFor({ hasDsMatch: false, mismatches: [], ruleViolations: [], classification }),
      confidence,
      confidenceBand: bandOf(confidence),
      escalationStatus: 'QUEUED',
      escalationReasons: escalation.reasons,
      evidence: [{ kind: 'aria-line', ref: subject.line, note: item.reason, ...(subject.box ? { box: subject.box } : {}) }],
      visualVerdict: 'NOT_CHECKED',
    },
    action: { recommendation: `This element could not be captured for audit (${item.reason}). Re-run the audit, or inspect it by hand.`, rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: classification, delta: null, previousRunId: null },
    review: { status: 'NEEDS_REVIEW', reason, node, signals: [`role=${subject.role}`, ...(item.type ? [`candidate shape: ${item.type}`] : [])], possibleMatches: [], observed: [] },
  };
}

/**
 * After the corrective passes (the cap is spent), whatever is STILL unresolved is finalized as NEEDS_REVIEW with
 * its reason — never retried, never dropped. Read-only apart from marking: no corrective action happens here.
 */
async function settleUnresolved(session: PageSession, state: B4Output, report: VerificationReport): Promise<B4Output> {
  let findings = [...state.findings];
  const byFindingId = new Map(state.components.map((c) => [c.findingId, c]));
  const findingOf = (ref: string): number => findings.findIndex((f) => byFindingId.get(f.identity.findingId)?.ref === ref);
  const mark = (item: ReportedItem) => {
    const i = findingOf(item.ref);
    if (i === -1) return;
    findings[i] = markNeedsReview(findings[i]!, item.reason);
    report.markedNeedsReview.push(item);
  };

  // (1) Property coverage that would not stabilise: the finding stands as measured, and is marked.
  for (const item of report.unresolvedRefs.filter((u) => u.kind === 'property')) mark(item);

  // (2) A family search still not shown to be right after the cap.
  if (state.matches.size > 0) {
    const index = await dsIndex(session.registry);
    for (const component of state.components) {
      const match = state.matches.get(component.ref);
      if (!match) continue;
      const verdict = verifyFamilySearch(component, match, index);
      if (!verdict.ok && !report.markedNeedsReview.some((m) => m.ref === component.ref)) mark({ ref: component.ref, sectionId: component.sectionId, reason: verdict.reason });
    }
  }

  // (3) Elements that could not be captured or resolved: one NEEDS_REVIEW finding each.
  const elementItems = [...report.captureFailures, ...report.unresolvedRefs.filter((u) => u.kind !== 'property')];
  if (elementItems.length > 0) {
    const byRef = new Map(state.ariaElements.map((e) => [e.ref, e]));
    const elements = elementItems.flatMap((item) => {
      const el = byRef.get(item.ref);
      return el ? [{ item, el }] : [];
    });
    // Synthetic fingerprints (an aria path — the DOM path is unreadable), de-duplicated among themselves.
    const fingerprints: ElementFingerprint[] = elements.map(({ el }) => ({ structuralPath: ariaPathOf(el, byRef), role: el.role, accessibleName: el.name, textPrefix: (/\]:\s*(.+)$/.exec(el.line)?.[1] ?? '').trim().slice(0, 64), box: el.box ?? { x: 0, y: 0, width: 0, height: 0 } }));
    const { ids } = assignElementFindingIds(session.pageId, fingerprints);
    for (const [i, { item, el }] of elements.entries()) {
      findings.push(unresolvedFinding(session, state.sections.find((s) => s.id === item.sectionId), subjectOf(el, item), item, ids[i]!));
      report.markedNeedsReview.push(item);
      report.needsReview.push({ ref: item.ref, sectionId: item.sectionId, reason: item.reason });
    }
  }
  return { ...state, findings };
}

/**
 * Runs the three coverage checks — element (→ B2), DS-matching (→ B3), property (→ B4) — and routes each
 * gap to the stage that owns it, in at most `MAX_CORRECTIVE_LOOPS` passes: pass 1 verifies everything; a
 * second pass runs only if the first corrected something, and then only over what it touched. A pass that
 * corrects nothing ends the loop (verified). Whatever is still unresolved after the cap is marked NEEDS_REVIEW
 * (`settleUnresolved`). Never an unbounded loop.
 */
export async function verifyCompleteness(session: PageSession, input: B4Output, ops: VerificationOps = {}): Promise<{ output: B4Output; report: VerificationReport }> {
  const decide = ops.decide ?? decideMatch;
  const report = emptyVerificationReport(input.sections.length);
  let state = input;
  let scope: ReadonlySet<string> | null = null;
  for (let pass = 1; pass <= MAX_CORRECTIVE_LOOPS; pass++) {
    report.passes = pass;
    const touched = new Set<string>();

    // 1. ELEMENT coverage → B2 (then B3 → B4 | B6 for what it recovers).
    const recovered = await recoverMissingComponents(session, state, report, { decide });
    for (const c of recovered.components) touched.add(c.ref);
    state = {
      ...state,
      components: [...state.components, ...recovered.components],
      matches: new Map([...state.matches, ...recovered.matches]),
      matched: [...state.matched, ...recovered.matched],
      findings: [...state.findings, ...recovered.findings],
    };

    // 2. DS-MATCHING coverage → B3 (then B4 | B6).
    state = await verifyMatchingCoverage(session, state, report, pass, scope, new Set(recovered.components.map((c) => c.ref)), touched, decide);

    // 3. PROPERTY coverage → B4.
    state = { ...state, findings: await recheckPropertyCompleteness(session, state, report, { scope, loop: pass, touched }) };

    if (touched.size === 0) break; // nothing needed correcting: verified
    scope = touched;
  }
  return { output: await settleUnresolved(session, state, report), report };
}

/**
 * The accounting invariant behind "nothing silently disappears": every candidate-shaped element a
 * section offers (a badge-shaped leaf, a repeated block) is a component, was DECIDED about by B2, or
 * was settled by B5 (excluded with its reason, or a reported failure). What this returns is whatever is
 * none of those — it must be empty once verification has run.
 */
export function unaccountedElements(input: B4Output, report: VerificationReport): AriaElement[] {
  const settled = alreadyAccountedFor(input);
  for (const item of [...report.excluded, ...report.captureFailures, ...report.unresolvedRefs]) settled.add(item.ref);
  const out: AriaElement[] = [];
  for (const section of input.sections) {
    if (section.personalized) continue;
    const elements = sectionElements(input.ariaElements, section).filter((e) => !settled.has(e.ref) && e.box && isVisiblySized(e.box));
    const { candidates } = selectCandidates(elements, { viewportWidth: 1440, allElements: input.ariaElements });
    for (const el of [...candidates, ...repeatedBlockCandidates(elements).flat()]) if (!out.some((o) => o.ref === el.ref)) out.push(el);
  }
  return out;
}

export { repeatedBlockCandidates, alreadyAccountedFor };
