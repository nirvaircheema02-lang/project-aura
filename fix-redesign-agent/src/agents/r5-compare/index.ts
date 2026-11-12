import { readFile } from 'node:fs/promises';
import { CompareVerdictsSchema } from '../../llm/schemas/r-nodes.ts';
import type { LlmClient, LlmImage } from '../../llm/client.ts';
import { propertyMatchesExpected } from '../../style/compare-expected.ts';
import { DS_TYPEFACES, typefaceInPage, typefaceRuleChecks } from '../../style/typeface-rule.ts';
import { extractComputedStyle } from '../../t-layer/computed-style.ts';
import { TerminalError } from '../../retry.ts';
import { POLICY_REFUSAL, REDESIGN_RULES } from '../../redesign-policy.ts';
import { measureTarget } from '../../resolution/resolve.ts';
import { setVerification } from '../../resolution/store.ts';
import { AwaitingJudgmentError } from '../../judgment/types.ts';
import type { FindingCheck, R5Input, R5Output, VisionIssue } from '../types.ts';
import { captureBaselineFromHtml, captureStructuralSnapshot, diffStructural } from './structural.ts';
import { computeIterationOutcome } from './verdict.ts';

/**
 * R5 — Compare (hybrid, §8.6). Tier (a) deterministic re-measurement of every finding's
 * mismatched properties, replaying audit-agent's OWN comparison method per property, plus a
 * structural diff; tier (b) ONE batched vision call, before/after composites against what
 * the plan was supposed to change. `computeIterationOutcome` (verdict.ts) turns both into
 * PASS / PARTIAL / FAIL.
 */

export const R5_STATUS = 'implemented' as const;

export interface R5Deps {
  llm: LlmClient;
  log?: (line: string) => void;
}

async function measureFinding(page: import('playwright').Page, elementId: string, mismatches: Array<{ property: string; expected: string; comparison: 'exact' | 'color-deltaE' | 'length-px' | 'unsupported' }>): Promise<{ measured: FindingCheck['measured']; allMatch: boolean }> {
  const style = await extractComputedStyle(page.locator(`[data-fra-element="${elementId}"]`).first());
  if (!style.connected) return { measured: mismatches.map((m) => ({ property: m.property, actual: '(element not connected)', expected: m.expected, matches: false })), allMatch: false };
  const measured = mismatches.map((m) => {
    const actual = style.raw[m.property] ?? '(not extracted)';
    const { matches } = propertyMatchesExpected(m.comparison, actual, m.expected);
    return { property: m.property, actual, expected: m.expected, matches };
  });
  return { measured, allMatch: measured.every((m) => m.matches) };
}

export async function runR5(deps: R5Deps, input: R5Input): Promise<R5Output> {
  const log = deps.log ?? (() => {});
  const { r1, session, plan, applied, iteration } = input;
  const previousApplied = input.previousApplied ?? [];
  const mapping = session.mapping;
  if (!mapping) throw new TerminalError('R5: session.mapping is not set — C2 must run before R5.');
  if (!session.originalHtml) throw new TerminalError('R5: session.originalHtml is not set — C2 must run before R5.');

  const inScope = r1.fixFindings.filter((f) => mapping.entries.some((e) => e.findingIds.includes(f.identity.findingId) && e.scope === 'content'));
  const unaddressedIds = new Set(plan.plan.unaddressed.map((u) => u.findingId));

  // Tier (a): deterministic re-measurement, one finding at a time (cheap — no model call).
  const checks: FindingCheck[] = [];
  for (const finding of inScope) {
    if (unaddressedIds.has(finding.identity.findingId)) {
      const reason = plan.plan.unaddressed.find((u) => u.findingId === finding.identity.findingId)?.reason ?? 'unaddressed';
      checks.push({ findingId: finding.identity.findingId, fixed: false, detail: `unaddressed: ${reason}`, measured: [] });
      continue;
    }
    const entry = mapping.entries.find((e) => e.findingIds.includes(finding.identity.findingId))!;
    // earlier iterations' edits are still on the live page; this iteration's own edits come last so a later retry of the same edit wins
    const editsForFinding = [...previousApplied, ...applied.applied].filter((a) => a.edit.findingId === finding.identity.findingId);
    const refused = editsForFinding.find((a) => !a.applied && a.error?.startsWith(POLICY_REFUSAL));
    if (refused) {
      checks.push({ findingId: finding.identity.findingId, fixed: false, detail: refused.error!, measured: [] });
      continue;
    }
    // resolver-derived targets (not the audit's own expectation) that the live edit route can measure: the element itself, in default/hover/focus states
    const resolution = input.resolution ?? null;
    const extraTargets = resolution ? resolution.targets.filter((t) => t.findingId === finding.identity.findingId && t.outcome === 'resolved-target' && t.provenance.kind !== 'audit-expected' && t.target && t.part === 'self') : [];
    const measurableState = (st: string) => st === 'default' || st === 'hover' || st === 'focus' || st === 'focus-visible';
    const extraRows: FindingCheck['measured'] = [];
    for (const t of extraTargets) {
      if (!measurableState(t.state)) { setVerification(resolution!, (x) => x.id === t.id, 'unverified', `the ${t.state} state cannot be measured on the live page; it is measured in the rendered preview`); continue; }
      const m = await measureTarget(session.page, `[data-fra-element="${entry.element}"]`, t);
      extraRows.push({ property: `${t.property}${t.state === 'default' ? '' : ` [${t.state}]`}`, actual: m.actual ?? '(not measurable)', expected: t.target!.value, matches: m.matches });
      // equal AND visible: a colour that matches its value but is invisible / collapsed is failed, one whose backdrop could not be measured is unverified
      setVerification(resolution!, (x) => x.id === t.id, m.matches ? 'verified-resolved-target' : m.unverified ? 'unverified' : 'failed', `live page: ${m.note}`);
    }
    if (finding.comparison.mismatches.length > 0) {
      const { measured, allMatch } = await measureFinding(session.page, entry.element, finding.comparison.mismatches);
      if (resolution) for (const row of measured) setVerification(resolution, (x) => x.findingId === finding.identity.findingId && x.provenance.kind === 'audit-expected' && x.property === row.property, row.matches ? 'verified-original-target' : 'failed', `live page: ${row.actual} vs expected ${row.expected}`);
      const rows = [...measured, ...extraRows];
      const ok = allMatch && extraRows.every((r) => r.matches);
      checks.push({ findingId: finding.identity.findingId, fixed: ok, detail: ok ? 'every measured property now matches its expected value' : `${rows.filter((m) => !m.matches).length}/${rows.length} propert(y/ies) still do not match`, measured: rows });
    } else if (typefaceRuleChecks(finding).length > 0) {
      // a rule violation that CAN be measured (R1.4 typeface): read the typeface the text is actually set in — an applied edit is not proof
      const rows: FindingCheck['measured'] = [];
      const offenders: string[] = [];
      for (const c of typefaceRuleChecks(finding)) {
        const loc = session.page.locator(`[data-fra-element="${entry.element}"]`).first();
        const r = (await loc.count()) ? await loc.evaluate(typefaceInPage, { bad: c.offending, ds: DS_TYPEFACES }) : { families: ['(element not connected)'], ok: false, offenders: [] as Array<{ path: string; family: string }> };
        rows.push({ property: 'font-family', actual: r.families.join(', '), expected: `a design-system typeface (DM Sans or Noto Serif), not ${c.offending}`, matches: r.ok });
        for (const o of r.offenders) offenders.push(`${o.path === '' ? 'the stamped element itself' : `the stamp selector followed by "${o.path}"`} is set in ${o.family}`);
      }
      const all = [...rows, ...extraRows];
      const ok = all.every((m) => m.matches);
      checks.push({ findingId: finding.identity.findingId, fixed: ok, detail: ok ? 'the text is now set in a design-system typeface (measured)' : `the text is still set in ${rows.filter((m) => !m.matches).map((m) => m.actual).join('; ') || 'a non-DS typeface'} (an applied edit that does not reach the visible text is not a fix); not yet corrected: ${offenders.join('; ')}`, measured: all });
    } else if (extraRows.length > 0) {
      const ok = extraRows.every((r) => r.matches);
      checks.push({ findingId: finding.identity.findingId, fixed: ok, detail: ok ? 'every resolved target now measures its resolved value' : `${extraRows.filter((m) => !m.matches).length}/${extraRows.length} resolved target(s) do not measure their resolved value`, measured: extraRows });
    } else {
      const anyApplied = editsForFinding.some((a) => a.applied);
      checks.push({ findingId: finding.identity.findingId, fixed: anyApplied, detail: anyApplied ? 'no measurable mismatch on this finding; verified only that a targeted edit was applied' : 'no edit was applied for this finding', measured: [] });
    }
  }

  // Structural diff: originalHtml (pre-any-edit, this run) vs the live page right now.
  const before = await captureBaselineFromHtml(session.context, session.originalHtml, r1.targetUrl);
  const after = await captureStructuralSnapshot(session.page);
  const structural = diffStructural(before, after);
  log(`R5 · iteration ${iteration} · ${checks.filter((c) => c.fixed).length}/${checks.length} finding(s) verified fixed · structural ${structural.ok ? 'ok' : 'FLAGGED'}`);

  // Tier (b): ONE batched vision call, before/after composites.
  let vision: R5Output['vision'] = 'NOT_CHECKED';
  let visionIssues: VisionIssue[] = [];
  let visionVerdicts: R5Output['visionVerdicts'] = null;
  let usage: R5Output['usage'] = null;

  if (session.before.composite && applied.after.composite && checks.length > 0) {
    try {
      const images: LlmImage[] = [
        { png: await readFile(session.before.composite.path), caption: 'BEFORE — the page before this iteration\'s edits', path: session.before.composite.path },
        { png: await readFile(applied.after.composite.path), caption: 'AFTER — the page after this iteration\'s edits', path: applied.after.composite.path },
      ];
      const intended = checks
        .map((c) => {
          const finding = inScope.find((f) => f.identity.findingId === c.findingId)!;
          const edit = applied.applied.find((a) => a.edit.findingId === c.findingId && a.applied)?.edit;
          return `findingId=${c.findingId} section="${finding.location.section}" ${finding.component.productionType} "${finding.component.productionLabel}": ${edit ? `${edit.rationale}` : 'no edit applied'}`;
        })
        .join('\n');
      const res = await deps.llm.structured({
        nodeId: 'R5',
        system: 'You are the Visual Verifier of a Design System auto-fix pipeline. Compare the BEFORE and AFTER screenshots and judge, per finding, whether the intended change is visible and whether anything else regressed (overlap, wrapping, lost content, broken alignment, hierarchy). Flat grey blocks, if any, are redactions from the capture tool, not design elements.',
        prompt: `Project rules:\n${REDESIGN_RULES}\n\nIntended changes this iteration:\n${intended}\n\nJudge each finding and report any regression. In particular check original section composition and centered heading/form alignment. Do not infer sticky, keyboard or other dynamic behavior from static screenshots.`,
        images,
        schema: CompareVerdictsSchema,
        effort: 'high',
      });
      visionVerdicts = res.data;
      usage = res.usage;
      const notFixed = res.data.verdicts.filter((v) => v.verdict === 'NOT_FIXED').length;
      const anyRejectedSeverity = res.data.regressions.some((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH');
      vision = res.data.overall === 'REJECTED' || anyRejectedSeverity ? 'REJECTED' : res.data.overall === 'UNCERTAIN' || notFixed > 0 ? 'UNCERTAIN' : 'CONFIRMED';
      visionIssues = res.data.regressions.map((r) => ({ description: r.description, severity: r.severity }));
      // A vision-confirmed "NOT_FIXED" finding that tier (a) called fixed is downgraded — the
      // picture is what the whole point of this tier exists to catch (measurement can't see
      // wrapping/overlap/hierarchy), so it is never silently overridden by the measured check.
      for (const v of res.data.verdicts) {
        if (v.verdict === 'NOT_FIXED') {
          const check = checks.find((c) => c.findingId === v.findingId);
          if (check && check.fixed) {
            check.fixed = false;
            check.detail = `${check.detail} — but the vision check says NOT_FIXED: ${v.reasoning}`;
          }
        }
      }
    } catch (err) {
      // A judgment pause is not a failure — the Session Agent hasn't answered yet, and
      // R5 must checkpoint (pipeline.ts), never downgrade the pause to a silent NOT_CHECKED.
      if (err instanceof AwaitingJudgmentError) throw err;
      log(`R5 · iteration ${iteration} · vision sub-step failed, proceeding on tier (a) alone: ${err instanceof Error ? err.message : String(err)}`);
      vision = 'NOT_CHECKED';
    }
  }

  const { overall, failedChecks } = (await import('./verdict.ts')).computeIterationOutcome({ checks, structural, vision, visionIssues });
  return { iteration, checks, structural, vision, visionIssues, visionVerdicts, overall, failedChecks, usage };
}
