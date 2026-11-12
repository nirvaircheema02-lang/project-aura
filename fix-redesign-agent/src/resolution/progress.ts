import type { TargetedEdit } from '../llm/schemas/r-nodes.ts';
import type { AppliedEdit, R3Output } from '../agents/types.ts';
import { setImplementation } from './store.ts';
import type { ResolutionFile, StateName } from './schema.ts';

/**
 * The implementation half of each target's status triple, written as the pipeline progresses: R3 says whether
 * a target is planned (or cannot be represented by a DOM edit), R4 says whether the edit reached the live page.
 * Design status comes from the Resolver; verification status from R5 (live page) and R8 (rendered preview) —
 * the three never overwrite one another, so "planned" is never read as "fixed".
 */

/** The state an edit's selector applies in: a trailing `:hover` / `:focus` / `:focus-visible` / `:active` pseudo-class, else `default`. */
export function stateOfEdit(edit: Pick<TargetedEdit, 'selector'>): StateName {
  const m = /:(hover|focus-visible|focus-within|focus|active)\s*$/.exec(edit.selector.trim());
  if (!m) return 'default';
  return m[1] === 'focus-within' ? 'focus' : (m[1] as StateName);
}

const propOf = (p: string | null | undefined): string => (p ?? '').trim().toLowerCase();

/** R3's per-target notes: planned, or blocked with the reason it has no live-DOM representation. */
export function recordPlan(resolution: ResolutionFile, r3: Pick<R3Output, 'targetNotes'>): void {
  for (const n of r3.targetNotes ?? []) setImplementation(resolution, (t) => t.id === n.targetId, n.implementation, n.detail);
}

/** What R4 did with the planned edits: `applied` only when the selector matched and the property changed on the live page. */
export function recordApplied(resolution: ResolutionFile, applied: AppliedEdit[]): void {
  for (const a of applied) {
    if (a.edit.kind !== 'style' || !a.edit.property) continue;
    const prop = propOf(a.edit.property);
    const state = stateOfEdit(a.edit);
    const reached = a.applied && a.matched > 0;
    setImplementation(
      resolution,
      (t) => t.findingId === a.edit.findingId && propOf(t.property) === prop && t.state === state && t.part === 'self',
      reached ? 'applied' : 'blocked',
      reached ? `applied to ${a.matched} element(s) of the live page` : a.error ?? `the edit matched ${a.matched} element(s) and was not applied`,
    );
  }
}
