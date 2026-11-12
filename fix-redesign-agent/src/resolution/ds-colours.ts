import { colorsNamed, converter, differenceCiede2000, parse } from 'culori';
import { resolveTokenInScope, type DsTokenIndex } from './ds-evidence.ts';
import type { ColourMapping, ColourRoleName, StateName } from './schema.ts';

/**
 * Colour mapping: a colour that comes from an approved REFERENCE project is never applied as it is. It is read (alpha included), then mapped to the DS token
 * that is the same colour for the same role on the same surface (EXACT), or — when none is — the nearest SUITABLE one (NEAREST); when no DS token can meet the
 * requirement the result is UNMAPPED with the specific gap, and the pattern is refused for it.
 *
 * "Suitable" is a set of constraints, not a distance: role pool (a border is mapped to a border token), scope-safety (the value is read in the surface's
 * own scope), polarity (a darkening hairline stays darkening), strength (it keeps separating by about as much), visibility (a boundary stays visible),
 * alpha kind and text contrast. Every threshold is in `COLOUR_RULES`, with the reason, and a mapping records the numbers it was judged on.
 * Pure: no I/O besides reading the injected DS token index.
 */

// ── thresholds ──────────────────────────────────────────────────────────────────────────────────

export const COLOUR_RULES = {
  /** Two colours are the SAME when every channel is within this (0-255 scale) and the alpha within `exactAlphaTolerance`: one 8-bit step of rounding (1/255 = 0.0039). */
  exactChannelTolerance: 1,
  exactAlphaTolerance: 0.004,
  /** Below this alpha a colour paints nothing: it maps to the keyword `transparent`. */
  transparentAlpha: 0.005,
  /** A nearest match must be within ΔE2000 2.0 of the reference on EVERY backdrop: the bound the verifiers (`propertyMatchesExpected`) already treat as "indistinguishable", so RV and R5/R8 agree. */
  nearestMaxDeltaE: 2.0,
  /** An OPAQUE reference may take an alpha token only on a measured solid backdrop and only this close: the composite then is the colour, but it stops being if the surface changes. */
  opaqueToAlphaMaxDeltaE: 1.0,
  /** How strongly the mapped colour may separate from the backdrop, relative to the reference: observed good matches are 0.79-1.28x; 1.8x (a hairline twice as heavy) is a different look. */
  strengthBand: { min: 0.75, max: 1.5 },
  /** ΔE2000 between a border (composited) and its backdrop below which a hairline is not visible: #f5f5f5 on #f5f2f1 is 1.53, black 8% on #111114 is 0.40. */
  borderVisibilityFloor: 1.5,
  /** A reference that separates less than this from its backdrop (a white fill on white) has no strength to preserve: the band does not apply, the match must stay subtle instead. */
  meaningfulStrength: 1.0,
  /** Below this the colour has no direction (polarity 0): it neither lightens nor darkens its backdrop. */
  polarityNeutralStrength: 0.3,
  /** WCAG 1.4.3 (large text) / 1.4.11 (non-text): the least contrast a text or icon colour needs to be visible at all. */
  textContrastFloor: 3,
  /** The WCAG thresholds a text colour may not cross below if the reference met them. */
  contrastThresholds: [3, 4.5, 7],
  /** A hover/focus colour must differ from the default state by this much (or by the reference's own difference when that is smaller). */
  stateDistinctMinDeltaE: 2.0,
  /** Shadow layers match a DS shadow when offsets, blur and spread are within this many px. */
  shadowGeometryTolerancePx: 1,
  /** A reference shadow layer this faint may be dropped to match a DS shadow (and the drop is recorded). */
  shadowDroppableAlpha: 0.03,
} as const;

// ── colour model ────────────────────────────────────────────────────────────────────────────────

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Rgba extends Rgb {
  alpha: number;
}
export type Surface = 'light' | 'dark';
export type ColourRole = ColourRoleName;
export type ColourTier = 'semantic' | 'role' | 'primitive' | 'component';

const toRgb = converter('rgb');
const toLab = converter('lab');
const deltaE = differenceCiede2000();
const NAMED: ReadonlySet<string> = new Set(Object.keys(colorsNamed));
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOUR_FUNCTIONS: ReadonlySet<string> = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);
/** Colour functions whose result depends on something other than the text (the colour scheme, a contrast partner, a mix): one span, never mappable. */
const DYNAMIC_COLOUR_FUNCTIONS: ReadonlySet<string> = new Set(['color-mix', 'light-dark', 'color-contrast', 'contrast-color', 'device-cmyk']);
/** CSS Color 4 system colours (and the deprecated ones): their value is the user agent's, so they are never a static colour a token can stand for. */
const SYSTEM_COLOURS: ReadonlySet<string> = new Set([
  'accentcolor', 'accentcolortext', 'activetext', 'buttonborder', 'buttonface', 'buttontext', 'canvas', 'canvastext', 'field', 'fieldtext', 'graytext', 'highlight', 'highlighttext',
  'linktext', 'mark', 'marktext', 'selecteditem', 'selecteditemtext', 'visitedtext',
  'activeborder', 'activecaption', 'appworkspace', 'background', 'buttonhighlight', 'buttonshadow', 'captiontext', 'inactiveborder', 'inactivecaption', 'inactivecaptiontext',
  'infobackground', 'infotext', 'menu', 'menutext', 'scrollbar', 'threeddarkshadow', 'threedface', 'threedhighlight', 'threedlightshadow', 'threedshadow', 'window', 'windowframe', 'windowtext',
]);

/**
 * Vendor colour keywords (WebKit/Blink `-webkit-link`, `-webkit-focus-ring-color` ...; Gecko `-moz-hyperlinktext`, `-moz-field` ...): the user agent's colour, exactly like a
 * system colour. The layout keywords that share the prefix (`-webkit-fill-available`, `-webkit-box`, `-moz-available`, `-moz-fit-content` ...) are not colours.
 */
const VENDOR_COLOUR = /^-(?:webkit-(?:link|activelink|focus-ring-color|text)|moz-(?!(?:available|fit-content|min-content|max-content|box|inline-box|stack|inline-stack|grid|inline-grid|groupbox|deck|popup)$)[a-z-]+)$/i;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function balancedFunction(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return false;
      if (depth === 0 && i !== text.length - 1) return false;
    }
  }
  return depth === 0;
}

/**
 * A static CSS colour (hex, rgb()/rgba(), hsl()/hsla(), hwb/lab/lch/oklab/oklch/color(), a named colour, `transparent`) as rgba, or null. Anything dynamic or not a
 * colour (color-mix(), calc(), var(), gradients, keywords, bare numbers — culori itself would read `400` as a colour) is null.
 */
export function parseCssColour(value: string): Rgba | null {
  const v = value.trim();
  if (v === '') return null;
  const lower = v.toLowerCase();
  const plausible = HEX.test(v) || lower === 'transparent' || NAMED.has(lower) || (/^[a-z]+\(/i.test(v) && COLOUR_FUNCTIONS.has(lower.slice(0, lower.indexOf('('))) && balancedFunction(v));
  if (!plausible) return null;
  try {
    const parsed = parse(lower); // function names and keywords are case-insensitive in CSS; culori's parser is not
    if (!parsed) return null;
    const c = toRgb(parsed);
    if (!c || [c.r, c.g, c.b].some((n) => !Number.isFinite(n))) return null;
    return { r: round4(clamp(c.r * 255, 0, 255)), g: round4(clamp(c.g * 255, 0, 255)), b: round4(clamp(c.b * 255, 0, 255)), alpha: round4(clamp(c.alpha ?? 1, 0, 1)) };
  } catch {
    return null; // culori throws on some malformed functions
  }
}

/** An opaque backdrop from a CSS colour (as measured in the page); null for anything translucent or not a colour. */
export function parseBackdrop(value: string): Rgb | null {
  const c = parseCssColour(value);
  return c && c.alpha >= 0.995 ? { r: c.r, g: c.g, b: c.b } : null;
}

export const formatRgb = (c: Rgb): string => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

export function compositeOver(c: Rgba, backdrop: Rgb): Rgb {
  return { r: c.r * c.alpha + backdrop.r * (1 - c.alpha), g: c.g * c.alpha + backdrop.g * (1 - c.alpha), b: c.b * c.alpha + backdrop.b * (1 - c.alpha) };
}

const asCulori = (c: Rgb) => ({ mode: 'rgb' as const, r: c.r / 255, g: c.g / 255, b: c.b / 255 });

export function deltaE2000(a: Rgb, b: Rgb): number {
  return deltaE(asCulori(a), asCulori(b));
}

/** How strongly `c` separates from `backdrop`: ΔE2000 between the composite and the backdrop. */
export function strengthOf(c: Rgba, backdrop: Rgb): number {
  return deltaE2000(compositeOver(c, backdrop), backdrop);
}

function luminance(c: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const lightness = (c: Rgb): number => toLab(asCulori(c)).l;

/** +1: lightens the backdrop, -1: darkens it, 0: no direction (too faint to tell). */
function polarityOf(c: Rgba, backdrop: Rgb): -1 | 0 | 1 {
  const comp = compositeOver(c, backdrop);
  if (deltaE2000(comp, backdrop) < COLOUR_RULES.polarityNeutralStrength) return 0;
  return lightness(comp) > lightness(backdrop) ? 1 : -1;
}

function sameColour(a: Rgba, b: Rgba): boolean {
  return Math.abs(a.alpha - b.alpha) <= COLOUR_RULES.exactAlphaTolerance && Math.abs(a.r - b.r) <= COLOUR_RULES.exactChannelTolerance && Math.abs(a.g - b.g) <= COLOUR_RULES.exactChannelTolerance && Math.abs(a.b - b.b) <= COLOUR_RULES.exactChannelTolerance;
}

// ── extracting colours from a declaration value ─────────────────────────────────────────────────

export interface ColourSpan {
  start: number;
  end: number;
  text: string;
  /** Null when the expression cannot be read as one static colour (see `unsupported`). */
  rgba: Rgba | null;
  keyword?: 'transparent' | 'currentcolor';
  unsupported?: string;
}

function skipQuoted(src: string, i: number): number {
  const quote = src.charAt(i);
  let j = i + 1;
  while (j < src.length) {
    const c = src.charAt(j);
    if (c === '\\') j += 2;
    else if (c === quote) return j + 1;
    else j++;
  }
  return src.length;
}

/** Index just past the `)` that closes the `(` at `open`; the end of the text when it never closes. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src.charAt(i);
    if (c === '"' || c === "'") i = skipQuoted(src, i) - 1;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/**
 * Every colour-like token of a value, in ANY property: a CSS property list of "the ones that take a colour" is never complete (`stop-color`, `flood-color`,
 * `scrollbar-color`, `text-emphasis`, `filter: drop-shadow(...)`, `-webkit-tap-highlight-color` ...), so a named or system colour counts wherever it is written.
 * `var()` and `url()` and strings are skipped (a leftover `var()` is a DS token). A gradient or a dynamic colour function is ONE span flagged unsupported; a
 * system colour is a span that cannot be read (its value is the user agent's); `currentcolor` is a keyword span.
 */
function scan(value: string, intoGradients = false): ColourSpan[] {
  const out: ColourSpan[] = [];
  let i = 0;
  while (i < value.length) {
    const c = value.charAt(i);
    if (c === '"' || c === "'") {
      i = skipQuoted(value, i);
      continue;
    }
    if (c === '#') {
      const text = /^#[0-9a-zA-Z]*/.exec(value.slice(i))?.[0] ?? '#';
      const rgba = HEX.test(text) ? parseCssColour(text) : null;
      out.push({ start: i, end: i + text.length, text, rgba, ...(rgba ? {} : { unsupported: `malformed hex colour ${text}` }) });
      i += text.length;
      continue;
    }
    if (/[A-Za-z_-]/.test(c) && (i === 0 || !/[\w-]/.test(value.charAt(i - 1)))) {
      const ident = /^[A-Za-z0-9_-]+/.exec(value.slice(i))![0];
      const lower = ident.toLowerCase();
      const after = i + ident.length;
      if (value.charAt(after) === '(') {
        const end = closeParen(value, after);
        const text = value.slice(i, end);
        if (lower === 'var' || lower === 'url') {
          i = end;
          continue;
        }
        if (DYNAMIC_COLOUR_FUNCTIONS.has(lower)) out.push({ start: i, end, text, rgba: null, unsupported: `${lower}() is not a static colour` });
        else if (lower.endsWith('-gradient') && !intoGradients) out.push({ start: i, end, text, rgba: null, unsupported: `${lower} is a gradient, not a static colour` });
        else if (COLOUR_FUNCTIONS.has(lower)) {
          const rgba = parseCssColour(text);
          out.push({ start: i, end, text, rgba, ...(rgba ? {} : { unsupported: `${text} could not be read as a colour` }) });
        } else {
          i = after + 1; // another function (calc, drop-shadow, a gradient when reading its stops ...): look inside it, a colour there is still a colour
          continue;
        }
        i = end;
        continue;
      }
      if (lower === 'transparent') out.push({ start: i, end: after, text: ident, rgba: { r: 0, g: 0, b: 0, alpha: 0 }, keyword: 'transparent' });
      else if (lower === 'currentcolor') out.push({ start: i, end: after, text: ident, rgba: null, keyword: 'currentcolor' });
      else if (VENDOR_COLOUR.test(lower)) out.push({ start: i, end: after, text: ident, rgba: null, unsupported: `${ident} is a vendor colour keyword: its value is the user agent's, not a static colour a DS token can stand for` });
      else if (SYSTEM_COLOURS.has(lower)) out.push({ start: i, end: after, text: ident, rgba: null, unsupported: `${ident} is a system colour: its value is the user agent's, not a static colour a DS token can stand for` });
      else if (NAMED.has(lower)) out.push({ start: i, end: after, text: ident, rgba: parseCssColour(lower) });
      i = after;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Every colour of a declaration value to be MAPPED, with its span, so a mapped token can be spliced back as `var(--x)`. `currentcolor` is not one: it is a
 * permitted keyword (REDESIGN_RULES) that follows the element's text colour, so it is kept as written. Use `colourLikeTokens` to ask "does this value contain
 * anything colour-like at all".
 */
export function extractColours(value: string): ColourSpan[] {
  return scan(value).filter((s) => s.keyword !== 'currentcolor');
}

/** Every colour-like token of a value (hex, functions, named and system colours, gradients, `transparent` and `currentcolor`): a value with none is a plain length or keyword. */
export function colourLikeTokens(value: string): string[] {
  return scan(value).map((s) => s.text);
}

/** Is `name` a function through which a colour is written or computed (a colour function, a gradient, a dynamic colour function)? The scanner reads each as a span. */
export const isColourFunction = (name: string): boolean => {
  const n = name.toLowerCase();
  return COLOUR_FUNCTIONS.has(n) || DYNAMIC_COLOUR_FUNCTIONS.has(n) || n.endsWith('-gradient');
};

/**
 * A value in one canonical spelling, for "is this the same value": lower case, no space around `,` `(` `)` `/`, every static colour - the stops of a gradient
 * too - as `rgba(r,g,b,a)` on the 8-bit grid. Hex and `rgb()` spellings of one gradient compare equal; a different stop, an extra stop or other geometry does not.
 */
export function canonicalValue(value: string): string {
  const v = value.replace(/\s*!important\s*$/i, '');
  let out = '';
  let at = 0;
  for (const s of scan(v, true)) {
    out += v.slice(at, s.start) + (s.rgba ? `rgba(${Math.round(s.rgba.r)},${Math.round(s.rgba.g)},${Math.round(s.rgba.b)},${Math.round(s.rgba.alpha * 1000) / 1000})` : s.text);
    at = s.end;
  }
  return (out + v.slice(at)).toLowerCase().replace(/\s*([,()/])\s*/g, '$1').replace(/\s+/g, ' ').trim();
}

// ── which declaration changes which property ────────────────────────────────────────────────────

const SIDES: readonly string[] = ['top', 'right', 'bottom', 'left'];
/**
 * The physical sides a side keyword names. The logical keywords are read with the usual assumption - left-to-right, horizontal-tb: `block-start` is `top`,
 * `inline-start` is `left`. A page in another writing mode or direction would map them differently; the table does not distinguish that (a logical and a physical
 * name are then treated as ONE property, which is the safe direction for "is this property changed": a name is never missed, one may be over-matched).
 */
const SIDE_ALIAS: Record<string, readonly string[]> = {
  top: ['top'], right: ['right'], bottom: ['bottom'], left: ['left'],
  'block-start': ['top'], 'block-end': ['bottom'], 'inline-start': ['left'], 'inline-end': ['right'], block: ['top', 'bottom'], inline: ['left', 'right'],
};
const SIDE_KEYWORD = 'top|right|bottom|left|block-start|block-end|inline-start|inline-end|block|inline';
const CORNER_ALIAS: Record<string, string> = { 'start-start': 'top-left', 'start-end': 'top-right', 'end-start': 'bottom-left', 'end-end': 'bottom-right' };
const sidesOf = (keyword: string | undefined): readonly string[] => (keyword === undefined ? SIDES : (SIDE_ALIAS[keyword] ?? []));
const BORDER_KINDS: readonly string[] = ['color', 'width', 'style'];
const BORDER_IMAGE = ['border-image-source', 'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat'];

/** Shorthands (and aliases) whose longhands are not simply `<name>-*`: the longhands each really sets (`outline` does not set `outline-offset`, `flex` not `flex-direction`). */
const FIXED_SETS: Record<string, readonly string[]> = {
  outline: ['outline-color', 'outline-width', 'outline-style'],
  'column-rule': ['column-rule-color', 'column-rule-width', 'column-rule-style'],
  'text-decoration': ['text-decoration-color', 'text-decoration-line', 'text-decoration-style', 'text-decoration-thickness'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  gap: ['row-gap', 'column-gap'], 'grid-gap': ['row-gap', 'column-gap'], 'grid-row-gap': ['row-gap'], 'grid-column-gap': ['column-gap'],
  overflow: ['overflow-x', 'overflow-y'], 'overflow-block': ['overflow-y'], 'overflow-inline': ['overflow-x'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'], 'flex-flow': ['flex-direction', 'flex-wrap'],
  columns: ['column-width', 'column-count'],
};
/** What a shorthand sets besides its `<name>-*` properties (`font` sets `line-height`). */
const ALSO_SETS: Record<string, readonly string[]> = { font: ['line-height'] };

/**
 * The PHYSICAL longhands a property name writes - a shorthand, a logical alias (`border-block-start-color`, `padding-inline`, `inline-size`) or a longhand itself - or
 * null for a name this table knows nothing about (itself, and by name prefix for an unlisted shorthand: `box-shadow`, `transition`, `background`, `grid`).
 */
function longhandsOf(p: string): readonly string[] | null {
  const fixed = FIXED_SETS[p];
  if (fixed) return fixed;
  let m = new RegExp(`^(margin|padding|scroll-margin|scroll-padding)(?:-(${SIDE_KEYWORD}))?$`).exec(p);
  if (m) return sidesOf(m[2]).map((side) => `${m![1]}-${side}`);
  m = new RegExp(`^inset(?:-(${SIDE_KEYWORD}))?$`).exec(p);
  if (m) return sidesOf(m[1]);
  m = new RegExp(`^border(?:-(${SIDE_KEYWORD}))?(?:-(color|width|style))?$`).exec(p);
  if (m) {
    const out = sidesOf(m[1]).flatMap((side) => (m![2] ? [m![2]] : BORDER_KINDS).map((kind) => `border-${side}-${kind}`));
    return m[1] === undefined && m[2] === undefined ? [...out, ...BORDER_IMAGE] : out;
  }
  m = /^border-(start|end)-(start|end)-radius$/.exec(p);
  if (m) return [`border-${CORNER_ALIAS[`${m[1]}-${m[2]}`]}-radius`];
  m = /^((?:min-|max-)?)(inline|block)-size$/.exec(p);
  if (m) return [`${m[1]}${m[2] === 'inline' ? 'width' : 'height'}`];
  return null;
}

const normName = (p: string): string => (p.trim().startsWith('--') ? p.trim() : p.trim().toLowerCase());
const setOf = (p: string): readonly string[] => longhandsOf(p) ?? [p];
/** Does an unlisted shorthand `d` set `x` by its name (`box-shadow` -> `box-shadow-color`, `font` -> `line-height`)? */
const prefixSets = (d: string, x: string): boolean => longhandsOf(d) === null && !d.startsWith('--') && (x.startsWith(`${d}-`) || (ALSO_SETS[d]?.includes(x) ?? false));
/** `all` resets every property except the custom ones, `direction` and `unicode-bidi`. */
const resetByAll = (p: string): boolean => !p.startsWith('--') && p !== 'direction' && p !== 'unicode-bidi';

/** Does the SHORTHAND (or property) `declared` set `longhand`, strictly more than it? `border-top` sets `border-top-color`; `border` sets `border-color` but not `border-radius`; `border-block` sets `border-top`; `all` sets all but the custom properties. A name never covers itself or an alias of itself. */
export function shorthandCovers(declared: string, longhand: string): boolean {
  const d = normName(declared);
  const l = normName(longhand);
  if (d === l) return false;
  if (d === 'all') return resetByAll(l);
  const D = setOf(d);
  const L = setOf(l);
  return (longhandsOf(d) !== null && L.every((x) => D.includes(x)) && L.length < D.length) || L.every((x) => prefixSets(d, x));
}

/**
 * Does the declaration of `declared` supply `need`, i.e. does writing one change the other? A shorthand supplies the longhands it sets (`border` -> `border-top-color`,
 * `border-block` -> `border-top`), the reverse, two shorthands that share a longhand (`border-block` and `border-top-color`), the logical and the physical name of
 * one property (`border-block-start-color` / `border-top-color`), and `all` supplies everything it resets. No `need`: everything does.
 */
export function suppliesProperty(declared: string, need: string | undefined): boolean {
  if (need === undefined || need === '') return true;
  const d = normName(declared);
  const n = normName(need);
  if (d === 'all' || n === 'all') return d === n || resetByAll(d === 'all' ? n : d);
  const D = setOf(d);
  const N = setOf(n);
  return D.some((x) => N.includes(x)) || N.some((x) => prefixSets(d, x)) || D.some((x) => prefixSets(n, x));
}

/** Is EVERY longhand `property` writes among those the properties in `authorized` write? (`border-top-color` is covered by `border`, `border` is not covered by `border-top-color`.) The authorization direction of `suppliesProperty`: an edit may not change more than it was given. */
export function coveredByAny(property: string, authorized: readonly string[]): boolean {
  const p = normName(property);
  const by = authorized.map(normName);
  if (by.includes('all')) return resetByAll(p) || by.includes(p);
  return setOf(p).every((x) => by.some((a) => setOf(a).includes(x) || prefixSets(a, x)));
}

// ── roles ───────────────────────────────────────────────────────────────────────────────────────

const BORDER_PROPERTY = /^(?:border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|column-rule(?:-color)?)$/;

/** The role a colour plays, from the property it is applied to (a custom property is judged by its name, and may be `unknown`). */
export function roleForProperty(property: string): ColourRole {
  const p = property.trim().toLowerCase();
  if (p.startsWith('--')) {
    if (/border|hairline|divider|(^|-)rule(-|$)|outline/.test(p)) return 'border';
    if (/(^|-)(?:bg|background|tint|surface|fill|wash)(-|$)/.test(p)) return 'fill';
    if (/(^|-)(?:text|ink|color|foreground|fg)(-|$)/.test(p)) return 'text';
    return 'unknown';
  }
  if (BORDER_PROPERTY.test(p)) return 'border';
  if (/^background(?:-color|-image)?$/.test(p)) return 'fill';
  if (/^(?:color|caret-color|-webkit-text-fill-color|text-decoration(?:-color)?)$/.test(p)) return 'text';
  if (p === 'fill' || p === 'stroke') return 'icon';
  if (p === 'box-shadow' || p === 'text-shadow') return 'shadow';
  return 'unknown';
}

/** Sub-roles a token of this DS family may serve, strongest first, for the kinds of component the colour sits on: a tie-break, never a filter. */
export function subRolesForKinds(kinds: readonly string[]): string[] {
  const out: string[] = [];
  const add = (...s: string[]) => {
    for (const x of s) if (!out.includes(x)) out.push(x);
  };
  for (const k of kinds) {
    if (k === 'card' || k === 'panel' || k === 'callout') add('card', 'soft', 'default');
    else if (k === 'accordion' || k === 'row') add('card', 'hairline', 'soft');
    else if (k === 'section' || k === 'strip') add('section', 'hairline', 'soft');
    else if (k === 'input') add('input');
  }
  return out;
}

const PRIMITIVE = /^--(?:color-ramp-|color-foundation-|(?:black|white|warm|neutral|purple|periwinkle|perano|coral|rose|red|green|amber)-\d+$|black$|white$|bg-warm-\d+$)/;
const COMPONENT = /^--(?:table-|glass-|chart-|cta-|label-on-|tooltip-|brand-|icon-|(?:success|warning|error|info)-|semantic-status-|semantic-brand-|semantic-scrim|variant-|accent-|color-(?:accent|semantic|brand|surface|bg|deep|secondary|red)|warmBg|warmBorder|warm-bg|motion-|font-|typography-|z-|section-bg-mesh|semantic-section-bg-mesh)/;
const BORDER_TOKEN = /^--(?:border-(?!radius|width|style)[a-z0-9-]+|semantic-hairline-[a-z0-9-]+)$/;
const FILL_TOKEN = /^--(?:tint-[a-z]+|semantic-surface-[a-z0-9-]+|surface-bg|section-bg-(?:primary|accent|contrast|current)|semantic-section-bg-(?:primary|accent|contrast)|semantic-bg-[a-z]+|bg-pure-[a-z]+|bg-warm)$/;
const TEXT_TOKEN = /^--(?:semantic-ink-[a-z0-9-]+|surface-text(?:-[a-z]+)?|text-(?:primary|secondary))$/;
const SUB_ROLE_WORDS: ReadonlySet<string> = new Set(['card', 'section', 'input', 'active', 'hairline', 'strong', 'default', 'soft', 'faint', 'subtle', 'muted', 'body', 'primary', 'secondary', 'tint', 'page', 'surface']);
// `-active` is deliberately not a state suffix: --border-active is the DS's "focused / emphasised border" role, not the pressed state of another token
const STATE_SUFFIX = /-(hover|focus|disabled)$/;

export interface TokenRole {
  tier: ColourTier;
  roles: ColourRole[];
  subRoles: string[];
  /** The interaction state the token is named for (`-hover`), or null for a rest-state token. */
  state: string | null;
}

/**
 * The tier and roles of a DS colour token, from its NAME (the DS's own naming, measured on its real tokens). Semantic and role tokens serve a role; primitives
 * (ramps, foundations) serve any role but only as an EXACT match; component tokens (table-, glass-, status, chart ...) serve only their own component and
 * never satisfy a generic border/fill/text need.
 */
export function inferTokenRole(token: string): TokenRole {
  const state = STATE_SUFFIX.exec(token)?.[1] ?? null;
  const subRoles = token.replace(/^--/, '').split('-').filter((w) => SUB_ROLE_WORDS.has(w));
  const base = { subRoles, state };
  if (COMPONENT.test(token)) return { ...base, tier: 'component', roles: [] };
  const semantic = token.startsWith('--semantic-');
  if (BORDER_TOKEN.test(token)) return { ...base, tier: semantic ? 'semantic' : 'role', roles: ['border'] };
  if (FILL_TOKEN.test(token)) return { ...base, tier: semantic ? 'semantic' : 'role', roles: ['fill'] };
  if (TEXT_TOKEN.test(token)) return { ...base, tier: semantic ? 'semantic' : 'role', roles: ['text', 'icon'] };
  if (PRIMITIVE.test(token)) return { ...base, tier: 'primitive', roles: [] };
  return { ...base, tier: 'component', roles: [] };
}

// ── shadows ─────────────────────────────────────────────────────────────────────────────────────

export interface ShadowLayer {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  colour: Rgba;
}

function splitTop(value: string, separator: ',' | ' '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    const split = depth === 0 && (separator === ',' ? ch === ',' : /\s/.test(ch));
    if (split) {
      if (cur.trim() !== '') parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

const PX = /^(-?(?:\d+\.?\d*|\.\d+))(?:px)?$/;

/** A literal `box-shadow` list as layers; null when any layer is not plain lengths + one static colour (var(), calc, ...). `none` is the empty list. */
export function parseShadowList(value: string): ShadowLayer[] | null {
  const v = value.trim();
  if (v.toLowerCase() === 'none') return [];
  const layers: ShadowLayer[] = [];
  for (const raw of splitTop(v, ',')) {
    let inset = false;
    const lengths: number[] = [];
    let colour: Rgba | null = null;
    for (const t of splitTop(raw, ' ')) {
      if (t.toLowerCase() === 'inset') inset = true;
      else if (PX.test(t) && lengths.length < 4) lengths.push(Number(PX.exec(t)![1]));
      else {
        const c = parseCssColour(t);
        if (!c || colour) return null;
        colour = c;
      }
    }
    if (!colour || lengths.length < 2) return null;
    layers.push({ inset, x: lengths[0]!, y: lengths[1]!, blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, colour });
  }
  return layers.length > 0 ? layers : null;
}

export interface DsShadowEntry {
  token: string;
  value: string;
  layers: ShadowLayer[];
  scope: string | null;
  file: string | null;
}

// ── the DS colour index ─────────────────────────────────────────────────────────────────────────

export interface DsColourEntry {
  token: string;
  /** The literal value as resolved in the surface's scope. */
  value: string;
  rgba: Rgba;
  surface: Surface;
  /** The variant scope the value was resolved in (null = unscoped / inherited by both surfaces). */
  scope: string | null;
  file: string | null;
  tier: ColourTier;
  roles: ColourRole[];
  subRoles: string[];
  state: string | null;
}

export interface DsColourIndex {
  get(surface: Surface, token: string): DsColourEntry | null;
  entries(surface: Surface): DsColourEntry[];
  shadows(surface: Surface): DsShadowEntry[];
  /** The DS section backgrounds of the surface's scope (those on the surface's own side of light/dark): where a colour is judged when the real backdrop was not measured. */
  backdrops(surface: Surface): Rgb[];
}

const FALLBACK_BACKDROPS: Record<Surface, string[]> = { light: ['#ffffff', '#f5f2f1'], dark: ['#111114', '#1a1a1e', '#050506'] };
const memo = new WeakMap<object, DsColourIndex>();

/**
 * The index of every DS colour token, resolved in each surface's own scope exactly as `resolveTokenInScope` does for a target (so the token chosen here is the
 * literal the target will hold). A token defined only under another scope is absent from this surface. Memoised per DS index.
 */
export function buildDsColourIndex(source: DsTokenIndex): DsColourIndex {
  const cached = memo.get(source);
  if (cached) return cached;
  const names = [...new Set(source.all().map((d) => d.token))].sort();
  const colours: Record<Surface, Map<string, DsColourEntry>> = { light: new Map(), dark: new Map() };
  const shadows: Record<Surface, DsShadowEntry[]> = { light: [], dark: [] };
  for (const surface of ['light', 'dark'] as const) {
    for (const token of names) {
      const r = resolveTokenInScope(source, token, surface);
      if (r.outcome !== 'resolved-target' || r.value === null) continue;
      const rgba = parseCssColour(r.value);
      if (rgba) {
        if (rgba.alpha < COLOUR_RULES.transparentAlpha) continue;
        colours[surface].set(token, { token, value: r.value, rgba, surface, scope: r.scope, file: r.file, ...inferTokenRole(token) });
      } else if (/^--shadow-/.test(token)) {
        const layers = parseShadowList(r.value);
        if (layers) shadows[surface].push({ token, value: r.value, layers, scope: r.scope, file: r.file });
      }
    }
  }
  const backdropCache = new Map<Surface, Rgb[]>();
  const index: DsColourIndex = {
    get: (surface, token) => colours[surface].get(token) ?? null,
    entries: (surface) => [...colours[surface].values()],
    shadows: (surface) => shadows[surface],
    backdrops(surface) {
      const hit = backdropCache.get(surface);
      if (hit) return hit;
      const wanted = (['--section-bg-primary', '--section-bg-accent', '--section-bg-contrast'] as const).map((t) => colours[surface].get(t)?.rgba ?? null);
      const found = wanted.filter((c): c is Rgba => c !== null && c.alpha >= 0.995).map((c) => ({ r: c.r, g: c.g, b: c.b }));
      const base = found.length > 0 ? found : FALLBACK_BACKDROPS[surface].map((c) => parseBackdrop(c)!);
      const sameSide = base.filter((c) => (lightness(c) > 50) === (surface === 'light'));
      const out = sameSide.length > 0 ? sameSide : base;
      backdropCache.set(surface, out);
      return out;
    },
  };
  memo.set(source, index);
  return index;
}

// ── mapping ─────────────────────────────────────────────────────────────────────────────────────

export interface ReferenceColourInput {
  /** The colour as written in the declaration (`var(--faq-border)`, `rgba(0,0,0,.08)`). */
  text: string;
  /** What it resolves to in the reference project, as written there (`#f5f5f5`). */
  resolved: string;
  rgba: Rgba;
  /** The reference project's token that supplied it, if any. */
  token: string | null;
  /** The project tokens followed to reach it, outermost first. */
  chain: string[];
  /** The whole declaration value the colour sits in. */
  declaration: string;
}

export interface ColourContext {
  property: string;
  role: ColourRole;
  /** Sub-role hints from the kind of element, strongest first (a tie-break; see `subRolesForKinds`). */
  subRoles?: readonly string[];
  state: StateName;
  surface: Surface;
  /** The opaque backdrops the colour must hold on. Empty/absent: the DS section backgrounds of the surface (`backdropSource` 'ds-section-tokens'). */
  backdrops?: readonly Rgb[];
  backdropSource?: 'measured' | 'ds-section-tokens';
  /** The text colour that sits on a fill being mapped, when known: it must keep the contrast it had. */
  textColour?: Rgb | null;
}

const NOT_RUN = { status: 'not-run' as const, measuredBy: null, backdrop: null, strength: null, detail: null };
const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();
const stateSuffix = (state: StateName): string | null => (state === 'hover' ? 'hover' : state === 'focus' || state === 'focus-visible' ? 'focus' : state === 'disabled' ? 'disabled' : null);
const TIER_RANK: Record<ColourTier, number> = { semantic: 0, role: 1, primitive: 2, component: 3 };
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The canonical token file ranks before legacy aliases of the same primitive. */
const canonicalFile = (e: { file: string | null }): number => (e.file !== null && e.file.startsWith('tokens/') ? 0 : 1);

interface Judged {
  entry: DsColourEntry;
  pass: boolean;
  why: string | null;
  perBackdrop: number[];
  maxDeltaE: number;
  /** min over backdrops of strength(candidate) / strength(reference) — null when the reference has none to compare. */
  strengthRatio: number | null;
  nonRegressive: boolean;
  polarityOk: boolean;
  strengthOk: boolean;
  contrastOk: boolean | null;
}

function judge(ref: Rgba, entry: DsColourEntry, ctx: ColourContext, backdrops: readonly Rgb[], source: 'measured' | 'ds-section-tokens'): Judged {
  const cand = entry.rgba;
  const perBackdrop = backdrops.map((b) => deltaE2000(compositeOver(ref, b), compositeOver(cand, b)));
  const maxDeltaE = Math.max(...perBackdrop);
  const refStrength = backdrops.map((b) => strengthOf(ref, b));
  const candStrength = backdrops.map((b) => strengthOf(cand, b));
  const ratios = refStrength.map((s, i) => (s >= COLOUR_RULES.meaningfulStrength ? candStrength[i]! / s : null));
  const strengthRatio = ratios.every((r) => r !== null) ? Math.min(...(ratios as number[])) : null;
  const polarityOk = backdrops.every((b) => polarityOf(ref, b) === polarityOf(cand, b));
  const isBorder = ctx.role === 'border';
  const visible = !isBorder || candStrength.every((s) => s >= COLOUR_RULES.borderVisibilityFloor);
  // a reference with no strength to preserve (a white fill on white) may only become something equally subtle
  const inBand = ratios.every((r, i) => (r === null ? candStrength[i]! <= COLOUR_RULES.borderVisibilityFloor : r >= COLOUR_RULES.strengthBand.min && r <= COLOUR_RULES.strengthBand.max));
  const strengthOk = visible && inBand;
  let contrastOk: boolean | null = null;
  if (ctx.role === 'text' || ctx.role === 'icon') {
    contrastOk = backdrops.every((b) => COLOUR_RULES.contrastThresholds.every((t) => contrastRatio(compositeOver(ref, b), b) < t || contrastRatio(compositeOver(cand, b), b) >= t));
  } else if (ctx.role === 'fill' && ctx.textColour) {
    const text = ctx.textColour;
    contrastOk = backdrops.every((b) => COLOUR_RULES.contrastThresholds.every((t) => contrastRatio(text, compositeOver(ref, b)) < t || contrastRatio(text, compositeOver(cand, b)) >= t));
  }
  const nonRegressive = candStrength.every((s, i) => s + 1e-9 >= refStrength[i]!);

  // the categorical rules first: they say WHY a token is the wrong kind, which a distance would hide
  let why: string | null = null;
  if (ref.alpha < 0.995 && cand.alpha >= 0.995) why = 'an alpha reference needs an alpha token: an opaque token does not follow the surface';
  else if (ref.alpha >= 0.995 && cand.alpha < 0.995 && source !== 'measured') why = 'an opaque reference may take an alpha token only on a measured solid backdrop; this backdrop was not measured';
  else if (maxDeltaE > COLOUR_RULES.nearestMaxDeltaE) why = `ΔE ${fmt(maxDeltaE)} from the reference exceeds ${COLOUR_RULES.nearestMaxDeltaE} on at least one backdrop`;
  else if (ref.alpha >= 0.995 && cand.alpha < 0.995 && maxDeltaE > COLOUR_RULES.opaqueToAlphaMaxDeltaE) why = `an opaque reference may take an alpha token only within ΔE ${COLOUR_RULES.opaqueToAlphaMaxDeltaE} (this one is ΔE ${fmt(maxDeltaE)})`;
  else if (!polarityOk) why = 'wrong polarity: it lightens where the reference darkens (or the reverse)';
  else if (!visible) why = `not visible enough as a border (strength ${fmt(Math.min(...candStrength))} < ${COLOUR_RULES.borderVisibilityFloor})`;
  else if (!inBand) {
    const r = strengthRatio;
    why = r !== null && r > COLOUR_RULES.strengthBand.max ? `${fmt(r)}x heavier than the reference (limit ${COLOUR_RULES.strengthBand.max}x)` : r !== null ? `${fmt(r)}x as strong as the reference (limit ${COLOUR_RULES.strengthBand.min}x): it would nearly vanish` : 'stronger than a subtle reference may become';
  } else if (contrastOk === false) why = 'it drops below a WCAG contrast threshold the reference met';
  return { entry, pass: why === null, why, perBackdrop, maxDeltaE, strengthRatio, nonRegressive, polarityOk, strengthOk, contrastOk };
}

function poolFor(ctx: ColourContext, index: DsColourIndex, exact: boolean): DsColourEntry[] {
  const want = stateSuffix(ctx.state);
  return index.entries(ctx.surface).filter((e) => {
    if (e.tier === 'component') return false;
    if (e.state !== null && e.state !== want) return false; // a hover token is not a rest-state token
    if (e.tier === 'primitive') return exact;
    return ctx.role === 'unknown' ? exact : e.roles.includes(ctx.role);
  });
}

function hintRank(e: DsColourEntry, hints: readonly string[]): number {
  const i = hints.findIndex((h) => e.subRoles.includes(h));
  return i === -1 ? 99 : i;
}

const stateRank = (e: DsColourEntry, ctx: ColourContext): number => (stateSuffix(ctx.state) !== null && e.state === stateSuffix(ctx.state) ? 0 : 1);

type MappingBase = Pick<ColourMapping, 'property' | 'declaration' | 'referenceValue' | 'referenceResolved' | 'referenceRgba' | 'referenceToken' | 'referenceChain' | 'role' | 'state' | 'theme' | 'backdrops' | 'backdropSource'>;

function withBase(base: MappingBase, rest: Pick<ColourMapping, 'outcome' | 'reason'> & Partial<ColourMapping>): ColourMapping {
  return {
    ...base,
    sameName: false,
    nameCollision: null,
    dsToken: null,
    dsValue: null,
    dsScope: null,
    dsFile: null,
    tier: null,
    keyword: null,
    distance: null,
    rejected: [],
    verification: { designTime: { polarityOk: rest.outcome !== 'unmapped', strengthOk: rest.outcome !== 'unmapped', contrastOk: null, stateDistinct: null, stateDelta: null }, rendered: { ...NOT_RUN } },
    ...rest,
  };
}

/**
 * Maps one reference colour. Order: `transparent` → the reference's own visibility on this surface → the same-named DS token (compared by VALUE, never by name) →
 * EXACT (rank: same name > sub-role > semantic > role > primitive > canonical file > name) → NEAREST (role pool, every constraint) → UNMAPPED with the gap.
 */
export function mapReferenceColour(ref: ReferenceColourInput, ctx: ColourContext, index: DsColourIndex): ColourMapping {
  const measured = (ctx.backdrops?.length ?? 0) > 0;
  const backdrops: readonly Rgb[] = measured ? ctx.backdrops! : index.backdrops(ctx.surface);
  const source: 'measured' | 'ds-section-tokens' = measured ? (ctx.backdropSource ?? 'measured') : 'ds-section-tokens';
  const hints = ctx.subRoles ?? [];
  const base = {
    property: ctx.property, declaration: ref.declaration, referenceValue: ref.text, referenceResolved: ref.resolved, referenceRgba: { ...ref.rgba }, referenceToken: ref.token, referenceChain: [...ref.chain],
    role: ctx.role, state: ctx.state, theme: ctx.surface, backdrops: backdrops.map(formatRgb), backdropSource: source,
  };
  const where = `${ctx.surface} surface (${base.backdrops.join(', ')})`;

  if (ref.rgba.alpha < COLOUR_RULES.transparentAlpha) {
    return withBase(base, { outcome: 'exact', keyword: 'transparent', reason: 'fully transparent: the keyword transparent, no DS token needed', distance: { deltaE: 0, perBackdrop: backdrops.map(() => 0), alphaDelta: 0, strengthRatio: null } });
  }

  if (ctx.role === 'border') {
    const weak = backdrops.map((b) => strengthOf(ref.rgba, b));
    if (weak.some((s) => s < COLOUR_RULES.borderVisibilityFloor)) {
      return withBase(base, { outcome: 'unmapped', reason: `the reference border ${ref.resolved} is not visible on this surface: ΔE ${weak.map(fmt).join('/')} against ${base.backdrops.join(', ')} is below the ${COLOUR_RULES.borderVisibilityFloor} a hairline needs; this treatment does not belong on a ${ctx.surface} surface` });
    }
  }

  const choose = (e: DsColourEntry, outcome: 'exact' | 'nearest', judged: Judged, reason: string, extra: Partial<ColourMapping> = {}, rejected: ColourMapping['rejected'] = []): ColourMapping =>
    withBase(base, {
      outcome, dsToken: e.token, dsValue: e.value, dsScope: e.scope, dsFile: e.file, tier: e.tier, reason, rejected,
      distance: { deltaE: judged.maxDeltaE, perBackdrop: judged.perBackdrop, alphaDelta: Math.abs(ref.rgba.alpha - e.rgba.alpha), strengthRatio: judged.strengthRatio },
      verification: { designTime: { polarityOk: judged.polarityOk, strengthOk: judged.strengthOk || outcome === 'exact', contrastOk: judged.contrastOk, stateDistinct: null, stateDelta: null }, rendered: { ...NOT_RUN } },
      ...extra,
    });
  const asJudged = (e: DsColourEntry): Judged => judge(ref.rgba, e, ctx, backdrops, source);

  // the DS token of the SAME NAME: equal values keep it; different values are a collision, mapped by value below
  let nameCollision: ColourMapping['nameCollision'] = null;
  if (ref.token !== null) {
    const same = index.get(ctx.surface, ref.token);
    if (same && sameColour(same.rgba, ref.rgba)) {
      return choose(same, 'exact', asJudged(same), `exact: the DS token ${same.token} has the same name and the same value (${same.value}) on a ${where}`, { sameName: true });
    }
    if (same) nameCollision = { referenceValue: ref.resolved, dsValue: same.value };
  }

  // EXACT
  const exact = poolFor(ctx, index, true)
    .filter((e) => sameColour(e.rgba, ref.rgba))
    .sort((a, b) => stateRank(a, ctx) - stateRank(b, ctx) || hintRank(a, hints) - hintRank(b, hints) || TIER_RANK[a.tier] - TIER_RANK[b.tier] || canonicalFile(a) - canonicalFile(b) || byName(a.token, b.token));
  if (exact.length > 0) {
    const e = exact[0]!;
    const others = exact.slice(1, 4).map((o) => ({ token: o.token, value: o.value, deltaE: 0, why: 'also an exact match; ranked below by sub-role, tier and name' }));
    return choose(e, 'exact', asJudged(e), `exact: ${e.token} (${e.value}, ${e.tier} tier) is the same colour as ${ref.resolved} for a ${ctx.role} on a ${where}${nameCollision ? `; the reference token ${ref.token} is NOT the DS token of that name (${nameCollision.dsValue})` : ''}`, { nameCollision }, others);
  }

  if (ctx.role === 'unknown' || ctx.role === 'shadow') {
    return withBase(base, { outcome: 'unmapped', nameCollision, reason: `no DS token has exactly ${ref.resolved}, and the role of ${ctx.property} is ${ctx.role === 'unknown' ? 'unknown' : 'a shadow'}, so a nearest match would be a guess` });
  }

  // NEAREST
  const judged = poolFor(ctx, index, false).map(asJudged);
  const passing = judged
    .filter((j) => j.pass)
    .sort((a, b) =>
      Math.round(a.maxDeltaE * 10) - Math.round(b.maxDeltaE * 10) ||
      stateRank(a.entry, ctx) - stateRank(b.entry, ctx) ||
      Number(b.nonRegressive) - Number(a.nonRegressive) ||
      hintRank(a.entry, hints) - hintRank(b.entry, hints) ||
      TIER_RANK[a.entry.tier] - TIER_RANK[b.entry.tier] ||
      byName(a.entry.token, b.entry.token));
  const closest = (list: Judged[]) => [...list].sort((a, b) => a.maxDeltaE - b.maxDeltaE || byName(a.entry.token, b.entry.token));
  if (passing.length === 0) {
    const near = closest(judged).slice(0, 3);
    const first = near[0];
    return withBase(base, {
      outcome: 'unmapped', nameCollision,
      rejected: near.map((j) => ({ token: j.entry.token, value: j.entry.value, deltaE: j.maxDeltaE, why: j.why ?? 'no constraint failed' })),
      reason: first
        ? `no DS ${ctx.role} token is a suitable match for ${ref.resolved} (alpha ${fmt(ref.rgba.alpha)}) on a ${where}; the closest, ${first.entry.token} (${first.entry.value}), is ΔE ${fmt(first.maxDeltaE)} away and fails: ${first.why}`
        : `no DS ${ctx.role} token exists in the ${ctx.surface} scope to map ${ref.resolved} to`,
    });
  }
  const best = passing[0]!;
  const rejected = closest(judged.filter((j) => j !== best)).slice(0, 3).map((j) => ({ token: j.entry.token, value: j.entry.value, deltaE: j.maxDeltaE, why: j.why ?? (j.nonRegressive || !best.nonRegressive ? 'also suitable; ranked below by distance, sub-role, tier and name' : 'also suitable, but weaker than the reference (the chosen token separates at least as much)') }));
  const strength = best.strengthRatio === null ? 'a subtle fill' : `${fmt(best.strengthRatio)}x the reference's strength`;
  return choose(best.entry, 'nearest', best, `nearest suitable DS ${ctx.role} token: ${best.entry.token} (${best.entry.value}, ${best.entry.tier} tier) is ΔE ${fmt(best.maxDeltaE)} from ${ref.resolved} on a ${where}; ${strength}; polarity kept; no exact DS equivalent exists`, { nameCollision }, rejected);
}

/** A reference colour that is refused without trying to map it: a gradient / color-mix(), or a DS that carries no colour values. `index` null: the DS has none. */
export function unmappedColour(ref: Omit<ReferenceColourInput, 'rgba'> & { rgba: Rgba | null }, ctx: ColourContext, index: DsColourIndex | null, reason: string): ColourMapping {
  const measured = (ctx.backdrops?.length ?? 0) > 0;
  const backdrops: readonly Rgb[] = measured ? ctx.backdrops! : (index?.backdrops(ctx.surface) ?? []);
  return withBase(
    {
      property: ctx.property, declaration: ref.declaration, referenceValue: ref.text, referenceResolved: ref.resolved, referenceRgba: ref.rgba ? { ...ref.rgba } : { r: 0, g: 0, b: 0, alpha: 0 }, referenceToken: ref.token, referenceChain: [...ref.chain],
      role: ctx.role, state: ctx.state, theme: ctx.surface, backdrops: backdrops.map(formatRgb), backdropSource: measured ? (ctx.backdropSource ?? 'measured') : 'ds-section-tokens',
    },
    { outcome: 'unmapped', reason },
  );
}

// ── shadows ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A `box-shadow` is matched as WHOLE layers against the DS shadow tokens (geometry within 1px, colour within ΔE 2 on every backdrop). A reference layer fainter
 * than `shadowDroppableAlpha` may be dropped to match, and the drop is recorded. The colour alone is never swapped inside a hand-made geometry.
 */
export function mapReferenceShadow(ref: ReferenceColourInput, ctx: ColourContext, index: DsColourIndex): ColourMapping {
  const measured = (ctx.backdrops?.length ?? 0) > 0;
  const backdrops: readonly Rgb[] = measured ? ctx.backdrops! : index.backdrops(ctx.surface);
  const base = {
    property: ctx.property, declaration: ref.declaration, referenceValue: ref.text, referenceResolved: ref.resolved, referenceRgba: { ...ref.rgba }, referenceToken: ref.token, referenceChain: [...ref.chain],
    role: 'shadow' as const, state: ctx.state, theme: ctx.surface, backdrops: backdrops.map(formatRgb), backdropSource: measured ? (ctx.backdropSource ?? 'measured') : ('ds-section-tokens' as const),
  };
  const layers = parseShadowList(ref.resolved);
  if (!layers) return withBase(base, { outcome: 'unmapped', reason: `the box-shadow ${ref.resolved} is an unsupported colour expression (not plain offsets, blur and one static colour per layer)` });
  const droppable = layers.filter((l) => l.colour.alpha <= COLOUR_RULES.shadowDroppableAlpha);
  const variants: Array<{ kept: ShadowLayer[]; dropped: number }> = [{ kept: layers, dropped: 0 }];
  if (droppable.length > 0 && droppable.length < layers.length) variants.push({ kept: layers.filter((l) => !droppable.includes(l)), dropped: droppable.length });
  const tol = COLOUR_RULES.shadowGeometryTolerancePx;
  const options: Array<{ entry: DsShadowEntry; deltaE: number; dropped: number; geometry: number }> = [];
  for (const entry of index.shadows(ctx.surface)) {
    for (const v of variants) {
      if (entry.layers.length === 0 || entry.layers.length !== v.kept.length) continue;
      let fits = true;
      let worst = 0;
      let geometry = 0;
      v.kept.forEach((l, i) => {
        const c = entry.layers[i]!;
        const d = Math.max(Math.abs(l.x - c.x), Math.abs(l.y - c.y), Math.abs(l.blur - c.blur), Math.abs(l.spread - c.spread));
        if (l.inset !== c.inset || d > tol) fits = false;
        geometry = Math.max(geometry, d);
        for (const b of backdrops) worst = Math.max(worst, deltaE2000(compositeOver(l.colour, b), compositeOver(c.colour, b)));
      });
      if (fits && worst <= COLOUR_RULES.nearestMaxDeltaE) options.push({ entry, deltaE: worst, dropped: v.dropped, geometry });
    }
  }
  options.sort((a, b) => Math.round(a.deltaE * 10) - Math.round(b.deltaE * 10) || a.dropped - b.dropped || a.geometry - b.geometry || byName(a.entry.token, b.entry.token));
  const best = options[0];
  if (!best) {
    return withBase(base, { outcome: 'unmapped', reason: `no DS shadow token matches the box-shadow ${ref.resolved} (whole layers: offsets/blur/spread within ${tol}px and colour within ΔE ${COLOUR_RULES.nearestMaxDeltaE}); the colour is not swapped inside a hand-made geometry` });
  }
  const exact = best.dropped === 0 && best.deltaE < 0.05 && best.geometry === 0;
  return withBase(base, {
    outcome: exact ? 'exact' : 'nearest', dsToken: best.entry.token, dsValue: best.entry.value, dsScope: best.entry.scope, dsFile: best.entry.file, tier: 'role',
    distance: { deltaE: best.deltaE, perBackdrop: [best.deltaE], alphaDelta: 0, strengthRatio: null },
    reason: `${exact ? 'exact' : 'nearest'} DS shadow ${best.entry.token} (${best.entry.value}) for the box-shadow ${ref.resolved}${best.dropped > 0 ? `; ${best.dropped} faint reference layer(s) (alpha <= ${COLOUR_RULES.shadowDroppableAlpha}) dropped to match` : ''}; geometry within ${best.geometry}px, ΔE ${fmt(best.deltaE)}`,
    rejected: options.slice(1, 4).map((o) => ({ token: o.entry.token, value: o.entry.value, deltaE: o.deltaE, why: 'also matches; ranked below by distance and dropped layers' })),
  });
}

// ── states, assessment, rendered checks ─────────────────────────────────────────────────────────

export interface StateDistinctness {
  distinct: boolean;
  /** ΔE between the reference's two states / between the two mapped states (max over backdrops). */
  referenceDelta: number;
  mappedDelta: number;
  required: number;
}

/** Two states that differ in the reference must still differ after mapping (by the reference's own difference, up to 2 ΔE). */
export function stateDistinctness(a: { reference: readonly [Rgba, Rgba]; mapped: readonly [Rgba, Rgba]; backdrops: readonly Rgb[] }): StateDistinctness {
  const delta = (pair: readonly [Rgba, Rgba]): number => Math.max(...a.backdrops.map((b) => deltaE2000(compositeOver(pair[0], b), compositeOver(pair[1], b))));
  const referenceDelta = delta(a.reference);
  const mappedDelta = delta(a.mapped);
  const required = Math.min(referenceDelta, COLOUR_RULES.stateDistinctMinDeltaE);
  return { distinct: mappedDelta + 1e-9 >= required, referenceDelta, mappedDelta, required };
}

export interface ColourAssessment {
  ok: boolean;
  role: ColourRole;
  perBackdrop: Array<{ backdrop: string; strength: number; contrast: number }>;
  reason: string;
}

/** Is a colour (a DS token's value, no reference involved) visible for its role on these backdrops? A border needs `borderVisibilityFloor`, text and icons `textContrastFloor`. */
export function assessColour(a: { role: ColourRole; colour: Rgba; backdrops: readonly Rgb[] }): ColourAssessment {
  const perBackdrop = a.backdrops.map((b) => ({ backdrop: formatRgb(b), strength: strengthOf(a.colour, b), contrast: contrastRatio(compositeOver(a.colour, b), b) }));
  const fail = (what: string): ColourAssessment => ({ ok: false, role: a.role, perBackdrop, reason: `not visible on this surface: ${what}` });
  if (a.role === 'border') {
    const weak = perBackdrop.filter((p) => p.strength < COLOUR_RULES.borderVisibilityFloor);
    if (weak.length > 0) return fail(`a border of ΔE ${weak.map((p) => `${fmt(p.strength)} on ${p.backdrop}`).join(', ')} is below the ${COLOUR_RULES.borderVisibilityFloor} a hairline needs`);
  } else if (a.role === 'text' || a.role === 'icon') {
    const weak = perBackdrop.filter((p) => p.contrast < COLOUR_RULES.textContrastFloor);
    if (weak.length > 0) return fail(`${a.role} contrast ${weak.map((p) => `${fmt(p.contrast)}:1 on ${p.backdrop}`).join(', ')} is below ${COLOUR_RULES.textContrastFloor}:1`);
  }
  return { ok: true, role: a.role, perBackdrop, reason: 'visible' };
}

export interface RenderedColourCheck {
  status: 'passed' | 'failed' | 'unverified';
  /** ΔE strength of a border/fill, or the contrast ratio of text/icons. */
  strength: number | null;
  detail: string;
}

/** The `colour-visible` acceptance check on what the page rendered: `expected` is `<role>:<minimum>` (`border:1.5`, `text:3`). */
export function evaluateColourVisible(expected: string, colour: string, backdrop: string | null): RenderedColourCheck {
  const m = /^([a-z]+):([\d.]+)$/.exec(expected.trim());
  const c = parseCssColour(colour);
  if (!m || !c) return { status: 'unverified', strength: null, detail: `the check "${expected}" or the rendered colour "${colour}" could not be read` };
  const min = Number(m[2]);
  const back = backdrop === null ? null : parseBackdrop(backdrop);
  if (back === null) return { status: 'unverified', strength: null, detail: 'the backdrop the colour is drawn over could not be measured' };
  const text = m[1] === 'text' || m[1] === 'icon';
  const value = text ? contrastRatio(compositeOver(c, back), back) : strengthOf(c, back);
  return value >= min
    ? { status: 'passed', strength: value, detail: `${text ? 'contrast' : 'strength'} ${fmt(value)}${text ? ':1' : ''} on ${formatRgb(back)} (>= ${min})` }
    : { status: 'failed', strength: value, detail: `not visible: ${text ? 'contrast' : 'ΔE'} ${fmt(value)}${text ? ':1' : ''} against ${formatRgb(back)} is below ${min}` };
}

/** One line for a candidate preview / a reviewer: `border: rgba(0,0,0,.06) -> --semantic-hairline-faint (nearest, ΔE 0.54)` or the gap. */
export function summariseMapping(m: ColourMapping): string {
  if (m.outcome === 'unmapped') return `${m.property}: ${m.referenceResolved} -> NO DS MAPPING (${m.reason})`;
  const target = m.dsToken ?? m.keyword ?? '?';
  return `${m.property}: ${m.referenceResolved} -> ${target} (${m.outcome}${m.tier ? `, ${m.tier}` : ''}${m.distance ? `, ΔE ${fmt(m.distance.deltaE)}` : ''}${m.state !== 'default' ? `, ${m.state}` : ''})`;
}
