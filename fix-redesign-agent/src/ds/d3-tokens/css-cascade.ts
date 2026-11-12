// Vendored verbatim from audit-agent src/ds/d3-tokens/css-cascade.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
/**
 * A small, purpose-built CSS custom-property block parser — not a general
 * CSS parser. It only needs to find `:root { --x: y; }` /
 * `[data-variant="..."] { --x: y; }` style blocks, optionally nested inside
 * a single `@layer <name> { ... }`, and extract the custom-property
 * declarations inside them. That's the actual shape of the 4 files D3 reads
 * (verified against the real files during this build, 2026-09-11) —
 * IMPLEMENTATION-PLAN.md §3 explicitly recommends this over a full
 * Tailwind/PostCSS build for resolving these specific overrides.
 */

export interface CssBlock {
  /** null = not inside any @layer (i.e. unlayered — wins over everything layered). */
  layer: string | null;
  selectors: string[];
  declarations: Map<string, string>;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Finds the index just after the `{` matching the `{` at `openIndex`, i.e. the index of the matching `}` + 1. */
function findMatchingBraceEnd(css: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`Unbalanced braces starting at index ${openIndex}`);
}

/**
 * Splits `css` into top-level regions: named `@layer <name> { ... }` bodies,
 * and the unlayered text in between. Only single-name `@layer x { ... }`
 * blocks are treated as layers — the bare `@layer a, b, c;` order
 * declaration has no `{` and is left in the unlayered text (harmless, it
 * has no selectors to match).
 */
function splitLayerRegions(css: string): Array<{ layer: string | null; text: string }> {
  const regions: Array<{ layer: string | null; text: string }> = [];
  const layerOpenRe = /@layer\s+([a-zA-Z0-9_-]+)\s*\{/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = layerOpenRe.exec(css))) {
    const layerName = match[1] as string;
    const openBraceIndex = match.index + match[0].length - 1;
    if (openBraceIndex > cursor) {
      regions.push({ layer: null, text: css.slice(cursor, match.index) });
    }
    const bodyEnd = findMatchingBraceEnd(css, openBraceIndex); // index just after the closing `}`
    regions.push({ layer: layerName, text: css.slice(openBraceIndex + 1, bodyEnd - 1) });
    cursor = bodyEnd;
    layerOpenRe.lastIndex = bodyEnd;
  }
  if (cursor < css.length) regions.push({ layer: null, text: css.slice(cursor) });
  return regions;
}

/** Within one region's text, finds `<selector list> { ... }` blocks and extracts `--x: y;` declarations. */
function extractBlocksFromRegion(layer: string | null, text: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  // A selector list is anything since the last `}`/start that isn't itself an at-rule,
  // followed directly by `{`. This matches the actual files' flat structure; nested
  // @media/@supports inside a layer are skipped (their `{` isn't preceded by a bare selector).
  const selectorThenBrace = /([^{}]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = selectorThenBrace.exec(text))) {
    const rawSelector = (match[1] as string).trim();
    const openBraceIndex = match.index + match[0].length - 1;
    const bodyEnd = findMatchingBraceEnd(text, openBraceIndex);
    const body = text.slice(openBraceIndex + 1, bodyEnd - 1);
    selectorThenBrace.lastIndex = bodyEnd;

    if (!rawSelector || rawSelector.startsWith('@')) continue; // skip @media/@supports/etc.
    const selectors = rawSelector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const relevant = selectors.filter((s) => s === ':root' || /^\[data-variant(-section)?=/.test(s));
    if (relevant.length === 0) continue;

    const declarations = new Map<string, string>();
    const declRe = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
    let d: RegExpExecArray | null;
    while ((d = declRe.exec(body))) {
      declarations.set(`--${d[1]}`, (d[2] as string).trim());
    }
    if (declarations.size > 0) blocks.push({ layer, selectors: relevant, declarations });
  }
  return blocks;
}

export function parseCssBlocks(css: string): CssBlock[] {
  const clean = stripComments(css);
  return splitLayerRegions(clean).flatMap((r) => extractBlocksFromRegion(r.layer, r.text));
}
