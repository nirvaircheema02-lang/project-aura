import type { PreviewCheck } from '../preview/types.ts';
import {
  COVERAGE_FAMILIES,
  type CoverageCell,
  type CoverageFamily,
  type CoverageGap,
  type CoverageSampling,
  type ElementEvidence,
  type FidelityCoverage,
  type FidelityReport,
  type FidelityVerdictSummary,
  type SectionEvidence,
  type UnverifiedReason,
} from './types.ts';

/**
 * ONE ledger of what the verifier set out to check. `compareDesign` records every unit of work here exactly once — verified, failed or
 * unverified (a required check that could not be run), or disclosed as not required (sampling) — and the verdict, `requiredChecksOpen`,
 * the R8 check, PREVIEW.md, correction-log.json and the G2 reason all read the SAME numbers. The report is hashed into the G2 fingerprint,
 * so everything here is deterministic: sorted, no clocks, and bounded.
 */

const GAP_CAP = 200;
const UNAVAILABLE_CAP = 40;

const emptyCell = (): CoverageCell => ({ required: 0, verified: 0, failed: 0, unverified: 0, notRequired: 0, reasons: {} });
const emptySampling = (): CoverageSampling => ({ hoverEligible: 0, hoverSampled: 0, focusEligible: 0, focusSampled: 0, elementsDropped: 0, groupsDropped: 0, stickyDropped: 0, stickyInert: 0, islandInternal: 0, animationsFrozen: 0, walkCut: 0, hoverSubtreeDropped: 0 });

/**
 * Required gaps nothing in the pipeline can ever clear: the output cannot be changed to make them go away, so they are counted apart from the
 * actionable ones (they still keep the verdict from being `pass` — a permanent gap is not a pass, it is a known limit).
 *  - a hand-authored section is not structurally comparable (its own checks cover it);
 *  - a state the ORIGINAL could not be captured in (it kept animating, or could not be hovered) can never be compared;
 *  - a section the original's capture could not locate has no baseline to compare with;
 *  - a walk cut of the original that hid a control, a possible group or a sticky element is the original's own shape (the walk limits are fixed).
 * `state-not-hoverable-on-original` is by-design because it means GENUINELY not hoverable (pointer-events none, covered, not rendered); a hover that merely failed twice is
 * `state-interrupted-on-original`, which stays actionable (only recapturing the baseline clears it).
 */
export const BY_DESIGN_GAP_REASONS: ReadonlySet<UnverifiedReason> = new Set<UnverifiedReason>(['hand-authored-override', 'state-unsettled-on-original', 'state-not-hoverable-on-original', 'section-not-located-on-original', 'walk-cut']);

export function emptyCoverage(): FidelityCoverage {
  return new CoverageLedger().finish();
}

export type GapInput = Omit<CoverageGap, 'required'>;

export class CoverageLedger {
  private readonly cells = Object.fromEntries(COVERAGE_FAMILIES.map((f) => [f, emptyCell()])) as Record<CoverageFamily, CoverageCell>;
  private readonly gaps: CoverageGap[] = [];
  private byDesign = 0;
  readonly sampling = emptySampling();
  readonly elements: ElementEvidence[] = [];
  readonly sections: SectionEvidence[] = [];

  verified(family: CoverageFamily): void { this.cells[family].verified++; this.cells[family].required++; }
  failed(family: CoverageFamily): void { this.cells[family].failed++; this.cells[family].required++; }
  /** A REQUIRED check that could not be run: it keeps the verdict from being `pass`. */
  unverified(g: GapInput): void {
    const c = this.cells[g.family];
    c.unverified++; c.required++; c.reasons[g.reason] = (c.reasons[g.reason] ?? 0) + 1;
    if (BY_DESIGN_GAP_REASONS.has(g.reason)) this.byDesign++;
    this.gaps.push({ ...g, required: true });
  }
  /** A gap that is disclosed (with numbers) but does not block: sampling, a component's own design, a by-design limit. */
  disclose(g: GapInput): void {
    this.cells[g.family].notRequired++;
    this.gaps.push({ ...g, required: false });
  }

  finish(): FidelityCoverage {
    const order = (f: CoverageFamily) => COVERAGE_FAMILIES.indexOf(f);
    const sorted = this.gaps.slice().sort((a, b) =>
      Number(b.required) - Number(a.required) || order(a.family) - order(b.family) || a.sectionId.localeCompare(b.sectionId) || a.viewport.localeCompare(b.viewport) ||
      (a.elementKey ?? '').localeCompare(b.elementKey ?? '') || a.state.localeCompare(b.state) || a.reason.localeCompare(b.reason));
    const sum = (k: 'required' | 'verified' | 'failed' | 'unverified') => COVERAGE_FAMILIES.reduce((n, f) => n + this.cells[f][k], 0);
    return {
      families: this.cells,
      requiredTotal: sum('required'), requiredVerified: sum('verified'), requiredFailed: sum('failed'), requiredUnverified: sum('unverified'), requiredByDesign: this.byDesign,
      gaps: sorted.slice(0, GAP_CAP), gapsTruncated: Math.max(0, sorted.length - GAP_CAP),
      sampling: this.sampling,
      elements: this.elements.slice().sort((a, b) => a.sectionId.localeCompare(b.sectionId) || a.viewport.localeCompare(b.viewport) || a.elementKey.localeCompare(b.elementKey)),
      sections: this.sections.slice().sort((a, b) => a.sectionId.localeCompare(b.sectionId) || a.viewport.localeCompare(b.viewport)),
    };
  }
}

/** The readable list of required gaps (the `unavailable` projection): unique, bounded, with the remainder counted. */
export function unavailableFrom(coverage: FidelityCoverage): string[] {
  const lines = [...new Set(coverage.gaps.filter((g) => g.required).map((g) => g.detail))];
  const required = coverage.requiredUnverified;
  if (lines.length <= UNAVAILABLE_CAP) return lines;
  return [...lines.slice(0, UNAVAILABLE_CAP), `…and ${required - UNAVAILABLE_CAP} more required check(s) could not be run (see coverage.gaps)`];
}

// ── consumers ───────────────────────────────────────────────────────────────────────────────

/** True for a report that is not a complete pass: its verdict says so, or (fail closed) a `pass` carries unverified required coverage — or no coverage at all, so nothing proves what was run. */
export const isIncomplete = (r: FidelityReport): boolean => r.verdict === 'incomplete' || (r.verdict === 'pass' && (!r.coverage || r.coverage.requiredUnverified > 0));

/** The unverified required checks split into those that could still be cleared and those that are permanent by design. */
export function gapSplit(r: FidelityReport): { actionable: number; byDesign: number } {
  const c = r.coverage;
  if (!c) return { actionable: 0, byDesign: 0 };
  const byDesign = Math.min(c.requiredByDesign ?? 0, c.requiredUnverified);
  return { actionable: c.requiredUnverified - byDesign, byDesign };
}
export const splitText = (s: { actionable: number; byDesign: number }): string => `${s.actionable} actionable / ${s.byDesign} by-design`;

/** The compact summary `verification.json` carries for the G2 decision. */
export function fidelitySummaryOf(r: FidelityReport, open: readonly string[]): FidelityVerdictSummary {
  const c = r.coverage;
  return {
    verdict: r.verdict, requiredTotal: c?.requiredTotal ?? 0, requiredVerified: c?.requiredVerified ?? 0, requiredFailed: c?.requiredFailed ?? 0, requiredUnverified: c?.requiredUnverified ?? 0,
    ...gapSplit(r), open: open.slice(0, 6).map((o) => o.slice(0, 300)),
  };
}

export interface UnverifiedFamily {
  family: CoverageFamily;
  count: number;
  of: number;
  reasons: Partial<Record<UnverifiedReason, number>>;
  examples: string[];
}

export function unverifiedByFamily(r: FidelityReport): UnverifiedFamily[] {
  const c = r.coverage;
  if (!c) return [];
  return COVERAGE_FAMILIES.filter((f) => c.families[f].unverified > 0).map((family) => ({
    family, count: c.families[family].unverified, of: c.families[family].required, reasons: c.families[family].reasons,
    examples: c.gaps.filter((g) => g.required && g.family === family).slice(0, 2).map((g) => g.detail.slice(0, 160)),
  }));
}

const familyBrief = (fams: UnverifiedFamily[]): string => fams.map((f) => `${f.family} ${f.count}`).join(', ');

/** `required 41/46 verified, 2 failed, 3 unverified: sticky 1, hover 2` — at most 240 characters. */
export function summarizeCoverage(r: FidelityReport): string {
  const c = r.coverage;
  if (!c) return 'no coverage was recorded for this comparison';
  const head = `required ${c.requiredVerified}/${c.requiredTotal} verified, ${c.requiredFailed} failed, ${c.requiredUnverified} unverified`;
  const fams = unverifiedByFamily(r);
  return (fams.length ? `${head}: ${familyBrief(fams)}` : head).slice(0, 240);
}

/** The line `requiredChecksOpen` reports for an incomplete comparison. */
export function incompleteLine(r: FidelityReport): string {
  const c = r.coverage;
  if (!c) return 'design/state fidelity is INCOMPLETE: no coverage was recorded for this comparison, so nothing proves which required checks were run';
  const first = c.gaps.find((g) => g.required);
  return `design/state fidelity is INCOMPLETE: ${c.requiredUnverified} of ${c.requiredTotal} required check(s) not verified (${c.requiredVerified} verified, ${c.requiredFailed} failed, ${c.requiredUnverified} unverified: ${familyBrief(unverifiedByFamily(r))}; ${splitText(gapSplit(r))})${first ? ` — first: ${first.detail.slice(0, 200)}` : ''}`;
}

/** R8's `fidelity.design-state` check. A comparison that did not verify every required check is NOT CHECKED, never a pass. */
export function fidelityCheckOf(f: FidelityReport): PreviewCheck {
  const incomplete = isIncomplete(f);
  const base = { id: 'fidelity.design-state', group: 'fidelity' as const, name: 'Design, state and composition are preserved except where a resolved target authorizes a change' };
  if (f.verdict === 'not-checked' && f.summary.elementsCompared === 0) return { ...base, status: 'not-checked', detail: f.unavailable[0] ?? 'nothing could be compared with the original' };
  const counts = `${f.summary.regressions} regression(s), ${f.summary.intentional} authorized change(s), ${f.summary.notCheckable} not checkable; ${f.summary.elementsCompared} element(s) compared (default ${f.summary.statesCompared.default}, hover ${f.summary.statesCompared.hover}, keyboard focus ${f.summary.statesCompared['focus-visible']})`;
  if (incomplete) {
    const gaps = (f.coverage?.gaps ?? []).filter((g) => g.required).slice(0, 2).map((g) => g.detail.slice(0, 160));
    return { ...base, status: 'not-checked', detail: `INCOMPLETE - ${summarizeCoverage(f)}${f.coverage ? ` (${splitText(gapSplit(f))})` : ''}; ${counts}${gaps.length ? `; unverified: ${gaps.join(' | ')}` : ''}` };
  }
  return { ...base, status: f.verdict === 'pass' ? 'pass' : f.verdict === 'fail' ? 'fail' : 'not-checked', detail: `${counts}${f.coverage ? `; ${summarizeCoverage(f)}` : ''}${f.verdict !== 'pass' && f.unavailable.length ? `; unavailable: ${f.unavailable.slice(0, 2).join(' | ')}` : ''}` };
}
