import { colorDeltaEWithAlpha, lengthToPx, lineHeightRatio, normalizeColor } from './computed-style.ts';
import { resolveCssVars, resolveToken } from '../ds/d3-tokens/resolve.ts';
import type { Mismatch } from '../skills/s0-result-contract.ts';

/**
 * Token Comparator (v1.0 §7 T-layer). Deterministically compares actual
 * rendered values against expected DS values. The engineering rule is
 * explicit in the spec: "If code can answer a question deterministically
 * (for example 44px != 48px), code should do it. Claude should interpret
 * what the mismatch means, not perform simple measurement comparisons by
 * guesswork." A model never supplies the verdict here — it supplies which
 * token is expected; this file resolves and compares the values.
 *
 * Every property is compared in the units the browser and the DS actually
 * use, because a naive string compare turns correct implementations into
 * false DEVIATIONs: tokens are aliases (`var(--space-md)`), line-heights are
 * unitless ratios while computed values are px, em is relative to the
 * ELEMENT's font size, colors carry alpha, browsers reorder box-shadow parts
 * and Tailwind pads them with transparent layers, gradients are
 * re-serialized, and next/font renames families. Anything that still cannot
 * be grounded is reported as `unresolved` — never as a mismatch, and never
 * as a pass.
 */

/** Perceptual threshold: ~2.3 is a just-noticeable difference; below that, two colors are the same to a human. */
export const COLOR_DELTA_E_THRESHOLD = 2.3;
/** Sub-pixel layout jitter and browser rounding are not deviations. */
export const LENGTH_TOLERANCE_PX = 0.5;

const COLOR_PROPERTIES = /color$/i;
const LENGTH_PROPERTIES = /(width|height|size|radius|padding|margin|gap)/i;
const GAP_PROPERTIES = new Set(['row-gap', 'column-gap']);
const MIN_MAX_PROPERTIES = new Set(['min-width', 'min-height', 'max-width', 'max-height']);
export const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);

export interface ExpectedValue {
  property: string;
  /** A DS token name (`--button-height-md`) whose value is resolved from D3's effective layer. */
  token: string | null;
  /** A literal expected value, used when the DS source hardcodes it. */
  literal: string | null;
  /** Expanded from a 1–4 value BOX shorthand (padding, margin, border-width, border-radius): which side/corner. */
  side?: number;
  /** Expanded from a 1–2 value PAIR shorthand (padding-inline/-block, margin-inline/-block, gap): which half. */
  pair?: 0 | 1;
}

export interface CompareInput {
  actual: Record<string, string>;
  expected: ExpectedValue[];
  /** D3 effective tokens for the active variant, as declared (aliases are resolved here). */
  effectiveTokens: Map<string, string>;
  rootFontSizePx: number;
  /** The element's rendered border-box size (what a radius is drawn against). */
  box?: { width: number; height: number } | null;
}

export interface CompareResult {
  mismatches: Mismatch[];
  /** Properties that were compared and matched — so "nothing was compared" is distinguishable from "all passed". */
  passed: string[];
  /** Properties that could not be compared at all — reported, never silently treated as passing. */
  unresolved: Array<{ property: string; reason: string }>;
}

// ── Normalizing what the model supplies ─────────────────────────────────

/** `backgroundColor` → `background-color`; trims and lowercases. */
export function normalizeProperty(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** `space-4`, `--space-4`, `var(--space-4)` → `--space-4`. */
export function normalizeTokenName(name: string): string {
  let n = name.trim();
  const wrapped = n.match(/^var\(\s*(--[\w-]+)\s*(?:,.*)?\)$/);
  if (wrapped) n = wrapped[1] as string;
  if (!n.startsWith('--')) n = `--${n.replace(/^-+/, '')}`;
  return n;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
type Expansion = { property: string; side?: number; pair?: 0 | 1 };
const SHORTHANDS: Record<string, Expansion[]> = {
  padding: SIDES.map((s, i) => ({ property: `padding-${s}`, side: i })),
  margin: SIDES.map((s, i) => ({ property: `margin-${s}`, side: i })),
  'border-width': SIDES.map((s, i) => ({ property: `border-${s}-width`, side: i })),
  'border-radius': CORNERS.map((c, i) => ({ property: `border-${c}-radius`, side: i })),
  // Logical pairs are START END — not the 4-side box order (that would put END on the start side).
  'padding-inline': [{ property: 'padding-left', pair: 0 }, { property: 'padding-right', pair: 1 }],
  'padding-block': [{ property: 'padding-top', pair: 0 }, { property: 'padding-bottom', pair: 1 }],
  'margin-inline': [{ property: 'margin-left', pair: 0 }, { property: 'margin-right', pair: 1 }],
  'margin-block': [{ property: 'margin-top', pair: 0 }, { property: 'margin-bottom', pair: 1 }],
  gap: [{ property: 'row-gap', pair: 0 }, { property: 'column-gap', pair: 1 }],
  'border-color': [{ property: 'border-top-color', side: 0 }],
  'border-style': [{ property: 'border-top-style', side: 0 }],
};

/** Normalizes model-supplied names and expands shorthands into the longhands the browser reports. */
export function normalizeExpectations(expected: ExpectedValue[]): ExpectedValue[] {
  const out: ExpectedValue[] = [];
  for (const e of expected) {
    const property = normalizeProperty(e.property);
    const token = e.token && e.token.trim() ? normalizeTokenName(e.token) : null;
    const literal = e.literal && e.literal.trim() ? e.literal.trim() : null;
    const expansion = SHORTHANDS[property];
    if (expansion) {
      for (const x of expansion) out.push({ property: x.property, token, literal, ...(x.side !== undefined ? { side: x.side } : {}), ...(x.pair !== undefined ? { pair: x.pair } : {}) });
    } else out.push({ property, token, literal });
  }
  return out;
}

// ── Value helpers ─────────────────────────────────────────────────────────

/** Splits on whitespace/commas that are not inside parentheses. */
function splitTopLevel(value: string, separator: ',' | ' '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    const isSep = separator === ',' ? ch === ',' : /\s/.test(ch);
    if (isSep && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The part of a value before its first `/` at parenthesis depth 0 (never one inside rgb() or calc()). */
function beforeTopLevelSlash(value: string): string {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '/' && depth === 0) return value.slice(0, i).trim();
  }
  return value;
}

/**
 * Picks one side's value out of a 1–4 value box shorthand (CSS top/right/
 * bottom/left order). Only border-radius has a `/` part (its vertical radii);
 * every other shorthand is split whole — `rgb(0 0 0 / 0.1)` and
 * `calc(8px / 2)` must never be cut at their slash.
 */
function boxSide(value: string, side: number | undefined, radius: boolean): string {
  if (side === undefined) return value;
  const parts = splitTopLevel(radius ? beforeTopLevelSlash(value) : value, ' ');
  if (parts.length <= 1) return parts[0] ?? value;
  const [a, b = a, c = a, d = b] = parts as [string, string?, string?, string?];
  return [a, b, c, d][side] ?? value;
}

/** Picks one half of a 1–2 value pair shorthand (start/end, row/column). */
function pairPart(value: string, pair: 0 | 1 | undefined): string {
  if (pair === undefined) return value;
  const parts = splitTopLevel(value, ' ');
  if (parts.length <= 1) return value;
  return parts[pair] ?? parts[0] ?? value;
}

const isExpression = (v: string) => /\b(calc|clamp|min|max|env)\(/i.test(v);

/**
 * A font stack as an ordered list of lower-cased family names. A `var()` entry
 * expands to the referenced stack; one that cannot be resolved statically
 * (next/font's runtime `--font-dm-sans`) is dropped rather than failing the
 * whole stack — the families after it are still the DS's intent.
 */
export function familyList(value: string, tokens: Map<string, string>, seen: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const raw of splitTopLevel(value, ',')) {
    const ref = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/);
    if (ref) {
      const name = ref[1] as string;
      const declared = tokens.get(name);
      if (declared !== undefined && !seen.has(name)) out.push(...familyList(declared, tokens, new Set([...seen, name])));
      else if (ref[2]) out.push(...familyList(ref[2], tokens, seen));
      continue;
    }
    let family = raw.replace(/^['"]|['"]$/g, '').trim();
    // next/font renames families to `__DM_Sans_4a8b2c` (+ `__DM_Sans_Fallback_4a8b2c`).
    const hashed = family.match(/^__(.+?)_([0-9a-f]{5,})$/i);
    if (hashed) {
      if (/_Fallback$/i.test(hashed[1] as string)) continue;
      family = (hashed[1] as string).replace(/_/g, ' ');
    }
    if (family) out.push(family.toLowerCase());
  }
  return out;
}

/** The first concrete (non-generic) family a stack leads with — `null` when there is none. */
export function leadingFamily(value: string, tokens: Map<string, string>): string | null {
  return familyList(value, tokens).find((f) => !GENERIC_FAMILIES.has(f)) ?? null;
}

/** Color equality INCLUDING alpha (see colorDeltaEWithAlpha). `null` when either side does not parse. */
function sameColor(a: string, b: string): boolean | null {
  const na = normalizeColor(a);
  const nb = normalizeColor(b);
  if (!na || !nb) return null;
  if (na === nb) return true;
  const d = colorDeltaEWithAlpha(a, b);
  return d === null ? null : d <= COLOR_DELTA_E_THRESHOLD;
}

interface ShadowLayer {
  inset: boolean;
  color: string | null;
  lengths: [number, number, number, number];
}

/**
 * Parses a box-shadow into the layers that actually PAINT. Tailwind composes
 * every shadow utility as `var(--tw-inset-shadow), var(--tw-inset-ring-shadow),
 * var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)` with
 * the unused parts defaulting to `0 0 #0000` — so a correctly built DS card
 * computes to four transparent layers plus the real one. Layers that paint
 * nothing (fully transparent, or zero offset/blur/spread) are dropped on both
 * sides, which also makes `none` equal to an all-transparent composite.
 */
function parseShadows(value: string): ShadowLayer[] | null {
  if (value.trim().toLowerCase() === 'none') return [];
  const layers: ShadowLayer[] = [];
  for (const layer of splitTopLevel(value, ',')) {
    let inset = false;
    let color: string | null = null;
    const lengths: number[] = [];
    for (const token of splitTopLevel(layer, ' ')) {
      if (token.toLowerCase() === 'inset') {
        inset = true;
        continue;
      }
      const px = lengthToPx(token);
      if (px !== null) {
        lengths.push(px);
        continue;
      }
      if (normalizeColor(token)) {
        color = token;
        continue;
      }
      return null;
    }
    if (lengths.length < 2 || lengths.length > 4) return null;
    const parsed: ShadowLayer = { inset, color, lengths: [lengths[0]!, lengths[1]!, lengths[2] ?? 0, lengths[3] ?? 0] };
    const transparent = color !== null && (normalizeColor(color) ?? '').endsWith('00');
    const noGeometry = parsed.lengths.every((v) => v === 0);
    if (transparent || noGeometry) continue;
    layers.push(parsed);
  }
  return layers;
}

const HORIZONTAL: Record<string, string> = { left: '0%', center: '50%', right: '100%' };
const VERTICAL: Record<string, string> = { top: '0%', center: '50%', bottom: '100%' };
const SIDE_DEGREES: Record<string, number> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 };

/**
 * A `<position>` as Chromium serializes it: `X Y`, horizontal first, keywords
 * as percentages (`top right` → `100% 0%`, `top` → `50% 0%`). Measured
 * against Chromium 153. Null for 3–4 value positions (`right 10px top 20px`),
 * which this does not model — that is unresolved, not a guess.
 */
function canonicalPosition(words: string[]): string | null {
  if (words.length > 2) return null;
  let x = '50%';
  let y = '50%';
  if (words.length === 1) {
    const w = words[0] as string;
    if (w in VERTICAL && w !== 'center') y = VERTICAL[w] as string;
    else x = HORIZONTAL[w] ?? w;
  } else if (words.length === 2) {
    let [first, second] = words as [string, string];
    // `top left` names the vertical first; CSS allows either order for keywords.
    if (first === 'top' || first === 'bottom' || second === 'left' || second === 'right') [first, second] = [second, first];
    x = HORIZONTAL[first] ?? first;
    y = VERTICAL[second] ?? second;
  }
  return `${x} ${y}`;
}

/** An angle in degrees, 0..360, from deg/turn/rad/grad — or null. */
function angleDeg(v: string): number | null {
  const m = v.match(/^(-?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const deg = m[2] === 'deg' ? n : m[2] === 'turn' ? n * 360 : m[2] === 'rad' ? (n * 180) / Math.PI : n * 0.9;
  return ((deg % 360) + 360) % 360;
}

interface GradientHead {
  /** Linear: degrees, or a corner keyword pair in canonical word order. Conic: the `from` angle. */
  direction: number | string | null;
  /** Radial shape/size, canonical ('' when default). */
  shape: string;
  /** `X Y`, or '' when centred (the default). */
  position: string;
  /** Interpolation colour space (`in oklab`), or '' for the default sRGB. */
  interp: string;
}

function parseHead(fn: string, raw: string): GradientHead | null {
  let head = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  // Interpolation method: `in oklab`, `in oklch longer hue` — split it off wherever it sits.
  let interp = '';
  const im = head.match(/\bin ([a-z0-9-]+)(?: (shorter|longer|increasing|decreasing) hue)?/);
  if (im) {
    interp = im[0] === 'in srgb' ? '' : im[0];
    head = head.replace(im[0], '').replace(/\s+/g, ' ').trim();
  }
  if (fn.includes('linear')) {
    if (!head) return { direction: 180, shape: '', position: '', interp };
    const deg = angleDeg(head);
    if (deg !== null) return { direction: deg, shape: '', position: '', interp };
    if (head in SIDE_DEGREES) return { direction: SIDE_DEGREES[head] as number, shape: '', position: '', interp };
    const corner = head.match(/^to (\w+) (\w+)$/);
    if (corner) return { direction: `to ${[corner[1], corner[2]].sort().join(' ')}`, shape: '', position: '', interp };
    return null;
  }
  const [before = '', after] = head.split(/\s*\bat\b\s*/);
  let direction: number | null = null;
  let shapePart = before;
  if (fn.includes('conic')) {
    const from = before.match(/^from (\S+)$/);
    if (before && !from) return null;
    direction = from ? angleDeg(from[1] as string) : 0;
    if (from && direction === null) return null;
    shapePart = '';
  }
  const words = shapePart.split(' ').filter((w) => w && w !== 'ellipse' && w !== 'farthest-corner');
  // `circle 20px` — one length already implies a circle.
  const lengths = words.filter((w) => lengthToPx(w) !== null || /%$/.test(w));
  const shape = (words.length === 2 && words[0] === 'circle' && lengths.length === 1 ? words.slice(1) : words).join(' ');
  const position = after === undefined ? '50% 50%' : canonicalPosition(after.split(' ').filter(Boolean));
  if (position === null) return null;
  return { direction: direction === 0 ? null : direction, shape, position: position === '50% 50%' ? '' : position, interp };
}

interface StopPosition {
  value: number;
  /** A zero is the same in every unit; px and % otherwise do not compare statically. */
  unit: '%' | 'px' | 'zero';
}
interface GradientStop {
  color: string;
  position: StopPosition | null;
}
interface Gradient {
  fn: string;
  head: GradientHead;
  stops: GradientStop[];
}

function stopPosition(v: string, rootFontSizePx: number, fontPx: number): StopPosition | null {
  if (/^-?0+(?:\.0+)?(?:%|px|rem|em)?$/.test(v)) return { value: 0, unit: 'zero' };
  if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(v)) return { value: Number(v.slice(0, -1)), unit: '%' };
  const px = lengthToPx(v, rootFontSizePx, fontPx);
  return px === null ? null : { value: px, unit: 'px' };
}

/**
 * Parses `background-image` into gradients in a canonical form, so the DS's
 * hex-and-keyword spelling and Chromium's rgb-and-percent re-serialization
 * compare equal. Returns null for anything it cannot parse (a `url(...)`, an
 * interpolation hint, a colour it cannot read) — that is unresolved, never a
 * mismatch.
 */
function parseBackgroundImage(value: string, rootFontSizePx: number, fontPx: number): Gradient[] | null {
  const images: Gradient[] = [];
  // Commas inside a gradient are nested in its parentheses, so a top-level split separates layers.
  for (const image of splitTopLevel(value, ',')) {
    const m = image.match(/^((?:repeating-)?(?:linear|radial|conic)-gradient)\(([\s\S]*)\)$/i);
    if (!m) return null;
    const fn = (m[1] as string).toLowerCase();
    const args = splitTopLevel(m[2] as string, ',');
    const first = args[0] ?? '';
    const firstIsStop = normalizeColor(splitTopLevel(first, ' ')[0] ?? '') !== null || normalizeColor(splitTopLevel(first, ' ').at(-1) ?? '') !== null;
    const head = parseHead(fn, firstIsStop ? '' : first);
    if (!head) return null;
    if (!firstIsStop) args.shift();
    const stops: GradientStop[] = [];
    for (const arg of args) {
      const parts = splitTopLevel(arg, ' ');
      const colorIndex = parts.findIndex((p) => normalizeColor(p) !== null);
      if (colorIndex === -1) return null; // interpolation hints etc. — not comparable statically
      const color = parts[colorIndex] as string;
      const positions = parts.filter((_, i) => i !== colorIndex);
      if (positions.length > 2) return null;
      if (positions.length === 0) stops.push({ color, position: null });
      // `red 10% 20%` is two stops of the same colour.
      for (const p of positions) {
        const pos = stopPosition(p, rootFontSizePx, fontPx);
        if (!pos) return null;
        stops.push({ color, position: pos });
      }
    }
    images.push({ fn, head, stops });
  }
  return images;
}

/**
 * CSS Images 4 implicit stop positions: first 0%, last 100%, a position below
 * an earlier one is raised to it, and runs of missing positions are spaced
 * evenly between their neighbours. Only when every known position is a
 * percentage or a zero — with lengths in the mix, the implicit positions
 * depend on the gradient's rendered length. Null = cannot be resolved.
 */
function withImplicitPositions(stops: GradientStop[]): Array<{ color: string; position: StopPosition }> | null {
  const known = stops.filter((s) => s.position !== null);
  const missing = stops.length - known.length;
  if (missing > 0 && known.some((s) => s.position!.unit === 'px')) return null;
  const pct: Array<number | null> = stops.map((s) => (s.position === null ? null : s.position.value));
  if (pct[0] === null) pct[0] = 0;
  if (pct.at(-1) === null) pct[pct.length - 1] = 100;
  let max = -Infinity;
  for (let i = 0; i < pct.length; i++) {
    if (pct[i] !== null) {
      max = Math.max(max, pct[i] as number);
      pct[i] = max;
    }
  }
  for (let i = 0; i < pct.length; i++) {
    if (pct[i] !== null) continue;
    let j = i;
    while (pct[j] === null) j++;
    const from = pct[i - 1] as number;
    const to = pct[j] as number;
    for (let k = i; k < j; k++) pct[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  return stops.map((s, i) => ({
    color: s.color,
    position: s.position ?? { value: pct[i] as number, unit: (pct[i] as number) === 0 ? 'zero' : '%' },
  }));
}

type Verdict = 'match' | 'mismatch' | 'unresolved';

function compareGradients(a: Gradient[], b: Gradient[]): Verdict {
  if (a.length !== b.length) return 'mismatch';
  let unresolved = false;
  for (let i = 0; i < a.length; i++) {
    const g = a[i]!;
    const o = b[i]!;
    if (g.fn !== o.fn) return 'mismatch';
    const dirA = g.head.direction;
    const dirB = o.head.direction;
    const sameDirection =
      typeof dirA === 'number' && typeof dirB === 'number' ? Math.min(Math.abs(dirA - dirB), 360 - Math.abs(dirA - dirB)) <= 0.5 : dirA === dirB;
    if (!sameDirection || g.head.shape !== o.head.shape || g.head.position !== o.head.position) return 'mismatch';
    // Tailwind v4 renders `in oklab` where DS tokens carry no interpolation space: the stops can
    // be identical and the blend still differ slightly — a judgment, not a measurable mismatch.
    if (g.head.interp !== o.head.interp) unresolved = true;
    const sa = withImplicitPositions(g.stops);
    const sb = withImplicitPositions(o.stops);
    if (!sa || !sb) {
      unresolved = true;
      continue;
    }
    if (sa.length !== sb.length) return 'mismatch';
    for (let j = 0; j < sa.length; j++) {
      const s = sa[j]!;
      const t = sb[j]!;
      const color = sameColor(s.color, t.color);
      if (color === false) return 'mismatch';
      if (color === null) unresolved = true;
      const p = s.position;
      const q = t.position;
      const units = p.unit === 'zero' ? q.unit : q.unit === 'zero' ? p.unit : p.unit === q.unit ? p.unit : null;
      if (units === null) {
        unresolved = true; // px vs % — depends on the rendered gradient length
        continue;
      }
      if (Math.abs(p.value - q.value) > 0.5) return 'mismatch';
    }
  }
  return unresolved ? 'unresolved' : 'match';
}

// ── Comparison ────────────────────────────────────────────────────────────

export function compareToExpected(input: CompareInput): CompareResult {
  const mismatches: Mismatch[] = [];
  const passed: string[] = [];
  const unresolved: Array<{ property: string; reason: string }> = [];
  const fontPx = lengthToPx(input.actual['font-size'] ?? '', input.rootFontSizePx) ?? input.rootFontSizePx;
  // The border box when captured (inline elements report `auto`, content-box elements the
  // inner size); otherwise the computed size.
  const widthPx = input.box?.width ?? lengthToPx(input.actual.width ?? '', input.rootFontSizePx, fontPx);
  const heightPx = input.box?.height ?? lengthToPx(input.actual.height ?? '', input.rootFontSizePx, fontPx);
  const display = (input.actual.display ?? '').trim().toLowerCase();

  for (const exp of normalizeExpectations(input.expected)) {
    const actual = input.actual[exp.property];
    if (actual === undefined || actual === '') {
      unresolved.push({ property: exp.property, reason: 'property not captured from the rendered element' });
      continue;
    }

    // ── Resolve the expected value ──
    let expectedValue: string | null;
    if (exp.token) {
      if (!input.effectiveTokens.has(exp.token)) {
        // A token the model named but the DS does not define is itself worth surfacing —
        // it means the expectation cannot be grounded, not that the element is compliant.
        unresolved.push({ property: exp.property, reason: `expected token ${exp.token} is not defined in the Design System` });
        continue;
      }
      expectedValue = exp.property === 'font-family' ? (input.effectiveTokens.get(exp.token) ?? null) : resolveToken(exp.token, input.effectiveTokens);
      if (expectedValue === null) {
        unresolved.push({ property: exp.property, reason: `token ${exp.token} could not be resolved (undefined var() with no fallback, or a cycle)` });
        continue;
      }
    } else if (exp.literal) {
      expectedValue = exp.property === 'font-family' ? exp.literal : resolveCssVars(exp.literal, input.effectiveTokens);
      if (expectedValue === null) {
        unresolved.push({ property: exp.property, reason: `literal "${exp.literal}" references an undefined token` });
        continue;
      }
    } else {
      unresolved.push({ property: exp.property, reason: 'no expected token or literal supplied' });
      continue;
    }
    expectedValue = exp.pair !== undefined ? pairPart(expectedValue, exp.pair) : boxSide(expectedValue, exp.side, exp.property.endsWith('-radius'));

    const expected = expectedValue;
    const push = (comparison: Mismatch['comparison'], delta: number | null) =>
      mismatches.push({ property: exp.property, actual, expected, expectedToken: exp.token, comparison, delta });
    const unresolvedBecause = (reason: string) => unresolved.push({ property: exp.property, reason });

    if (exp.property !== 'font-family' && isExpression(expected)) {
      unresolvedBecause(`expected value "${expected}" is an expression that cannot be evaluated statically`);
      continue;
    }

    // ── Colors: perceptual, alpha included, never by string ──
    if (COLOR_PROPERTIES.test(exp.property)) {
      const target = /^currentcolor$/i.test(expected) ? (input.actual.color ?? expected) : expected;
      const same = sameColor(actual, target);
      if (same === null) {
        unresolvedBecause(`unparseable color (actual "${actual}", expected "${expected}")`);
        continue;
      }
      if (same) passed.push(exp.property);
      else push('color-deltaE', Math.round((colorDeltaEWithAlpha(actual, target) ?? 0) * 100) / 100);
      continue;
    }

    // ── line-height: a ratio of the element's own font size ──
    if (exp.property === 'line-height') {
      const a = actual.trim().toLowerCase();
      const e = expected.trim().toLowerCase();
      if (a === 'normal' || e === 'normal') {
        if (a === e) passed.push(exp.property);
        else unresolvedBecause('"normal" line-height depends on font metrics and cannot be compared to a fixed value');
        continue;
      }
      const actualRatio = lineHeightRatio(a, fontPx);
      const expectedRatio = /^-?[\d.]+%$/.test(e)
        ? Number(e.slice(0, -1)) / 100
        : /^-?[\d.]+$/.test(e)
          ? Number(e)
          : (() => {
              const px = lengthToPx(e, input.rootFontSizePx, fontPx);
              return px === null || fontPx === 0 ? null : px / fontPx;
            })();
      if (actualRatio === null || expectedRatio === null) {
        unresolvedBecause(`line-height not comparable (actual "${actual}", expected "${expected}")`);
        continue;
      }
      const deltaPx = (actualRatio - expectedRatio) * fontPx;
      if (Math.abs(deltaPx) > LENGTH_TOLERANCE_PX) push('length-px', Math.round(deltaPx * 100) / 100);
      else passed.push(exp.property);
      continue;
    }

    // ── letter-spacing: `normal` is 0; em is relative to the element ──
    if (exp.property === 'letter-spacing') {
      const toPx = (v: string) => (v.trim().toLowerCase() === 'normal' ? 0 : lengthToPx(v, input.rootFontSizePx, fontPx));
      const a = toPx(actual);
      const e = toPx(expected);
      if (a === null || e === null) {
        unresolvedBecause(`letter-spacing not comparable (actual "${actual}", expected "${expected}")`);
        continue;
      }
      if (Math.abs(a - e) > LENGTH_TOLERANCE_PX / 10) push('length-px', Math.round((a - e) * 100) / 100);
      else passed.push(exp.property);
      continue;
    }

    // ── box-shadow: painting layers only, compared part by part ──
    if (exp.property === 'box-shadow') {
      const a = parseShadows(actual);
      const e = parseShadows(expected);
      if (!a || !e) {
        unresolvedBecause(`box-shadow not parseable (actual "${actual}", expected "${expected}")`);
        continue;
      }
      const matches =
        a.length === e.length &&
        a.every((layer, i) => {
          const other = e[i]!;
          const colorOk = layer.color && other.color ? sameColor(layer.color, other.color) === true : layer.color === other.color;
          return layer.inset === other.inset && colorOk && layer.lengths.every((v, j) => Math.abs(v - other.lengths[j]!) <= LENGTH_TOLERANCE_PX);
        });
      if (matches) passed.push(exp.property);
      else push('exact', null);
      continue;
    }

    // ── background-image: gradients in canonical form ──
    if (exp.property === 'background-image') {
      const a = actual.trim().toLowerCase();
      const e = expected.trim().toLowerCase();
      if (a === 'none' || e === 'none') {
        if (a === e) passed.push(exp.property);
        else push('exact', null); // a gradient where none belongs (or vice versa) is a real difference
        continue;
      }
      const ga = parseBackgroundImage(actual, input.rootFontSizePx, fontPx);
      const ge = parseBackgroundImage(expected, input.rootFontSizePx, fontPx);
      const verdict = ga && ge ? compareGradients(ga, ge) : 'unresolved';
      if (verdict === 'match') passed.push(exp.property);
      else if (verdict === 'mismatch') push('exact', null);
      else unresolvedBecause(`background-image not comparable statically (actual "${actual.slice(0, 60)}", expected "${expected.slice(0, 60)}")`);
      continue;
    }

    // ── font-family: the intended family must be the one the stack leads with ──
    if (exp.property === 'font-family') {
      const a = familyList(actual, input.effectiveTokens).filter((f) => !GENERIC_FAMILIES.has(f));
      const e = familyList(expected, input.effectiveTokens).filter((f) => !GENERIC_FAMILIES.has(f));
      if (a.length === 0 || e.length === 0) {
        unresolvedBecause(`font-family has no concrete family to compare (actual "${actual}", expected "${expected}")`);
        continue;
      }
      if (a[0] === e[0]) passed.push(exp.property);
      else push('exact', null);
      continue;
    }

    // ── font-weight: keywords to numbers ──
    if (exp.property === 'font-weight') {
      const weight = (v: string) => ({ normal: 400, bold: 700 })[v.trim().toLowerCase() as 'normal' | 'bold'] ?? Number(v);
      const a = weight(actual);
      const e = weight(expected);
      if (!Number.isFinite(a) || !Number.isFinite(e)) {
        unresolvedBecause(`font-weight not numeric (actual "${actual}", expected "${expected}")`);
        continue;
      }
      if (a === e) passed.push(exp.property);
      else push('exact', a - e);
      continue;
    }

    // ── Lengths ──
    if (LENGTH_PROPERTIES.test(exp.property)) {
      // `normal` gap is a real 0 between grid tracks; in flex layout it depends on the items.
      const normalGap = GAP_PROPERTIES.has(exp.property) && actual.trim().toLowerCase() === 'normal';
      const actualForLength = normalGap && (display === 'grid' || display === 'inline-grid') ? '0px' : actual;
      let a = lengthToPx(actualForLength, input.rootFontSizePx, fontPx);
      let e = lengthToPx(expected, input.rootFontSizePx, fontPx);
      if (a === null || e === null) {
        const av = actual.trim().toLowerCase();
        if (av === expected.trim().toLowerCase()) passed.push(exp.property);
        // A min/max the DS sets that production leaves at auto/none is simply not applied.
        else if (MIN_MAX_PROPERTIES.has(exp.property) && (av === 'auto' || av === 'none') && e !== null) push('exact', null);
        else unresolvedBecause(`length not comparable without layout context (actual "${actual}", expected "${expected}")`);
        continue;
      }
      // Radii larger than half the box all render fully rounded: `rounded-full` computes to a
      // huge px value while the DS may spell it 9999px — compare what is actually drawn.
      if (/radius$/.test(exp.property)) {
        if (widthPx !== null && heightPx !== null) {
          const cap = Math.min(widthPx, heightPx) / 2;
          a = Math.min(a, cap);
          e = Math.min(e, cap);
        } else if (a >= 9999 && e >= 9999) {
          a = e; // both render fully rounded at any size
        } else if (a > 1e6 || e > 1e6) {
          unresolvedBecause(`an effectively infinite radius cannot be compared without the element's size (actual "${actual}", expected "${expected}")`);
          continue;
        }
      }
      if (Math.abs(a - e) > LENGTH_TOLERANCE_PX) push('length-px', Math.round((a - e) * 100) / 100);
      else passed.push(exp.property);
      continue;
    }

    if (exp.property === 'opacity') {
      const num = (v: string) => (/%$/.test(v.trim()) ? Number(v.trim().slice(0, -1)) / 100 : Number(v));
      const a = num(actual);
      const e = num(expected);
      if (Number.isFinite(a) && Number.isFinite(e)) {
        if (Math.abs(a - e) > 0.01) push('exact', Math.round((a - e) * 100) / 100);
        else passed.push(exp.property);
        continue;
      }
    }

    // ── Keywords: only plain keywords are compared as strings ──
    const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
    const keyword = /^[a-z-]+( [a-z-]+)*$/;
    if (norm(actual) === norm(expected)) passed.push(exp.property);
    else if (keyword.test(norm(actual)) && keyword.test(norm(expected))) push('exact', null);
    else unresolvedBecause(`value not comparable as a keyword (actual "${actual.slice(0, 60)}", expected "${expected.slice(0, 60)}")`);
  }

  return { mismatches, passed, unresolved };
}
