import { converter, parse } from 'culori';
import { EXTRACTED_PROPERTIES } from '../t-layer/computed-style.ts';
import { resolveCssVars, resolveToken } from './d3-tokens/resolve.ts';

/**
 * Tailwind v4 class tokens → the CSS longhands they set, restricted to the
 * properties the T-layer extracts (EXTRACTED_PROPERTIES). A D-layer derived
 * view: it reads nothing but the class string and the DS's effective token
 * map, and it never invents a value. A utility whose value cannot be derived
 * exactly returns null and the caller skips it — a missing expectation is
 * safe, a wrong one publishes a false deviation.
 *
 * The semantics are Tailwind v4's as the DS's own pinned compiler emits them
 * (tailwindcss 4.2.4 in core-v2/node_modules; every family below was checked
 * against its real output, 4.3.3 behaves the same):
 *  - Theme-backed utilities compile to `var(--namespace-key)` and resolve at
 *    runtime through whatever the page defines — so `text-sm` expects the
 *    DS's own `--text-sm` (1rem here, NOT Tailwind's 0.875rem) when the DS
 *    defines it, and Tailwind's default only when it does not. A key outside
 *    Tailwind's default theme (`rounded-button`, `text-display`) is not
 *    generated at all unless a consumer adds it to `@theme` (the DS has no
 *    `@theme`), so it is unknown, not assumed.
 *  - An arbitrary value that is a bare `var()` is NEVER type-inferred:
 *    Tailwind picks the utility's default type (`text-[var(--x)]` → color,
 *    `bg-[var(--x)]` → background-color, `border-[var(--x)]` → border-color,
 *    `font-[var(--x)]` → font-weight). When the referenced token's value is
 *    of another type (the DS writes `text-[var(--typography-size-sm)]` for a
 *    font size), the declaration is invalid at computed-value time: the class
 *    sets neither the intended property nor the one it compiled to. That is
 *    reported as unknown with the reason, never "corrected" into the DS's
 *    intent — the rendered component does not have that font size either.
 *  - Spacing numbers are `calc(var(--spacing) * N)`; the DS does not define
 *    `--spacing`, so they are Tailwind's N × 0.25rem.
 */

export interface Declaration {
  property: string;
  /** Set only when the value is exactly `var(--x)` (no fallback). */
  token: string | null;
  /** Any other value, as CSS text; it may itself contain var()/calc() — the comparator resolves those. */
  literal: string | null;
}

/** The DS's effective tokens for the active variant (editorial-light), as D3 declares them. */
export interface UtilityContext {
  tokens: Map<string, string>;
}

export interface ParsedClass {
  /** The utility without variant prefixes, e.g. "h-[var(--button-height-md)]". */
  utility: string;
  /** Responsive gate from sm:/md:/lg:/xl:/2xl:/max-*: prefixes (px), null when none. */
  media: { minWidth?: number; maxWidth?: number } | null;
  /**
   * True when a state/context prefix gates it (hover:, focus:, focus-visible:, active:, disabled:,
   * group-hover:, peer-*, aria-*, data-*, dark:, motion-reduce:, motion-safe:, print:, first:, last:,
   * odd:, even:, open:, placeholder:, before:, after:, *:). Whether such a class can then apply in the
   * rest state is `atRest`: interaction states and pseudo-element/child targets never do, but an
   * element state or a structural position (disabled:, aria-invalid:, data-[state=…]:, last:) is
   * exactly what a real rendered instance may be in.
   */
  stateGated: boolean;
  important: boolean;
  /** The variant prefixes, in source order. */
  variants: string[];
  /**
   * True when a prefix gates it that cannot be evaluated statically
   * (`@md:` container queries, `supports-*`, `has-*`, `not-*`, `rtl:`, an
   * arbitrary `[.x_&]:` selector on the element itself). Such a class may or
   * may not apply at rest: it can be neither expected nor ignored.
   */
  unknownVariant: boolean;
  /**
   * What the prefixes mean for the root element in the rest state the audit
   * captures (breakpoints aside — those are `media`):
   *  - 'never'   a prefix never holds at rest (hover:, focus:, before:,
   *              [&>svg]:, dark: under the light rendering policy) — the class
   *              is fingerprint-only;
   *  - 'maybe'   a prefix may hold for a rendered instance (disabled:,
   *              aria-*, data-*, first:, last:, open:, motion-safe:) or cannot
   *              be evaluated (`unknownVariant`) — its properties can carry
   *              no expectation, and when it holds it beats every plain class
   *              (extra specificity, or a later place in the stylesheet);
   *  - 'applies' nothing but breakpoints gates it.
   */
  atRest: 'applies' | 'maybe' | 'never';
}

/**
 * The full answer for one utility. `declarations` null means "no expectation
 * can be derived"; `touched` then lists the extracted properties the utility
 * nevertheless sets (a theme shadow, `w-full`, a type-mismatched var()), so
 * an earlier class's value for them is not mistaken for the rendered one.
 */
export interface UtilityAnalysis {
  declarations: Declaration[] | null;
  touched: string[];
  /**
   * Extracted properties this utility adds a LAYER to, composed with the
   * layers other utilities set whatever the class order: ring-*,
   * ring-offset-*, inset-ring-*, inset-shadow-* and shadow colors all feed
   * the one `box-shadow` Tailwind v4 assembles from --tw-* variables. While
   * such a class applies, no single class decides the value — only an inline
   * style, which replaces the whole composite.
   */
  layered: string[];
  /** Why the value could not be derived, when that is worth a human's attention (a DS bug, a missing theme key). */
  reason: string | null;
}

const EXTRACTED = new Set<string>(EXTRACTED_PROPERTIES);

/** Tailwind v4's default `--breakpoint-*` theme values (the DS has no @theme, so these are what compile). */
const BREAKPOINT_THEME: Readonly<Record<string, string>> = { sm: '40rem', md: '48rem', lg: '64rem', xl: '80rem', '2xl': '96rem' };
export const BREAKPOINTS_PX: Readonly<Record<string, number>> = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };

// ── Tailwind v4 default theme (tailwindcss 4.2.4 theme.css) ────────────────
// Used only when the DS does not define the variable itself.

const DEFAULT_TEXT_SIZE: Record<string, string> = {
  xs: '0.75rem', sm: '0.875rem', base: '1rem', lg: '1.125rem', xl: '1.25rem', '2xl': '1.5rem', '3xl': '1.875rem',
  '4xl': '2.25rem', '5xl': '3rem', '6xl': '3.75rem', '7xl': '4.5rem', '8xl': '6rem', '9xl': '8rem',
};
const DEFAULT_FONT_WEIGHT: Record<string, string> = {
  thin: '100', extralight: '200', light: '300', normal: '400', medium: '500', semibold: '600', bold: '700', extrabold: '800', black: '900',
};
const DEFAULT_RADIUS: Record<string, string> = {
  xs: '0.125rem', sm: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem', '2xl': '1rem', '3xl': '1.5rem', '4xl': '2rem',
};
const DEFAULT_TRACKING: Record<string, string> = {
  tighter: '-0.05em', tight: '-0.025em', normal: '0em', wide: '0.025em', wider: '0.05em', widest: '0.1em',
};
const DEFAULT_LEADING: Record<string, string> = { tight: '1.25', snug: '1.375', normal: '1.5', relaxed: '1.625', loose: '2' };
const DEFAULT_FONT_FAMILY: Record<string, string> = {
  sans: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'",
  serif: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
};
const DEFAULT_CONTAINER: Record<string, string> = {
  '3xs': '16rem', '2xs': '18rem', xs: '20rem', sm: '24rem', md: '28rem', lg: '32rem', xl: '36rem', '2xl': '42rem',
  '3xl': '48rem', '4xl': '56rem', '5xl': '64rem', '6xl': '72rem', '7xl': '80rem',
};
const SPACING_STEP_REM = 0.25;

/** `--color-white` / `--color-black` in the default theme. Every other palette color is oklch — never guessed. */
const DEFAULT_NAMED_COLOR: Record<string, string> = { white: '#fff', black: '#000' };
const PALETTE_NAMES = new Set([
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple',
  'fuchsia', 'pink', 'rose', 'slate', 'gray', 'zinc', 'neutral', 'stone', 'mauve', 'olive', 'mist', 'taupe',
]);
const PALETTE_COLOR_RE = /^([a-z]+)-(50|100|200|300|400|500|600|700|800|900|950)$/;

// ── Static (keyword) utilities ─────────────────────────────────────────────

const STATIC_UTILITIES: Record<string, Array<[string, string]>> = {
  block: [['display', 'block']],
  'inline-block': [['display', 'inline-block']],
  inline: [['display', 'inline']],
  flex: [['display', 'flex']],
  'inline-flex': [['display', 'inline-flex']],
  grid: [['display', 'grid']],
  'inline-grid': [['display', 'inline-grid']],
  contents: [['display', 'contents']],
  'flow-root': [['display', 'flow-root']],
  table: [['display', 'table']],
  'inline-table': [['display', 'inline-table']],
  'table-row': [['display', 'table-row']],
  'table-cell': [['display', 'table-cell']],
  'list-item': [['display', 'list-item']],
  hidden: [['display', 'none']],
  'items-start': [['align-items', 'flex-start']],
  'items-end': [['align-items', 'flex-end']],
  'items-center': [['align-items', 'center']],
  'items-baseline': [['align-items', 'baseline']],
  'items-stretch': [['align-items', 'stretch']],
  'justify-start': [['justify-content', 'flex-start']],
  'justify-end': [['justify-content', 'flex-end']],
  'justify-center': [['justify-content', 'center']],
  'justify-between': [['justify-content', 'space-between']],
  'justify-around': [['justify-content', 'space-around']],
  'justify-evenly': [['justify-content', 'space-evenly']],
  'justify-stretch': [['justify-content', 'stretch']],
  'justify-normal': [['justify-content', 'normal']],
  'flex-row': [['flex-direction', 'row']],
  'flex-row-reverse': [['flex-direction', 'row-reverse']],
  'flex-col': [['flex-direction', 'column']],
  'flex-col-reverse': [['flex-direction', 'column-reverse']],
  uppercase: [['text-transform', 'uppercase']],
  lowercase: [['text-transform', 'lowercase']],
  capitalize: [['text-transform', 'capitalize']],
  'normal-case': [['text-transform', 'none']],
  underline: [['text-decoration-line', 'underline']],
  overline: [['text-decoration-line', 'overline']],
  'line-through': [['text-decoration-line', 'line-through']],
  'no-underline': [['text-decoration-line', 'none']],
  italic: [['font-style', 'italic']],
  'not-italic': [['font-style', 'normal']],
  'border-solid': [['border-top-style', 'solid']],
  'border-dashed': [['border-top-style', 'dashed']],
  'border-dotted': [['border-top-style', 'dotted']],
  'border-double': [['border-top-style', 'double']],
  'border-hidden': [['border-top-style', 'hidden']],
  'border-none': [['border-top-style', 'none']],
  // Tailwind v4's `rounded` is a static 0.25rem — it does not read --radius-sm.
  rounded: [['border-radius', '0.25rem']],
  'rounded-none': [['border-radius', '0']],
  // Compiled as calc(infinity * 1px); 9999px is what the comparator treats as "fully rounded".
  'rounded-full': [['border-radius', '9999px']],
  'leading-none': [['line-height', '1']],
  'max-w-prose': [['max-width', '65ch']],
  'max-w-none': [['max-width', 'none']],
  'max-h-none': [['max-height', 'none']],
  'bg-none': [['background-image', 'none']],
  // Its own shadow is transparent; a ring on the same element is flagged separately (see `ring`).
  'shadow-none': [['box-shadow', 'none']],
};

/** Utilities that set extracted properties to layout-dependent or unknowable values. */
const TOUCH_ONLY: Record<string, string[]> = {
  'sr-only': ['width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'not-sr-only': ['width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  container: ['width', 'max-width'],
  shadow: ['box-shadow'],
};

/** `text-*` utilities that are neither a color nor a font size. */
const TEXT_NON_VALUE = new Set(['left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip']);
/** `bg-*` utilities for size/position/repeat/attachment/clip/origin/blend — none extracted. */
const BG_NON_VALUE_RE = /^(auto|cover|contain|center|top|bottom|left|right|left-top|left-bottom|right-top|right-bottom|top-left|top-right|bottom-left|bottom-right|repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space|fixed|local|scroll|clip-.+|origin-.+|blend-.+|position-.+|size-.+)$/;

// ── Variants ──────────────────────────────────────────────────────────────

/** Pointer/focus interaction pseudo-classes: none holds at rest (the audit captures a page nobody is hovering or focusing). */
const INTERACTION_VARIANTS = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited', 'target']);

/**
 * Prefixes under which a class never styles the root element at rest:
 * interaction states, pseudo-element and child/descendant targets, and media
 * the audit never renders — `dark:` is `prefers-color-scheme: dark` (the DS
 * defines no class-based dark variant) and the rendering policy pins light.
 */
const NEVER_AT_REST_VARIANTS = new Set([
  ...INTERACTION_VARIANTS,
  'placeholder', 'before', 'after', 'first-letter', 'first-line', 'marker', 'selection', 'file', 'backdrop',
  'details-content', '*', '**', 'dark', 'print', 'starting', 'noscript',
]);

/**
 * Prefixes a rendered instance may well satisfy at rest: element states (a
 * disabled or aria-invalid field — `:enabled`, `:optional`, `:valid` and
 * `:read-only` even match most elements), structural positions (the last
 * item of a list), open disclosures, and reduced-motion media the rendering
 * policy does not pin. The class can be neither expected nor ignored.
 */
const MAY_APPLY_VARIANTS = new Set([
  'disabled', 'enabled', 'checked', 'indeterminate', 'default', 'required', 'optional', 'valid', 'invalid',
  'user-valid', 'user-invalid', 'in-range', 'out-of-range', 'placeholder-shown', 'autofill', 'read-only', 'empty',
  'first', 'last', 'only', 'odd', 'even', 'first-of-type', 'last-of-type', 'only-of-type', 'open', 'inert',
  'motion-safe', 'motion-reduce',
]);
const MAY_APPLY_PREFIX_RE = /^(aria|data|nth|nth-last|nth-of-type|nth-last-of-type)-/;
/** `group-hover:`, `peer-data-[state=open]/item:` — an ancestor's or sibling's state, with an optional group name. */
const RELATIONAL_VARIANT_RE = /^(group|peer)-(.+?)(\/[A-Za-z0-9_-]+)?$/;

type RestGate = 'never' | 'maybe';

/** How a (non-breakpoint) state/context prefix gates a class at rest; null when it is not one this module knows. */
function stateVariantGate(variant: string): RestGate | null {
  if (NEVER_AT_REST_VARIANTS.has(variant)) return 'never';
  if (MAY_APPLY_VARIANTS.has(variant) || MAY_APPLY_PREFIX_RE.test(variant)) return 'maybe';
  const relational = variant.match(RELATIONAL_VARIANT_RE);
  if (relational) {
    // The group/peer element is hovered or focused no more than the root is; any other state of it may hold.
    return INTERACTION_VARIANTS.has(relational[2] as string) ? 'never' : 'maybe';
  }
  return null;
}

/** `(…)` and `[…]` groups emptied, so a combinator inside `:not(.a_.b)` or `[data-x="a_b"]` is not mistaken for one on the root. */
function withoutGroups(selector: string): string {
  let depth = 0;
  let out = '';
  for (const ch of selector) {
    if (ch === '(' || ch === '[') {
      if (depth === 0) out += ch;
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) out += ch;
    } else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * An arbitrary selector variant (`[&>svg]:`, `[&:hover]:`, `[&:not(:first-child)]:`):
 * a combinator or pseudo-element after `&` moves the target off the root
 * (never); a bare interaction pseudo-class is never at rest; anything else
 * on the element itself — `:disabled`, `:last-child`, `:not(:hover)` (which
 * DOES hold at rest), an attribute, an ancestor qualifier `[.x_&]` — may hold.
 */
function arbitraryVariantGate(variant: string): RestGate {
  const selector = variant.slice(1, -1);
  if (!selector.startsWith('&')) return 'maybe';
  const onRoot = withoutGroups(selector.slice(1));
  if (/::|[_>+~\s]/.test(onRoot)) return 'never';
  const pseudo = onRoot.match(/^:([a-z-]+)$/);
  if (pseudo && INTERACTION_VARIANTS.has(pseudo[1] as string)) return 'never';
  return 'maybe';
}

/**
 * Splits a class token into its variant prefixes and utility at top-level
 * colons only — `bg-[image:var(--x)]` and `[&:hover]:x` keep their inner
 * colons. Null when brackets/parentheses are unbalanced (a fragment).
 */
function splitVariants(token: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of token) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') {
      depth--;
      if (depth < 0) return null;
    }
    if (ch === ':' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  if (depth !== 0) return null;
  parts.push(current);
  return parts;
}

/** A CSS length in px for a min-[…]/max-[…] breakpoint value, or null. */
function breakpointPx(value: string): number | null {
  const m = value.match(/^(\d+(?:\.\d+)?)(px|rem|em)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'px' ? n : n * 16;
}

/** The part of a utility outside any [...] / (...) — what must look like a utility name. */
function outsideBrackets(value: string): string {
  let depth = 0;
  let out = '';
  for (const ch of value) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Parses one class token. Null for garbage — whitespace, non-ASCII, unbalanced
 * brackets, or a fragment cut from a template literal (`bg-`, `hover:`) —
 * which is not a class the browser will ever see.
 */
export function parseClass(token: string): ParsedClass | null {
  const raw = token.trim();
  if (!raw || !/^[\x21-\x7e]+$/.test(raw)) return null;
  const segments = splitVariants(raw);
  if (!segments) return null;
  let utility = segments.pop() as string;
  const variants = segments;
  if (variants.some((v) => v === '')) return null;

  let important = false;
  if (utility.startsWith('!')) {
    important = true;
    utility = utility.slice(1);
  } else if (utility.endsWith('!')) {
    important = true;
    utility = utility.slice(0, -1);
  }
  if (!utility || utility.endsWith('-') || utility.includes('${')) return null;
  const bare = outsideBrackets(utility);
  if (!/^-?[A-Za-z@*]?[A-Za-z0-9_\-./@*]*$/.test(bare)) return null;
  if (!/^-?[A-Za-z@[*(]/.test(utility)) return null;

  let minWidth: number | undefined;
  let maxWidth: number | undefined;
  let stateGated = false;
  let unknownVariant = false;
  let neverAtRest = false;
  let mayApply = false;
  for (const v of variants) {
    const breakpoint = breakpointVariant(v);
    if (breakpoint === 'unparsed') {
      unknownVariant = true;
      continue;
    }
    if (breakpoint) {
      if (breakpoint.group === 'min') minWidth = Math.max(minWidth ?? 0, breakpoint.px);
      // Tailwind v4 emits `(width < 40rem)`: 639.98 keeps 640 itself outside the range.
      else maxWidth = Math.min(maxWidth ?? Infinity, breakpoint.px - 0.02);
      continue;
    }
    const gate = v.startsWith('[') ? arbitraryVariantGate(v) : stateVariantGate(v);
    if (gate === null) {
      unknownVariant = true;
      continue;
    }
    // An arbitrary selector that stays on the root (`[.x_&]:`, `[&:has(…)]:`) is not a known state.
    if (v.startsWith('[') && gate === 'maybe') unknownVariant = true;
    else stateGated = true;
    if (gate === 'never') neverAtRest = true;
    else mayApply = true;
  }

  let media: ParsedClass['media'] = null;
  if (minWidth !== undefined || maxWidth !== undefined) {
    media = {};
    if (minWidth !== undefined) media.minWidth = minWidth;
    if (maxWidth !== undefined) media.maxWidth = maxWidth;
  }
  // Every prefix must hold at once: one that never holds at rest outweighs any that may.
  const atRest: ParsedClass['atRest'] = neverAtRest ? 'never' : mayApply || unknownVariant ? 'maybe' : 'applies';
  return { utility, media, stateGated, important, variants, unknownVariant, atRest };
}

// ── Breakpoint variants and their stylesheet order ────────────────────────

interface BreakpointVariant {
  /** Tailwind v4 registers the `max-*` group before the min group (`sm`…`2xl` and `min-*`). */
  group: 'max' | 'min';
  /** The value its media query compares against, as Tailwind resolves it (`40rem`, `900px`). */
  value: string;
  px: number;
}

/**
 * `md:`, `max-lg:`, `min-md:`, `min-[900px]:`, `max-[50rem]:` → the
 * breakpoint it gates on; null when the prefix is not a breakpoint;
 * 'unparsed' for an arbitrary breakpoint whose value is not a plain length.
 */
function breakpointVariant(variant: string): BreakpointVariant | null | 'unparsed' {
  const named = (key: string, group: BreakpointVariant['group']): BreakpointVariant | null => {
    const value = BREAKPOINT_THEME[key];
    const px = BREAKPOINTS_PX[key];
    return value !== undefined && px !== undefined ? { group, value, px } : null;
  };
  const plain = named(variant, 'min');
  if (plain) return plain;
  const prefixed = variant.match(/^(min|max)-(.+)$/);
  if (!prefixed) return null;
  const group = prefixed[1] as BreakpointVariant['group'];
  const rest = prefixed[2] as string;
  const themed = named(rest, group);
  if (themed) return themed;
  const arbitraryValue = rest.match(/^\[(.+)\]$/);
  if (!arbitraryValue) return null;
  const px = breakpointPx(arbitraryValue[1] as string);
  return px === null ? 'unparsed' : { group, value: arbitraryValue[1] as string, px };
}

/**
 * Tailwind v4's own `compareBreakpoints`: values are bucketed by unit (or
 * by function name) and the buckets compared as strings BEFORE the numbers
 * — so every `px` breakpoint sorts before every `rem` one, whatever its
 * width (`min-[2000px]:` comes before `sm:`) — then by `parseInt` of the
 * value, ascending for min-width, descending for max-width.
 */
function compareBreakpointValues(a: string, z: string, direction: 'asc' | 'desc'): number {
  if (a === z) return 0;
  const aFunction = a.indexOf('(');
  const zFunction = z.indexOf('(');
  const aBucket = aFunction === -1 ? a.replace(/[\d.]+/g, '') : a.slice(0, aFunction);
  const zBucket = zFunction === -1 ? z.replace(/[\d.]+/g, '') : z.slice(0, zFunction);
  const byBucket = aBucket === zBucket ? 0 : aBucket < zBucket ? -1 : 1;
  const order = byBucket || (direction === 'asc' ? Number.parseInt(a, 10) - Number.parseInt(z, 10) : Number.parseInt(z, 10) - Number.parseInt(a, 10));
  if (Number.isNaN(order)) return a < z ? -1 : 1;
  return order;
}

function compareBreakpointVariants(a: BreakpointVariant, z: BreakpointVariant): number {
  if (a.group !== z.group) return a.group === 'max' ? -1 : 1;
  return compareBreakpointValues(a.value, z.value, a.group === 'max' ? 'desc' : 'asc');
}

/** A class's breakpoint variants, highest stylesheet position first; variants that compare equal share one position. */
function breakpointKey(variants: readonly string[]): BreakpointVariant[] {
  const key: BreakpointVariant[] = [];
  for (const v of variants) {
    const bp = breakpointVariant(v);
    if (bp && bp !== 'unparsed' && !key.some((k) => compareBreakpointVariants(k, bp) === 0)) key.push(bp);
  }
  return key.sort((a, z) => compareBreakpointVariants(z, a));
}

/**
 * Where two classes' breakpoint variants put them relative to each other in
 * Tailwind v4's stylesheet (negative: `a` is emitted first, so `b` wins a
 * tie in specificity). Tailwind sorts a rule by the bit set of its variants'
 * positions, so the highest-placed variant decides and a stacked variant
 * sorts after its own base (`md:max-lg:` after `md:`, before `lg:`). Order
 * within the min group follows compareBreakpointValues — NOT the width alone.
 */
export function compareBreakpointOrder(a: readonly string[], b: readonly string[]): number {
  const aKey = breakpointKey(a);
  const bKey = breakpointKey(b);
  for (let i = 0; i < Math.max(aKey.length, bKey.length); i++) {
    const x = aKey[i];
    const y = bKey[i];
    if (!x) return -1;
    if (!y) return 1;
    const c = compareBreakpointVariants(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

// ── Value helpers ─────────────────────────────────────────────────────────

const VAR_ONLY_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/;

/** `var(--x)` → token `--x`; anything else → literal. */
export function tokenOrLiteral(property: string, value: string): Declaration {
  const v = value.trim();
  const m = v.match(VAR_ONLY_RE);
  return m ? { property, token: m[1] as string, literal: null } : { property, token: null, literal: v };
}

/** Splits on whitespace that is not inside parentheses (box shorthands). */
function splitSpaces(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/** Splits on commas that are not inside parentheses (background layers). */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function formatNumber(n: number): string {
  return String(Number(n.toFixed(6)));
}

const toRgb = converter('rgb');

/** A parseable CSS color (culori), or null. `currentcolor` and CSS-wide keywords are not colors here. */
function isColorValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'currentcolor' || v === 'inherit' || v === 'initial' || v === 'unset' || v === 'revert') return false;
  return parse(v) !== undefined;
}

const LENGTH_RE = /^-?(?:\d+\.?\d*|\.\d+)(px|rem|em|ex|ch|lh|rlh|vw|vh|vmin|vmax|svh|lvh|dvh|svw|lvw|dvw|cqw|cqh|pt|pc|in|cm|mm|q|%)$/i;
const FONT_SIZE_KEYWORDS = new Set(['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large', 'larger', 'smaller']);

function isLengthLike(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === '0' || LENGTH_RE.test(v) || /^(calc|clamp|min|max)\(/.test(v);
}

function isImageValue(value: string): boolean {
  return /^((repeating-)?(linear|radial|conic)-gradient|url|image-set|image|cross-fade|element)\(/i.test(value.trim());
}

function isNumberValue(value: string): boolean {
  return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim());
}

/**
 * Tailwind's arbitrary-value normalization: `_` is a space except inside
 * `url(...)`, inside a custom-property name (`var(--my_token)`), or when
 * escaped as `\_`.
 */
function normalizeArbitrary(value: string): string {
  let out = '';
  let urlDepth = 0;
  let inCustomIdent = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === '\\' && value[i + 1] === '_') {
      out += '_';
      i++;
      continue;
    }
    if (value.startsWith('url(', i)) urlDepth++;
    if (urlDepth > 0 && ch === ')') urlDepth--;
    if (value.startsWith('--', i)) inCustomIdent = true;
    else if (inCustomIdent && !/[A-Za-z0-9_-]/.test(ch)) inCustomIdent = false;
    out += ch === '_' && urlDepth === 0 && !inCustomIdent ? ' ' : ch;
  }
  return out;
}

interface ArbitraryValue {
  /** Tailwind's explicit data-type hint (`length`, `color`, `image`, …), or null. */
  hint: string | null;
  value: string;
}

const TYPE_HINTS = new Set([
  'length', 'size', 'color', 'image', 'url', 'number', 'integer', 'percentage', 'family-name', 'generic-name', 'line-width',
  'position', 'bg-size', 'absolute-size', 'relative-size', 'angle', 'ratio', 'any',
]);

/** `[value]`, `[hint:value]`, `(--x)` or `(hint:--x)` → the value; null when `raw` is not arbitrary. */
function arbitrary(raw: string): ArbitraryValue | null {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1);
    const m = inner.match(/^([a-z-]+):(.+)$/);
    if (m && TYPE_HINTS.has(m[1] as string)) return { hint: m[1] as string, value: normalizeArbitrary(m[2] as string) };
    return { hint: null, value: normalizeArbitrary(inner) };
  }
  if (raw.startsWith('(') && raw.endsWith(')')) {
    const inner = raw.slice(1, -1);
    const m = inner.match(/^(?:([a-z-]+):)?(--[A-Za-z0-9_-]+)$/);
    if (!m) return null;
    return { hint: m[1] ?? null, value: `var(${m[2]})` };
  }
  return null;
}

/** Splits `base/modifier` at the last `/` outside brackets. */
function splitModifier(value: string): { base: string; modifier: string | null } {
  let depth = 0;
  for (let i = value.length - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === ']' || ch === ')') depth++;
    else if (ch === '[' || ch === '(') depth--;
    else if (ch === '/' && depth === 0 && i > 0) return { base: value.slice(0, i), modifier: value.slice(i + 1) };
  }
  return { base: value, modifier: null };
}

/** An opacity modifier (`30`, `[0.05]`, `[5%]`) as a 0..1 fraction; null for var() or anything else. */
function modifierAlpha(modifier: string): number | null {
  if (/^\d+(\.\d+)?$/.test(modifier)) {
    const n = Number(modifier);
    return n >= 0 && n <= 100 ? n / 100 : null;
  }
  const arb = modifier.match(/^\[(.+)\]$/);
  if (!arb) return null;
  const inner = arb[1] as string;
  if (/^\d*\.?\d+%$/.test(inner)) return Number(inner.slice(0, -1)) / 100;
  if (isNumberValue(inner)) {
    const n = Number(inner);
    return n >= 0 && n <= 1 ? n : null;
  }
  return null;
}

/**
 * A color with an opacity modifier, as the browser computes Tailwind v4's
 * `color-mix(in oklab, C p%, transparent)`: mixing with transparent keeps the
 * color and scales its alpha (premultiplied interpolation). Null when the
 * color itself does not parse.
 */
function withAlpha(color: string, alpha: number): string | null {
  const parsed = parse(color.trim());
  if (!parsed) return null;
  const rgb = toRgb(parsed);
  const channel = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255);
  const a = Math.round((rgb.alpha ?? 1) * alpha * 1000) / 1000;
  return `rgba(${channel(rgb.r)}, ${channel(rgb.g)}, ${channel(rgb.b)}, ${formatNumber(a)})`;
}

/** The DS's own value for a theme variable when it defines one (as a token), else Tailwind's default (as a literal). */
function themeValue(ctx: UtilityContext, variable: string, fallback: string | undefined): string | null {
  if (ctx.tokens.has(variable)) return `var(${variable})`;
  return fallback ?? null;
}

/** N × the spacing step — `calc(var(--spacing) * N)` evaluated when the DS's --spacing is a plain length. */
function spacingValue(n: number, ctx: UtilityContext): string {
  if (ctx.tokens.has('--spacing')) {
    const resolved = resolveToken('--spacing', ctx.tokens);
    const m = resolved?.match(/^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)$/);
    if (!m) return `calc(var(--spacing) * ${formatNumber(n)})`;
    return `${formatNumber(n * Number(m[1]))}${m[2]}`;
  }
  return `${formatNumber(n * SPACING_STEP_REM)}rem`;
}

/** A bare spacing number Tailwind v4 generates: a non-negative multiple of 0.25. */
function spacingMultiplier(value: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n * 4) ? n : null;
}

const ok = (declarations: Declaration[]): UtilityAnalysis => ({ declarations: declarations.length > 0 ? declarations : null, touched: [], layered: [], reason: null });
const nothing = (): UtilityAnalysis => ({ declarations: null, touched: [], layered: [], reason: null });
const unknown = (touched: string[], reason: string | null = null): UtilityAnalysis => ({
  declarations: null,
  touched: touched.filter((p) => EXTRACTED.has(p)),
  layered: [],
  reason,
});
/** A utility that only adds a layer to a composite property (see UtilityAnalysis.layered). */
const layer = (properties: string[], reason: string | null = null): UtilityAnalysis => ({
  declarations: null,
  touched: [],
  layered: properties.filter((p) => EXTRACTED.has(p)),
  reason,
});

// ── CSS declaration → extracted longhands ─────────────────────────────────

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const BORDER_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);

/** Values of a 1–4 part box shorthand in top/right/bottom/left order. A single var() whose token is multi-part is split on its resolved value. */
function boxValues(value: string, ctx: UtilityContext, count: 2 | 4): string[] | null {
  let parts = splitSpaces(value);
  if (parts.length === 1 && VAR_ONLY_RE.test(parts[0] as string)) {
    const resolved = resolveCssVars(parts[0] as string, ctx.tokens);
    if (resolved !== null && splitSpaces(resolved).length > 1) parts = splitSpaces(resolved);
  }
  if (parts.length === 0 || parts.length > count) return null;
  if (count === 2) {
    const [a, b = a] = parts as [string, string?];
    return [a, b];
  }
  const [a, b = a, c = a, d = b] = parts as [string, string?, string?, string?];
  return [a, b, c, d];
}

/**
 * Expands one CSS declaration — as Tailwind emits it, or as an inline style
 * sets it — into the extracted longhands. Logical properties map to physical
 * ones for a left-to-right page (the audited site is LTR). Anything whose
 * per-longhand value is not certain (a multi-part var(), an elliptical
 * radius, the `font` shorthand) is reported as touched, not guessed.
 */
export function cssPropertyDeclarations(property: string, value: string, ctx: UtilityContext): { declarations: Declaration[]; touched: string[] } {
  const prop = property.trim().toLowerCase();
  const v = value.trim();
  const declarations: Declaration[] = [];
  const touched: string[] = [];
  if (!v) return { declarations, touched };

  const perSide = (props: readonly string[], values: string[] | null) => {
    if (!values) {
      touched.push(...props);
      return;
    }
    props.forEach((p, i) => {
      const sideValue = values[i] as string;
      if (sideValue === 'auto' || CSS_WIDE.has(sideValue)) touched.push(p);
      else declarations.push(tokenOrLiteral(p, sideValue));
    });
  };

  if (CSS_WIDE.has(v.toLowerCase())) {
    // `inherit` & co. depend on the parent — touched, never a comparable value. Expanding a
    // placeholder value is simply the way to learn which longhands this property sets.
    const longhands = cssPropertyDeclarations(property, '0', ctx);
    return { declarations, touched: [...longhands.declarations.map((d) => d.property), ...longhands.touched] };
  }

  switch (prop) {
    case 'padding':
    case 'margin':
      perSide(SIDES.map((s) => `${prop}-${s}`), boxValues(v, ctx, 4));
      break;
    case 'padding-inline':
    case 'margin-inline':
      perSide([`${prop.split('-')[0]}-left`, `${prop.split('-')[0]}-right`], boxValues(v, ctx, 2));
      break;
    case 'padding-block':
    case 'margin-block':
      perSide([`${prop.split('-')[0]}-top`, `${prop.split('-')[0]}-bottom`], boxValues(v, ctx, 2));
      break;
    case 'padding-inline-start':
    case 'margin-inline-start':
      perSide([`${prop.split('-')[0]}-left`], [v]);
      break;
    case 'padding-inline-end':
    case 'margin-inline-end':
      perSide([`${prop.split('-')[0]}-right`], [v]);
      break;
    case 'padding-block-start':
    case 'margin-block-start':
      perSide([`${prop.split('-')[0]}-top`], [v]);
      break;
    case 'padding-block-end':
    case 'margin-block-end':
      perSide([`${prop.split('-')[0]}-bottom`], [v]);
      break;
    case 'gap':
      perSide(['row-gap', 'column-gap'], boxValues(v, ctx, 2));
      break;
    case 'border-width':
      perSide(SIDES.map((s) => `border-${s}-width`), boxValues(v, ctx, 4));
      break;
    case 'border-inline-width':
      perSide(['border-left-width', 'border-right-width'], boxValues(v, ctx, 2));
      break;
    case 'border-block-width':
      perSide(['border-top-width', 'border-bottom-width'], boxValues(v, ctx, 2));
      break;
    case 'border-inline-start-width':
      perSide(['border-left-width'], [v]);
      break;
    case 'border-inline-end-width':
      perSide(['border-right-width'], [v]);
      break;
    case 'border-radius':
      if (v.includes('/')) touched.push(...CORNERS.map((c) => `border-${c}-radius`));
      else perSide(CORNERS.map((c) => `border-${c}-radius`), boxValues(v, ctx, 4));
      break;
    case 'border-start-start-radius':
      perSide(['border-top-left-radius'], [v]);
      break;
    case 'border-start-end-radius':
      perSide(['border-top-right-radius'], [v]);
      break;
    case 'border-end-start-radius':
      perSide(['border-bottom-left-radius'], [v]);
      break;
    case 'border-end-end-radius':
      perSide(['border-bottom-right-radius'], [v]);
      break;
    case 'border-color':
    case 'border-block-color':
    case 'border-block-start-color': {
      const first = splitSpaces(v);
      if (first.length === 1) declarations.push(tokenOrLiteral('border-top-color', first[0] as string));
      else if (first.length > 1 && first.length <= 4 && !first.some((p) => p.includes('var('))) declarations.push(tokenOrLiteral('border-top-color', first[0] as string));
      else touched.push('border-top-color');
      break;
    }
    case 'border-style':
    case 'border-block-style':
    case 'border-block-start-style': {
      const first = splitSpaces(v)[0] as string;
      declarations.push(tokenOrLiteral('border-top-style', first));
      break;
    }
    case 'border':
    case 'border-top':
    case 'border-right':
    case 'border-bottom':
    case 'border-left': {
      const sides = prop === 'border' ? SIDES : [prop.slice('border-'.length) as (typeof SIDES)[number]];
      const parsedBorder = parseBorderShorthand(v);
      if (!parsedBorder) {
        touched.push(...sides.map((s) => `border-${s}-width`));
        if (sides.includes('top')) touched.push('border-top-style', 'border-top-color');
        break;
      }
      // Omitted parts reset to their initial values — medium width, none style, currentcolor —
      // and a none/hidden style computes every width to 0.
      const noBorder = parsedBorder.style === 'none' || parsedBorder.style === 'hidden';
      for (const s of sides) declarations.push(tokenOrLiteral(`border-${s}-width`, noBorder ? '0px' : (parsedBorder.width ?? 'medium')));
      if (sides.includes('top')) {
        declarations.push(tokenOrLiteral('border-top-style', parsedBorder.style ?? 'none'));
        declarations.push(tokenOrLiteral('border-top-color', parsedBorder.color ?? 'currentcolor'));
      }
      break;
    }
    case 'background': {
      const layers = splitTopLevelCommas(v);
      if (layers.length === 1 && isColorValue(v)) {
        declarations.push(tokenOrLiteral('background-color', v), { property: 'background-image', token: null, literal: 'none' });
      } else if (layers.every((layer) => splitSpaces(layer).length === 1 && isImageValue(layer))) {
        declarations.push(tokenOrLiteral('background-image', v), { property: 'background-color', token: null, literal: 'transparent' });
      } else if (VAR_ONLY_RE.test(v)) {
        const resolved = resolveCssVars(v, ctx.tokens);
        if (resolved !== null && isColorValue(resolved)) declarations.push(tokenOrLiteral('background-color', v), { property: 'background-image', token: null, literal: 'none' });
        else if (resolved !== null && isImageValue(resolved)) declarations.push(tokenOrLiteral('background-image', v), { property: 'background-color', token: null, literal: 'transparent' });
        else touched.push('background-color', 'background-image');
      } else touched.push('background-color', 'background-image');
      break;
    }
    case 'text-decoration': {
      const parts = splitSpaces(v);
      if (parts.length === 1 && /^(none|underline|overline|line-through)$/.test(v)) declarations.push({ property: 'text-decoration-line', token: null, literal: v });
      else touched.push('text-decoration-line', 'text-decoration-color');
      break;
    }
    case 'font':
      touched.push('font-family', 'font-size', 'font-weight', 'font-style', 'line-height');
      break;
    case 'flex-flow':
      touched.push('flex-direction');
      break;
    case 'place-items':
      touched.push('align-items');
      break;
    case 'place-content':
      touched.push('justify-content');
      break;
    default:
      if (EXTRACTED.has(prop)) declarations.push(tokenOrLiteral(prop, v));
  }
  return { declarations, touched };
}

/** `1px solid rgba(0,0,0,.12)` → its parts. Null when a part is a var() (its type is unknowable here) or unrecognized. */
function parseBorderShorthand(value: string): { width: string | null; style: string | null; color: string | null } | null {
  let width: string | null = null;
  let style: string | null = null;
  let color: string | null = null;
  for (const part of splitSpaces(value)) {
    if (part.includes('var(')) return null;
    if (BORDER_STYLES.has(part)) style = part;
    else if (isLengthLike(part) || /^(thin|medium|thick)$/.test(part)) width = part;
    else if (isColorValue(part) || part.toLowerCase() === 'currentcolor') color = part;
    else return null;
  }
  return { width, style, color };
}

// ── Utility families ──────────────────────────────────────────────────────

/** Utility roots, longest first so `border-t` wins over `border` and `px` over `p`. */
const ROOTS = [
  'inset-shadow', 'inset-ring', 'ring-offset', 'line-clamp', 'decoration', 'tracking', 'leading', 'opacity', 'rounded',
  'border', 'shadow', 'min-w', 'min-h', 'max-w', 'max-h', 'gap-x', 'gap-y', 'size', 'text', 'font', 'ring', 'from', 'via',
  'gap', 'bg', 'to', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me', 'p', 'm',
  'w', 'h',
] as const;

const PADDING_PROPERTY: Record<string, string> = {
  p: 'padding', px: 'padding-inline', py: 'padding-block', pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom',
  pl: 'padding-left', ps: 'padding-inline-start', pe: 'padding-inline-end',
};
const MARGIN_PROPERTY: Record<string, string> = {
  m: 'margin', mx: 'margin-inline', my: 'margin-block', mt: 'margin-top', mr: 'margin-right', mb: 'margin-bottom',
  ml: 'margin-left', ms: 'margin-inline-start', me: 'margin-inline-end',
};
const SIZE_PROPERTY: Record<string, string[]> = {
  w: ['width'], h: ['height'], size: ['width', 'height'], 'min-w': ['min-width'], 'min-h': ['min-height'],
  'max-w': ['max-width'], 'max-h': ['max-height'],
};
/** Sizing keywords whose used value depends on layout (the containing block, the viewport, the content). */
const LAYOUT_SIZE_RE = /^(auto|full|screen|svw|lvw|dvw|svh|lvh|dvh|min|max|fit|lh|\d+\/\d+)$/;

function splitRoot(utility: string): { root: string; value: string | null } | null {
  for (const root of ROOTS) {
    if (utility === root) return { root, value: null };
    if (utility.startsWith(`${root}-`)) return { root, value: utility.slice(root.length + 1) };
  }
  return null;
}

/**
 * The declarations one Tailwind v4 utility (no variant prefix) sets on its
 * element, with the reason when they cannot be derived. See the module
 * comment for the semantics; `utilityDeclarations` is the plain-list view.
 */
export function analyzeUtility(utility: string, ctx: UtilityContext): UtilityAnalysis {
  const u = utility.trim();
  if (!u) return nothing();

  // Arbitrary property: [prop:value]
  const arbitraryProperty = u.match(/^\[([a-z-]+):(.+)\]$/);
  if (arbitraryProperty) {
    const expanded = cssPropertyDeclarations(arbitraryProperty[1] as string, normalizeArbitrary(arbitraryProperty[2] as string), ctx);
    return { declarations: expanded.declarations.length > 0 ? expanded.declarations : null, touched: expanded.touched, layered: [], reason: null };
  }

  const fixed = STATIC_UTILITIES[u];
  if (fixed) return fromCss(fixed, ctx);
  const touchOnly = TOUCH_ONLY[u];
  if (touchOnly) return unknown(touchOnly);

  const negative = u.startsWith('-');
  const split = splitRoot(negative ? u.slice(1) : u);
  if (!split) return nothing();
  const { root, value } = split;

  if (negative && !(root in MARGIN_PROPERTY)) {
    // Only margins are negated here; any other negative utility sets what its positive form sets, value unknown.
    const positive = analyzeUtility(u.slice(1), ctx);
    return unknown([...(positive.declarations ?? []).map((d) => d.property), ...positive.touched]);
  }
  if (root in PADDING_PROPERTY) return spacingFamily([PADDING_PROPERTY[root] as string], value, ctx, false);
  if (root in MARGIN_PROPERTY) return spacingFamily([MARGIN_PROPERTY[root] as string], value, ctx, negative);
  if (root === 'gap') return spacingFamily(['gap'], value, ctx, false);
  if (root === 'gap-x') return spacingFamily(['column-gap'], value, ctx, false);
  if (root === 'gap-y') return spacingFamily(['row-gap'], value, ctx, false);
  if (root in SIZE_PROPERTY) return sizeFamily(root, value, ctx);

  switch (root) {
    case 'text':
      return textFamily(u, value, ctx);
    case 'font':
      return fontFamily(u, value, ctx);
    case 'rounded':
      return roundedFamily(value, ctx);
    case 'border':
      return borderFamily(u, value, ctx);
    case 'bg':
      return bgFamily(u, value, ctx);
    case 'decoration':
      return decorationFamily(u, value, ctx);
    case 'opacity':
      return opacityFamily(value);
    case 'shadow':
      return shadowFamily(u, value, ctx);
    case 'tracking':
      return themeScalarFamily('letter-spacing', '--tracking', DEFAULT_TRACKING, u, value, ctx);
    case 'leading':
      return leadingFamily(u, value, ctx);
    case 'ring':
    case 'ring-offset':
    case 'inset-ring':
    case 'inset-shadow':
      // Widths, colors, offsets and `ring-inset` all set --tw-* layer variables that end up in the
      // element's one composite box-shadow next to shadow-*'s layer, whichever class comes last.
      return layer(['box-shadow']);
    case 'line-clamp':
      return unknown(['display']);
    default:
      // from-/via-/to- only set gradient stop variables; the gradient itself is flagged by bg-gradient-*.
      return nothing();
  }
}

/** The plain list view of `analyzeUtility`: null = nothing that can be expected (the caller skips it). */
export function utilityDeclarations(utility: string, ctx: UtilityContext): Declaration[] | null {
  return analyzeUtility(utility, ctx).declarations;
}

function fromCss(pairs: Array<[string, string]>, ctx: UtilityContext): UtilityAnalysis {
  const declarations: Declaration[] = [];
  const touched: string[] = [];
  for (const [property, value] of pairs) {
    const expanded = cssPropertyDeclarations(property, value, ctx);
    declarations.push(...expanded.declarations);
    touched.push(...expanded.touched);
  }
  return { declarations: declarations.length > 0 ? declarations : null, touched, layered: [], reason: null };
}

/** Padding / margin / gap: N × spacing, `px`, arbitrary values; `auto` is layout-dependent. */
function spacingFamily(properties: string[], value: string | null, ctx: UtilityContext, negative: boolean): UtilityAnalysis {
  const longhands = (css: string) => properties.flatMap((p) => cssPropertyDeclarations(p, css, ctx).declarations.map((d) => d.property));
  if (value === null) return nothing();
  let css: string | null = null;
  if (value === 'px') css = '1px';
  else if (value === 'auto') return unknown(longhands('0'));
  else {
    const n = spacingMultiplier(value);
    if (n !== null) css = spacingValue(n, ctx);
    else {
      const arb = arbitrary(value);
      if (arb) css = arb.value;
      else return unknown(longhands('0')); // a theme key only a consumer's @theme could define
    }
  }
  if (negative) css = negate(css);
  return fromCss(properties.map((p) => [p, css as string]), ctx);
}

function negate(css: string): string {
  if (css === '0' || /^0(\.0+)?[a-z%]*$/.test(css)) return css;
  if (/^(?:\d+\.?\d*|\.\d+)[a-z%]+$/i.test(css)) return `-${css}`;
  return `calc(${css} * -1)`;
}

/** w / h / size / min-* / max-*: fixed lengths only; full/screen/auto/fit/fractions depend on layout. */
function sizeFamily(root: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  const properties = SIZE_PROPERTY[root] as string[];
  if (value === null) return nothing();
  if (value === 'px') return fromCss(properties.map((p) => [p, '1px']), ctx);
  if (value === 'none' && root.startsWith('max-')) return fromCss(properties.map((p) => [p, 'none']), ctx);
  if (LAYOUT_SIZE_RE.test(value)) return unknown(properties);
  if (root === 'max-w' && DEFAULT_CONTAINER[value] !== undefined) {
    const css = themeValue(ctx, `--container-${value}`, DEFAULT_CONTAINER[value]);
    return css === null ? unknown(properties) : fromCss(properties.map((p) => [p, css]), ctx);
  }
  const n = spacingMultiplier(value);
  if (n !== null) return fromCss(properties.map((p) => [p, spacingValue(n, ctx)]), ctx);
  const arb = arbitrary(value);
  if (arb) {
    if (/%|v[wh]\b|vmin|vmax|auto|fit-content|min-content|max-content/.test(arb.value)) return unknown(properties);
    return fromCss(properties.map((p) => [p, arb.value]), ctx);
  }
  return unknown(properties);
}

type ColorOutcome = { kind: 'value'; css: string } | { kind: 'unknown'; reason: string | null };

/**
 * A color utility value — named (`white`, `black/30`), arbitrary literal
 * (`[#e5e5e5]`, `[rgba(…)]`) or token (`[var(--c)]`) — as CSS. Palette
 * colors are oklch values in Tailwind's theme: never guessed.
 */
function colorValue(raw: string, ctx: UtilityContext, utility: string, property: string): ColorOutcome {
  const { base, modifier } = splitModifier(raw);
  const alpha = modifier === null ? 1 : modifierAlpha(modifier);
  if (alpha === null) return { kind: 'unknown', reason: null };

  if (base === 'transparent') return { kind: 'value', css: 'transparent' };
  if (base === 'current' || base === 'inherit') return { kind: 'unknown', reason: null };
  const named = DEFAULT_NAMED_COLOR[base];
  if (named !== undefined) {
    const variable = `--color-${base}`;
    if (modifier === null) return { kind: 'value', css: themeValue(ctx, variable, named) as string };
    const resolved = ctx.tokens.has(variable) ? resolveToken(variable, ctx.tokens) : named;
    const mixed = resolved === null ? null : withAlpha(resolved, alpha);
    return mixed === null ? { kind: 'unknown', reason: null } : { kind: 'value', css: mixed };
  }
  const palette = base.match(PALETTE_COLOR_RE);
  if (palette && PALETTE_NAMES.has(palette[1] as string)) return { kind: 'unknown', reason: null };

  const arb = arbitrary(base);
  if (!arb) return { kind: 'unknown', reason: `${utility}: not a Tailwind v4 default-theme color — generated only if a consumer defines --color-${base} in @theme` };
  if (arb.value.includes('var(')) {
    // `[var(--c)]/50` mixes a runtime value — skipped rather than approximated.
    if (modifier !== null) return { kind: 'unknown', reason: null };
    const resolved = resolveCssVars(arb.value, ctx.tokens);
    if (resolved === null) return { kind: 'unknown', reason: `${utility}: ${arb.value} is not defined in the Design System — the ${property} it compiles to cannot be grounded` };
    if (!isColorValue(resolved)) {
      return {
        kind: 'unknown',
        reason:
          `${utility}: Tailwind v4 compiles an untyped var() here to \`${property}: ${arb.value}\` (a var() is never type-inferred), ` +
          `but it resolves to "${resolved}", which is not a color — the declaration is invalid at computed-value time and the class sets nothing; ` +
          `the intended property would need a type hint (e.g. [length:${arb.value}])`,
      };
    }
    return { kind: 'value', css: arb.value };
  }
  if (!isColorValue(arb.value)) return { kind: 'unknown', reason: null };
  if (modifier === null) return { kind: 'value', css: arb.value };
  const mixed = withAlpha(arb.value, alpha);
  return mixed === null ? { kind: 'unknown', reason: null } : { kind: 'value', css: mixed };
}

/**
 * A font size without a line-height modifier still decides the line height:
 * v4 pairs `text-sm` with `--text-sm--line-height` (ignored — never
 * expected), and tailwind-merge (the DS's cn()) drops an EARLIER `leading-*`
 * when a font-size class follows it. So the line height is marked as set,
 * and only a `leading-*` written after the size can be expected.
 */
function fontSizeOnly(css: string, ctx: UtilityContext): UtilityAnalysis {
  const sized = fromCss([['font-size', css]], ctx);
  return { ...sized, touched: [...sized.touched, 'line-height'] };
}

/** text-*: a font size (theme key, length) or a color (named, literal, token). */
function textFamily(utility: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  if (value === null || TEXT_NON_VALUE.has(value) || value.startsWith('shadow')) return nothing();
  const { base, modifier } = splitModifier(value);

  const themeSize = DEFAULT_TEXT_SIZE[base];
  if (themeSize !== undefined) {
    const size = themeValue(ctx, `--text-${base}`, themeSize) as string;
    if (modifier === null) return fontSizeOnly(size, ctx);
    // An explicit /N modifier IS the line height.
    const lineHeight = lineHeightModifier(modifier, ctx);
    if (lineHeight === null) return unknown(['font-size', 'line-height']);
    return fromCss([['font-size', size], ['line-height', lineHeight]], ctx);
  }

  const arb = arbitrary(base);
  if (arb) {
    const sizeHint = arb.hint === 'length' || arb.hint === 'size' || arb.hint === 'percentage' || arb.hint === 'absolute-size' || arb.hint === 'relative-size';
    const isSize = sizeHint || (arb.hint === null && !arb.value.startsWith('var(') && (isLengthLike(arb.value) || FONT_SIZE_KEYWORDS.has(arb.value)));
    if (isSize) {
      if (modifier === null) return fontSizeOnly(arb.value, ctx);
      const lineHeight = lineHeightModifier(modifier, ctx);
      if (lineHeight === null) return unknown(['font-size', 'line-height']);
      return fromCss([['font-size', arb.value], ['line-height', lineHeight]], ctx);
    }
    if (arb.hint !== null && arb.hint !== 'color') return nothing();
  }

  const color = colorValue(value, ctx, utility, 'color');
  if (color.kind === 'value') return fromCss([['color', color.css]], ctx);
  if (!arb && DEFAULT_NAMED_COLOR[base] === undefined && !PALETTE_COLOR_RE.test(base) && base !== 'transparent' && base !== 'current' && base !== 'inherit') {
    // An unknown key could be a consumer's font size OR color — both are unknowable.
    return unknown(['color', 'font-size'], `${utility}: not a Tailwind v4 default-theme key — generated only if a consumer defines --text-${base} or --color-${base} in @theme`);
  }
  return unknown(['color'], color.reason);
}

/** `/6` → N × spacing, `/[1.5]` → 1.5, `/(--x)` → var(--x). */
function lineHeightModifier(modifier: string, ctx: UtilityContext): string | null {
  const n = spacingMultiplier(modifier);
  if (n !== null) return spacingValue(n, ctx);
  const arb = arbitrary(modifier);
  return arb ? arb.value : null;
}

/** font-*: weight keys, family keys, arbitrary (number → weight, name → family, var() → weight per Tailwind). */
function fontFamily(utility: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  if (value === null) return nothing();
  const weight = DEFAULT_FONT_WEIGHT[value];
  if (weight !== undefined) return fromCss([['font-weight', themeValue(ctx, `--font-weight-${value}`, weight) as string]], ctx);
  const family = DEFAULT_FONT_FAMILY[value];
  if (family !== undefined) return fromCss([['font-family', themeValue(ctx, `--font-${value}`, family) as string]], ctx);

  const arb = arbitrary(value);
  if (!arb) {
    return unknown(['font-family', 'font-weight'], `${utility}: not a Tailwind v4 default-theme key — generated only if a consumer defines --font-${value} or --font-weight-${value} in @theme`);
  }
  if (arb.hint === 'family-name' || arb.hint === 'generic-name') return fromCss([['font-family', arb.value]], ctx);
  if (arb.hint === 'number' || arb.hint === 'integer') return fromCss([['font-weight', arb.value]], ctx);
  if (arb.hint !== null) return nothing();
  if (arb.value.startsWith('var(')) {
    const resolved = resolveCssVars(arb.value, ctx.tokens);
    if (resolved !== null && (isNumberValue(resolved) || /^(normal|bold|bolder|lighter)$/.test(resolved))) return fromCss([['font-weight', arb.value]], ctx);
    return unknown(
      ['font-weight'],
      resolved === null
        ? `${utility}: ${arb.value} is not defined in the Design System`
        : `${utility}: Tailwind v4 compiles an untyped var() under font-* to \`font-weight: ${arb.value}\`, but it resolves to "${resolved}", ` +
            `not a weight — invalid at computed-value time, so it sets no font-family either (a family needs font-[family-name:${arb.value}])`,
    );
  }
  if (isNumberValue(arb.value)) return fromCss([['font-weight', arb.value]], ctx);
  return fromCss([['font-family', arb.value]], ctx);
}

const RADIUS_SIDE_CORNERS: Record<string, string[]> = {
  t: ['border-top-left-radius', 'border-top-right-radius'],
  r: ['border-top-right-radius', 'border-bottom-right-radius'],
  b: ['border-bottom-right-radius', 'border-bottom-left-radius'],
  l: ['border-top-left-radius', 'border-bottom-left-radius'],
  tl: ['border-top-left-radius'],
  tr: ['border-top-right-radius'],
  br: ['border-bottom-right-radius'],
  bl: ['border-bottom-left-radius'],
  // Logical corners, left-to-right.
  s: ['border-top-left-radius', 'border-bottom-left-radius'],
  e: ['border-top-right-radius', 'border-bottom-right-radius'],
  ss: ['border-top-left-radius'],
  se: ['border-top-right-radius'],
  es: ['border-bottom-left-radius'],
  ee: ['border-bottom-right-radius'],
};
const ALL_CORNERS = CORNERS.map((c) => `border-${c}-radius`);

function roundedFamily(value: string | null, ctx: UtilityContext): UtilityAnalysis {
  let corners = ALL_CORNERS;
  let rest = value;
  const side = value?.match(/^(tl|tr|br|bl|ss|se|es|ee|t|r|b|l|s|e)(?:-(.+))?$/);
  if (side) {
    corners = RADIUS_SIDE_CORNERS[side[1] as string] as string[];
    rest = side[2] ?? null;
  }
  let css: string | null;
  if (rest === null) css = '0.25rem';
  else if (rest === 'none') css = '0';
  else if (rest === 'full') css = '9999px';
  else if (DEFAULT_RADIUS[rest] !== undefined) css = themeValue(ctx, `--radius-${rest}`, DEFAULT_RADIUS[rest]);
  else css = arbitrary(rest)?.value ?? null;
  if (css === null) {
    return unknown(corners, `rounded-${value}: not a Tailwind v4 default-theme radius — generated only if a consumer defines --radius-${rest} in @theme`);
  }
  if (corners === ALL_CORNERS) return fromCss([['border-radius', css]], ctx);
  return fromCss(corners.map((c) => [c, css as string]), ctx);
}

const BORDER_WIDTH_SIDES: Record<string, string[]> = {
  all: SIDES.map((s) => `border-${s}-width`),
  x: ['border-left-width', 'border-right-width'],
  y: ['border-top-width', 'border-bottom-width'],
  t: ['border-top-width'],
  r: ['border-right-width'],
  b: ['border-bottom-width'],
  l: ['border-left-width'],
  s: ['border-left-width'],
  e: ['border-right-width'],
};
/** Only the top border color is extracted; these sides include it. */
const BORDER_SIDES_WITH_TOP = new Set(['all', 'y', 't']);

function borderFamily(utility: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  // Table borders (border-collapse, border-spacing-*) set nothing extracted.
  if (value !== null && /^(collapse|separate|spacing(-.+)?)$/.test(value)) return nothing();
  let side = 'all';
  let rest = value;
  const sideMatch = value?.match(/^(x|y|t|r|b|l|s|e)(?:-(.+))?$/);
  if (sideMatch) {
    side = sideMatch[1] as string;
    rest = sideMatch[2] ?? null;
  }
  const widths = BORDER_WIDTH_SIDES[side] as string[];
  const width = (css: string) => fromCss(widths.map((p) => [p, css]), ctx);
  const color = (css: string) => (BORDER_SIDES_WITH_TOP.has(side) ? fromCss([['border-top-color', css]], ctx) : nothing());
  const colorTouched = BORDER_SIDES_WITH_TOP.has(side) ? ['border-top-color'] : [];

  if (rest === null) return width('1px');
  if (/^\d+$/.test(rest)) return width(`${rest}px`);
  const arb = arbitrary(splitModifier(rest).base);
  if (arb && splitModifier(rest).modifier === null) {
    if (arb.hint === 'length' || arb.hint === 'line-width') return width(arb.value);
    if (arb.hint === null && !arb.value.startsWith('var(') && (isLengthLike(arb.value) || /^(thin|medium|thick)$/.test(arb.value))) return width(arb.value);
    if (arb.hint !== null && arb.hint !== 'color') return nothing();
  }
  const c = colorValue(rest, ctx, utility, side === 'all' ? 'border-color' : 'border-top-color');
  if (c.kind === 'value') return color(c.css);
  if (!arb && DEFAULT_NAMED_COLOR[rest] === undefined && !PALETTE_COLOR_RE.test(splitModifier(rest).base) && !['transparent', 'current', 'inherit'].includes(rest)) {
    return unknown([...widths, ...colorTouched], `${utility}: not a Tailwind v4 default-theme key — generated only if a consumer defines it in @theme`);
  }
  return unknown(colorTouched, c.reason);
}

function bgFamily(utility: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  if (value === null || BG_NON_VALUE_RE.test(value)) return nothing();
  if (/^(gradient-to-|linear-|radial|conic)/.test(value)) return unknown(['background-image']);
  const { base, modifier } = splitModifier(value);
  const arb = arbitrary(base);
  if (arb && modifier === null) {
    if (arb.hint === 'image' || arb.hint === 'url') return fromCss([['background-image', arb.value]], ctx);
    if (arb.hint === null && isImageValue(arb.value)) return fromCss([['background-image', arb.value]], ctx);
    if (arb.hint !== null && arb.hint !== 'color') return nothing();
    if (arb.hint === null && !arb.value.startsWith('var(') && !isColorValue(arb.value)) return nothing(); // sizes / positions
  }
  const c = colorValue(value, ctx, utility, 'background-color');
  if (c.kind === 'value') return fromCss([['background-color', c.css]], ctx);
  if (!arb && DEFAULT_NAMED_COLOR[base] === undefined && !PALETTE_COLOR_RE.test(base) && !['transparent', 'current', 'inherit'].includes(base)) {
    return unknown(['background-color'], `${utility}: not a Tailwind v4 default-theme key — generated only if a consumer defines it in @theme`);
  }
  return unknown(['background-color'], c.reason);
}

function decorationFamily(utility: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  if (value === null) return nothing();
  // Thickness (decoration-1, -from-font, -auto, -[2px]) and style (solid, wavy, …) are not extracted.
  if (/^(\d+|auto|from-font|solid|double|dotted|dashed|wavy)$/.test(value)) return nothing();
  const arb = arbitrary(splitModifier(value).base);
  if (arb && arb.hint === null && !arb.value.startsWith('var(') && isLengthLike(arb.value)) return nothing();
  if (arb && arb.hint !== null && arb.hint !== 'color') return nothing();
  const c = colorValue(value, ctx, utility, 'text-decoration-color');
  if (c.kind === 'value') return fromCss([['text-decoration-color', c.css]], ctx);
  return unknown(['text-decoration-color'], c.reason);
}

function opacityFamily(value: string | null): UtilityAnalysis {
  if (value === null) return nothing();
  if (/^\d+$/.test(value) && Number(value) <= 100) return ok([{ property: 'opacity', token: null, literal: formatNumber(Number(value) / 100) }]);
  const arb = arbitrary(value);
  if (!arb) return unknown(['opacity']);
  return ok([tokenOrLiteral('opacity', arb.value)]);
}

/** Tailwind v4's `--shadow-*` theme keys (plus `shadow-inner`): each sets the --tw-shadow layer itself. */
const THEME_SHADOW_KEYS = new Set(['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'inner']);

/**
 * shadow-[…] is an exact box-shadow (Tailwind wraps it in transparent
 * ring/inset layers the comparator ignores). A theme shadow (`shadow-md`)
 * also sets the --tw-shadow layer, in cascade order with shadow-[…] — its
 * value is touched, never guessed. A shadow COLOR (`shadow-black/10`,
 * `shadow-[#000]`) sets --tw-shadow-color, which retints the colors of
 * shadow-[…] and the theme shadows whatever the class order: it is a layer.
 */
function shadowFamily(utility: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  if (value === null) return unknown(['box-shadow']);
  const { base, modifier } = splitModifier(value);
  if (THEME_SHADOW_KEYS.has(base)) return unknown(['box-shadow']);
  const arb = arbitrary(base);
  if (arb && arb.hint === null && !isColorValue(arb.value)) {
    // `shadow-[…]/50` scales the shadow colors' alpha: still this layer, value not derived.
    if (modifier !== null) return unknown(['box-shadow']);
    if (arb.value.startsWith('var(')) {
      const resolved = resolveCssVars(arb.value, ctx.tokens);
      if (resolved !== null && isColorValue(resolved)) return unknown(['box-shadow'], `${utility}: ${arb.value} resolves to a color, not a shadow`);
    }
    return fromCss([['box-shadow', arb.value]], ctx);
  }
  if (arb && arb.hint !== null && arb.hint !== 'color') return nothing();
  if (!arb && DEFAULT_NAMED_COLOR[base] === undefined && !PALETTE_COLOR_RE.test(base) && !['transparent', 'current', 'inherit'].includes(base)) {
    // Not generated unless a consumer's @theme defines it — as a shadow or as a color, so it is treated as a layer.
    return layer(['box-shadow'], `${utility}: not a Tailwind v4 default-theme key — generated only if a consumer defines --shadow-${base} or --color-${base} in @theme`);
  }
  return layer(['box-shadow']);
}

/** tracking-* and similar: a default-theme key (DS override first) or an arbitrary value. */
function themeScalarFamily(property: string, namespace: string, defaults: Record<string, string>, utility: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  if (value === null) return nothing();
  const fallback = defaults[value];
  if (fallback !== undefined) return fromCss([[property, themeValue(ctx, `${namespace}-${value}`, fallback) as string]], ctx);
  const arb = arbitrary(value);
  if (arb) return arb.hint === null || arb.hint === 'length' ? fromCss([[property, arb.value]], ctx) : nothing();
  return unknown([property], `${utility}: not a Tailwind v4 default-theme key — generated only if a consumer defines ${namespace}-${value} in @theme`);
}

function leadingFamily(utility: string, value: string | null, ctx: UtilityContext): UtilityAnalysis {
  if (value !== null) {
    const n = spacingMultiplier(value);
    if (n !== null) return fromCss([['line-height', spacingValue(n, ctx)]], ctx);
  }
  return themeScalarFamily('line-height', '--leading', DEFAULT_LEADING, utility, value, ctx);
}
