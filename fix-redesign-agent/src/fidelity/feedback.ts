import type { StateName } from '../resolution/schema.ts';
import { coveredProperties } from './compare.ts';
import type { CorrectionAction, CorrectionFeedback, CorrectionRoute, DifferenceCategory, FidelityDifference, FidelityReport, PlannerFeedbackItem } from './types.ts';

/** What the pipeline knows about HOW the preview was produced — the basis for deciding who can correct a regression. */
export interface AttributionContext {
  /** findingId → the CSS-property edits replayed into the preview for it. */
  editsByFinding: ReadonlyMap<string, ReadonlyArray<{ property: string | null; kind: string }>>;
  /** Findings whose element is a mounted design-system component in the preview. */
  islandFindingIds: ReadonlySet<string>;
  /** Sections rendered as hand-authored React. */
  overrideSectionIds: ReadonlySet<string>;
}

const KIND: Record<DifferenceCategory, CorrectionFeedback['kind'] | null> = {
  'default-style': 'default-regression',
  hover: 'state-regression',
  'focus-visible': 'state-regression',
  alignment: 'alignment-regression',
  composition: 'composition-regression',
  sticky: 'sticky-regression',
  'element-unmatched': 'element-regression',
  'state-unavailable': null, // not a regression: reported as unavailable, never as passed
};

function messageOf(d: FidelityDifference): string {
  const where = `"${d.elementLabel.slice(0, 40)}" in ${d.sectionId} at the ${d.viewport} viewport`;
  if (d.category === 'hover' || d.category === 'focus-visible') return `${where}, ${d.category === 'hover' ? 'hovered' : 'keyboard-focused'}: ${d.property} should be ${d.baseline} (the original), but is ${d.observed}.`;
  if (d.property) return `${where}${d.state === 'default' ? '' : `, ${d.state}`}: ${d.property} should be ${d.baseline} (the original), but is ${d.observed}.`;
  return `${where}: ${d.detail}`;
}

function actionFor(d: FidelityDifference, ctx: AttributionContext): { route: CorrectionRoute; action: CorrectionAction | null; blockedReason: string | null } {
  if (ctx.overrideSectionIds.has(d.sectionId)) return { route: 'override', action: null, blockedReason: 'this section is hand-authored React; the change belongs in its override module (session-authored), not in an automatic correction' };
  const findings = d.findingIds;
  // a design-system component that changes something no authorized target covers
  const island = findings.find((f) => ctx.islandFindingIds.has(f));
  if (island) return { route: 'preview-generator', action: { type: 'drop-island', findingId: island, reason: `the design-system component changes ${d.property ?? d.category} (${d.state}), which no authorized target covers` }, blockedReason: null };
  // a replayed CSS edit that is not state-safe: it applies `!important` in states where the original had its own rule
  if (d.property && (d.category === 'hover' || d.category === 'focus-visible') ) {
    for (const f of findings) {
      const edits = ctx.editsByFinding.get(f) ?? [];
      const hit = edits.find((e) => e.property && coveredProperties(e.property).has(d.property!));
      if (hit?.property) return { route: 'preview-generator', action: { type: 'state-guard', findingId: f, property: hit.property }, blockedReason: null };
    }
    const anyEdit = findings.some((f) => (ctx.editsByFinding.get(f)?.length ?? 0) > 0);
    return { route: 'preview-generator', action: null, blockedReason: anyEdit ? `no replayed edit touches ${d.property}, so the ${d.state} difference is not caused by an authorized edit (a generator defect, or a state the page's script drives)` : 'no authorized edit or component is attributed to this element, so the difference comes from the generator itself' };
  }
  if (d.property && d.category === 'default-style') {
    for (const f of findings) {
      const edits = ctx.editsByFinding.get(f) ?? [];
      const hit = edits.find((e) => e.property && coveredProperties(e.property).has(d.property!));
      if (hit?.property) return { route: 'planner', action: { type: 'replan', findingIds: [f], constraint: `${d.property} on "${d.elementLabel.slice(0, 40)}" must keep the original value ${d.baseline} unless a resolved target authorizes a change; the preview shows ${d.observed}` }, blockedReason: null };
    }
  }
  return { route: 'preview-generator', action: null, blockedReason: findings.length ? 'the difference sits on an element of an authorized finding, but no replayed edit or mounted component accounts for it' : 'no authorized finding is attributed to this element, so the difference comes from the generator itself (or the page\'s own script)' };
}

/** Every regression becomes one actionable record: element, state, viewport, expected, observed, and who can correct it. */
export function deriveFeedback(report: FidelityReport, ctx: AttributionContext): CorrectionFeedback[] {
  const out: CorrectionFeedback[] = [];
  for (const d of report.differences) {
    if (d.classification !== 'regression') continue;
    const kind = KIND[d.category];
    if (!kind) continue;
    const a = actionFor(d, ctx);
    out.push({
      id: d.id, kind, sectionId: d.sectionId, viewport: d.viewport, elementKey: d.elementKey, elementLabel: d.elementLabel, state: d.state as StateName, property: d.property,
      expected: d.baseline, observed: d.observed, findingIds: d.findingIds, message: messageOf(d), responsible: a.route, action: a.action, blockedReason: a.blockedReason,
    });
  }
  return out;
}

/** A resolved target that was NOT met when measured in the rendered preview: the planner is asked to re-plan with it as a hard constraint. */
export function feedbackForUnmetTargets(unmet: Array<{ targetId: string; findingId: string; property: string; state: StateName; expected: string; observed: string; label: string; sectionId: string; part?: string }>): CorrectionFeedback[] {
  return unmet.map((u) => ({
    id: `target:${u.targetId}`, kind: 'target-not-met' as const, sectionId: u.sectionId, viewport: 'any' as const, elementKey: '', elementLabel: u.label, state: u.state, property: u.property, expected: u.expected, observed: u.observed, findingIds: [u.findingId],
    message: `"${u.label.slice(0, 40)}" in ${u.sectionId}${u.state === 'default' ? '' : `, ${u.state}`}: ${u.property} should be ${u.expected} (a resolved target) but measures ${u.observed} in the rendered preview.`,
    responsible: 'planner' as const,
    action: { type: 'replan' as const, findingIds: [u.findingId], constraint: `${u.property} on "${u.label.slice(0, 40)}" must measure ${u.expected}${u.state === 'default' ? '' : ` in the ${u.state} state`}; the rendered preview measures ${u.observed}. An edit that does not reach the visible element is not a fix.` },
    blockedReason: null,
    targetId: u.targetId,
    ...(u.part !== undefined ? { part: u.part } : {}),
  }));
}

const PLANNER_KINDS = new Set<CorrectionFeedback['kind']>(['target-not-met', 'default-regression', 'preserve-broken']);

/**
 * The planner-routed feedback in the structured form R3 consumes. Only a `replan` action with a concrete property is converted: state guards,
 * dropped components/edits and blocked items belong to other routes. A preserve-broken item carries no concrete value (its original is not
 * recorded), so `expected` is null for it rather than the descriptive string the message uses.
 */
export function toPlannerFeedback(feedback: readonly CorrectionFeedback[]): PlannerFeedbackItem[] {
  const out: PlannerFeedbackItem[] = [];
  for (const f of feedback) {
    if (f.action?.type !== 'replan' || !f.property || !PLANNER_KINDS.has(f.kind)) continue;
    out.push({
      id: f.id, kind: f.kind as PlannerFeedbackItem['kind'], findingIds: [...new Set(f.action.findingIds)], targetId: f.targetId ?? null, property: f.property, part: f.part ?? null, state: f.state, viewport: f.viewport,
      expected: f.kind === 'preserve-broken' ? null : f.expected, observed: f.observed, elementLabel: f.elementLabel, sectionId: f.sectionId, constraint: f.action.constraint,
    });
  }
  return out;
}
