/**
 * Every ref a model returns is normalized before any lookup. A real model
 * echoes the syntax it was shown — `ref=e63`, `[ref=e63]`, ` E63 ` — and an
 * exact-match lookup would silently drop each of those, emptying a section or
 * turning a component into a false MATCH. Frame-prefixed refs (`f1e5`) are
 * deliberately not matched: the snapshot parser does not produce them.
 */
export function normalizeRef(raw: string): string | null {
  const m = raw.trim().match(/\b(e\d+)\b/i);
  return m ? (m[1] as string).toLowerCase() : null;
}

/** A model-cited ref that could not be used — recorded in coverage, never dropped silently. */
export interface DroppedRef {
  node: string;
  ref: string;
  reason: string;
}
