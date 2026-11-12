// Vendored verbatim from audit-agent src/ds/d3-tokens/resolve.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
/**
 * `var()` resolution over D3's effective token layer. D3 stores each custom
 * property exactly as declared (`--space-4: var(--space-md)`), which is the
 * right record for provenance but not a value anything can compare against:
 * 35 of the tokens B4 is shown are aliases, some nested with fallbacks
 * (`--semantic-ink-strong → var(--black-900) → var(--color-ramp-black-900, #171717)`).
 *
 * Follows CSS semantics closely enough for comparison: a defined reference is
 * substituted recursively; an undefined one uses its fallback (which may
 * itself contain `var()`); a cycle or an undefined reference with no fallback
 * resolves to null — "cannot be grounded", never a guess.
 */

/** Index of the first comma not nested inside parentheses, or -1. */
function topLevelComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

export function resolveCssVars(value: string, tokens: Map<string, string>, seen: ReadonlySet<string> = new Set()): string | null {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('var(', i);
    if (start === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, start);

    // Find the parenthesis that closes this var( — fallbacks may nest calls.
    let depth = 0;
    let end = -1;
    for (let j = start + 3; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) return null; // malformed — unbalanced parentheses

    const inner = value.slice(start + 4, end);
    const comma = topLevelComma(inner);
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();

    let replacement: string | null = null;
    const declared = tokens.get(name);
    if (declared !== undefined && !seen.has(name)) {
      replacement = resolveCssVars(declared, tokens, new Set([...seen, name]));
    }
    if (replacement === null && fallback !== null) replacement = resolveCssVars(fallback, tokens, seen);
    if (replacement === null) return null;

    out += replacement;
    i = end + 1;
  }
  return out.trim();
}

/** Resolves a token by name. Null when the name is unknown or its chain cannot be grounded. */
export function resolveToken(name: string, tokens: Map<string, string>): string | null {
  const declared = tokens.get(name);
  if (declared === undefined) return null;
  return resolveCssVars(declared, tokens, new Set([name]));
}
