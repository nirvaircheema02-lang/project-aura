import { join } from 'node:path';
import { applyEdit, isSingleSelector } from '../../dom/apply-edit.ts';
import { redesignPolicyViolation } from '../../redesign-policy.ts';
import { buildDsTokenIndex } from '../../resolution/ds-evidence.ts';
import { compositeTilesToFile } from '../../imaging/index.ts';
import { STAMP_ATTR_ELEMENT } from '../../mapping/stamp.ts';
import { captureOverviewTiles } from '../../t-layer/screenshot.ts';
import type { RedesignPaths } from '../../output/redesign-store.ts';
import type { AppliedEdit, R4Input, R4Output } from '../types.ts';

/**
 * R4 — Apply & Render (deterministic, §8.6). Applies ONLY the plan's targeted edits to the
 * SAME live page R2 opened (never a detached HTML-string edit-and-reload — §6.7's note),
 * enforcing `expectedMatches` strictly, then captures the after state.
 */

export const R4_STATUS = 'implemented' as const;

export interface R4Deps {
  paths: RedesignPaths;
  log?: (line: string) => void;
  /** The Design System: the colour guard reads its token index to recognise `var(--alias)` as the resolved target's colour. Absent: an alias is refused (it cannot be shown to be one). */
  designSystemPath?: string;
}

/**
 * §security/§6.4's structural guarantee: "a selector may be supplied only to reach a
 * DESCENDANT of a stamped element" is stated as an R3 system-prompt instruction, but a prompt
 * instruction is not an enforcement mechanism — a finding's reviewer-authored `note` (the only
 * free text in this system's inputs) reaches that same prompt unescaped, and an LLM can also
 * simply err. Verified here, in code, against the finding's OWN mapped stamp from
 * `session.mapping` — the one thing R3 cannot override — before any edit ever reaches the DOM.
 */
export function selectorStaysWithinStamp(selector: string, stampElementId: string): boolean {
  const stamp = `[${STAMP_ATTR_ELEMENT}="${stampElementId}"]`;
  if (selector === stamp) return true;
  if (!selector.startsWith(stamp)) return false;
  // may carry ONE interaction-state pseudo-class directly on the stamp (a hover/focus target), then must continue as a DESCENDANT (whitespace) or CHILD (">") of
  // the stamp and be ONE selector: a list (`<stamp> , #o`) or a sibling combinator (`<stamp> ~ #o`, `<stamp> + #o`) would reach elements the finding never selected,
  // and `expectedMatches` would simply count them. Later combinators stay inside the subtree (both sides are descendants). A comment is never part of a selector.
  if (/\/\*|\*\//.test(selector)) return false;
  const rest = selector.slice(stamp.length).replace(/^:(?:hover|focus-visible|focus-within|focus|active)(?![\w-])/, '');
  return rest === '' || (/^(?:\s+|\s*>\s*)(?![>+~])\S/.test(rest) && isSingleSelector(rest));
}

export async function runR4(deps: R4Deps, input: R4Input): Promise<R4Output> {
  const log = deps.log ?? (() => {});
  const { session, plan, iteration, previousApplied } = input;
  const applied: AppliedEdit[] = [];
  const dsIndex = deps.designSystemPath ? buildDsTokenIndex(deps.designSystemPath) : null;

  for (const edit of plan.plan.edits) {
    const entry = session.mapping?.entries.find((e) => e.findingIds.includes(edit.findingId));
    const violation = redesignPolicyViolation(edit, input.r1.fixFindings.find((f) => f.identity.findingId === edit.findingId), entry, input.resolution ?? null, { dsIndex });
    if (violation) {
      applied.push({ edit, matched: 0, applied: false, previousValue: null, error: violation });
      log(`R4 · iteration ${iteration} · NOT applied (${edit.findingId}): ${violation}`);
      continue;
    }
    if (!entry || !selectorStaysWithinStamp(edit.selector, entry.element)) {
      const outcome = { matched: 0, applied: false, previousValue: null, error: entry ? `selector "${edit.selector}" does not stay within finding ${edit.findingId}'s own stamped element ("${entry.element}") — refused, never applied outside the given stamp` : `finding ${edit.findingId} has no mapping entry — refused, cannot verify this edit stays within its own stamp` };
      applied.push({ edit, ...outcome });
      log(`R4 · iteration ${iteration} · NOT applied (${edit.findingId}/${edit.property ?? edit.kind}): ${outcome.error}`);
      continue;
    }
    // §7.5's idempotency key: (findingId, property) alone collides whenever a finding has more
    // than one edit of a kind with no property ('text'/'class'/'component-swap' are always
    // property=null) — kind+selector are what actually distinguish two edits of the same
    // finding from each other, so both are part of the key.
    const prior = previousApplied.find((a) => a.edit.findingId === edit.findingId && a.edit.kind === edit.kind && a.edit.property === edit.property && a.edit.selector === edit.selector && a.applied);
    const outcome = await applyEdit(session.page, edit, prior ? { previousValue: prior.previousValue } : null);
    applied.push({ edit, matched: outcome.matched, applied: outcome.applied, previousValue: outcome.previousValue, error: outcome.error });
    if (!outcome.applied) log(`R4 · iteration ${iteration} · NOT applied (${edit.findingId}/${edit.property ?? edit.kind}): ${outcome.error}`);
  }
  log(`R4 · iteration ${iteration} · applied ${applied.filter((a) => a.applied).length}/${applied.length} edit(s)`);

  const afterTiles = await captureOverviewTiles(session.page, (i) => join(deps.paths.afterTilesDir, `page-tile-${iteration}-${i}.png`));
  const compositeResult = await compositeTilesToFile(afterTiles.tiles.map((t) => t.path), deps.paths.afterPng);

  return {
    iteration,
    applied,
    after: { tiles: afterTiles.tiles, totalHeight: afterTiles.totalHeight, truncated: afterTiles.truncated, composite: compositeResult ? { path: compositeResult.outPath, plan: compositeResult.plan } : null },
  };
}
