import type { Finding } from '../audit-link/index.ts';
import type { PreviewNode } from './types.ts';

/**
 * Which design-system Button variant is this call-to-action — decided from what the ORIGINAL element looks like, not only from the
 * audit's label.
 *
 * Why: the audit measured only the element's own box. On this page the hero CTAs get their red from a CHILD layer
 * (`absolute -z-10 … bg-[linear-gradient(90deg,#B01F24 …)]`) while the `<a>` itself is transparent with white text, so the audit
 * matched every CTA to "Button ghost · light" — and mounting that gave grey outlined buttons where the page has red brand CTAs. A
 * white-filled button on a dark photo (View More) was likewise mounted for a light surface.
 *
 *  - a descendant painted with the brand-red gradient → `brand` (the project's primary-action variant; never `primary`);
 *  - a white fill with dark text, or a brand-red outline without fill → `secondary`;
 *  - otherwise the variant the audit matched (`brand` / `secondary` / `ghost`).
 *  - `background` follows the SURFACE the section sits on: a section whose headings are light-on-dark is `dark`.
 */

type El = Extract<PreviewNode, { t: 'el' }>;
const BRAND_RED = /#B01F24/i;

function descendantClasses(n: PreviewNode): string[] {
  return n.t === 'el' ? n.children.flatMap((c) => (c.t === 'el' ? [c.attrs['class'] ?? '', ...descendantClasses(c)] : [])) : [];
}

export const hasBrandGradientLayer = (node: El): boolean => descendantClasses(node).some((c) => /gradient/i.test(c) && BRAND_RED.test(c));

// the brand red as the browser serializes it (rgb(176, 31, 36)) or as authored (#B01F24)
const BRAND_RED_ANY = /#B01F24|rgba?\(\s*176[,\s]+31[,\s]+36\b/i;

/** The control's OWN fill is brand red: a `background` / `background-image` / `background-color` of the element itself (inline style) that is a red gradient or the brand red. */
/** The control is a brand-red OUTLINE with no fill: brand-red border and brand-red text (class tokens or inline colour). */
export function isBrandRedOutline(node: El): boolean {
  const cls = node.attrs['class'] ?? '';
  const border = /(^|\s)border-\[#B01F24\]/i.test(cls) || BRAND_RED_ANY.test(node.style?.['border-color'] ?? '') || BRAND_RED_ANY.test(node.style?.['border'] ?? '');
  const text = /(^|\s)text-\[#B01F24\]/i.test(cls) || BRAND_RED_ANY.test(node.style?.['color'] ?? '');
  return border && text && !paintsOwnBrandFill(node);
}

export function paintsOwnBrandFill(node: El): boolean {
  const inline = Object.entries(node.style ?? {}).filter(([k]) => /^background(-color|-image)?$/i.test(k)).map(([, v]) => v);
  const attr = /background(?:-color|-image)?\s*:\s*([^;]+)/i.exec(node.attrs['style'] ?? '');
  if (attr?.[1]) inline.push(attr[1]);
  return inline.some((v) => BRAND_RED_ANY.test(v));
}

const channel = (v: string): number[] | null => {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const luma = (rgb: number[]): number => (0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!) / 255;

function measured(f: Finding, prop: string): string | null {
  const p = (f.comparison.properties ?? []).find((x) => x.property === prop);
  return p && typeof p.actual === 'string' ? p.actual : null;
}

/** 'dark' when the section's headings are light text (on a dark surface), else 'light'. */
export function surfaceOf(sectionName: string, findings: readonly Finding[]): 'dark' | 'light' {
  const headings = findings.filter((f) => f.location.section === sectionName && (f.component.productionType === 'section-heading' || f.component.productionType === 'heading'));
  const lumas = headings.map((f) => measured(f, 'color')).map((c) => (c ? channel(c) : null)).filter((c): c is number[] => !!c).map(luma);
  return lumas.length > 0 && lumas.reduce((a, b) => a + b, 0) / lumas.length > 0.7 ? 'dark' : 'light';
}

export interface CtaStyle { variant: 'brand' | 'secondary' | 'ghost'; background: 'light' | 'dark'; why: string }

export function ctaStyleFor(node: El, finding: Finding, matched: { variant: string; background: string }, surface: 'dark' | 'light'): CtaStyle {
  const background = surface;
  if (hasBrandGradientLayer(node)) return { variant: 'brand', background: 'light', why: 'the original paints a brand-red gradient layer inside the control (the audit only measured its transparent box)' };
  if (paintsOwnBrandFill(node)) return { variant: 'brand', background: 'light', why: 'the original control itself is filled with the brand red (inline background), which the audit did not measure as a fill' };
  // brand red is reserved for the primary action: a red OUTLINE is the page's second CTA, and the DS Button for a secondary action is `secondary`
  // (white fill, neutral rest, brand-red on hover) — not `ghost`, which is transparent with an always-on grey shimmer.
  if (isBrandRedOutline(node)) return { variant: 'secondary', background, why: 'the original is a brand-red outline control: the secondary action, which the design system draws as Button secondary' };
  const fill = measured(finding, 'background-color');
  const text = measured(finding, 'color');
  const fillRgb = fill ? channel(fill) : null;
  const textRgb = text ? channel(text) : null;
  if (fillRgb && luma(fillRgb) > 0.95 && (!textRgb || luma(textRgb) < 0.4)) return { variant: 'secondary', background, why: 'the original is a white-filled control with dark text' };
  const v = ['brand', 'secondary', 'ghost'].includes(matched.variant) ? (matched.variant as CtaStyle['variant']) : 'brand';
  return { variant: v, background, why: `the audit's matched variant (${matched.variant})` };
}
