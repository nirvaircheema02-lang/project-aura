import { coveredProperties } from '../fidelity/compare.ts';
import { deriveFeedback, feedbackForUnmetTargets, type AttributionContext } from '../fidelity/feedback.ts';
import { runCorrectionLoop, type BudgetTracker, type LoopResult } from '../fidelity/loop.ts';
import type { CorrectionFeedback, FidelityReport } from '../fidelity/types.ts';
import { guardKey } from '../fidelity/guard.ts';
import { measuredPropertiesOf } from '../fidelity/preserve.ts';
import type { ResolutionFile } from '../resolution/schema.ts';
import { requiredGapsOf } from './status.ts';
import type { PreviewVerification } from './types.ts';

/**
 * Verification feedback must not end as an ignored report. This turns the verification of a rendered preview
 * (resolved targets, fidelity, design-system components that do not measure up) into actionable feedback,
 * applies the corrections the preview generator can perform, re-renders, and re-verifies — inside ONE bounded
 * loop (fidelity/loop.ts). What only the planner can correct is returned for the pipeline; what nothing can
 * correct stays open and is reported, never passed.
 */

/** The corrections in force. A correction only narrows what is replayed or mounted; it never touches the original baseline. */
export interface CorrectionSet {
  /** `guardKey(findingId, property)`: this style edit is emitted so it does not apply in hover/focus/active states. */
  stateGuards: Set<string>;
  /** `findingId|property`: stop replaying this edit. */
  droppedEdits: Set<string>;
  /** Findings whose design-system component is replaced by the original element. */
  droppedIslands: Set<string>;
}

export const emptyCorrections = (): CorrectionSet => ({ stateGuards: new Set(), droppedEdits: new Set(), droppedIslands: new Set() });
export const correctionsFrom = (c: { stateGuards: string[]; droppedEdits: string[]; droppedIslands: string[] } | undefined | null): CorrectionSet => ({ stateGuards: new Set(c?.stateGuards ?? []), droppedEdits: new Set(c?.droppedEdits ?? []), droppedIslands: new Set(c?.droppedIslands ?? []) });
export const correctionsToJson = (c: CorrectionSet) => ({ stateGuards: [...c.stateGuards].sort(), droppedEdits: [...c.droppedEdits].sort(), droppedIslands: [...c.droppedIslands].sort() });
export const editKey = (findingId: string, property: string | null): string => `${findingId}|${(property ?? '').trim().toLowerCase()}`;

/** What one produced-and-verified preview looks like to the loop. */
export interface VerifiedAttempt<A> {
  attempt: A;
  verification: PreviewVerification;
  fidelity: FidelityReport;
  attribution: AttributionContext;
}

export function feedbackOf<A>(v: VerifiedAttempt<A>, resolution: ResolutionFile | null, opts: { dsFirst?: boolean } = {}): CorrectionFeedback[] {
  const out: CorrectionFeedback[] = [];
  out.push(...deriveFeedback(v.fidelity, v.attribution));

  // a design-system component that does not measure up: the original element is kept (never silently), then re-verified
  // DS-first: a mounted component whose measured values differ from the audit's expected values stays mounted — the component is the design, and the
  // finding is reported with the values that differ (never as fixed), instead of the component being thrown away for the production markup
  for (const f of opts.dsFirst ? [] : v.verification.findings) {
    if (f.route === 'island' && (f.status === 'unresolved' || f.status === 'partially-verified') && !f.reported && /not matching/.test(f.detail)) {
      out.push({
        id: `island:${f.findingId}`, kind: 'target-not-met', sectionId: f.section, viewport: 'any', elementKey: '', elementLabel: f.label, state: 'default', property: null, expected: null, observed: null, findingIds: [f.findingId],
        message: `the design-system component for "${f.label}" does not measure up: ${f.detail}`, responsible: 'preview-generator', action: { type: 'drop-island', findingId: f.findingId, reason: f.detail }, blockedReason: null,
      });
    }
  }

  // resolved targets that measured NOT met in the rendered preview (and are not the island case above)
  if (resolution) {
    const failed = (v.verification.targetResults ?? []).filter((r) => r.verification === 'failed');
    const unmet = [];
    for (const r of failed) {
      const t = resolution.targets.find((x) => x.id === r.targetId);
      if (!t || t.outcome !== 'resolved-target' || !t.target) continue;
      const outcome = v.verification.findings.find((f) => f.findingId === t.findingId);
      if (outcome?.route === 'island') continue;
      unmet.push({ targetId: t.id, findingId: t.findingId, property: t.property, part: t.part, state: t.state, expected: t.target.value, observed: r.detail, label: outcome?.label ?? t.findingId, sectionId: outcome?.section ?? '', blocked: t.status.implementation === 'blocked' ? t.status.implementationDetail : null });
    }
    for (const fb of feedbackForUnmetTargets(unmet)) {
      const u = unmet.find((x) => `target:${x.targetId}` === fb.id)!;
      // no live-DOM representation exists for it: the planner cannot correct it, so it is reported as blocked rather than looped on
      out.push(u.blocked ? { ...fb, responsible: 'none', action: null, blockedReason: u.blocked } : fb);
    }
    out.push(...preserveFeedback(v, resolution));
  }
  return out;
}

/**
 * A preserve decision that FAILED but is not already a fidelity regression (a box that changed size, a removal found by the preserve
 * evidence only) must not end as an ignored report: it goes back to the planner to restore the original when an edit of that property
 * exists, and is otherwise reported as blocked with the concrete reason. Unverified preserve decisions are NOT feedback: nothing can
 * correct missing evidence, so they stay open in `requiredChecksOpen`.
 */
function preserveFeedback<A>(v: VerifiedAttempt<A>, resolution: ResolutionFile): CorrectionFeedback[] {
  const out: CorrectionFeedback[] = [];
  for (const r of v.verification.targetResults ?? []) {
    if (r.verification !== 'failed') continue;
    const t = resolution.targets.find((x) => x.id === r.targetId);
    if (!t || t.outcome !== 'preserve-existing') continue;
    const m = measuredPropertiesOf(t.property);
    const props = new Set<string>([...coveredProperties(t.property), ...(m.kind === 'style' ? [...m.props, ...m.differenceProps] : m.kind === 'box' ? m.differenceProps : [])]);
    // a regression with no property (an element that is gone) already says what a REMOVAL failure says; it says nothing about a changed width or colour
    const removal = /^element removed/.test(r.detail);
    const already = v.fidelity.differences.some((d) => d.classification === 'regression' && d.findingIds.includes(t.findingId) && (d.property === null ? removal && d.category === 'element-unmatched' : props.has(d.property)));
    if (already) continue;
    const outcome = v.verification.findings.find((f) => f.findingId === t.findingId);
    const label = outcome?.label ?? t.findingId;
    const touches = (v.attribution.editsByFinding.get(t.findingId) ?? []).some((e) => e.property && (e.property.trim().toLowerCase() === t.property.trim().toLowerCase() || [...coveredProperties(e.property)].some((p) => props.has(p))));
    out.push({
      id: `preserve:${t.id}`, kind: 'preserve-broken', sectionId: outcome?.section ?? '', viewport: 'any', elementKey: '', elementLabel: label, state: t.state, property: t.property, expected: 'the original value', observed: r.detail, findingIds: [t.findingId],
      message: `"${label.slice(0, 40)}"${t.state === 'default' ? '' : `, ${t.state}`}: ${t.property} must stay as the original (a preserve decision) but changed — ${r.detail}`,
      responsible: touches ? 'planner' : 'none',
      action: touches ? { type: 'replan', findingIds: [t.findingId], constraint: `${t.property} on "${label.slice(0, 40)}" is a preserve decision and must keep the original value; the rendered preview breaks it: ${r.detail}` } : null,
      blockedReason: touches ? null : `no replayed edit touches ${t.property}, so the change is not caused by an authorized edit of that property (a side effect of another change, a design-system component, or the generator)`,
      targetId: t.id, part: t.part,
    });
  }
  return out;
}

export interface CorrectArgs<A> {
  initial: CorrectionSet;
  /** Generate (and build, serve) the preview with these corrections in force. */
  produce: (c: CorrectionSet) => Promise<A>;
  /** Verify that preview: scope, content, measured targets, interactions, runtime, design/state fidelity. */
  verify: (attempt: A, c: CorrectionSet) => Promise<{ verification: PreviewVerification; fidelity: FidelityReport; attribution: AttributionContext }>;
  resolution: ResolutionFile | null;
  dsFirst?: boolean;
  budget: BudgetTracker;
  /** Evidence from an earlier verification of this same plan, kept (not re-measured) when the budget allows no verification now. */
  previous?: VerifiedAttempt<A> | null;
  log?: (line: string) => void;
}

/** `final` is null when the budget allowed no verification and there was no `previous`: the caller then reports every required check as unverified. */
export interface CorrectOutcome<A> extends LoopResult<VerifiedAttempt<A>, CorrectionSet> {
  corrections: CorrectionSet;
}

export async function verifyAndCorrect<A>(args: CorrectArgs<A>): Promise<CorrectOutcome<A>> {
  const log = args.log ?? (() => {});
  const result = await runCorrectionLoop<VerifiedAttempt<A>, CorrectionSet>({
    initial: args.initial,
    budget: args.budget,
    previous: args.previous ?? null,
    log,
    verify: async (c) => {
      const attempt = await args.produce(c);
      const v = await args.verify(attempt, c);
      return { attempt, ...v };
    },
    feedback: (v) => feedbackOf(v, args.resolution, args.dsFirst ? { dsFirst: true } : {}),
    correct: async (c, actionable) => {
      const next: CorrectionSet = { stateGuards: new Set(c.stateGuards), droppedEdits: new Set(c.droppedEdits), droppedIslands: new Set(c.droppedIslands) };
      const applied: string[] = [];
      for (const fb of actionable) {
        const a = fb.action!;
        if (a.type === 'state-guard') { const k = guardKey(a.findingId, a.property); if (!next.stateGuards.has(k)) { next.stateGuards.add(k); applied.push(`state-guard ${a.findingId}/${a.property}`); } }
        else if (a.type === 'drop-island') { if (!next.droppedIslands.has(a.findingId)) { next.droppedIslands.add(a.findingId); applied.push(`drop-island ${a.findingId}`); } }
        else if (a.type === 'drop-edit') { const k = editKey(a.findingId, a.property); if (!next.droppedEdits.has(k)) { next.droppedEdits.add(k); applied.push(`drop-edit ${a.findingId}/${a.property}`); } }
      }
      return { state: next, applied };
    },
  });
  return { ...result, corrections: result.state };
}

/**
 * The text of everything required that is still not satisfied once the loop has stopped (the structured form, with the failed / unverified
 * split the overall status is built from, is `requiredGapsOf` in status.ts). The loop stopping with "nothing left to correct" is NOT a pass.
 */
export function requiredChecksOpen(v: PreviewVerification, fidelity: FidelityReport | null, resolution: ResolutionFile | null): string[] {
  return requiredGapsOf(v, fidelity, resolution).map((g) => g.text);
}
