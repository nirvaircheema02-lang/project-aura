import { formatPx } from '../skills/nearest-typography.ts';
import { lengthToPx } from '../t-layer/computed-style.ts';

/**
 * REPORT FORMATTING RULE — permanent, DISPLAY ONLY, shared by every report surface.
 *
 *   An Expected typography value that is stored or shown in `rem` is displayed with its resolved px
 *   beside it:  `2.441rem (39.06px)`.
 *
 * Where it applies (one function each, so a surface cannot drift from another):
 *  - `expectedForDisplay`      — a structured Expected value: the compact "actual → expected" summary, the
 *                                detail view's Expected field, every property comparison table cell, the
 *                                Figma plan's actual → expected lines, the Excel Expected columns.
 *  - `recommendationForDisplay` — recommendation / detail PROSE that quotes an Expected value
 *                                (`font-size: 32px → 1.953rem`), however a surface shows it.
 *
 * What it never does: change the stored value. `data.json`, the DS token, the finding's `expected`,
 * its status, its matching/nearest-match result and its recommendation TEXT are exactly what the audit
 * produced — these functions only change how a string is spelled when a report draws it. They are
 * idempotent (a value that already carries its px is returned as it is), and they use the audit's OWN
 * conversion (`lengthToPx`: rem × the root font size) and its own px spelling (`formatPx`, ≤ 2
 * decimals) — nothing is hardcoded to a value.
 *
 * Root context — the page's MEASURED root, never an assumed 16px. A `rem` length resolves against the
 * root font size of the page it is drawn on, so the px beside an expected `rem` value is that value ×
 * the root the audit MEASURED on that page (`readRootFontSizePx`, t-layer/capture.ts — the same read
 * `extractComputedStyle` attaches to every element B3/B4 compared). The capture summary persists it per
 * page (`pageSummary[].rootFontSizePx` in data.json) and `pageRoots(data)` hands each surface the root of
 * the page a finding belongs to. `FALLBACK_ROOT_FONT_SIZE_PX` applies ONLY when a run recorded none (a
 * data.json written before the measurement was persisted, or a record restored from the database) — for
 * such a run the px are shown at the browser default and a re-audit records the real root.
 *
 * Scope: typography lengths only — a rem spacing or radius value is shown exactly as before (widen
 * `TYPOGRAPHY_LENGTH_PROPERTIES`, in this one place, to change that).
 *
 * Templates: this rule is part of what the locked templates draw, so introducing it moved them to
 * `html-report-v11` (render.ts) and `figma-layout-v5` (figma/prompt-contract.ts). Changing the rule —
 * its scope or its spelling — is a template change again: bump the stamp of each template it touches.
 */

/**
 * The root font size used ONLY when no measured root exists for a page: the browser default, and the
 * default `lengthToPx` itself uses when it is given none. Never applied to a page whose root was measured.
 */
export const FALLBACK_ROOT_FONT_SIZE_PX = 16;

/** A measured root is usable only as a finite, positive number (a hand-edited or damaged data.json is not trusted). */
function usableRoot(px: number | null | undefined): number | undefined {
  return typeof px === 'number' && Number.isFinite(px) && px > 0 ? px : undefined;
}

/** What `pageRoots` needs from an audit's data: each page's id, URL and (when recorded) its measured root. */
export interface PageRootSource {
  pageSummary?: ReadonlyArray<{ pageId: string; url: string; rootFontSizePx?: number | null }>;
}

/** The measured root font size (px) of each page of one audit — undefined for a page that recorded none. */
export interface PageRoots {
  /** The root measured on the page a finding was captured on. */
  of(finding: { location: { pageId: string; url: string } }): number | undefined;
  /** The same, by page URL — for aggregate rows (a global issue's example) that carry the URL, not the page id. */
  ofUrl(url: string | null | undefined): number | undefined;
}

export function pageRoots(data: PageRootSource): PageRoots {
  const byId = new Map<string, number>();
  const byUrl = new Map<string, number>();
  for (const page of data.pageSummary ?? []) {
    const root = usableRoot(page.rootFontSizePx);
    if (root === undefined) continue;
    byId.set(page.pageId, root);
    byUrl.set(page.url, root);
  }
  return {
    of: (finding) => byId.get(finding.location.pageId) ?? byUrl.get(finding.location.url),
    ofUrl: (url) => (url ? byUrl.get(url) : undefined),
  };
}

/** The CSS properties whose Expected value is a typographic length — the only ones this rule formats. */
export const TYPOGRAPHY_LENGTH_PROPERTIES: ReadonlySet<string> = new Set(['font-size', 'line-height', 'letter-spacing', 'word-spacing', 'text-indent']);

/** Whether a property row is typography. A compound part is named `part.property` (`label.font-size`). */
export function isTypographyProperty(property: string | null | undefined): boolean {
  if (!property) return false;
  return TYPOGRAPHY_LENGTH_PROPERTIES.has(property.slice(property.lastIndexOf('.') + 1).trim().toLowerCase());
}

/**
 * An expected value written as exactly one `rem` length → `2.441rem (39.06px)`, the px being the rem
 * length × `rootFontSizePx` (the page's measured root; the fallback only when none was recorded).
 * Anything else (a token name, `em`, a compound value, a keyword, "Not resolved") is returned unchanged.
 * null/undefined → ''.
 */
export function withResolvedPx(value: string | null | undefined, rootFontSizePx?: number | null): string {
  if (value == null) return '';
  const m = /^(\s*)(-?(?:\d+\.?\d*|\.\d+)rem)(\s*)$/i.exec(value);
  if (!m) return value;
  const px = lengthToPx(m[2] as string, usableRoot(rootFontSizePx) ?? FALLBACK_ROOT_FONT_SIZE_PX);
  return px === null ? value : `${m[2]} (${formatPx(px)})`;
}

/** A property's Expected value as a report shows it: a typography rem length gains its px, every other value is returned as it is. */
export function expectedForDisplay(property: string | null | undefined, expected: string | null | undefined, rootFontSizePx?: number | null): string {
  if (expected == null) return '';
  return isTypographyProperty(property) ? withResolvedPx(expected, rootFontSizePx) : expected;
}

/**
 * Recommendation / detail prose quotes an Expected value in B4's one format — `<property>: <actual> →
 * <expected>` (`mismatchLine`, src/agents/b4-compliance-auditor/index.ts). A typography `rem` expected
 * value in that position gains its px. B4's own annotation after a nearest-size value
 * (`1.953rem (31.25px — the closest DS size …)`) already carries it and is left alone, and so is a
 * value that was formatted before (idempotent). `test/unit/display-values.test.ts` builds a finding
 * through B4 itself, so a change to that format fails there rather than silently dropping the px.
 */
const QUOTED_TYPOGRAPHY_EXPECTED = new RegExp(`((?:[\\w-]+\\.)?(?:${[...TYPOGRAPHY_LENGTH_PROPERTIES].join('|')}): [^;→]*? → )(-?(?:\\d+\\.?\\d*|\\.\\d+)rem)(?! \\(\\d)`, 'g');

export function recommendationForDisplay(text: string | null | undefined, rootFontSizePx?: number | null): string {
  if (text == null) return '';
  return text.replace(QUOTED_TYPOGRAPHY_EXPECTED, (_whole, head: string, value: string) => `${head}${withResolvedPx(value, rootFontSizePx)}`);
}
