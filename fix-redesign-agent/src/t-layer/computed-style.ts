// Vendored verbatim from audit-agent src/t-layer/computed-style.ts (2026-09-22) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed. Pulled in for R5's deterministic re-measurement tier and C2's `restyled` drift comparison (both need to answer "does this element's property now equal an expected value", exactly what this module's normalization functions are for).
import { converter, differenceCiede2000, formatHex8, parse } from 'culori';
import type { Locator, Page } from 'playwright';

/**
 * B4's deterministic computed-style extraction + normalization (T-layer
 * half; the token COMPARISON is B4's job, build step 4). Grounding pitfalls
 * handled here:
 *  - getComputedStyle returns resolved values (px, rgb()) while Ken's tokens
 *    are hex / rem / unitless — so normalize both sides before comparing.
 *  - modern color spaces (oklch/oklab/lab/lch/color()) serialize in their own
 *    notation; Tailwind v4's palette is oklch — parse with a CSS Color 4
 *    parser (culori) and compare perceptually (ΔE2000), never by string.
 *  - line-height may come back unitless, as px, or as the literal "normal".
 *  - a detached node yields garbage — assert isConnected, return a sentinel.
 *  - raw AND normalized values are both kept, so a human reviewing an
 *    escalation sees exactly what the browser reported.
 */

export const EXTRACTED_PROPERTIES = [
  'color', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'text-transform',
  'text-decoration-line', 'text-decoration-color',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-top-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'opacity',
  'display', 'flex-direction', 'align-items', 'justify-content', 'width', 'height',
  'min-width', 'min-height', 'max-width', 'max-height',
] as const;

/**
 * `box` is the rendered BORDER-BOX size — what a radius is actually drawn
 * against. Computed width/height are `auto` for inline elements (a pill
 * `<a>`/`<span>`) and the content box for `box-sizing: content-box`, so they
 * cannot tell whether two radii both render fully rounded.
 */
export type ExtractedStyle =
  | { connected: false }
  | { connected: true; raw: Record<string, string>; rootFontSizePx: number; box?: { width: number; height: number } | null };

export async function extractComputedStyle(locator: Locator): Promise<ExtractedStyle> {
  return locator.evaluate((el, props) => {
    if (!el.isConnected) return { connected: false as const };
    const cs = getComputedStyle(el);
    const raw: Record<string, string> = {};
    for (const p of props) raw[p] = cs.getPropertyValue(p);
    const rootFontSizePx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const rect = el.getClientRects()[0] ?? el.getBoundingClientRect();
    const box = rect && rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null;
    return { connected: true as const, raw, rootFontSizePx, box };
  }, EXTRACTED_PROPERTIES as unknown as string[]);
}

/** Reads resolved values of CSS custom properties at :root — the effective-token check against a live page. */
export async function readRootCustomProperties(page: Page, names: string[]): Promise<Record<string, string>> {
  return page.evaluate((ns) => {
    const cs = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const n of ns) out[n] = cs.getPropertyValue(n).trim();
    return out;
  }, names);
}

// ── Normalization (pure) ─────────────────────────────────────────────────

/** Any CSS Color 4 string → canonical #rrggbbaa (lower-case), or null if unparseable. */
export function normalizeColor(value: string): string | null {
  const parsed = parse(value.trim());
  if (!parsed) return null;
  return formatHex8(parsed) ?? null;
}

/** Perceptual color distance (CIEDE2000) of the opaque colors only — alpha is ignored. Use `colorDeltaEWithAlpha` to compare CSS colors. */
export function colorDeltaE(a: string, b: string): number | null {
  const ca = parse(a.trim());
  const cb = parse(b.trim());
  if (!ca || !cb) return null;
  return differenceCiede2000()(ca, cb);
}

const toRgb = converter('rgb');

/**
 * Perceptual distance between two CSS colors INCLUDING alpha. ΔE2000 works in
 * Lab and throws alpha away, so on its own it scored solid black as identical
 * to a 60%-black text token and solid brand red as identical to its 12% tint.
 * Each color is composited over white and over black and the larger ΔE wins:
 * the result stays in ΔE units (so the severity rubric still means something)
 * and is 0 exactly when the two colors look the same on any background. Two
 * fully transparent colors are equal whatever their RGB.
 */
export function colorDeltaEWithAlpha(a: string, b: string): number | null {
  const pa = parse(a.trim());
  const pb = parse(b.trim());
  if (!pa || !pb) return null;
  const ca = toRgb(pa);
  const cb = toRgb(pb);
  const alphaA = ca.alpha ?? 1;
  const alphaB = cb.alpha ?? 1;
  if (alphaA < 0.005 && alphaB < 0.005) return 0;
  const over = (c: typeof ca, alpha: number, bg: number) => ({
    mode: 'rgb' as const,
    r: c.r * alpha + bg * (1 - alpha),
    g: c.g * alpha + bg * (1 - alpha),
    b: c.b * alpha + bg * (1 - alpha),
  });
  const de = differenceCiede2000();
  return Math.max(de(over(ca, alphaA, 1), over(cb, alphaB, 1)), de(over(ca, alphaA, 0), over(cb, alphaB, 0)));
}

/**
 * px / rem / em / unitless-zero → px number, or null (e.g. "auto", "normal",
 * percentages). Accepts exponent notation: Tailwind v4's `rounded-full` is
 * `calc(infinity * 1px)`, which Chromium serializes as `3.35544e+07px`.
 */
export function lengthToPx(value: string, rootFontSizePx = 16, elementFontSizePx = rootFontSizePx): number | null {
  const v = value.trim();
  if (v === '0') return 0;
  const m = v.match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|rem|em)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  if (unit === 'px') return n;
  if (unit === 'rem') return n * rootFontSizePx;
  return n * elementFontSizePx;
}

/**
 * line-height → a ratio of font-size, handling all three forms browsers
 * return: unitless ("1.6"), resolved px ("25.6px"), or "normal" (null —
 * font-dependent, not comparable to a DS token without font metrics).
 */
export function lineHeightRatio(lineHeight: string, fontSizePx: number): number | null {
  const v = lineHeight.trim();
  if (v === 'normal') return null;
  if (/^[\d.]+$/.test(v)) return Number(v);
  const px = lengthToPx(v, 16, fontSizePx);
  return px === null || fontSizePx === 0 ? null : Math.round((px / fontSizePx) * 1000) / 1000;
}
