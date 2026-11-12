/**
 * Pure CSS-text helpers for the React Preview generator. They run in Node (rewriting) and are
 * also stringified into the page (`normalizeForMatching`, `splitSelectorList`) so the matching
 * done against the live DOM uses exactly the logic that is unit-tested here. Both functions
 * above the line are therefore self-contained: no closure variables, no imports.
 */

/** Splits a selector list on its top-level commas (ignores commas inside (), [] and quotes). */
export function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depthParen = 0;
  let depthBracket = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < list.length; i++) {
    const ch = list[i] as string;
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += list[++i] ?? ''; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\') { cur += ch + (list[++i] ?? ''); continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    if (ch === ',' && depthParen === 0 && depthBracket === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Turns a selector into one that can be tested with `element.matches` for "does this rule
 * apply to some element in the section in SOME state": state pseudo-classes (hover, focus,
 * active …) and pseudo-elements are removed, since they never match statically. A selector
 * that is empty after stripping becomes `*`.
 */
export function normalizeForMatching(sel: string): string {
  let s = sel;
  // pseudo-elements (single or double colon legacy forms) and vendor pseudos
  s = s.replace(/::?(before|after|first-line|first-letter|selection|placeholder|marker|backdrop|file-selector-button|cue|part\([^)]*\)|slotted\([^)]*\))/gi, '');
  s = s.replace(/::-?[a-z-]*(webkit|moz|ms)[a-z-]*(\([^)]*\))?/gi, '');
  s = s.replace(/:-(webkit|moz|ms)-[a-z-]+(\([^)]*\))?/gi, '');
  // state pseudo-classes that depend on user interaction
  s = s.replace(/:(hover|focus|focus-visible|focus-within|active|visited|target|target-within|user-invalid|user-valid|popover-open|open|fullscreen|modal|playing|paused)(?![\w-])/gi, '');
  // :is()/:where()/:not() may now be empty
  s = s.replace(/:(is|where|not)\(\s*\)/gi, '');
  s = s.trim();
  if (!s || /[>+~]\s*$/.test(s)) s = (s + ' *').trim();
  return s || '*';
}

// ── above this line: stringified into the page. Below: Node only. ─────────────────────────────

const IDENT = /[A-Za-z0-9_-]/;

/**
 * Rewrites one selector for use inside a shadow root:
 *  - `:root` → `:host` (custom properties declared on the document root are inherited via the host)
 *  - leading/ancestor `html` and `body` type selectors → attribute selectors on stand-in wrappers
 *    (`[data-pv-html]`, `[data-pv-body]`) that carry the original classes/attributes
 * Type selectors are only rewritten at a compound-selector start, never inside [...], strings, or
 * as class/id names.
 */
export function rewriteSelectorForShadow(sel: string): string {
  let out = '';
  let bracket = 0;
  let quote = '';
  let atCompoundStart = true;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i] as string;
    if (quote) {
      out += ch;
      if (ch === '\\') { out += sel[++i] ?? ''; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\') { out += ch + (sel[++i] ?? ''); atCompoundStart = false; continue; }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '[') { bracket++; out += ch; atCompoundStart = false; continue; }
    if (ch === ']') { bracket = Math.max(0, bracket - 1); out += ch; continue; }
    if (bracket > 0) { out += ch; continue; }
    if (ch === ':' && /^:root(?![\w-])/.test(sel.slice(i))) { out += ':host'; i += 4; atCompoundStart = false; continue; }
    if (atCompoundStart && /[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < sel.length && IDENT.test(sel[j] as string)) j++;
      const ident = sel.slice(i, j);
      const lower = ident.toLowerCase();
      if (lower === 'html') { out += '[data-pv-html]'; i = j - 1; atCompoundStart = false; continue; }
      if (lower === 'body') { out += '[data-pv-body]'; i = j - 1; atCompoundStart = false; continue; }
      out += ident; i = j - 1; atCompoundStart = false; continue;
    }
    if (/\s|[>+~,(]/.test(ch)) { out += ch; atCompoundStart = true; continue; }
    out += ch;
    atCompoundStart = false;
  }
  return out;
}

export interface RuleItem {
  kind: 'style' | 'layer-statement' | 'keyframes' | 'font-face' | 'property' | 'raw';
  /** Wrapper at-rule headers from outermost to innermost, e.g. `@media (min-width: 640px)`, `@layer utilities`. */
  groups: string[];
  selectors?: string[];
  body?: string;
  text?: string;
  name?: string;
  family?: string;
}

/** Renders ordered rule items, re-opening/closing wrapper groups as their paths change. */
export function renderRuleItems(items: RuleItem[], transformSelector: (s: string) => string): string {
  const lines: string[] = [];
  let open: string[] = [];
  const closeTo = (target: string[]) => {
    let common = 0;
    while (common < open.length && common < target.length && open[common] === target[common]) common++;
    while (open.length > common) { open.pop(); lines.push('}'.repeat(1)); }
    for (let k = common; k < target.length; k++) { lines.push(`${target[k]} {`); open.push(target[k] as string); }
  };
  for (const it of items) {
    if (it.kind === 'style') {
      const sels = (it.selectors ?? []).map(transformSelector).filter(Boolean);
      if (sels.length === 0) continue;
      closeTo(it.groups);
      lines.push(`${sels.join(',\n')} { ${it.body ?? ''} }`);
    } else if (it.kind === 'layer-statement' || it.kind === 'raw') {
      closeTo(it.groups);
      lines.push(it.text ?? '');
    } else {
      closeTo(it.groups);
      lines.push(it.text ?? '');
    }
  }
  closeTo([]);
  return lines.join('\n');
}

/** Names referenced by `animation` / `animation-name` declarations in a CSS text. */
export function referencedAnimationNames(css: string, available: ReadonlySet<string>): Set<string> {
  const used = new Set<string>();
  for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/gi)) {
    for (const tok of (m[1] as string).split(/[\s,]+/)) {
      const name = tok.replace(/["']/g, '');
      if (available.has(name)) used.add(name);
    }
  }
  return used;
}

/** Custom-property names (`--x`) referenced by `@property` candidates in a CSS text. */
export function referencesCustomProperty(css: string, name: string): boolean {
  return css.includes(name);
}

/** Every custom property (`--x`) the CSS declares, including `@property` registrations. */
export function definedCustomProperties(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)) out.add(m[1] as string);
  for (const m of css.matchAll(/@property\s+(--[A-Za-z0-9_-]+)/g)) out.add(m[1] as string);
  return out;
}

/**
 * Gives the captured page's custom properties their own namespace (`--pv-…`). Without it the
 * design system's own Tailwind registers properties such as `--tw-gradient-from` as `<color>` at
 * document level, which silently invalidates the page's differently-shaped values inside the
 * shadow roots (found live: a dark hero rendered transparent). Only names the page itself defines
 * are renamed, so references to anything it merely inherits are left alone.
 */
export function makeVarRenamer(defined: ReadonlySet<string>): (text: string) => string {
  if (defined.size === 0) return (t) => t;
  const names = [...defined].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![A-Za-z0-9_-])(${names.join('|')})(?![A-Za-z0-9_-])`, 'g');
  return (text) => text.replace(re, (_m, name: string) => `--pv-${name.slice(2)}`);
}
