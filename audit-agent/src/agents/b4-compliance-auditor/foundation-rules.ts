import { resolveToken } from '../../ds/d3-tokens/resolve.ts';
import { effectiveTokenMap } from '../../ds/catalog.ts';
import { colorDeltaEWithAlpha, lengthToPx } from '../../t-layer/computed-style.ts';
import { COLOR_DELTA_E_THRESHOLD, familyList, GENERIC_FAMILIES } from '../../t-layer/token-comparator.ts';
import { pickNearestSize, type SizeCandidate } from '../../skills/nearest-typography.ts';
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
 *  - R3.5 Spacing Scale Discipline: every gap/padding/margin is a step of the
 *    DS's named spacing scale (`--space-2xs`…`--space-5xl`, 4–128px) — "NEVER
 *    arbitrary values (5px · 13px · 27px etc)."
 *  - R3.6 Border Radius Decision Table: "NEVER arbitrary px values" — every
 *    radius is a DS radius token (or fully rounded).
 *  - R1.2 Brand Red is for CTAs ONLY: "NEVER for … headings".
 *
 * Rules whose check needs judgment (R1.2 on a link, R7.1 contrast against an
 * image, R5.1 "never hardcode" — a hardcoded value that EQUALS a token is
 * invisible in computed styles) are deliberately absent: never guessed.
 *
 * R1.3, R3.5 and R3.6 share ONE mechanism (src/skills/nearest-typography.ts):
 * when a measured value is not a step of the relevant DS scale, the single
 * NEAREST step (by px distance, within that property's own token family —
 * never a value borrowed from a different family) is cited as `expected`,
 * never a generic "use a DS token" and never a list of every valid step. A
 * property a matched DS component/variant already governs is never
 * second-guessed here — see `b4-compliance-auditor/index.ts`'s
 * `filterFoundationViolations`, which drops a foundation citation for any
 * property the matched variant's own comparison already resolved (pass OR
 * mismatch): that comparison's expected value is the exact contract, this
 * module's nearest-scale check is only a backstop for what it did not cover.
 */

export interface FoundationContext {
  tokens: Map<string, string>;
  /** Only rules the DS actually defines are ever cited. */
  ruleTitles: Map<string, string>;
  sansFamilies: Set<string>;
  serifFamilies: Set<string>;
  /**
   * The sizes R1.3 accepts, in px at the 16px root: the DS Major Third STEPS plus the exceptions R1.3 itself documents
   * ("only deviate for spatial constraints" — --text-compact · --text-nav · --text-2xs · --text-card-micro). Legacy remap
   * tokens, component-specific tokens and aliases are NOT in it — see `textTokens`.
   */
  textSizesPx: number[];
  /** Every text-size-looking DS token, CLASSIFIED — so a size that equals a legacy / component token can say what it is. */
  textTokens?: TextToken[];
  /** Every DS radius, in px. */
  radiiPx: number[];
  /** The DS's named spacing scale (R3.5: `--space-2xs`…`--space-5xl`), in px — never the Tailwind-interop `--space-1`…`--space-20` numeric aliases R3.5 itself calls "intentional gaps…to discourage off-rhythm values". */
  spacingPx: number[];
  brandRed: string | null;
  /** Every DS colour token that resolves to a concrete colour — the palette body text and stat numerals must be drawn from (R1.1). */
  palette?: Array<{ token: string; value: string }>;
}

/**
 * What a DS text-size token IS (read from the DS, never assumed):
 *  - `scale`      a Major Third step R1.3 names (12.8 / 16 / 20 / 25 / 31.25 / 39 / 48.8 / 61 / 76.3) — the general typography tokens;
 *  - `exception`  a size R1.3's own "WHEN NOT" documents for spatial constraints (--text-compact, --text-nav, --text-2xs, --text-card-micro);
 *  - `legacy`     a remap kept for old pages ("ADDED TYPE TOKENS · V0.2 remap": --text-md, -13, -24, -30, -32, -48, --text-nav-helper);
 *  - `component`  a token one component owns (--button-font-*, --badge-*-font, --text-paywall-*, --text-data-label, --text-eyebrow, …);
 *  - `alias`      a second spelling (--typography-size-*, --font-size) — its value is never trusted over the --text-* token it mirrors
 *                 (--typography-size-2xs is 11px in FOUNDATIONS but a 12px CSS fallback in utilities.css).
 * Only `scale` and `exception` are valid text sizes for general text.
 */
export type TextTokenClass = 'scale' | 'exception' | 'legacy' | 'component' | 'alias';
export interface TextToken { token: string; px: number; value: string; klass: TextTokenClass }

const SCALE_STEP = /^--text-(xs|sm|base|lg|xl|[2-5]xl)$/;
const LEGACY_TEXT = /^--text-(md|nav-helper|\d+)$/;
const ALIAS_TEXT = /^--(typography-size-[a-z0-9]+|font-size)$/;
/** The exceptions RULES.md R1.3 names, when the registry's rules are not available. */
const DEFAULT_R13_EXCEPTIONS = ['--text-compact', '--text-nav', '--text-2xs', '--text-card-micro'];

function classifyTextTokens(tokens: Map<string, string>, exceptions: ReadonlySet<string>): TextToken[] {
  const include = /^--(text|typography-size|button-font|font-size)(-|$)|^--badge-[a-z]+-font$/;
  const exclude = /tracking|measure|leading|line-height|color|primary|secondary|muted|weight|family/;
  const out: TextToken[] = [];
  for (const [name] of tokens) {
    if (!include.test(name) || exclude.test(name)) continue;
    const value = resolveToken(name, tokens)?.trim() ?? '';
    const px = value ? lengthToPx(value) : null;
    if (px === null || !Number.isFinite(px)) continue;
    const klass: TextTokenClass = exceptions.has(name) ? 'exception' : SCALE_STEP.test(name) ? 'scale' : ALIAS_TEXT.test(name) ? 'alias' : LEGACY_TEXT.test(name) ? 'legacy' : 'component';
    out.push({ token: name, px: Math.round(px * 1000) / 1000, value, klass });
  }
  return out;
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
    textSizesPx: [],
    textTokens: [],
    radiiPx: lengthsOf(tokens, /^--(radius|badge-radius|rc-radius)(-|$)/, /^$/),
    // Only the named scale R3.5 actually documents (`--space-2xs`…`--space-5xl`). The registry also
    // defines `--space-1`…`--space-20` (and `-1-5`/`-2-5`/`-3-5`) as Tailwind-interop numeric aliases
    // — R3.5's own text calls the values they fill in "intentional gaps…to discourage off-rhythm
    // values", so including them would defeat the rule by making every off-scale value "valid".
    spacingPx: lengthsOf(tokens, /^--space-(2xs|xs|sm|md|lg|xl|2xl|3xl|4xl|5xl)$/, /^$/),
    brandRed: (() => {
      const v = resolveToken('--color-brand-red', tokens) ?? resolveToken('--brand-red', tokens);
      return v ? v.trim() : null;
    })(),
    palette: [...tokens.keys()].flatMap((name) => {
      // The canonical palette only (foundation black/white, brand red, accents and their ramps) — never a
      // surface, border or semantic alias: text is never recommended a background colour.
      if (!/^--color-(foundation|brand|accent|ramp)-/.test(name)) return [];
      const value = resolveToken(name, tokens)?.trim();
      return value && colorDeltaEWithAlpha(value, '#000000') !== null ? [{ token: name, value }] : [];
    }),
  };
  // The sizes R1.3 accepts come from the DS's OWN statement of its scale: the Major Third steps, plus the exceptions
  // R1.3's "WHEN NOT" names (read from the rule text; the documented four when the rules are not available).
  const r13 = registry.rules.rules.find((r) => r.id === 'R1.3');
  const named = new Set([...(r13?.fields['WHEN NOT'] ?? '').matchAll(/--text-[a-z0-9-]+/g)].map((m) => m[0]));
  ctx.textTokens = classifyTextTokens(tokens, named.size > 0 ? named : new Set(DEFAULT_R13_EXCEPTIONS));
  ctx.textSizesPx = [...new Set(ctx.textTokens.filter((t) => t.klass === 'scale' || t.klass === 'exception').map((t) => t.px))].sort((a, b) => a - b);
  contextCache.set(registry, ctx);
  return ctx;
}

const near = (value: number, scale: number[], tolerance = 0.5) => scale.some((s) => Math.abs(s - value) <= tolerance);
const fmt = (n: number) => `${Math.round(n * 100) / 100}px`;

/**
 * The single nearest step of a DS numeric scale (src/skills/nearest-typography.ts) — shared by
 * R1.3 (type scale), R3.5 (spacing scale) and R3.6 (radius scale), each passing only ITS OWN
 * token family's values, so a radius is never recommended a spacing step or vice versa. Null when
 * the scale is empty or `valuePx` isn't a usable number — the caller then cites no recommendation
 * rather than guessing one.
 */
function nearestStep(valuePx: number, scalePx: number[]): { sizePx: number; distancePx: number } | null {
  const candidates: Array<SizeCandidate<number>> = scalePx.map((px) => ({ id: String(px), sizePx: px, payload: px }));
  const choice = pickNearestSize(valuePx, candidates);
  return choice ? { sizePx: choice.chosen.sizePx, distancePx: choice.distancePx } : null;
}

export function checkFoundationRules(input: {
  componentType: string;
  /** 1–6 for an h1–h6 element, else null. */
  headingLevel: number | null;
  /** Whether the element renders text — a typeface rule means nothing on an icon. */
  hasText: boolean;
  style: ExtractedStyle;
  ctx: FoundationContext;
  /**
   * The ROLE B2 decided from the section (never the tag or the size alone): `card-title` is judged against the DS's documented
   * card-title contract (R4.3.5 — `--text-base` 20px with 4+ cards, `--text-lg` 25px with 2–3 — in DM Sans 500, R1.4 "H4 card
   * titles") instead of only the generic scale. Any other role changes nothing here.
   */
  role?: string | null | undefined;
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
    // A card title is judged by its own documented contract below (its size is one of two DS sizes, both on the scale).
    if (input.role !== 'card-title' && input.role !== 'question' && fontSizePx !== null && ctx.textSizesPx.length > 0 && !heroClamp && !near(fontSizePx, ctx.textSizesPx)) {
      // The ONE nearest step of the scale — a single value to recommend, never "this or that".
      const closest = nearestStep(fontSizePx, ctx.textSizesPx);
      if (closest) {
        // A size that EQUALS a legacy / component / alias token is still off the scale — and says what that token is.
        const rank = (k: TextTokenClass) => (k === 'legacy' ? 0 : k === 'component' ? 1 : 2);
        const lookalike = (ctx.textTokens ?? []).filter((t) => t.klass !== 'scale' && t.klass !== 'exception' && Math.abs(t.px - fontSizePx) <= 0.5).sort((a, b) => rank(a.klass) - rank(b.klass) || a.token.localeCompare(b.token))[0];
        const aside = lookalike ? ` — it equals ${lookalike.token}, a ${lookalike.klass === 'legacy' ? 'legacy remap' : lookalike.klass === 'component' ? 'component-specific' : 'alias'} token the DS keeps outside its type scale` : '';
        cite('R1.3', {
          why: `font-size ${fmt(fontSizePx)} is not a step of the Design System type scale (closest: ${fmt(closest.sizePx)}, ${fmt(closest.distancePx)} away)${aside}`,
          severity: 'MEDIUM',
          property: 'font-size',
          actual: fmt(fontSizePx),
          expected: fmt(closest.sizePx),
        });
      }
    }

    // ── Card title (R4.3.5 + R1.4 "H4 card titles"): the documented contract, not just the generic scale ──
    if (input.role === 'card-title') {
      const sizes = ['--text-base', '--text-lg'].map((t) => ({ t, px: (() => { const v = resolveToken(t, ctx.tokens); return v ? lengthToPx(v.trim()) : null; })() })).filter((x): x is { t: string; px: number } => x.px !== null);
      if (fontSizePx !== null && sizes.length > 0 && !sizes.some((x) => Math.abs(x.px - fontSizePx) <= 0.5)) {
        const closest = nearestStep(fontSizePx, sizes.map((x) => x.px));
        if (closest) {
          cite('R4.3', {
            why: `card title set at ${fmt(fontSizePx)} — R4.3.5: a card title is ${sizes.map((x) => `${x.t} (${fmt(x.px)})`).join(' with 4+ cards, or ')} with 2–3 cards (closest: ${fmt(closest.sizePx)}, ${fmt(closest.distancePx)} away)`,
            severity: 'MEDIUM',
            property: 'font-size',
            actual: fmt(fontSizePx),
            expected: fmt(closest.sizePx),
          });
        }
      }
      const weight = Number(style.raw['font-weight'] ?? '');
      const mediumRaw = resolveToken('--font-weight-medium', ctx.tokens);
      const medium = mediumRaw ? Number(mediumRaw.trim()) : NaN;
      if (Number.isFinite(weight) && Number.isFinite(medium) && weight !== medium) {
        cite('R1.4', {
          why: `card title at weight ${weight} — R1.4: "H4 card titles (500 medium · 20px)"`,
          severity: 'LOW',
          property: 'font-weight',
          actual: String(weight),
          expected: String(medium),
        });
      }
      const rawFam = familyList(style.raw['font-family'] ?? '', ctx.tokens).map((f) => f.toLowerCase());
      if (rawFam[0] && ctx.serifFamilies.has(rawFam[0])) {
        cite('R1.4', {
          why: `a card title set in the serif display face — R1.4: H4 card titles are sans ("serif loses clarity below 25px in dense UI — H4 (20px) drops to sans")`,
          severity: 'MEDIUM',
          property: 'font-family',
          actual: rawFam[0],
          expected: [...ctx.sansFamilies].join(' / '),
        });
      }
    }

    // ── FAQ question: the DS AccordionItem contract (question = --text-sm, weight 500, DM Sans) — its nearest match, not a heading size ──
    // Accepted sizes: the AccordionItem's own --text-sm, and the exceptions R1.3 documents for compact UI text (--text-compact /
    // --text-nav, 14px) — those are DS sizes too, so a 14px question is not a deviation. Anything else gets ONE recommendation: the
    // nearest accepted size.
    if (input.role === 'question') {
      const sm = resolveToken('--text-sm', ctx.tokens);
      const smPx = sm ? lengthToPx(sm.trim(), style.rootFontSizePx) : null;
      const accepted = [...new Set([...(smPx !== null ? [smPx] : []), ...(ctx.textTokens ?? []).filter((t) => t.klass === 'exception' && t.px >= 14).map((t) => t.px)])];
      if (fontSizePx !== null && smPx !== null && !accepted.some((a) => Math.abs(a - fontSizePx) <= 0.5)) {
        const closest = nearestStep(fontSizePx, accepted) ?? { sizePx: smPx, distancePx: Math.abs(smPx - fontSizePx) };
        cite('R1.3', {
          why: `FAQ question set at ${fmt(fontSizePx)} — the DS AccordionItem question is --text-sm (${fmt(smPx)}) in DM Sans 500${accepted.length > 1 ? `, or a documented compact-text size (${accepted.filter((a) => a !== smPx).map(fmt).join(' / ')})` : ''} (closest: ${fmt(closest.sizePx)}, ${fmt(closest.distancePx)} away)`,
          severity: 'MEDIUM',
          property: 'font-size',
          actual: fmt(fontSizePx),
          expected: fmt(closest.sizePx),
        });
      }
      const qWeight = Number(style.raw['font-weight'] ?? '');
      const qMediumRaw = resolveToken('--font-weight-medium', ctx.tokens);
      const qMedium = qMediumRaw ? Number(qMediumRaw.trim()) : NaN;
      if (Number.isFinite(qWeight) && Number.isFinite(qMedium) && qWeight !== qMedium) {
        cite('R1.4', {
          why: `FAQ question at weight ${qWeight} — the DS AccordionItem question is weight ${qMedium} (font-medium)`,
          severity: 'LOW',
          property: 'font-weight',
          actual: String(qWeight),
          expected: String(qMedium),
        });
      }
    }

    // ── R1.2: brand red is never heading text ──
    // (An eyebrow / supporting heading is not a heading in this sense: the DS's own eyebrow atoms are
    // brand red on light surfaces — a heading TAG on one does not make it heading text.)
    if (input.headingLevel !== null && input.componentType !== 'eyebrow' && ctx.brandRed) {
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

  // ── R1.2: brand red is never a border or a decorative fill on a non-CTA element ──
  // RULES.md's own "WHEN NOT" for R1.2 lists these explicitly: "NEVER for borders · icons ·
  // section bgs · decoration · body text · headings · hover states" — `--brand-red` is button
  // `variant="brand"` ONLY. Foundation-rules has no per-variant granularity, so this is
  // deliberately conservative: skip componentType 'button' entirely (a real brand CTA legitimately
  // has a brand-red border/fill) rather than risk a false positive on the one case the rule allows.
  if (input.componentType !== 'button' && ctx.brandRed) {
    const borderColor = colorDeltaEWithAlpha(style.raw['border-top-color'] ?? '', ctx.brandRed);
    const bgColor = colorDeltaEWithAlpha(style.raw['background-color'] ?? '', ctx.brandRed);
    const borderIsBrandRed = borderColor !== null && borderColor <= COLOR_DELTA_E_THRESHOLD && (style.raw['border-top-width'] ?? '0px') !== '0px';
    const bgIsBrandRed = bgColor !== null && bgColor <= COLOR_DELTA_E_THRESHOLD;
    if (borderIsBrandRed || bgIsBrandRed) {
      const parts = [borderIsBrandRed ? `border (${style.raw['border-top-color']})` : null, bgIsBrandRed ? `background (${style.raw['background-color']})` : null].filter(Boolean);
      cite('R1.2', {
        why: `brand red used decoratively on a non-CTA ${input.componentType} (${parts.join(' and ')}) — R1.2: brand red is for CTAs only, "NEVER for borders · icons · section bgs · decoration"`,
        severity: 'CRITICAL',
        property: borderIsBrandRed ? 'border-top-color' : 'background-color',
        actual: borderIsBrandRed ? (style.raw['border-top-color'] ?? '') : (style.raw['background-color'] ?? ''),
        expected: 'a foundation or accent colour (not brand red)',
      });
    }
  }

  // ── R1.1 / R1.2 on body text and stat numerals ──
  // These two types have no DS component, so the palette itself is the contract: R1.1 (92-5-3) says
  // every text colour is a foundation/accent token, and R1.2 says brand red is never body text. A
  // stat painted with `background-clip:text` has a transparent `color` — its ink is the gradient.
  if ((input.componentType === 'paragraph' || input.componentType === 'stat') && input.hasText) {
    const ink = textInkOf(style);
    if (ctx.brandRed && ink.some((c) => (colorDeltaEWithAlpha(c, ctx.brandRed as string) ?? 99) <= COLOR_DELTA_E_THRESHOLD)) {
      cite('R1.2', {
        why: `${input.componentType === 'stat' ? 'stat numeral' : 'body text'} painted in brand red${ink.length > 1 ? ' (a gradient with a brand-red stop)' : ''} — R1.2: brand red is for CTAs only, "NEVER for … body text · decoration"`,
        severity: 'CRITICAL',
        property: 'color',
        actual: ink.length > 1 ? (style.raw['background-image'] ?? '').slice(0, 80) : (style.raw.color ?? ''),
        expected: 'a text ink (not brand red)',
      });
    } else if ((ctx.palette?.length ?? 0) > 0 && ink.length === 1) {
      const colour = ink[0] as string;
      const nearest = (ctx.palette ?? [])
        .map((p) => ({ p, d: colorDeltaEWithAlpha(colour, p.value) }))
        .filter((x): x is { p: { token: string; value: string }; d: number } => x.d !== null)
        .sort((a, b) => a.d - b.d)[0];
      if (nearest && nearest.d > COLOR_DELTA_E_THRESHOLD) {
        cite('R1.1', {
          why: `${input.componentType === 'stat' ? 'stat numeral' : 'body text'} colour ${colour} is not a Design System colour (closest: ${nearest.p.token} ${nearest.p.value}, ΔE ${Math.round(nearest.d * 10) / 10}) — R1.1: text is drawn from the foundation palette`,
          severity: 'MEDIUM',
          property: 'color',
          actual: colour,
          expected: `${nearest.p.token} (${nearest.p.value})`,
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
    // The ONE nearest step of the radius scale — never the generic "a DS radius token" that lists
    // every valid step without saying which one, and never a value from another token family.
    const closest = nearestStep(r, ctx.radiiPx.filter((x) => x < 999));
    if (!closest) continue;
    cite('R3.6', {
      why: `border-radius ${fmt(r)} is not on the Design System radius scale (${ctx.radiiPx.filter((x) => x < 999).map(fmt).join(' / ')}) — R3.6: "NEVER arbitrary px values" (nearest: ${fmt(closest.sizePx)}, ${fmt(closest.distancePx)} away)`,
      severity: 'LOW',
      property: corner,
      actual: fmt(r),
      expected: fmt(closest.sizePx),
    });
    break; // one radius finding per element — the corners share one cause
  }

  // ── R3.5: gaps/padding/margin come from the DS's named spacing scale ──
  // One citation per DISTINCT off-scale value within each spacing kind (padding/margin/gap), so an
  // element whose padding is 20px on all four sides is not cited four times for the same choice —
  // but a 20px padding and a 13px margin on the SAME element are different decisions and both cited.
  const SPACING_GROUPS: Array<[string, string[]]> = [
    ['padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
    ['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
    ['gap', ['gap', 'row-gap', 'column-gap']],
  ];
  if (ctx.spacingPx.length > 0) {
    for (const [kind, props] of SPACING_GROUPS) {
      const citedValues = new Set<number>();
      for (const prop of props) {
        const raw = (style.raw[prop] ?? '').trim();
        const v = lengthToPx(raw, style.rootFontSizePx);
        if (v === null || v <= 0 || near(v, ctx.spacingPx)) continue;
        const rounded = Math.round(v * 100) / 100;
        if (citedValues.has(rounded)) continue;
        const closest = nearestStep(v, ctx.spacingPx);
        if (!closest) continue;
        citedValues.add(rounded);
        cite('R3.5', {
          why: `${kind} ${fmt(v)} is not a step of the Design System spacing scale (${ctx.spacingPx.map(fmt).join(' / ')}) — R3.5: "NEVER arbitrary values (5px · 13px · 27px etc)" (nearest: ${fmt(closest.sizePx)}, ${fmt(closest.distancePx)} away)`,
          severity: 'LOW',
          property: prop,
          actual: fmt(v),
          expected: fmt(closest.sizePx),
        });
      }
    }
  }
  return out;
}

/**
 * The colour(s) a text element is actually inked with: its `color`, or — when that is transparent and
 * the text is clipped to its background (`background-clip: text`, a gradient numeral) — every colour
 * stop of the background image. Empty when the ink cannot be read.
 */
export function textInkOf(style: ExtractedStyle): string[] {
  if (!style.connected) return [];
  const color = (style.raw.color ?? '').trim();
  const clipped = (style.raw['background-clip'] ?? '').trim() === 'text';
  const transparent = color === 'transparent' || /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)$/.test(color);
  if (clipped && transparent) {
    const image = style.raw['background-image'] ?? '';
    const stops = image.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g) ?? [];
    return stops;
  }
  return color && !transparent ? [color] : [];
}

/** One property a clean foundation check VERIFIED for body text — what the property table must show as verified (never "Not verified"). */
export interface VerifiedTextRow {
  property: 'font-family' | 'font-size' | 'color';
  actual: string;
  /** The DS value the measured one was verified against (a token's value), spelled as the DS spells it. */
  expected: string;
  expectedToken: string | null;
  rule: string;
  note: string;
}

/**
 * The properties a foundation check verified, with the DS value each was verified against. Pure companion of
 * `textFoundationChecked`: that names the properties, this says what they were verified AGAINST — so the property table, the
 * evidence line and the status all tell the same story. Properties that broke a rule (`broken`) are never listed here.
 */
export function verifiedTextRows(input: { componentType: string; hasText: boolean; style: ExtractedStyle; ctx: FoundationContext; role?: string | null | undefined; broken: ReadonlySet<string> }): VerifiedTextRow[] {
  const { style, ctx } = input;
  const out: VerifiedTextRow[] = [];
  if (!style.connected) return out;
  const raw = style.raw;
  for (const property of textFoundationChecked(input)) {
    if (input.broken.has(property)) continue;
    if (property === 'font-family') {
      const declared = familyList(raw['font-family'] ?? '', ctx.tokens);
      const leading = declared.find((f) => !GENERIC_FAMILIES.has(f.toLowerCase())) ?? declared[0] ?? '';
      const sans = ctx.sansFamilies.has(leading.toLowerCase());
      out.push({ property: 'font-family', actual: raw['font-family'] ?? leading, expected: leading, expectedToken: sans ? '--font-sans' : '--font-serif', rule: 'R1.4', note: `Verified against R1.4: ${leading} is the DS ${sans ? 'sans (body / UI)' : 'serif (display)'} typeface.` });
    } else if (property === 'font-size') {
      const px = lengthToPx(raw['font-size'] ?? '', style.rootFontSizePx);
      const tok = px === null ? undefined : (ctx.textTokens ?? []).find((t) => (t.klass === 'scale' || t.klass === 'exception') && Math.abs(t.px - px) <= 0.5);
      const kind = tok?.klass === 'exception' ? `a documented R1.3 exception (${tok.token})` : tok ? `a step of the DS type scale (${tok.token})` : 'on the DS type scale';
      out.push({ property: 'font-size', actual: raw['font-size'] ?? '', expected: tok?.value ?? (px === null ? '' : `${Math.round(px * 100) / 100}px`), expectedToken: tok?.token ?? null, rule: input.role === 'card-title' ? 'R4.3' : 'R1.3', note: `Verified against ${input.role === 'card-title' ? 'R4.3.5 (card title: --text-base 20px with 4+ cards, --text-lg 25px with 2–3)' : input.role === 'question' ? 'the DS AccordionItem question size (--text-sm)' : 'R1.3'}: ${kind}.` });
    } else {
      const ink = textInkOf(style)[0] ?? '';
      let best: { token: string; value: string; d: number } | null = null;
      for (const p of ctx.palette ?? []) {
        const d = colorDeltaEWithAlpha(ink, p.value);
        if (d !== null && d <= COLOR_DELTA_E_THRESHOLD && (best === null || d < best.d)) best = { token: p.token, value: p.value, d };
      }
      out.push({ property: 'color', actual: raw.color ?? ink, expected: best?.value ?? 'a DS foundation / accent colour', expectedToken: best?.token ?? null, rule: 'R1.1', note: 'Verified against R1.1 / R1.2: a DS foundation or accent colour, not brand red.' });
    }
  }
  return out;
}

/** The foundation properties `checkFoundationRules` actually measures for a body-text / stat element — what a clean result VERIFIED. */
export function textFoundationChecked(input: { componentType: string; hasText: boolean; style: ExtractedStyle; ctx: FoundationContext }): string[] {
  if ((input.componentType !== 'paragraph' && input.componentType !== 'stat') || !input.hasText || !input.style.connected) return [];
  const { style, ctx } = input;
  const out: string[] = [];
  if (familyList(style.raw['font-family'] ?? '', ctx.tokens).length > 0 && (ctx.sansFamilies.size > 0 || ctx.serifFamilies.size > 0)) out.push('font-family');
  if (ctx.textSizesPx.length > 0 && lengthToPx(style.raw['font-size'] ?? '', style.rootFontSizePx) !== null) out.push('font-size');
  if (textInkOf(style).length > 0 && ((ctx.palette?.length ?? 0) > 0 || ctx.brandRed)) out.push('color');
  return out;
}
