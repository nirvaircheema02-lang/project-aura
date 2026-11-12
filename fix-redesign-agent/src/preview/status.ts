import { incompleteLine, isIncomplete, unverifiedByFamily } from '../fidelity/coverage.ts';
import { isByDesignPreserveReason } from '../fidelity/accounting.ts';
import type { FidelityReport } from '../fidelity/types.ts';
import type { ResolutionFile } from '../resolution/schema.ts';
import type { PreviewCheck, PreviewStatus, PreviewVerdict, PreviewVerification, RequiredGap } from './types.ts';

export type { PreviewStatus, PreviewVerdict, RequiredGap } from './types.ts';

/**
 * The OVERALL preview status, computed in one place and read by every consumer (verification.json, pv-status.json, the preview UI,
 * PREVIEW.md, the CLI, the G2 reason and the G2 approval note) so they cannot disagree.
 *
 * REQUIRED (can make the verdict `fail` or `incomplete`):
 *  - every verification check that FAILED;
 *  - every check that could not run (`not-checked`) and is a gate - one that would have FAILED the preview had it run (interaction parity,
 *    contrast, the preserve check, a section-authored check...). Not running a gate is missing required evidence, not a pass;
 *  - the fidelity coverage's required checks (verified / failed / unverified), incl. a comparison that never ran;
 *  - the resolved targets (each must be measured in the rendered preview) and the preserve decisions (each needs positive evidence).
 *  This is exactly what `requiredChecksOpen` lists (it is derived from here), plus the gate checks above.
 *
 * DISCLOSED (never change the verdict, always listed apart): fidelity coverage `notRequired` (sampling caps, a component's own internals,
 * frozen animation), states the verifier does not capture, behaviour of the original that is not reproduced, simulated forms/embeds, and the
 * informational `not-checked` checks (DISCLOSED_ONLY_CHECKS below: they cannot fail, they only report a fact).
 *
 * Rule: any failed required item => `fail` (whatever is also missing - both are listed); else any required item unverified => `incomplete`;
 * else `pass`. Individual check / finding / target results are never rewritten by this.
 */

/** `not-checked` checks that are informational, not gates: they cannot fail the preview, so they are disclosed (never required). */
const DISCLOSED_ONLY_CHECKS: ReadonlySet<string> = new Set([
  'scope.no-orphan-content', // reports page content beside a section that belongs to none; it is a notice about the original's structure
  'contrast.inherited', // text below AA that the ORIGINAL already had and the redesign left as designed (outside the selected findings)
]);
/** Their evidence is carried by the fidelity report / resolved targets, which `requiredGapsOf` reads directly. */
const FIDELITY_CHECK = 'fidelity.design-state';
const PRESERVE_CHECK = 'ds-fix.preserved-unchanged';

/** The family of the open item "no new verification was allowed" (preview/budget-stop.ts): it explains why the rest is unverified, so the cap never drops it. */
export const BUDGET_GAP_FAMILY = 'budget';

const GAP_CAP = 12;
const DISCLOSED_CAP = 12;
const TEXT_CAP = 400;
const cut = (s: string, n = TEXT_CAP) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Failed checks and gate checks that did not run - everything the verification's own check list says. `skip` leaves out checks whose evidence another source carries. */
function checkGaps(v: Pick<PreviewVerification, 'checks' | 'interactions'>, skip: (id: string) => boolean): RequiredGap[] {
  const { checks } = v;
  const out: RequiredGap[] = [];
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.length) out.push({ kind: 'failed', family: 'checks', count: failed.filter((c) => !skip(c.id)).length, text: `${failed.length} verification check(s) failed: ${failed.slice(0, 6).map((c) => c.id).join(', ')}` });
  for (const c of checks) {
    if (c.status !== 'not-checked' || DISCLOSED_ONLY_CHECKS.has(c.id) || skip(c.id)) continue;
    out.push({ kind: 'unverified', family: `check:${c.id}`, count: 1, text: cut(`${c.name}: not checked - ${c.detail}`) });
  }
  // a section that could not be located on the original page had its behaviour compared with nothing: that is missing evidence, whatever the parity check says of the rest
  const notLocated = [...new Set(v.interactions.filter((i) => i.verdict === 'not-probed' && i.probe === 'section').map((i) => i.sectionId))];
  if (notLocated.length) out.push({ kind: 'unverified', family: 'interaction:not-located', count: notLocated.length, text: cut(`${notLocated.length} section(s) could not be located on the original page, so their behaviour was not compared with it (${notLocated.slice(0, 4).join(', ')}${notLocated.length > 4 ? ', …' : ''}): interaction parity is not verified for them`) });
  return out;
}

/** The checks' own gaps, for a verification that has no fidelity / resolution yet (verifyPreview's provisional status) and for files written before `status` existed. */
export const checkGapsOf = (v: PreviewVerification): RequiredGap[] => checkGaps(v, () => false);

const notComparedGap = (because: string): RequiredGap => ({ kind: 'unverified', family: 'fidelity:not-compared', count: 1, text: `design and state fidelity was not compared (${because})` });

/**
 * Everything required that is still not satisfied: one gap per `required.open` line (`requiredChecksOpen` is `.map(g => g.text)`), structured.
 * The loop stopping with "nothing left to correct" is NOT a pass: an unverifiable comparison, a failed check, or a resolved target nobody could measure keeps the preview from being verified.
 */
export function requiredGapsOf(v: PreviewVerification, fidelity: FidelityReport | null, resolution: ResolutionFile | null, notComparedBecause = 'no baseline of the original'): RequiredGap[] {
  // the fidelity check and the preserve check are the SAME evidence as the fidelity report / the preserve targets below: not counted twice
  const gaps = checkGaps(v, (id) => id === FIDELITY_CHECK || (id === PRESERVE_CHECK && !!resolution));
  if (!fidelity) gaps.push(notComparedGap(notComparedBecause));
  else {
    if (fidelity.verdict === 'fail') gaps.push({ kind: 'failed', family: 'fidelity:regression', count: Math.max(1, fidelity.summary.regressions), text: `design/state fidelity: ${fidelity.summary.regressions} regression(s)` });
    else if (fidelity.verdict === 'not-checked') gaps.push({ kind: 'unverified', family: 'fidelity:not-checked', count: 1, text: `design/state fidelity is NOT verified: ${fidelity.unavailable[0] ?? 'nothing could be compared with the original'}` });
    // required checks that could not be run keep the preview from being called verified - also next to a regression, and even on a report that claims `pass` (fail closed)
    if (isIncomplete(fidelity) || (fidelity.verdict === 'fail' && (fidelity.coverage?.requiredUnverified ?? 0) > 0)) {
      const fams = unverifiedByFamily(fidelity).map((f) => f.family);
      gaps.push({ kind: 'unverified', family: `fidelity:${fams.join('+') || 'coverage'}`, count: Math.max(1, fidelity.coverage?.requiredUnverified ?? 1), text: incompleteLine(fidelity) });
    }
  }
  if (resolution) {
    const required = resolution.targets.filter((t) => t.outcome === 'resolved-target');
    const unverified = required.filter((t) => t.status.verification !== 'verified-original-target' && t.status.verification !== 'verified-resolved-target');
    const failedTargets = unverified.filter((t) => t.status.verification === 'failed').length;
    if (unverified.length) {
      gaps.push({ kind: failedTargets > 0 ? 'failed' : 'unverified', family: 'target', count: failedTargets > 0 ? failedTargets : unverified.length, text: `${unverified.length} of ${required.length} resolved target(s) not verified in the rendered preview (${failedTargets} failed)` });
      // a failed target keeps the line a failure; the targets that merely could not be measured are still missing evidence and are said so
      if (failedTargets > 0 && unverified.length > failedTargets) gaps.push({ kind: 'unverified', family: 'target', count: unverified.length - failedTargets, text: `${unverified.length - failedTargets} resolved target(s) could not be measured in the rendered preview` });
    }
    const brokenPreserve = resolution.targets.filter((t) => t.outcome === 'preserve-existing' && t.status.verification === 'failed');
    if (brokenPreserve.length) gaps.push({ kind: 'failed', family: 'preserve:changed', count: brokenPreserve.length, text: `${brokenPreserve.length} property(ies) that must stay as the original changed` });
    // a preserve decision without positive evidence is not "kept": it is open, grouped by why it could not be verified
    const unproven = resolution.targets.filter((t) => t.outcome === 'preserve-existing' && (t.status.verification === 'unverified' || t.status.verification === 'not-run'));
    if (unproven.length) {
      const reasons = new Map<string, number>();
      let byDesign = 0;
      for (const t of unproven) { const r = (t.status.verificationDetail ?? 'not evaluated').split(':')[0]!.slice(0, 80); reasons.set(r, (reasons.get(r) ?? 0) + 1); if (isByDesignPreserveReason(r)) byDesign++; }
      gaps.push({ kind: 'unverified', family: 'preserve', count: unproven.length, text: `${unproven.length} preserve decision(s) could not be verified (insufficient evidence; ${unproven.length - byDesign} actionable / ${byDesign} by-design): ${[...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([r, n]) => `${r} ×${n}`).join(', ')}` });
    }
  }
  return gaps;
}

/**
 * The optional / by-design limitations: listed apart from the required gaps and never part of the verdict.
 * What is derivable from the verification alone is added by `applyOverallStatus`; the fidelity report adds its own here.
 */
export function disclosedOf(v: PreviewVerification, fidelity: FidelityReport | null): string[] {
  const out: string[] = [];
  const cov = fidelity?.coverage;
  if (cov) {
    const notRequired = Object.entries(cov.families).filter(([, x]) => x.notRequired > 0).map(([f, x]) => `${f} ${x.notRequired}`);
    const sm = cov.sampling;
    if (notRequired.length) out.push(`fidelity: ${notRequired.join(', ')} check(s) disclosed as not required (sampled ${sm.hoverSampled} of ${sm.hoverEligible} element(s) for hover, ${sm.focusSampled} of ${sm.focusEligible} for keyboard focus; the rest are in fidelity.json coverage.gaps)`);
  }
  if (fidelity?.statesNotCaptured.length) out.push(`not captured by the fidelity verifier: ${fidelity.statesNotCaptured.join('; ')}`);
  return out;
}

const verifierDisclosed = (v: PreviewVerification): string[] => {
  const out: string[] = [];
  for (const c of v.checks) if (c.status === 'not-checked' && DISCLOSED_ONLY_CHECKS.has(c.id)) out.push(cut(`${c.name}: ${c.detail}`, 300));
  if (v.unavailable.length) out.push(`${v.unavailable.length} behaviour(s) of the original page are not reproduced in the preview (listed in PREVIEW.md)`);
  if (v.simulated.length) out.push(`${v.simulated.length} simulated or stubbed behaviour(s) (for example forms do not submit)`);
  if (v.contrast && v.contrast.unmeasuredRuns > 0) out.push(`${v.contrast.unmeasuredRuns} text run(s) could not be contrast-measured`);
  const handAuthored = v.interactions.filter((i) => i.verdict === 'not-probed' && i.probe !== 'section').length;
  if (handAuthored) out.push(`${handAuthored} interaction(s) of hand-authored section(s) were not compared with the original (no structural counterpart; covered by the section's own checks, if any)`);
  // Fix findings are claims, not required checks: they never change the verdict, but a PASS must not read as "everything was fixed"
  const notFixed = v.summary.findingsTotal - v.summary.findingsVerified;
  if (notFixed > 0) {
    const by = new Map<string, number>();
    for (const f of v.findings) if (f.status !== 'fixed-verified' && f.status !== 'component-verified') by.set(f.status, (by.get(f.status) ?? 0) + 1);
    out.push(`${notFixed} of ${v.summary.findingsTotal} Fix finding(s) are not measured fixed${by.size ? ` (${[...by].map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}: they are listed in finding-accounting.md and are not claimed fixed; this does not change the required-check verdict`);
  }
  return out;
};

/**
 * The one call that finalizes a verification once fidelity and the resolved targets are known (R8): the required gaps (returned, their text is
 * `required.open`), the disclosed limitations, and the overall verdict + status written onto `v`.
 */
export function settleStatus(v: PreviewVerification, fidelity: FidelityReport | null, resolution: ResolutionFile | null): RequiredGap[] {
  const gaps = requiredGapsOf(v, fidelity, resolution);
  applyOverallStatus(v, gaps, disclosedOf(v, fidelity));
  return gaps;
}

const worse = (a: PreviewVerdict, b: PreviewVerdict): PreviewVerdict => (a === 'fail' || b === 'fail' ? 'fail' : a === 'incomplete' || b === 'incomplete' ? 'incomplete' : 'pass');

/**
 * Sets `v.verdict` and `v.status` from the gaps. A failed check or a failed gap => `fail`; else any gap => `incomplete`; else `pass`.
 * Idempotent. `disclosed` (from `disclosedOf`) replaces the stored fidelity-derived lines; omit it to keep what is stored.
 */
export function applyOverallStatus(v: PreviewVerification, gaps: RequiredGap[], disclosed?: string[]): void {
  const failedGaps = gaps.filter((g) => g.kind === 'failed');
  const unverifiedGaps = gaps.filter((g) => g.kind === 'unverified');
  const verdict: PreviewVerdict = v.checks.some((c) => c.status === 'fail') || failedGaps.length ? 'fail' : gaps.length ? 'incomplete' : 'pass';
  // failures are never truncated away behind unverified items, and the reason no verification was allowed is never truncated away behind the rest
  const ordered = [...failedGaps, ...unverifiedGaps.filter((g) => g.family === BUDGET_GAP_FAMILY), ...unverifiedGaps.filter((g) => g.family !== BUDGET_GAP_FAMILY)];
  const lines = [...new Set([...(disclosed ?? v.status?.disclosed ?? []).filter((d) => !verifierDisclosed(v).includes(d)), ...verifierDisclosed(v)])];
  v.verdict = verdict;
  v.status = {
    verdict,
    failedRequired: failedGaps.reduce((n, g) => n + (g.count ?? 1), 0),
    unverifiedRequired: unverifiedGaps.reduce((n, g) => n + (g.count ?? 1), 0),
    gaps: ordered.slice(0, GAP_CAP).map((g) => ({ ...g, text: cut(g.text) })), gapsTruncated: Math.max(0, ordered.length - GAP_CAP),
    disclosed: lines.slice(0, DISCLOSED_CAP), disclosedTruncated: Math.max(0, lines.length - DISCLOSED_CAP),
  };
}

/** What a verification.json written before `status` existed says, derived from its own fields. Never reads an unknown as a pass. */
function legacyGaps(v: PreviewVerification): RequiredGap[] {
  const f = v.fidelity;
  // with the fidelity summary, it speaks for the fidelity check; without it the check's own text does
  const gaps = checkGaps(v, (id) => !!f && id === FIDELITY_CHECK);
  // no fidelity summary and no fidelity check: the comparison was never recorded, which is what a fresh run without a report says too
  if (!f && !v.checks.some((c) => c.id === FIDELITY_CHECK)) gaps.push(notComparedGap('no baseline of the original'));
  if (f) {
    const open = f.open.length ? ` - open: ${f.open.slice(0, 3).join(' | ')}` : '';
    if (f.verdict === 'fail' || f.requiredFailed > 0) gaps.push({ kind: 'failed', family: 'fidelity:regression', count: Math.max(1, f.requiredFailed), text: cut(`design/state fidelity: ${f.verdict.toUpperCase()}, ${f.requiredFailed} required check(s) failed${open}`) });
    if (f.requiredUnverified > 0) gaps.push({ kind: 'unverified', family: 'fidelity:coverage', count: f.requiredUnverified, text: cut(`${f.requiredUnverified} of ${f.requiredTotal} required fidelity check(s) unverified (${f.actionable} actionable / ${f.byDesign} by-design), fidelity ${f.verdict.toUpperCase()}${open}`) });
    else if (f.verdict !== 'fail' && (f.verdict !== 'pass' || f.open.length > 0)) gaps.push({ kind: 'unverified', family: 'fidelity:not-checked', count: 1, text: cut(`fidelity ${f.verdict.toUpperCase()}${open}`) });
  }
  return gaps;
}

/**
 * The effective status of ANY verification.json: the stored one (never better than the file's own verdict), or - for a file written before
 * `status` existed - one derived from its checks and fidelity summary. An old `pass` whose fidelity check was `not-checked` is INCOMPLETE, not PASS.
 */
export function statusOf(v: PreviewVerification): PreviewStatus {
  if (v.status) return { ...v.status, verdict: worse(v.status.verdict, v.verdict) };
  const gaps = legacyGaps(v);
  const failed = gaps.filter((g) => g.kind === 'failed');
  const unverified = gaps.filter((g) => g.kind === 'unverified');
  const verdict = worse(v.verdict, failed.length ? 'fail' : unverified.length ? 'incomplete' : 'pass');
  const ordered = [...failed, ...unverified];
  const disclosed = verifierDisclosed(v);
  return {
    verdict, failedRequired: failed.reduce((n, g) => n + (g.count ?? 1), 0), unverifiedRequired: unverified.reduce((n, g) => n + (g.count ?? 1), 0),
    gaps: ordered.slice(0, GAP_CAP), gapsTruncated: Math.max(0, ordered.length - GAP_CAP), disclosed: disclosed.slice(0, DISCLOSED_CAP), disclosedTruncated: Math.max(0, disclosed.length - DISCLOSED_CAP),
  };
}

export const effectiveVerdict = (v: PreviewVerification): PreviewVerdict => statusOf(v).verdict;

/** `PASS` / `INCOMPLETE - 3 required check(s) not verified` / `FAIL - 1 required check(s) failed, 3 not verified`: the one phrase every surface uses. */
export function statusHeadline(s: Pick<PreviewStatus, 'verdict' | 'failedRequired' | 'unverifiedRequired'>): string {
  if (s.verdict === 'pass') return 'PASS - every required check is verified';
  if (s.verdict === 'incomplete') return `INCOMPLETE - ${s.unverifiedRequired} required check(s) not verified`;
  return `FAIL - ${s.failedRequired} required check(s) failed${s.unverifiedRequired ? `, ${s.unverifiedRequired} not verified` : ''}`;
}

/** The body of pv-status.json's status part: the same numbers and gaps as verification.json. */
export function statusFields(v: PreviewVerification): Pick<PreviewStatus, 'verdict' | 'failedRequired' | 'unverifiedRequired' | 'gaps' | 'gapsTruncated' | 'disclosed' | 'disclosedTruncated'> {
  const s = statusOf(v);
  return { verdict: s.verdict, failedRequired: s.failedRequired, unverifiedRequired: s.unverifiedRequired, gaps: s.gaps, gapsTruncated: s.gapsTruncated, disclosed: s.disclosed, disclosedTruncated: s.disclosedTruncated };
}

/** The CLI's verification lines: the same verdict, counts and gaps as every other surface. */
export function cliVerificationLines(v: PreviewVerification, opts: { report?: string } = {}): string[] {
  const s = statusOf(v);
  const lines = [`Verification:  ${statusHeadline(s)} · ${v.summary.passed} passed, ${v.summary.failed} failed, ${v.summary.notChecked} not checked · ${v.summary.findingsVerified}/${v.summary.findingsTotal} findings measured fixed · ${v.summary.interactionsMatched}/${v.summary.interactionsTotal} interactions reproduced, ${v.summary.interactionsUnavailable} not reproduced`];
  for (const g of s.gaps.slice(0, 6)) lines.push(`  ${g.kind === 'failed' ? 'FAILED    ' : 'UNVERIFIED'} ${cut(g.text, 220)}`);
  if (s.gaps.length > 6 || s.gapsTruncated) lines.push(`  …and ${s.gaps.length - 6 + s.gapsTruncated} more required item(s)${opts.report ? ` - see ${opts.report}` : ''}`);
  return lines;
}
