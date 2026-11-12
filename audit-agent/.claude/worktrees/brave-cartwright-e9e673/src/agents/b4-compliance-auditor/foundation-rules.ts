import { resolveToken } from '../../ds/d3-tokens/resolve.ts';
import { effectiveTokenMap } from '../../ds/catalog.ts';
import { colorDeltaEWithAlpha, lengthToPx } from '../../t-layer/computed-style.ts';
import { COLOR_DELTA_E_THRESHOLD, familyList, GENERIC_FAMILIES } from '../../t-layer/token-comparator.ts';
import type { DsRegistry } from '../../ds/d2-registry/index.ts';
import type { ExtractedStyle } from '../../t-layer/computed-style.ts';
import type { Severity } from '../../skills/s0-result-contract.ts';

/**
 * Deterministic foundation-rule checks (no-api mode, Decision Log #31).
 *
 * The Design System's foundation rules govern EVERY element, whatever
 * component it is — so a measured breach is proven even when the component
 * itself cannot be identified. Only rules whose check is a plain measurement
 * against the DS's own values are here, each stated exactly as RULES.md does:
 *
 *  - R1.4 Two-Font Pairing: text is set in Noto Serif (display) or DM Sans
 *    (body/UI); never serif on UI, never sans on a display heading (≥ 25px).
 *  - R1.3 Major Third Typography: every font size is a DS text-size token.
 *  - R3.6 Border Radius Decision Table: "NEVER arbitrary px values" — every
 *    radius is a DS radius token (or fully rounded).
 *  - R1.2 Brand Red is for CTAs ONLY: "NEVER for … headings".
 *
 * Rules whose check needs judgment (R1.2 on a link, R7.1 contrast against an
 * image, R5.1 "never hardcode" — a hardcoded value that EQUALS a token is
 * invisible in computed styles) are deliberately absent: never guessed.
 */

export interface FoundationContext {
  tokens: Map<string, string>;
  /** Only rules the DS actually defines are ever cited. */
  ruleTitles: Map<string, string>;
  sansFamilies: Set<string>;
  serifFamilies: Set<string>;
  /** Every DS text size, in px at the 16px root. */
  textSizesPx: number[];
  /** Every DS radius, in px. */
  radiiPx: number[];
  brandRed: string | null;
}

export interface FoundationViolation {
  ruleId: string;
  title: string;
  why: string;
  severity: Severity;
  property: string;
  actual: string;
  expected: string;
}

/** Elements whose text is UI, never display — serif there breaks R1.4. */
const UI_TYPES = new Set(['button', 'link', 'nav-link', 'icon-button', 'input', 'select', 'search', 'badge', 'chip', 'tag', 'eyebrow', 'tabs', 'breadcrumb', 'checkbox', 'radio', 'textarea']);

/** R1.3's hero exception: the H1 may be clamp-responsive up to --text-3xl, so its px size varies by viewport. */
const HERO_CLAMP_MIN_PX = 36;

const contextCache = new WeakMap<DsRegistry, FoundationContext>();

function familiesOf(value: string | undefined, tokens: Map<string, string>): string[] {
  if (!value) return [];
  return familyList(value, tokens).map((f) => f.toLowerCase()).filter((f) => !GENERIC_FAMILIES.has(f));
}

function lengthsOf(tokens: Map<string, string>, include: RegExp, exclude: RegExp): number[] {
  const out = new Set<number>();
  for (const [name] of tokens) {
    if (!include.test(name) || exclude.test(name)) continue;
    const resolved = resolveToken(name, tokens);
    const px = resolved ? lengthToPx(resolved.trim()) : null;
    if (px !== null && Number.isFinite(px)) out.add(Math.round(px * 1000) / 1000);
  }
  return [...out].sort((a, b) => a - b);
}

export function buildFoundationContext(registry: DsRegistry): FoundationContext {
  const cached = contextCache.get(registry);
  if (cached) return cached;
  const tokens = effectiveTokenMap(registry, 'editorial-light');
  const ctx: FoundationContext = {
    tokens,
    ruleTitles: new Map(registry.rules.rules.map((r) => [r.id, r.title])),
    sansFamilies: new Set(familiesOf(tokens.get('--font-sans'), tokens).slice(0, 1)),
    serifFamilies: new Set(familiesOf(tokens.get('--font-serif'), tokens).slice(0, 1)),
    textSizesPx: lengthsOf(tokens, /^--(text|typography-size|button-font|font-size)(-|$)|^--badge-[a-z]+-font$/, /tracking|measure|leading|line-height|color|primary|secondary|muted|weight|family|eyebrow-tracking/),
    radiiPx: lengthsOf(tokens, /^--(radius|badge-radius|rc-radius)(-|$)/, /^$/),
    brandRed: (() => {
      const v = resolveToken('--color-brand-red', tokens) ?? resolveToken('--brand-red', tokens);
      return v ? v.trim() : null;
    })(),
  };
  contextCache.set(registry, ctx);
  return ctx;
}

const near = (value: number, scale: number[], tolerance = 0.5) => scale.some((s) => Math.abs(s - value) <= tolerance);
const fmt = (n: number) => `${Math.round(n * 100) / 100}px`;

export function checkFoundationRules(input: {
  componentType: string;
  /** 1–6 for an h1–h6 element, else null. */
  headingLevel: number | null;
  /** Whether the element renders text — a typeface rule means nothing on an icon. */
  hasText: boolean;
  style: ExtractedStyle;
  ctx: FoundationContext;
}): FoundationViolation[] {
  const { style, ctx } = input;
  if (!style.connected) return [];
  const out: FoundationViolation[] = [];
  const cite = (ruleId: string, v: Omit<FoundationViolation, 'ruleId' | 'title'>) => {
    const title = ctx.ruleTitles.get(ruleId);
    if (title) out.push({ ruleId, title, ...v });
  };
  const fontSizePx = lengthToPx(style.raw['font-size'] ?? '', style.rootFontSizePx);

  if (input.hasText) {
    // ── R1.4: the typeface itself ──
    const rawFamily = style.raw['font-family'] ?? '';
    const declared = familyList(rawFamily, ctx.tokens).map((f) => f.toLowerCase());
    const concrete = declared.find((f) => !GENERIC_FAMILIES.has(f)) ?? null;
    const dsFamilies = new Set([...ctx.sansFamilies, ...ctx.serifFamilies]);
    if (declared.length > 0 && dsFamilies.size > 0) {
      const leading = declared[0] as string;
      if (!concrete || !dsFamilies.has(leading)) {
        // A stack that LEADS with a generic family renders the browser/system default face —
        // name that, not whatever emoji font happens to be the first concrete name after it.
        const face = GENERIC_FAMILIES.has(leading) ? `the browser's default ${leading} face` : `"${leading}"`;
        cite('R1.4', {
          why: `set in ${face} (${rawFamily.slice(0, 60)}) — not a Design System typeface (Noto Serif for display, DM Sans for body/UI)`,
          severity: 'HIGH',
          property: 'font-family',
          actual: leading,
          expected: [...ctx.serifFamilies, ...ctx.sansFamilies].join(' / '),
        });
      } else if (ctx.serifFamilies.has(leading) && UI_TYPES.has(input.componentType)) {
        cite('R1.4', {
          why: `a ${input.componentType} set in the serif display face — R1.4: "NEVER serif for body/buttons/nav/labels"`,
          severity: 'MEDIUM',
          property: 'font-family',
          actual: leading,
          expected: [...ctx.sansFamilies].join(' / '),
        });
      } else if (ctx.sansFamilies.has(leading) && input.headingLevel !== null && input.headingLevel <= 3 && fontSizePx !== null && fontSizePx >= 25) {
        cite('R1.4', {
          why: `an h${input.headingLevel} at ${fmt(fontSizePx)} set in the sans UI face — R1.4: "NEVER sans for hero H1 / section H2 / H3" (serif from 25px)`,
          severity: 'MEDIUM',
          property: 'font-family',
          actual: leading,
          expected: [...ctx.serifFamilies].join(' / '),
        });
      }
    }

    // ── R1.3: the size is a step of the DS type scale ──
    const heroClamp = input.headingLevel === 1 && fontSizePx !== null && fontSizePx >= HERO_CLAMP_MIN_PX;
    if (fontSizePx !== null && ctx.textSizesPx.length > 0 && !heroClamp && !near(fontSizePx, ctx.textSizesPx)) {
      const nearest = [...ctx.textSizesPx].sort((a, b) => Math.abs(a - fontSizePx) - Math.abs(b - fontSizePx)).slice(0, 2).sort((a, b) => a - b);
      cite('R1.3', {
        why: `font-size ${fmt(fontSizePx)} is not a step of the Design System type scale (nearest: ${nearest.map(fmt).join(' / ')})`,
        severity: 'MEDIUM',
        property: 'font-size',
        actual: fmt(fontSizePx),
        expected: nearest.map(fmt).join(' or '),
      });
    }

    // ── R1.2: brand red is never heading text ──
    if (input.headingLevel !== null && ctx.brandRed) {
      const d = colorDeltaEWithAlpha(style.raw.color ?? '', ctx.brandRed);
      if (d !== null && d <= COLOR_DELTA_E_THRESHOLD) {
        cite('R1.2', {
          why: `heading text in brand red — R1.2: brand red is for CTAs only, "NEVER for … headings"`,
          severity: 'CRITICAL',
          property: 'color',
          actual: style.raw.color ?? '',
          expected: 'a text ink (not brand red)',
        });
      }
    }
  }

  // ── R3.6: radii come from the DS radius scale ──
  const corners = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
  const box = style.box ?? null;
  const fullyRound = (r: number) => box !== null && r >= Math.min(box.width, box.height) / 2 - 0.5;
  for (const corner of corners) {
    const first = (style.raw[corner] ?? '').trim().split(/\s+/)[0] ?? '';
    const r = lengthToPx(first, style.rootFontSizePx);
    if (r === null || r <= 0.5 || r >= 999 || fullyRound(r) || near(r, ctx.radiiPx)) continue;
    cite('R3.6', {
      why: `border-radius ${fmt(r)} is not on the Design System radius scale (${ctx.radiiPx.filter((x) => x < 999).map(fmt).join(' / ')}) — R3.6: "NEVER arbitrary px values"`,
      severity: 'LOW',
      property: corner,
      actual: fmt(r),
      expected: 'a DS radius token',
    });
    break; // one radius finding per element — the corners share one cause
  }
  return out;
}
