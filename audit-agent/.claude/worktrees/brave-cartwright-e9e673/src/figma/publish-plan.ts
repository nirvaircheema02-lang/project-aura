import type { AuditData } from '../agents/c2-json-writer/index.ts';
import { findingStatus, isNotCompared, isPriorIssueUnverified, reAuditLabel, statusLabel, type Classification, type Finding, type Severity } from '../skills/s0-result-contract.ts';
import { describeRenderingEngine } from '../graph/run-metadata.ts';

/**
 * C3's deterministic publish plan — the complete description of what the
 * Figma file should contain for a run, computed from C2's audit data alone
 * (Decision Log #19). Nothing here talks to Figma; it is pure data, which is
 * what makes repeated publishes converge on the same structure and what makes
 * the whole layout testable without credentials.
 *
 * Pages are v1.0 §16's set plus `07 Re-Audit History` (ARCHITECTURE.md §6)
 * and `08 Needs Review` (Decision Log #31) — what no deterministic decision
 * could settle, so Figma never silently drops it.
 */

export const FIGMA_PAGES = [
  '00 Overview',
  '01 Template Summary',
  '02 Global Issues',
  '03 Page Audits',
  '04 Component Audit',
  '05 New Components',
  '06 DS Candidates',
  '07 Re-Audit History',
  '08 Needs Review',
] as const;

export type FigmaPageName = (typeof FIGMA_PAGES)[number];

export interface SummaryTile {
  label: string;
  value: string;
}

export interface IssueMarker {
  /** 1-based number shown on the screenshot and on the matching issue card. */
  number: number;
  findingId: string;
  /** Page-absolute element geometry from B2's measurement (never a model's guess). */
  box: { x: number; y: number; width: number; height: number };
  severity: string;
}

export interface IssueCard {
  number: number;
  findingId: string;
  title: string;
  status: string;
  severity: string;
  confidence: string;
  actualVsExpected: string;
  recommendation: string;
  reviewState: string;
}

export interface PageAuditFrame {
  key: string;
  url: string;
  title: string;
  complianceLabel: string;
  /** Screenshot tiles for the page. Delivery is BLOCKED — see imageDelivery below. */
  screenshots: string[];
  markers: IssueMarker[];
  cards: IssueCard[];
  /**
   * The approved interactive-marker system (Decision Log #32): a curated, deduplicated set of
   * markers — one per root cause when an issue repeats, one per genuinely unique finding
   * otherwise — instead of `markers` above's one-per-finding list. This is what a live Figma
   * publish (via an authenticated Figma-MCP session — see docs/FIGMA-PUBLISH-RUNBOOK.md) should
   * actually build: Default/Hover interactive components, never a flat marker-per-finding dump.
   */
  markerGroups: MarkerGroup[];
  /** True when more distinct root-cause/unique groups existed than `maxMarkers` allowed — never a silent cap. */
  markerGroupsTruncated: boolean;
  /** Total distinct root-cause/unique groups found BEFORE the `maxMarkers` cap — lets the Legend's capture note say "top 12 of N" instead of just "capped at 12". Equal to `markerGroups.length` when `markerGroupsTruncated` is false. */
  markerGroupsTotal: number;
}

/** The four statuses a page-audit marker may carry — never MATCH (v1.0 §16), color is status-only. */
export type MarkerColor = 'RED' | 'ORANGE' | 'AMBER' | 'GRAY';

/** Red=INCORRECT, Orange=DEVIATION, Amber=NEEDS_REVIEW, Gray=UNVERIFIED — never used for severity, never for MATCH. */
export function colorForMarkerStatus(status: Classification): MarkerColor | null {
  switch (status) {
    case 'INCORRECT':
      return 'RED';
    case 'DEVIATION':
      return 'ORANGE';
    case 'NEEDS_REVIEW':
      return 'AMBER';
    case 'UNVERIFIED':
      return 'GRAY';
    default:
      return null; // MATCH, NEW_COMPONENT, DS_CANDIDATE — never a page-audit marker
  }
}

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * A label/section string is safe to show verbatim in a compact UI slot only if it actually reads
 * as a short label, not raw extracted page text — the exact failure mode this guards against:
 * `component.productionLabel` and `location.section` are both DOM-extracted, and can come back as
 * a whole run-on sentence or several concatenated headings (e.g. a `productionLabel` of
 * `"01Employee EngagementWant to know what drives your people?"`, seen on a real audit). Never
 * hand-invents a replacement — callers fall back to a clean, always-available field instead
 * (`productionType`, a category, etc.) when this returns false.
 */
function isCleanLabel(s: string | null | undefined, maxLen: number): s is string {
  if (!s) return false;
  const trimmed = s.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return false;
  if (/[.!?]$/.test(trimmed)) return false; // ends like a sentence, not a label
  if (/[()]/.test(trimmed)) return false; // placeholder-style system text, e.g. "(unlabelled icon-button generic)" — not real production copy
  return true;
}

/** Hard length cap with a single trailing ellipsis — cuts at the last word boundary within the limit when one exists close enough (never mid-word if a clean break is available), otherwise a plain hard cut. Never invents replacement text, just cuts. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const safe = lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${safe.trimEnd()}…`;
}

/** 'NEEDS_REVIEW' → 'Needs Review'. Used wherever a status must read as a short display label (legend/marker text), distinct from `statusLabel`'s ALL-CAPS wording (s0-result-contract.ts) used elsewhere. */
export function statusTitleCase(status: string): string {
  return status
    .split('_')
    .map((w) => titleCase(w))
    .join(' ');
}

/**
 * The four classifications a page-audit marker may represent (Decision Log #32, widened): every
 * non-neutral, non-MATCH classification gets a colored marker via `colorForMarkerStatus` — MATCH
 * is compliant and NEW_COMPONENT/DS_CANDIDATE have their own pages, so none of the three ever
 * becomes a page-audit marker.
 */
export const MARKER_ELIGIBLE_CLASSIFICATIONS: Classification[] = ['INCORRECT', 'DEVIATION', 'NEEDS_REVIEW', 'UNVERIFIED'];

function isMarkerEligible(c: Classification): c is MarkerGroup['status'] {
  return (MARKER_ELIGIBLE_CLASSIFICATIONS as string[]).includes(c);
}

export interface MarkerGroup {
  /** 1-based, assigned in top-to-bottom reading order of the representative's measured box. Resolve identity by findingId, not by number alone — numbers can shift if the curated set changes across a re-audit. */
  number: number;
  findingId: string;
  status: 'INCORRECT' | 'DEVIATION' | 'NEEDS_REVIEW' | 'UNVERIFIED';
  color: MarkerColor;
  severityText: string;
  shortName: string;
  explanation: string;
  /** 2–5 actual → expected lines — never more, never invented; drawn from the finding's own mismatches/rule violations. */
  bullets: string[];
  dsLine: string;
  isRootCause: boolean;
  /** How many findings this one marker stands in for (≥1). 1 means a genuinely unique, single-instance issue. */
  affectedCount: number;
  affectedFindingIds: string[];
  box: { x: number; y: number; width: number; height: number };
  /** Where the annotation card should sit relative to the marker — computed from the frame width, never hand-picked per page. */
  placement: 'left' | 'right' | 'below';
  /** The same element-screenshot evidence the marker's own box came from — the Component Findings/Global Components card's thumbnail image. Null only if the finding genuinely has none (shouldn't happen for a marker-eligible finding, which requires a box). */
  evidenceRef: string | null;
  confidence: number;
  confidenceBand: string;
  recommendation: string;
  section: string;
  /** Total actual→expected/observed lines BEFORE the 5-item cap on `bullets` — lets a card say "(N properties total)" instead of silently hiding the true count. */
  propertiesTotal: number;
  /** The finding's raw component type (e.g. `button`, `nav-link`) — same value `shortName`/`dsLine` already read from, exposed directly so the Legend's richer per-finding treatment never has to re-derive it by parsing `shortName`. */
  productionType: string;
  /**
   * A short, generated (never hand-typed) issue title for the Legend's colored primary line —
   * the "richer Market Entry treatment" (Decision Log #33): `"{Category} mismatch"` for a
   * finding with a specific named rule violation (category via `categorizeIssue`, the SAME
   * function already used for Root Cause card pills), `"{Component} property drift"` for a
   * multi-property drift with no single named rule, or a cleaned production-label-based title for
   * NEEDS_REVIEW/UNVERIFIED findings. Never the raw, sometimes-garbled `component.productionLabel`
   * verbatim — see `isCleanLabel`.
   */
  legendTitle: string;
  /**
   * A short, generated (never hand-typed) neutral secondary line for the Legend — up to three
   * `" · "`-joined parts: a clean context (`{section} {productionType}`, falling back to just
   * `{productionType}` when the section reads as a full sentence rather than a label — see
   * `isCleanLabel`), a truncated actual→expected/reason snippet, and `"root cause, N elements"` /
   * `"unique, N elements"` (mirrors `isRootCause`/`affectedCount` exactly, matching the reference
   * file's own wording). Never the raw, unbounded `explanation`/`bullets` text.
   */
  legendSecondary: string;
}

export interface MarkerGroupOptions {
  /** The capture viewport width markers/cards are placed against. Default 1440 (B1's standard capture width). */
  frameWidthPx?: number;
  /** A group needs at least this many member findings to become one "root cause" marker instead of one marker per member. Default 2. */
  minRepeatCount?: number;
  /** Hard cap on markers per page so a very non-compliant page never floods the frame. Default 12. */
  maxMarkers?: number;
  cardWidthPx?: number;
  cardGapPx?: number;
}

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

function markerCandidateBox(f: Finding): { x: number; y: number; width: number; height: number } | null {
  return f.quality.evidence.find((e) => e.kind === 'element-screenshot' && e.box)?.box ?? null;
}

/** The one line naming the DS component/rule this marker's card cites. */
function dsLineFor(f: Finding, ruleIds: string[]): string {
  const subject = f.component.dsComponent ? `${f.component.dsComponent}${f.component.dsVariant ? ` · ${f.component.dsVariant}` : ''}` : '(no DS match — one-off)';
  const isUndecided = f.classification === 'NEEDS_REVIEW' || f.classification === 'UNVERIFIED';
  const qualifier = isUndecided ? statusTitleCase(f.classification).toLowerCase() : ruleIds.length > 0 ? ruleIds.join(', ') : 'property drift';
  return `${subject} · ${qualifier}`;
}

/** One "actual → expected" line for a NEEDS_REVIEW/UNVERIFIED finding's `review.observed` entry — no expectation existed to compare against for some of these, so that case reads plainly rather than as a bare arrow to nothing. */
function formatObservedLine(o: { property: string; actual: string; expected: string | null; expectedToken: string | null }): string {
  if (o.expected === null) return `${o.property}: ${o.actual} (no expectation to compare)`;
  const token = o.expectedToken ? ` (${o.expectedToken})` : '';
  return `${o.property}: ${o.actual} → ${o.expected}${token}`;
}

function placementFor(box: { x: number; width: number }, opts: Required<Pick<MarkerGroupOptions, 'frameWidthPx' | 'cardWidthPx' | 'cardGapPx'>>): 'left' | 'right' | 'below' {
  if (box.x + opts.cardGapPx + opts.cardWidthPx <= opts.frameWidthPx) return 'right';
  if (box.x - opts.cardGapPx - opts.cardWidthPx >= 0) return 'left';
  return 'below';
}

/**
 * The deduplicated, root-cause-aware marker set for one page's findings (Decision Log #32).
 * Pure and deterministic over C2's own findings — never a fresh calculation, never a guess at
 * which finding "represents" a pattern: representatives are chosen by measured severity and
 * findings-array order, both already in C2.
 *
 * Grouping: every INCORRECT/DEVIATION finding with a measured element box joins one group per
 * rule it violates (keyed by ruleId), or — when it violates no rule — one group keyed by its
 * sorted mismatch property signature (a property-drift group). Groups are resolved largest
 * first: a group at or above `minRepeatCount` members becomes ONE root-cause marker (claiming
 * every member so it never also gets its own individual marker); a group of exactly one
 * becomes that finding's own individual marker, unless something bigger already claimed it.
 */
const MAX_LEGEND_LABEL_LEN = 40;
const MAX_LEGEND_SECTION_LEN = 30;
const MAX_LEGEND_DIFF_LEN = 60;

export function buildMarkerGroups(findings: Finding[], opts: MarkerGroupOptions = {}): { groups: MarkerGroup[]; truncated: boolean; total: number } {
  const frameWidthPx = opts.frameWidthPx ?? 1440;
  const minRepeatCount = opts.minRepeatCount ?? 2;
  const maxMarkers = opts.maxMarkers ?? 12;
  const cardWidthPx = opts.cardWidthPx ?? 300;
  const cardGapPx = opts.cardGapPx ?? 12;

  const candidates = findings.filter((f) => MARKER_ELIGIBLE_CLASSIFICATIONS.includes(f.classification) && markerCandidateBox(f) !== null);

  const groupsByKey = new Map<string, { ruleId: string | null; members: Finding[] }>();
  for (const f of candidates) {
    if (f.classification === 'NEEDS_REVIEW' || f.classification === 'UNVERIFIED') {
      // Not a rule/property defect — "couldn't be decided". Group by classification + the
      // reason a human would see (never merged with an unrelated undecidable finding just
      // because both left comparison.ruleViolations/mismatches empty).
      const key = `review:${f.classification}:${f.review?.reason ?? f.component.productionType}`;
      if (!groupsByKey.has(key)) groupsByKey.set(key, { ruleId: null, members: [] });
      groupsByKey.get(key)!.members.push(f);
    } else if (f.comparison.ruleViolations.length > 0) {
      for (const rv of f.comparison.ruleViolations) {
        const key = `rule:${rv.ruleId}`;
        if (!groupsByKey.has(key)) groupsByKey.set(key, { ruleId: rv.ruleId, members: [] });
        groupsByKey.get(key)!.members.push(f);
      }
    } else {
      const key = `props:${[...f.comparison.mismatches.map((m) => m.property)].sort().join(',')}`;
      if (!groupsByKey.has(key)) groupsByKey.set(key, { ruleId: null, members: [] });
      groupsByKey.get(key)!.members.push(f);
    }
  }

  const orderedKeys = [...groupsByKey.entries()].sort((a, b) => b[1].members.length - a[1].members.length || a[0].localeCompare(b[0]));

  const claimed = new Set<string>();
  const selected: Array<{ finding: Finding; ruleId: string | null; isRootCause: boolean; affectedCount: number; affectedFindingIds: string[] }> = [];

  for (const [, group] of orderedKeys) {
    const affectedFindingIds = [...new Set(group.members.map((m) => m.identity.findingId))];
    const unclaimedMembers = group.members.filter((m) => !claimed.has(m.identity.findingId));
    if (unclaimedMembers.length === 0) continue; // every member already represented by a bigger group

    if (affectedFindingIds.length >= minRepeatCount) {
      // Root cause: pick the richest available representative (present box, highest severity, then original order).
      const representative = [...unclaimedMembers].sort((a, b) => SEVERITY_RANK[b.quality.severity] - SEVERITY_RANK[a.quality.severity])[0]!;
      for (const m of group.members) claimed.add(m.identity.findingId); // the WHOLE group is now represented — never double-counted elsewhere
      selected.push({ finding: representative, ruleId: group.ruleId, isRootCause: true, affectedCount: affectedFindingIds.length, affectedFindingIds });
    } else if (affectedFindingIds.length === 1) {
      const finding = unclaimedMembers[0]!;
      claimed.add(finding.identity.findingId);
      selected.push({ finding, ruleId: group.ruleId, isRootCause: false, affectedCount: 1, affectedFindingIds });
    }
    // A group with 2+ members below minRepeatCount can't happen (minRepeatCount defaults to 2, i.e. exactly the boundary) —
    // left unhandled deliberately rather than silently merged into "root cause" or "unique".
  }

  const truncated = selected.length > maxMarkers;
  const capped = [...selected].sort((a, b) => (b.affectedCount - a.affectedCount) || (SEVERITY_RANK[b.finding.quality.severity] - SEVERITY_RANK[a.finding.quality.severity])).slice(0, maxMarkers);

  const numbered = capped
    .map((s) => ({ ...s, box: markerCandidateBox(s.finding)! }))
    .sort((a, b) => a.box.y - b.box.y)
    .map((s, i) => {
      const color = colorForMarkerStatus(s.finding.classification);
      if (!color || !isMarkerEligible(s.finding.classification)) {
        throw new Error(`buildMarkerGroups: candidate filter should only ever admit ${MARKER_ELIGIBLE_CLASSIFICATIONS.join('/')}, got ${s.finding.classification}`);
      }
      const status = s.finding.classification; // narrowed by isMarkerEligible above
      const isUndecided = status === 'NEEDS_REVIEW' || status === 'UNVERIFIED';
      const ruleIds = s.finding.comparison.ruleViolations.map((rv) => rv.ruleId);
      const primaryRule = s.ruleId ? s.finding.comparison.ruleViolations.find((rv) => rv.ruleId === s.ruleId) : undefined;
      // Never embed the status word in shortName — formatLegendLine (publish-ops.ts) always
      // appends "— <StatusTitleCase>" itself; doing it here too produced a literal
      // "link — Needs Review — Needs Review" on the very first real run this was checked
      // against (market-entry-real-1's backfilled figma-ops.json).
      const shortName = isUndecided
        ? s.finding.component.productionLabel
          ? `${s.finding.component.productionType} "${s.finding.component.productionLabel}"`
          : s.finding.component.productionType
        : `${s.finding.component.productionType} — ${primaryRule?.title ?? (ruleIds.length > 0 ? s.finding.comparison.ruleViolations[0]!.title : 'Property drift')}`;
      const explanationBase = isUndecided
        ? (s.finding.review?.reason ?? 'Could not be decided without semantic judgment — queued for human review.')
        : (primaryRule?.why ?? s.finding.comparison.ruleViolations[0]?.why ?? `Non-foundation drift in ${s.finding.comparison.mismatches.map((m) => m.property).join(', ')}.`);
      const explanation = s.isRootCause
        ? `Root cause · ${explanationBase} Affects ${s.affectedCount} element${s.affectedCount === 1 ? '' : 's'}.`
        : `Unique · ${explanationBase} Single instance, not part of a repeated pattern.`;
      const bullets = isUndecided
        ? (s.finding.review?.observed ?? []).slice(0, 5).map(formatObservedLine)
        : s.finding.comparison.mismatches.length > 0
          ? s.finding.comparison.mismatches.slice(0, 5).map((m) => `${m.property}: ${m.actual} → ${m.expected}${m.expectedToken ? ` (${m.expectedToken})` : ''}`)
          : s.finding.comparison.ruleViolations.slice(0, 5).map((rv) => `${rv.ruleId}: ${rv.why}`);
      const propertiesTotal = isUndecided ? (s.finding.review?.observed ?? []).length : s.finding.comparison.mismatches.length > 0 ? s.finding.comparison.mismatches.length : s.finding.comparison.ruleViolations.length;
      const productionType = s.finding.component.productionType;

      // Legend primary-line title (Decision Log #33, "richer Market Entry treatment"): a short,
      // generated issue name — never the raw shortName (which repeats the component type the
      // secondary line already states) and never a raw productionLabel that might read as
      // "01Employee EngagementWant to know what drives your people?" (a real extracted label).
      const legendTitle = isUndecided
        ? isCleanLabel(s.finding.component.productionLabel, MAX_LEGEND_LABEL_LEN)
          ? `${s.finding.component.productionLabel} ${productionType}`
          : titleCase(productionType)
        : primaryRule
          ? `${categorizeIssue(primaryRule.title, [productionType]).split('/')[0]} mismatch`
          : ruleIds.length > 0
            ? `${categorizeIssue(s.finding.comparison.ruleViolations[0]!.title, [productionType]).split('/')[0]} mismatch`
            : `${titleCase(productionType)} property drift`;

      // Legend secondary line: up to three concise, generated parts — context, a short
      // actual→expected/reason snippet, and the same "root cause, N elements" / "unique, N
      // elements" wording the reference file uses (mirrors isRootCause/affectedCount exactly).
      const sectionClean = isCleanLabel(s.finding.location.section, MAX_LEGEND_SECTION_LEN) ? s.finding.location.section : null;
      const contextPart = sectionClean ? `${sectionClean} ${productionType}` : titleCase(productionType);
      const diffPart = isUndecided ? truncate(explanationBase, MAX_LEGEND_DIFF_LEN) : bullets.length > 0 ? truncate(bullets[0]!.replace(/\s*\(--[a-z0-9-]+\)\s*$/i, ''), MAX_LEGEND_DIFF_LEN) : null;
      const countPart = `${s.isRootCause ? 'root cause' : 'unique'}, ${s.affectedCount} element${s.affectedCount === 1 ? '' : 's'}`;
      const legendSecondary = [contextPart, diffPart, countPart].filter((p): p is string => Boolean(p)).join(' · ');

      const g: MarkerGroup = {
        number: i + 1,
        findingId: s.finding.identity.findingId,
        status,
        color,
        severityText: titleCase(s.finding.quality.severity),
        shortName,
        explanation,
        bullets,
        dsLine: dsLineFor(s.finding, ruleIds),
        isRootCause: s.isRootCause,
        affectedCount: s.affectedCount,
        affectedFindingIds: s.affectedFindingIds,
        box: s.box,
        placement: placementFor(s.box, { frameWidthPx, cardWidthPx, cardGapPx }),
        evidenceRef: s.finding.quality.evidence.find((e) => e.kind === 'element-screenshot' && e.box)?.ref ?? null,
        confidence: s.finding.quality.confidence,
        confidenceBand: s.finding.quality.confidenceBand,
        recommendation: s.finding.action.recommendation,
        section: s.finding.location.section,
        propertiesTotal,
        productionType,
        legendTitle,
        legendSecondary,
      };
      return g;
    });

  return { groups: numbered, truncated, total: selected.length };
}

export interface GlobalComponentRepresentative {
  findingId: string;
  productionType: string;
  status: 'INCORRECT' | 'DEVIATION' | 'NEEDS_REVIEW' | 'UNVERIFIED';
  /** The reference file's 2-tone card scheme (RED=Incorrect, AMBER=everything else) — see `cardStatusColor`. */
  color: 'RED' | 'AMBER';
  note: string;
  /** The element-screenshot evidence for this representative's card thumbnail — same convention as MarkerGroup.evidenceRef. */
  evidenceRef: string | null;
}

export interface GlobalComponentGroup {
  /** The section name matched (e.g. 'Header'), exactly as B1 recorded it. */
  sectionName: string;
  /** Every INCORRECT/DEVIATION finding in this section, before capping to representatives. */
  totalFindings: number;
  representatives: GlobalComponentRepresentative[];
}

const DEFAULT_GLOBAL_SECTION_NAMES = ['header', 'navbar', 'nav', 'footer'];

/**
 * Findings from sections that render on every page of a site (Header/Navbar, Footer) —
 * generalizes the manual Header/Footer curation done for market-entry-real-1's "Global
 * Components" Figma page (Decision Log #32) into a reusable selection, keyed off
 * `location.section` (whatever B1 already named it — no new classification, no guessing).
 */
export function selectGlobalComponents(findings: Finding[], opts: { sectionNames?: string[]; maxPerSection?: number } = {}): GlobalComponentGroup[] {
  const wanted = (opts.sectionNames ?? DEFAULT_GLOBAL_SECTION_NAMES).map((s) => s.toLowerCase());
  const maxPerSection = opts.maxPerSection ?? 3;

  const bySection = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!isMarkerEligible(f.classification)) continue;
    if (!f.quality.evidence.some((e) => e.kind === 'element-screenshot')) continue;
    const section = f.location.section;
    if (!wanted.some((w) => section.toLowerCase().includes(w))) continue;
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push(f);
  }

  return [...bySection.entries()].map(([sectionName, members]) => {
    const sorted = [...members].sort((a, b) => {
      if (a.classification !== b.classification) return a.classification === 'INCORRECT' ? -1 : 1;
      return SEVERITY_RANK[b.quality.severity] - SEVERITY_RANK[a.quality.severity];
    });
    const representatives = sorted.slice(0, maxPerSection).map((f) => {
      if (!isMarkerEligible(f.classification)) {
        throw new Error(`selectGlobalComponents: candidate filter should only admit ${MARKER_ELIGIBLE_CLASSIFICATIONS.join('/')}, got ${f.classification}`);
      }
      const status = f.classification;
      const isUndecided = status === 'NEEDS_REVIEW' || status === 'UNVERIFIED';
      const note = isUndecided
        ? (f.review?.reason ?? 'Could not be decided without semantic judgment.')
        : (f.comparison.ruleViolations[0]?.why ?? (f.comparison.mismatches.length > 0 ? `${f.comparison.mismatches.length} propert${f.comparison.mismatches.length === 1 ? 'y' : 'ies'} drift from the Design System` : f.action.recommendation));
      const evidenceRef = f.quality.evidence.find((e) => e.kind === 'element-screenshot')?.ref ?? null;
      const rep: GlobalComponentRepresentative = { findingId: f.identity.findingId, productionType: f.component.productionType, status, color: cardStatusColor(status), note, evidenceRef };
      return rep;
    });
    return { sectionName, totalFindings: members.length, representatives };
  });
}

/** RED for a confirmed defect, AMBER for everything else marker-eligible — the 2-tone scheme actually used by the approved reference file (market-entry-real-1) on its Component Findings / Needs Review / Global Components card status pills. Deliberately NOT the same 4-tone scale as `colorForMarkerStatus` (the Page Audit page's spatial markers use that one) — two different, both-approved conventions for two different presentations. */
export function cardStatusColor(status: 'INCORRECT' | 'DEVIATION' | 'NEEDS_REVIEW' | 'UNVERIFIED'): 'RED' | 'AMBER' {
  return status === 'INCORRECT' ? 'RED' : 'AMBER';
}

/** RED/AMBER/GRAY by severity — the Root Causes page's card category-pill color in the reference file (HIGH+ → RED, MEDIUM → AMBER, LOW/INFO → GRAY), distinct from `cardStatusColor` (status-based) and `colorForMarkerStatus` (also status-based). */
export function severityCardColor(severity: Severity): 'RED' | 'AMBER' | 'GRAY' {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'RED';
  if (severity === 'MEDIUM') return 'AMBER';
  return 'GRAY';
}

const CATEGORY_BY_PRODUCTION_TYPE: Record<string, string> = {
  button: 'Buttons',
  'icon-button': 'Buttons',
  input: 'Forms/Inputs',
  select: 'Forms/Inputs',
  textarea: 'Forms/Inputs',
  link: 'Links',
  'nav-link': 'Navigation',
  card: 'Cards',
  'section-heading': 'Typography',
  eyebrow: 'Typography',
};

/**
 * A presentational bucket for a Root Cause card's category pill — never a new compliance
 * classification, purely a readability grouping (matches the reference file's "Typography" /
 * "Radius/Shape" / "Buttons" / "Forms/Inputs" pills). Rule violations are categorized by their
 * own title/id text (a rule's subject is usually explicit — "Two-Font Pairing", "Border Radius
 * Decision Table"); property-drift groups (no rule, just a foundation-adjacent mismatch) fall
 * back to the affected component type's own category.
 */
export function categorizeIssue(ruleTitleOrId: string | null, productionTypes: string[]): string {
  const text = (ruleTitleOrId ?? '').toLowerCase();
  if (/font|typeface|typography|type.?scale|letter.?spacing|line.?height|heading/.test(text)) return 'Typography';
  if (/radius|corner|shape/.test(text)) return 'Radius/Shape';
  if (/color|background/.test(text)) return 'Color';
  if (/padding|margin|spacing|gap/.test(text)) return 'Spacing';
  if (/shadow|elevation/.test(text)) return 'Elevation';
  const primaryType = productionTypes[0];
  if (primaryType && CATEGORY_BY_PRODUCTION_TYPE[primaryType]) return CATEGORY_BY_PRODUCTION_TYPE[primaryType]!;
  return primaryType ? `${titleCase(primaryType)}s` : 'Component';
}

export interface RootCauseCard {
  title: string;
  category: string;
  severity: Severity;
  severityColor: 'RED' | 'AMBER' | 'GRAY';
  occurrences: number;
  affectedTypes: string[];
  explanation: string;
  expected: string;
  ruleId: string | null;
}

/**
 * Page-wide root-cause dedup for the "02 Root Causes" card page — same grouping principle as
 * `buildMarkerGroups` (dedup by rule id, or by mismatch-property signature when there's no rule),
 * but page-wide (not marker-eligible/box-gated) and uncapped (every distinct group gets a card,
 * matching the reference file's card count — this is a presentation page, not a spatial one).
 */
export function buildRootCauseCards(findings: Finding[]): RootCauseCard[] {
  const candidates = findings.filter((f) => f.classification === 'INCORRECT' || f.classification === 'DEVIATION');

  const groupsByKey = new Map<string, { ruleId: string | null; members: Finding[] }>();
  for (const f of candidates) {
    if (f.comparison.ruleViolations.length > 0) {
      for (const rv of f.comparison.ruleViolations) {
        const key = `rule:${rv.ruleId}`;
        if (!groupsByKey.has(key)) groupsByKey.set(key, { ruleId: rv.ruleId, members: [] });
        groupsByKey.get(key)!.members.push(f);
      }
    } else {
      const key = `props:${[...f.comparison.mismatches.map((m) => m.property)].sort().join(',')}`;
      if (!groupsByKey.has(key)) groupsByKey.set(key, { ruleId: null, members: [] });
      groupsByKey.get(key)!.members.push(f);
    }
  }

  const orderedKeys = [...groupsByKey.entries()].sort((a, b) => b[1].members.length - a[1].members.length || a[0].localeCompare(b[0]));
  const claimed = new Set<string>();
  const cards: RootCauseCard[] = [];

  for (const [, group] of orderedKeys) {
    const unclaimed = group.members.filter((m) => !claimed.has(m.identity.findingId));
    if (unclaimed.length === 0) continue;
    for (const m of group.members) claimed.add(m.identity.findingId);

    const representative = [...unclaimed].sort((a, b) => SEVERITY_RANK[b.quality.severity] - SEVERITY_RANK[a.quality.severity])[0]!;
    const ruleViolation = group.ruleId ? representative.comparison.ruleViolations.find((rv) => rv.ruleId === group.ruleId) : undefined;
    const affectedTypes = [...new Set(group.members.map((m) => m.component.productionType))].sort();
    const title = group.ruleId ? `${representative.component.dsComponent ?? representative.component.productionType}: ${ruleViolation?.title ?? group.ruleId}` : `${affectedTypes.join('/')}: property drift`;
    const explanation = ruleViolation?.why ?? `Non-foundation drift in ${representative.comparison.mismatches.map((m) => m.property).join(', ')}.`;
    const expected = ruleViolation
      ? representative.comparison.mismatches.find((m) => m.expectedToken)?.expectedToken ?? representative.comparison.mismatches[0]?.expected ?? '—'
      : representative.comparison.mismatches.map((m) => `${m.expectedToken ?? m.expected}`).join(', ') || '—';

    cards.push({
      title,
      category: categorizeIssue(ruleViolation?.title ?? group.ruleId, affectedTypes),
      severity: representative.quality.severity,
      severityColor: severityCardColor(representative.quality.severity),
      occurrences: group.members.length,
      affectedTypes,
      explanation,
      expected,
      ruleId: group.ruleId,
    });
  }

  return cards.sort((a, b) => b.occurrences - a.occurrences);
}

export interface NeedsReviewCard {
  findingId: string;
  productionType: string;
  productionLabel: string | null;
  status: 'NEEDS_REVIEW' | 'UNVERIFIED';
  confidence: number;
  confidenceBand: string;
  section: string;
  reason: string;
  possibleMatches: string[];
  evidenceRef: string | null;
}

/**
 * A curated, representative sample of NEEDS_REVIEW/UNVERIFIED findings for the "04 Needs Review"
 * card page — matches the reference file's own curation principle exactly ("8 of 30... chosen for
 * diversity of component type"): never dump every one of potentially dozens, pick for spread
 * across component types, and always report the true total so nothing is silently hidden.
 */
export function buildNeedsReviewCards(findings: Array<Finding & { classification: 'NEEDS_REVIEW' | 'UNVERIFIED' }> | Finding[], opts: { max?: number } = {}): { cards: NeedsReviewCard[]; total: number } {
  const eligible = (findings as Finding[]).filter((f) => (f.classification === 'NEEDS_REVIEW' || f.classification === 'UNVERIFIED') && f.quality.evidence.some((e) => e.kind === 'element-screenshot'));
  const max = opts.max ?? 8;

  // Diversity-first selection: walk productionType buckets round-robin so a page dominated by
  // one repeated component (e.g. 40 near-identical buttons) doesn't crowd out every other type.
  const byType = new Map<string, Finding[]>();
  for (const f of eligible) {
    const key = f.component.productionType;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(f);
  }
  const buckets = [...byType.values()].map((list) => [...list].sort((a, b) => b.quality.confidence - a.quality.confidence));
  const selected: Finding[] = [];
  let round = 0;
  while (selected.length < max && buckets.some((b) => round < b.length)) {
    for (const b of buckets) {
      if (selected.length >= max) break;
      if (round < b.length) selected.push(b[round]!);
    }
    round++;
  }

  const cards: NeedsReviewCard[] = selected.map((f) => ({
    findingId: f.identity.findingId,
    productionType: f.component.productionType,
    productionLabel: f.component.productionLabel || null,
    status: f.classification as 'NEEDS_REVIEW' | 'UNVERIFIED',
    confidence: f.quality.confidence,
    confidenceBand: f.quality.confidenceBand,
    section: f.location.section,
    reason: f.review?.reason ?? f.action.recommendation,
    possibleMatches: (f.review?.possibleMatches ?? []).map((m) => `${m.dsComponent}${m.dsVariant ? ` (${m.dsVariant})` : ''} — score ${m.score.toFixed(2)}`),
    evidenceRef: f.quality.evidence.find((e) => e.kind === 'element-screenshot')?.ref ?? null,
  }));

  return { cards, total: eligible.length };
}

export interface PublishPlan {
  contractVersion: string;
  runId: string;
  targetUrl: string;
  dsRegistryVersion: string;
  /** From C2's run.renderingPolicy — the exact browser build the evidence was captured with. */
  renderingEngine: string;
  /** From C2's run.aiMode — which strategy produced the findings. */
  aiMode: string;
  pages: Record<FigmaPageName, { tiles: SummaryTile[]; rows: string[][]; headers: string[] }> & Record<string, unknown>;
  pageAudits: PageAuditFrame[];
  /** "02 Root Causes" page content — page-wide rule/property dedup, card presentation (not the flat `pages['02 Global Issues']` table rows). */
  rootCauseCards: RootCauseCard[];
  /** "04 Needs Review" page content — curated, diversity-sampled, with the true total. */
  needsReviewCards: { cards: NeedsReviewCard[]; total: number };
  /** Header/Navbar and Footer findings — generalized from the manual "Global Components" curation (Decision Log #32). */
  globalComponents: GlobalComponentGroup[];
  /**
   * Explicitly records that screenshot delivery is deferred, and exactly which
   * assets WOULD be uploaded once the upload spike is resolved
   * (IMPLEMENTATION-PLAN.md §6 — confirmed unresolved, so C3 publishes
   * placeholders with a visible note rather than pretending images shipped).
   */
  imageDelivery: { status: 'deferred-unresolved-spike'; wouldUpload: string[]; note: string };
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${value}%`;
}

function issueTitle(f: Finding): string {
  const subject = f.component.dsComponent ?? f.component.productionType;
  // A resolved record has no live mismatches; its recommendation says what WAS wrong.
  if (f.history.absentThisRun) return `${subject} — ${f.action.recommendation}`;
  const defect = f.comparison.ruleViolations[0]?.ruleId || f.comparison.mismatches.map((m) => m.property).join(', ') || (isNotCompared(f) ? 'not compared' : f.classification);
  return `${subject} — ${defect}`;
}

/** The run-level baseline change in one tile value — the notes themselves ride on each finding's Delta. */
function baselineSummary(changes: Array<{ note: string; findings: number }>): string {
  if (changes.length === 0) return 'no';
  const touched = changes.reduce((n, c) => Math.max(n, c.findings), 0);
  return `yes — ${changes.length} change(s), up to ${touched} finding(s)`;
}

function actualVsExpected(f: Finding): string {
  if (f.comparison.mismatches.length > 0) {
    return f.comparison.mismatches.map((m) => `${m.property}: ${m.actual} → expected ${m.expected}${m.expectedToken ? ` (${m.expectedToken})` : ''}`).join('\n');
  }
  return f.comparison.ruleViolations.map((r) => `${r.ruleId}: ${r.why}`).join('\n') || '—';
}

export function buildPublishPlan(data: AuditData, contractVersion: string): PublishPlan {
  const s = data.websiteSummary;

  const pageAudits: PageAuditFrame[] = data.pageSummary.map((page) => {
    // Only actual ISSUES get numbered markers and cards (v1.0 §16). MATCH is
    // compliant, and NEW_COMPONENT/DS_CANDIDATE are neutral by §13 — they have
    // their own pages (05/06) and would otherwise inflate a page's issue count.
    const pageFindings = data.findings.filter(
      (f) => f.location.pageId === page.pageId && (f.classification === 'DEVIATION' || f.classification === 'INCORRECT'),
    );
    const markers: IssueMarker[] = [];
    const cards: IssueCard[] = [];
    let n = 0;
    for (const f of pageFindings) {
      const evidence = f.quality.evidence.find((e) => e.kind === 'element-screenshot' && e.box);
      n++;
      if (evidence?.box) {
        markers.push({ number: n, findingId: f.identity.findingId, box: evidence.box, severity: f.quality.severity });
      }
      cards.push({
        number: n,
        findingId: f.identity.findingId,
        title: issueTitle(f),
        status: f.classification,
        severity: f.quality.severity,
        confidence: `${f.quality.confidence.toFixed(2)} (${f.quality.confidenceBand})`,
        actualVsExpected: actualVsExpected(f),
        recommendation: f.action.recommendation,
        reviewState: f.quality.escalationStatus,
      });
    }
    // markerGroups (the interactive-marker system a live Figma publish actually builds) covers
    // the full marker-eligible set (Decision Log #32, widened) — NOT just pageFindings' flat
    // INCORRECT/DEVIATION-only legacy contract, which stays frozen for the headless-path only.
    const markerGroupFindings = data.findings.filter((f) => f.location.pageId === page.pageId && MARKER_ELIGIBLE_CLASSIFICATIONS.includes(f.classification));
    const { groups: markerGroups, truncated: markerGroupsTruncated, total: markerGroupsTotal } = buildMarkerGroups(markerGroupFindings);
    return {
      key: page.pageId,
      url: page.url,
      title: page.url,
      complianceLabel: `${page.templateFamily ?? 'unclassified'} · ${pct(page.compliance.compliancePercent)} · ${page.componentsChecked} components${page.compliance.needsReview ? ` · ${page.compliance.needsReview} need review` : ''}${page.compliance.notCompared ? ` · ${page.compliance.notCompared} unverified` : ''}`,
      screenshots: [...new Set(data.findings.filter((f) => f.location.pageId === page.pageId).flatMap((f) => f.quality.evidence.filter((e) => e.kind === 'element-screenshot').map((e) => e.ref)))],
      markers,
      cards,
      markerGroups,
      markerGroupsTruncated,
      markerGroupsTotal,
    };
  });

  const pages = {
    '00 Overview': {
      headers: [],
      rows: [],
      tiles: [
        { label: 'Compliance', value: pct(s.compliancePercent) },
        { label: 'Match', value: String(s.match) },
        { label: 'Deviation', value: String(s.deviation) },
        { label: 'Incorrect', value: String(s.incorrect) },
        { label: 'New components', value: String(s.newComponent) },
        { label: 'DS candidates', value: String(s.dsCandidate) },
        { label: 'Needs review', value: String(s.needsReview ?? 0) },
        { label: 'Unverified', value: String(s.notCompared) },
        // Distinct from page 07's 'Resolved' tile (data.reAudit.resolved, a fixed issue) — this one
        // is S7's history record of an element that is simply gone (third-pass review OUT-2: the
        // same bare label on two Figma pages, with two different meanings).
        { label: 'Resolved — not on page', value: String(data.statusCounts?.RESOLVED ?? 0) },
        { label: 'Resolved since last run', value: String(data.reAudit.resolved) },
        { label: 'Coverage limits', value: String(data.coverageSummary.truncation.length + data.coverageSummary.droppedRefs.length + data.coverageSummary.sampledListings.length) },
        { label: 'Pages audited', value: String(s.pagesAudited) },
        { label: 'Awaiting review', value: String(s.escalationsQueued) },
      ],
    },
    '01 Template Summary': {
      tiles: [],
      headers: ['Template', 'Pages', 'Components', 'Match', 'Deviation', 'Incorrect', 'Needs review', 'Unverified', 'Compliance'],
      rows: data.templateSummary.map((t) => [t.templateFamily, String(t.pages), String(t.components), String(t.match), String(t.deviation), String(t.incorrect), String(t.needsReview ?? 0), String(t.notCompared), pct(t.compliancePercent)]),
    },
    '02 Global Issues': {
      tiles: [],
      headers: ['Issue', 'Severity', 'Occurrences', 'Pages', 'Recommendation'],
      rows: data.globalIssues.map((i) => [i.title, i.severity, String(i.occurrences), String(i.affectedPages.length), i.example.recommendation]),
    },
    '03 Page Audits': { tiles: [], headers: [], rows: [] },
    '04 Component Audit': {
      tiles: [],
      headers: ['DS component', 'Variant', 'Production type', 'Instances', 'Match', 'Deviation', 'Incorrect', 'Needs review', 'Unverified', 'Compliance'],
      rows: data.componentSummary.map((c) => [c.dsComponent ?? '—', c.dsVariant ?? '—', c.productionType, String(c.instances), String(c.match), String(c.deviation), String(c.incorrect), String(c.needsReview ?? 0), String(c.notCompared), pct(c.compliancePercent)]),
    },
    '05 New Components': {
      tiles: [],
      headers: ['Component', 'Section', 'Signature', 'Confidence', 'Note'],
      rows: data.newComponents.map((f) => [`${f.component.productionType} "${f.component.productionLabel}"`, f.location.section, f.component.signature.slice(0, 12), f.quality.confidence.toFixed(2), f.action.recommendation]),
    },
    '06 DS Candidates': {
      tiles: [],
      headers: ['Component', 'Section', 'Signature', 'Registry request', 'Note'],
      rows: data.dsCandidates.map((f) => [`${f.component.productionType} "${f.component.productionLabel}"`, f.location.section, f.component.signature.slice(0, 12), f.action.registryUpdateRef ?? '—', f.action.dsCandidateNote ?? f.action.recommendation]),
    },
    '07 Re-Audit History': {
      tiles: [
        { label: 'New issues', value: String(data.reAudit.newIssues) },
        { label: 'Still open', value: String(data.reAudit.stillOpen) },
        { label: 'Resolved', value: String(data.reAudit.resolved) },
        { label: 'Regressions', value: String(data.reAudit.regressions) },
        { label: 'Prior issues unverified', value: String(data.reAudit.unverified ?? 0) },
        { label: 'Baseline changed', value: baselineSummary(data.reAudit.baselineChanges ?? []) },
      ],
      headers: ['Finding', 'Previous', 'Current', 'Delta'],
      // Every history event — including a still-open prior issue this run could not re-verify,
      // which has no delta but must not vanish from the history page.
      rows: data.findings
        .filter((f) => (f.history.delta && f.history.delta !== 'UNCHANGED_COMPLIANT') || isPriorIssueUnverified(f))
        .map((f) => [issueTitle(f), f.history.previousStatus ?? '—', f.history.currentStatus, reAuditLabel(f)]),
    },
    '08 Needs Review': {
      tiles: [
        { label: 'Needs review', value: String((data.needsReview ?? []).length) },
        { label: 'Unverified', value: String((data.unverified ?? []).length) },
      ],
      headers: ['Status', 'Component', 'Page', 'Section', 'Possible DS matches', 'Confidence', 'Why not decided'],
      rows: [...(data.needsReview ?? []), ...(data.unverified ?? [])].map((f) => [
        statusLabel(findingStatus(f)),
        `${f.component.productionType} "${f.component.productionLabel}"`,
        f.location.url,
        f.location.section,
        (f.review?.possibleMatches ?? []).map((m) => `${m.dsComponent}${m.dsVariant ? ` (${m.dsVariant})` : ''} ${m.score.toFixed(2)}`).join('; ') || '—',
        f.quality.confidence.toFixed(2),
        f.review?.reason ?? f.action.recommendation,
      ]),
    },
  };

  return {
    contractVersion,
    runId: data.run.runId,
    targetUrl: data.run.targetUrl,
    dsRegistryVersion: data.run.dsRegistryVersion,
    renderingEngine: data.run.renderingPolicy ? describeRenderingEngine(data.run.renderingPolicy) : 'not recorded',
    aiMode: data.run.aiMode ?? 'not recorded',
    pages,
    pageAudits,
    rootCauseCards: buildRootCauseCards(data.findings),
    needsReviewCards: buildNeedsReviewCards(data.findings),
    globalComponents: selectGlobalComponents(data.findings),
    imageDelivery: {
      status: 'deferred-unresolved-spike',
      wouldUpload: pageAudits.flatMap((p) => p.screenshots),
      // Decision Log #32 correction: the blank-image result was specific to the HEADLESS Claude
      // Code publish path — a live, authenticated Figma-MCP session uploads images correctly
      // (verified end-to-end: real screenshots render, zero blank/gray results — see
      // docs/FIGMA-PUBLISH-RUNBOOK.md and src/figma/publish-plan.test.ts's marker-group tests).
      // This status stays 'deferred-unresolved-spike' because it describes the HEADLESS
      // path specifically, which remains genuinely blocked (IMPLEMENTATION-PLAN.md §6, auth) —
      // it never implies upload_assets itself is broken.
      note:
        'Screenshot delivery via upload_assets is blocked specifically for a HEADLESS Claude Code publish (IMPLEMENTATION-PLAN.md §6 — an auth blocker, unresolved for v1); a headless run should publish labelled placeholder frames rather than risk a blank result it cannot visually verify. Delivery is PROVEN TO WORK end-to-end (no blank/gray images) when performed by a live, authenticated interactive Figma-MCP session — see markerGroups on each page audit for the exact curated marker/annotation content such a session should build, and docs/FIGMA-PUBLISH-RUNBOOK.md for how.',
    },
  };
}
