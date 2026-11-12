import type { TargetedEdit } from '../llm/schemas/r-nodes.ts';

/**
 * State-safe emission of a style edit.
 *
 * An applied style edit reaches the preview as an `!important` rule keyed on the finding's stamp. An
 * `!important` rule beats the original page's own `:hover` / `:focus` rules for the same property, so a
 * perfectly authorized default-state change can silently erase the original's hover or focus design.
 * The guarded form adds `:not(:hover):not(:focus-within):not(:active)` to the STAMP: the edit applies at
 * rest, and in every interaction state (anywhere over the element or its descendants) the original rules
 * win again. It never widens an edit — it only narrows when it applies.
 */
export const STATE_GUARD = ':not(:hover):not(:focus-within):not(:active)';

export const guardKey = (findingId: string, property: string): string => `${findingId}|${property.trim().toLowerCase()}`;

const STAMP_PREFIX = /^(\[data-fra-element="[^"]+"\])/;

export function guardedSelector(selector: string): string {
  if (selector.includes(STATE_GUARD)) return selector;
  return STAMP_PREFIX.test(selector) ? selector.replace(STAMP_PREFIX, `$1${STATE_GUARD}`) : `${selector}${STATE_GUARD}`;
}

/** Returns the edits with the guarded form applied to every style edit named in `guards` (a set of `guardKey`s). */
export function applyStateGuards(edits: TargetedEdit[], guards: ReadonlySet<string> | undefined): TargetedEdit[] {
  if (!guards || guards.size === 0) return edits;
  return edits.map((e) => (e.kind === 'style' && e.property && guards.has(guardKey(e.findingId, e.property)) ? { ...e, selector: guardedSelector(e.selector) } : e));
}
