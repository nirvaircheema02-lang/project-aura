import { buildComponentCatalog, contextualTokenMap, type CatalogComponent } from '../../ds/catalog.ts';
import { breadcrumbSlotModels, headingSlotModels } from '../../ds/context-models.ts';
import { buildComponentStyleModel, dimensionLabel, expectationsFor, type Assignment, type ComponentStyleModel } from '../../ds/component-styles.ts';
import { resolveCssVars, resolveToken } from '../../ds/d3-tokens/resolve.ts';
import { COLOR_DELTA_E_THRESHOLD, compareToExpected } from '../../t-layer/token-comparator.ts';
import { colorDeltaEWithAlpha, lengthToPx } from '../../t-layer/computed-style.ts';
import { BANDS } from '../../skills/s8-confidence-escalation-policy.ts';
import { DECIDED_BY_TEXT, formatPx, pickNearestSize, type SizeCandidate } from '../../skills/nearest-typography.ts';
import type { DsRegistry } from '../../ds/d2-registry/index.ts';
import type { PossibleMatch } from '../../skills/s0-result-contract.ts';
import type { ExtractedStyle } from '../../t-layer/computed-style.ts';
import type { DetectedComponent, DsMatch, DsSearch, TypographyChoice } from '../types.ts';

/**
 * B3's no-api strategy (Decision Log #31): which Design System component a
 * production element IS, decided only from evidence that can be shown to a
 * reviewer — never from a resemblance a model would have to judge.
 *
 *  1. Class fingerprint. A production element built FROM a DS component
 *     carries that component's own class strings (`tracking-[0.0875px]`,
 *     `rounded-[var(--radius-button)]` …). Classes are weighted by how rare
 *     they are across the DS's sources, so `flex` proves nothing and a class
 *     only Button uses proves a lot. A clear winner is a match.
 *  2. DS rule mapping. The DS's own rules say which component a control must
 *     use (R4.1 Button System, R4.2 Link Decision Tree, R4.3 Card System …).
 *     Such a candidate is a match only when the element's computed style FITS
 *     one of its variants on most governed properties — then its remaining
 *     differences are real deviations from the component it evidently is.
 *  3. Anything else is undecided: no match, and B6 publishes it as
 *     NEEDS_REVIEW with every candidate, its score, and why.
 *
 * The variant is never guessed either: every variant/size/prop assignment of
 * the matched component is compared, and all the equally best-fitting ones
 * are handed to B4, which then only calls a property deviating when it
 * matches NONE of them.
 */

/** DS files a production type must be audited against — each mapping is a DS rule's, cited in the rationale. */
const RULE_CANDIDATES: Record<string, { files: string[]; ruleId: string }> = {
  button: { files: ['atoms/Button.tsx'], ruleId: 'R4.1' },
  'icon-button': { files: ['atoms/Button.tsx'], ruleId: 'R4.1' },
  link: { files: ['atoms/CTALink.tsx', 'atoms/TextLink.tsx', 'atoms/InlineLink.tsx'], ruleId: 'R4.2' },
  'nav-link': { files: ['atoms/TextLink.tsx', 'atoms/MenuItem.tsx'], ruleId: 'R4.7' },
  card: { files: ['atoms/Card.tsx', 'molecules/ReportCard.tsx', 'atoms/ResourceCard.tsx'], ruleId: 'R4.3' },
  badge: { files: ['atoms/Badge.tsx'], ruleId: 'R4.6' },
  tag: { files: ['atoms/Badge.tsx'], ruleId: 'R4.6' },
  chip: { files: ['atoms/FilterChip.tsx', 'atoms/Badge.tsx'], ruleId: 'R4.9' },
  'section-heading': { files: ['atoms/SectionHeading.tsx'], ruleId: 'R4.8' },
  eyebrow: { files: ['atoms/OverheadText.tsx', 'atoms/SectionLabel.tsx'], ruleId: 'R4.8' },
  input: { files: ['atoms/FilterSearchInput.tsx'], ruleId: 'R4.10' },
  search: { files: ['atoms/FilterSearchInput.tsx', 'molecules/navbar/SearchBar.tsx'], ruleId: 'R4.10' },
};

/**
 * The DEEPER half of a family: DS components that belong to the same family as the rule's named files
 * but that the rule does not list. They are searched only when none of the named files can represent
 * the element (wrong root tag, too few comparable properties), so an element is never declared "no
 * Design System family" while a sibling of its family could still hold it.
 *  - badge / tag / chip: the DS's badge-like components, found by name — Badge, Tag, Chip, Pill, Label,
 *    Status (R4.6 Badge System names Badge's label / pill / status wrappers; R4.9 the filter chips).
 *    Matched on whole camel-case WORDS, and only among atoms / molecules / ui — `ValuePillarsSection`
 *    is not a pill.
 *  - card: the card families R4.4 (the Card decision tree) lists beyond the three the rule maps.
 * A type with no entry has no deeper search; it joins by adding its family here and a test.
 */
const BADGE_FAMILY_WORDS = new Set(['badge', 'tag', 'chip', 'pill', 'label', 'status']);
const DEEP_FAMILY: Record<string, (index: DsIndex) => string[]> = {
  badge: (index) => badgeLikeFiles(index),
  tag: (index) => badgeLikeFiles(index),
  chip: (index) => badgeLikeFiles(index),
  card: (index) => ['molecules/StatCard.tsx', 'molecules/SurveyCard.tsx', 'molecules/DataHighlightCard.tsx', 'molecules/AnalystPickCardB.tsx', 'molecules/CategoryListCard.tsx', 'ui/card.tsx'].filter((f) => index.byFile.has(f)),
};

function wordsOf(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/).filter(Boolean);
}

function badgeLikeFiles(index: DsIndex): string[] {
  return index.components
    .filter((c) => ['atoms', 'molecules', 'ui'].includes(c.entry.category) && wordsOf(c.entry.name).some((w) => BADGE_FAMILY_WORDS.has(w)))
    .map((c) => c.entry.file);
}

/** Categories whose files are components a production element can be (not hooks, types, lib or chart internals). */
const COMPONENT_CATEGORIES = new Set(['atoms', 'molecules', 'organisms', 'patterns', 'ui']);

/** A class-fingerprint match needs this much of the element's (rarity-weighted) class vocabulary explained… */
export const CLASS_MATCH_SCORE = 0.45;
/** …and must beat the runner-up by this much, or two components explain it equally and it is undecided. */
export const CLASS_MATCH_MARGIN = 0.1;
/**
 * Below this many shared DS-identifying classes, a class-fingerprint match is
 * held at the MEDIUM confidence floor whatever share of the element's (short)
 * class list it explains — a ratio close to 1.00 over the bare-minimum 2
 * classes is not the same amount of evidence as the same ratio over 10
 * (third-pass review M4: 2 classes and 25 classes both scored 0.95).
 */
export const CLASS_MATCH_STRONG_EVIDENCE = 3;
/** A rule-mapped candidate is the component it evidently is when this share of its governed properties fit… */
export const RULE_FIT_SCORE = 0.7;
/** …over at least this many compared properties (one matching colour proves nothing). */
export const RULE_FIT_MIN_COMPARED = 3;
/** Two family candidates this close in fit score are a genuine variant tie — noted, never guessed. */
export const VARIANT_TIE_MARGIN = 0.1;
/** component-styles' dimension for which root element the component rendered (`a`, `button`, …). */
const ROOT_DIMENSION = '$root';
/** Most assignments ever compared per candidate — a bound on work, stated, never silently exceeded. */
export const MAX_ASSIGNMENTS = 2048;

interface IndexedComponent {
  entry: CatalogComponent;
  model: ComponentStyleModel;
  classes: Set<string>;
}

export interface DsIndex {
  breadcrumbSlots?: Map<string, ComponentStyleModel>;
  headingSlots?: Map<string, ComponentStyleModel>;
  components: IndexedComponent[];
  byFile: Map<string, IndexedComponent>;
  idf: Map<string, number>;
  /** Weight of a class no DS source uses — as rare as it gets. */
  unknownIdf: number;
}

const indexCache = new WeakMap<DsRegistry, Promise<DsIndex>>();

/** Builds (once per registry snapshot) the style model and class fingerprint of every DS component. */
export function dsIndex(registry: DsRegistry): Promise<DsIndex> {
  const cached = indexCache.get(registry);
  if (cached) return cached;
  const built = (async () => {
    const catalog = buildComponentCatalog(registry).filter((c) => COMPONENT_CATEGORIES.has(c.category));
    const components: IndexedComponent[] = [];
    for (const entry of catalog) {
      const model = await buildComponentStyleModel(registry, entry.file).catch(() => null);
      if (model) components.push({ entry, model, classes: new Set(model.classTokens) });
    }
    const df = new Map<string, number>();
    for (const c of components) for (const t of c.classes) df.set(t, (df.get(t) ?? 0) + 1);
    const n = components.length;
    const idf = new Map<string, number>();
    for (const [t, count] of df) idf.set(t, Math.log((n + 1) / (count + 1)) + 1);
    return { components, byFile: new Map(components.map((c) => [c.entry.file, c])), idf, unknownIdf: Math.log(n + 1) + 1, breadcrumbSlots: await breadcrumbSlotModels(registry), headingSlots: await headingSlotModels(registry) };
  })();
  indexCache.set(registry, built);
  return built;
}

/**
 * Only Tailwind's ARBITRARY-VALUE syntax (`class-[value]`) is specific enough
 * to fingerprint a DS component from real production markup. A plain utility
 * — `block`, `truncate`, `uppercase`, `text-center`, `py-6`, `sr-only` — is
 * common to any hand-rolled Tailwind and, because the idf below is computed
 * over only 239 DS component root class sets, one of these can look "rare"
 * there by accident and score a false match at 1.00 (confirmed: `[block
 * truncate uppercase]` scored IndustryBadge 1.00; `[text-center py-6]` scored
 * LoadMoreSentinel 1.00 — third-pass review M2). An arbitrary value carries
 * the DS's own exact geometry or a `var(--token)` reference, which unrelated
 * markup essentially never reproduces by chance — so only THESE ever count as
 * fingerprint evidence; plain utilities can still appear in `shared` for the
 * rationale text, but never move the score.
 */
function isIdentifyingClass(token: string): boolean {
  return /\[.+\]/.test(token);
}

/**
 * How much of the element's class vocabulary a DS component explains,
 * weighted by rarity: Σ idf(shared) / Σ idf(element's classes) — over
 * DS-IDENTIFYING classes only (see `isIdentifyingClass`). A class no DS
 * source uses (a hardcoded `text-[#00000099]`) weighs the most and explains
 * nothing — hand-rolled markup scores low, DS-built markup scores high.
 */
export function classScore(elementClasses: string[], component: IndexedComponent, index: DsIndex): { score: number; shared: string[] } {
  const own = [...new Set(elementClasses.filter((c) => c.trim() !== '' && isIdentifyingClass(c)))];
  if (own.length === 0) return { score: 0, shared: [] };
  const weight = (t: string) => index.idf.get(t) ?? index.unknownIdf;
  const shared = own.filter((t) => component.classes.has(t));
  const total = own.reduce((n, t) => n + weight(t), 0);
  return { score: total === 0 ? 0 : shared.reduce((n, t) => n + weight(t), 0) / total, shared: shared.sort((a, b) => weight(b) - weight(a)) };
}

/** Dimensions that actually change a rule — the only ones worth varying. */
function relevantDimensions(model: ComponentStyleModel) {
  const used = new Set(model.rules.flatMap((r) => Object.keys(r.when)));
  return model.dimensions.filter((d) => used.has(d.name));
}

/** Every assignment of the relevant dimensions (others at their defaults), defaults first. */
export function assignmentsOf(model: ComponentStyleModel): Assignment[] {
  const defaults: Assignment = {};
  for (const d of model.dimensions) if (d.defaultValue !== null) defaults[d.name] = d.defaultValue;
  let out: Assignment[] = [{ ...defaults }];
  for (const d of relevantDimensions(model)) {
    const values = [...new Set([d.defaultValue, ...d.values].filter((v): v is string => v !== null))];
    const next: Assignment[] = [];
    for (const a of out) for (const v of values) next.push({ ...a, [d.name]: v });
    out = next;
    if (out.length > MAX_ASSIGNMENTS) {
      out = out.slice(0, MAX_ASSIGNMENTS);
      break;
    }
  }
  return out;
}

export interface Fit {
  assignments: Assignment[];
  passed: number;
  compared: number;
  score: number;
  observed: Array<{ property: string; actual: string; expected: string | null; expectedToken: string | null }>;
}

/** Containers a component's `as`/wrapper prop can render interchangeably — never compatible with an interactive tag. */
const CONTAINER_TAGS = new Set(['div', 'span', 'section', 'article']);

/**
 * Whether a DS component root rendering `dsTag` is even a candidate for a
 * production element whose own tag is `elementTag`. An `<input>` is never a
 * `<div>` wrapper's compliance target, whatever CSS box properties happen to
 * line up (third-pass review M3: a hand-rolled `<input>` "fit" 15/17 of
 * FilterSearchInput's properties — generic flex/align-items geometry, no
 * identifying property — while having none of the component's actual
 * structure). Only genuinely interchangeable containers are compatible with
 * each other; every other pairing must match on tag.
 */
function tagsCompatible(elementTag: string, dsTag: string): boolean {
  if (elementTag === dsTag) return true;
  return CONTAINER_TAGS.has(elementTag) && CONTAINER_TAGS.has(dsTag);
}

/**
 * The variant(s) of a DS component the element's rendered style fits best.
 * Score = passed ÷ compared (compared = passed + mismatched; unresolvable
 * expectations count for nothing); ties broken by more properties passed. All
 * equally-best assignments are kept — which of them the production element
 * "is" is not knowable, so none is guessed.
 *
 * `model.roots` is now recorded for every component, one entry or several
 * (component-styles.ts) — before this, only components with more than one
 * root ever had it, so a whole class of production elements (an `<input>`
 * against a `<div>`-rooted component) fit on pure box geometry with no root
 * check at all (third-pass review M3). A candidate whose root tag matches
 * NONE of the production element's tag is rejected outright, not merely
 * filtered per-assignment.
 */
export function bestFit(
  model: ComponentStyleModel,
  style: ExtractedStyle,
  tokens: Map<string, string>,
  viewportWidth: number,
  rootTag?: string | null,
  pins: Record<string, string> = {},
  /** A variant for which this is true is never a candidate (see `brandRedAvoider`) — skipped, not scored. */
  avoid?: (expected: ReturnType<typeof expectationsFor>) => boolean,
): Fit | null {
  if (!style.connected) return null;
  // Which root element the component renders (`<a>` with href, `<button>` without) is a FACT
  // about the production element, not something to fit.
  const roots = model.roots ?? [];
  const compatibleIds = rootTag ? roots.filter((r) => r.tags.some((t) => tagsCompatible(rootTag, t))).map((r) => r.id) : [];
  // The DS knows what tag(s) this component renders, and the production element's tag matches none of
  // them: not a compliance question about ANY of its variants, whatever its box properties look like.
  if (rootTag && roots.length > 0 && compatibleIds.length === 0) return null;
  const rootIds = compatibleIds;
  let best: Fit | null = null;
  for (const assignment of assignmentsOf(model)) {
    if (Object.entries(pins).some(([key, value]) => assignment[key] !== undefined && assignment[key] !== value)) continue;
    const root = assignment[ROOT_DIMENSION];
    if (rootIds.length > 0 && root !== undefined && !rootIds.includes(root)) continue;
    const expected = expectationsFor(model, assignment, { viewportWidth });
    if (expected.length === 0) continue;
    if (avoid?.(expected)) continue;
    const result = compareToExpected({
      actual: style.raw,
      expected: expected.map((e) => ({ property: e.property, token: e.token, literal: e.literal })),
      effectiveTokens: tokens,
      rootFontSizePx: style.rootFontSizePx,
      box: style.box ?? null,
    });
    const compared = result.passed.length + result.mismatches.length;
    if (compared === 0) continue;
    const score = result.passed.length / compared;
    const better = !best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && result.passed.length > best.passed);
    const equal = best && Math.abs(score - best.score) <= 1e-9 && result.passed.length === best.passed;
    if (better) {
      best = {
        assignments: [assignment],
        passed: result.passed.length,
        compared,
        score,
        observed: expected.slice(0, 10).map((e) => {
          const resolved = e.token ? resolveToken(e.token, tokens) : null;
          return { property: e.property, actual: style.raw[e.property] ?? '—', expected: resolved ?? e.literal ?? null, expectedToken: e.token };
        }),
      };
    } else if (equal && best) {
      best.assignments.push(assignment);
    }
  }
  return best;
}

interface Evaluated {
  component: IndexedComponent;
  cls: { score: number; shared: string[] };
  fit: Fit | null;
  viaRule: boolean;
}

function possibleMatchOf(e: Evaluated): PossibleMatch {
  const label = e.fit ? dimensionLabel(e.component.model, e.fit.assignments[0] ?? {}) : '';
  // A fit over one or two properties is weak evidence however well they fit.
  const evidence = e.fit ? Math.min(1, e.fit.compared / (RULE_FIT_MIN_COMPARED + 1)) : 0;
  const why = [
    e.cls.shared.length > 0 ? `${e.cls.shared.length} shared DS class(es) (${e.cls.shared.slice(0, 4).join(' ')}) · class score ${e.cls.score.toFixed(2)}` : 'no DS class in common',
    e.fit ? `${e.fit.passed}/${e.fit.compared} governed properties fit${label ? ` (${label})` : ''}` : 'no comparable governed properties',
    e.viaRule ? 'mapped by a DS rule for this element type' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    dsComponent: e.component.entry.name,
    dsFile: e.component.entry.file,
    dsVariant: label || null,
    score: Math.round(Math.max(e.cls.score, e.fit ? e.fit.score * (e.viaRule ? 0.8 : 0.5) * evidence : 0) * 100) / 100,
    why,
  };
}

/**
 * The Design System family a production type belongs to — what B3 searches for it, and what B5 later
 * checks the answer against. `files` are the ones the rule names (R4.x), searched first; `deep` are the
 * rest of the family (see `DEEP_FAMILY`), searched only when none of the named files can represent the
 * element. Null when the DS names no family for the type: B6 then has no existing component to hand an
 * element to, and "no existing family" is the honest answer.
 */
export function familyOf(componentType: string, index: DsIndex): { ruleId: string; files: string[]; deep: string[] } | null {
  const rule = RULE_CANDIDATES[componentType];
  if (!rule) return null;
  const deep = (DEEP_FAMILY[componentType]?.(index) ?? []).filter((file) => !rule.files.includes(file));
  return { ruleId: rule.ruleId, files: [...rule.files], deep };
}

/** Whether a DS file belongs to a type's family — the rule's named files or its deeper members. */
export function isInFamily(family: { files: string[]; deep: string[] }, file: string | null): boolean {
  return file !== null && (family.files.includes(file) || family.deep.includes(file));
}

/**
 * R1.2 — brand red is never a border or a decorative fill on a non-CTA element — decides which variant
 * a family-identity match may name as "the closest": a variant that itself PAINTS brand red on its
 * border or background is never recommended for a non-button, because the finding would tell the
 * element to adopt the very colour R1.2 forbids. Undefined for a button (R1.2 allows brand red on a
 * CTA, exactly as `checkFoundationRules` does) and when the DS defines no brand red.
 */
function brandRedAvoider(componentType: string, tokens: Map<string, string>): ((expected: ReturnType<typeof expectationsFor>) => boolean) | undefined {
  if (componentType === 'button') return undefined;
  const brand = (resolveToken('--color-brand-red', tokens) ?? resolveToken('--brand-red', tokens))?.trim();
  if (!brand) return undefined;
  return (expected) =>
    expected.some((e) => {
      if (e.property !== 'border-top-color' && e.property !== 'background-color') return false;
      const value = e.token ? resolveToken(e.token, tokens) : e.literal !== null ? resolveCssVars(e.literal, tokens) : null;
      const distance = value === null ? null : colorDeltaEWithAlpha(value.trim(), brand);
      return distance !== null && distance <= COLOR_DELTA_E_THRESHOLD;
    });
}

/** What B3 knows about the PAGE when it matches one element — only what a nearest-size tie-break may need. */
export interface PageTypography {
  /** Rendered font sizes (px) of the OTHER section headings on the page: the visual hierarchy a choice must not reorder. */
  headingSizesPx: number[];
}

/** The page's OTHER section headings' rendered sizes — what a re-asked heading match must not reorder (the same context B3's node gives `decideMatch`). */
export function pageTypographyOf(components: DetectedComponent[], component: DetectedComponent): PageTypography {
  const headingSizesPx = components.flatMap((c) => {
    if (c.ref === component.ref || c.componentType !== 'section-heading' || !c.style.connected) return [];
    const px = lengthToPx(c.style.raw['font-size'] ?? '', c.style.rootFontSizePx);
    return px === null ? [] : [px];
  });
  return { headingSizesPx };
}

/** SectionHeading's levels — the DS heading sizes an element's visual size is chosen from. */
const HEADING_LEVELS = ['h1', 'h2', 'h3'] as const;

interface HeadingVisual {
  slot: string;
  confidence: number;
  rationale: string;
  typography: TypographyChoice;
}

/**
 * Which DS heading level an `<h1>`–`<h3>` is audited against: the one whose rendered size at the
 * captured viewport is NEAREST the element's own — permanent audit-engine rule, not a per-page
 * special case (src/skills/nearest-typography.ts). The semantic tag is supporting evidence: it only
 * breaks an exact tie, so an `<h2>` rendered at 32px is compared with level 3 (31.25px, 0.75px
 * away) instead of level 2 (39.06px, 7.06px away) while remaining an `<h2>`. Null when the element's
 * size cannot be read — the caller then keeps the tag's own level, as before.
 */
function nearestHeadingVariant(component: DetectedComponent, index: DsIndex, tokens: Map<string, string>, viewportWidth: number, tag: string, page: PageTypography | undefined, domTag: string = tag): HeadingVisual | null {
  // `tag` names the slot used as the exact-tie proxy; `domTag` is what the element REALLY is. They differ only for a
  // main heading promoted by its role from a non-heading element (a display-size `<p>`): everything the finding SAYS
  // about its tag is that real tag, never the proxy.
  const tagIsProxy = domTag !== tag;
  const style = component.style;
  if (!style.connected) return null;
  const rootPx = style.rootFontSizePx;
  const actualPx = lengthToPx(style.raw['font-size'] ?? '', rootPx);
  if (actualPx === null || !(actualPx > 0)) return null;

  type Payload = { value: string; token: string | null };
  const candidates: Array<SizeCandidate<Payload>> = [];
  for (const slot of HEADING_LEVELS) {
    const model = index.headingSlots?.get(slot);
    if (!model) continue;
    const expected = expectationsFor(model, {}, { viewportWidth });
    const size = expected.find((e) => e.property === 'font-size');
    if (!size) continue;
    const value = size.token ? resolveToken(size.token, tokens) : size.literal !== null ? resolveCssVars(size.literal, tokens) : null;
    const sizePx = value === null ? null : lengthToPx(value.trim(), rootPx, actualPx);
    if (value === null || sizePx === null || !(sizePx > 0)) continue;
    // Contextual evidence: how much of this level's OTHER governed typography the element already fits.
    const rest = compareToExpected({
      actual: style.raw,
      expected: expected.filter((e) => e.property !== 'font-size').map((e) => ({ property: e.property, token: e.token, literal: e.literal })),
      effectiveTokens: tokens,
      rootFontSizePx: rootPx,
      box: style.box ?? null,
    });
    const compared = rest.passed.length + rest.mismatches.length;
    candidates.push({ id: slot, sizePx, context: compared > 0 ? rest.passed.length / compared : null, semanticLevel: Number(slot.slice(1)), payload: { value: value.trim(), token: size.token } });
  }
  const tagLevel = /^h([1-6])$/.exec(tag)?.[1];
  const choice = pickNearestSize(actualPx, candidates, { semanticLevel: tagLevel ? Number(tagLevel) : null, pageHeadingSizesPx: page?.headingSizesPx ?? [] });
  if (!choice) return null;

  const levelOf = (id: string) => `level ${id.slice(1)}`;
  const typography: TypographyChoice = {
    property: 'font-size',
    actualPx,
    closestPx: choice.chosen.sizePx,
    closestValue: choice.chosen.payload.value,
    closestToken: choice.chosen.payload.token,
    differencePx: choice.distancePx,
    variant: levelOf(choice.chosen.id),
    semanticTag: domTag || null,
    followsSemanticLevel: tagIsProxy ? true : tagLevel ? choice.chosen.id === tag : true,
    decidedBy: choice.decidedBy,
    considered: choice.ranked.map((r) => ({ variant: levelOf(r.candidate.id), px: r.candidate.sizePx, value: r.candidate.payload.value, distancePx: r.distancePx })),
  };
  const nearest = `${typography.variant} (${formatPx(typography.closestPx)}, ${formatPx(typography.differencePx)} away)`;
  const own = tagLevel && !tagIsProxy ? typography.considered.find((c) => c.variant === `level ${tagLevel}`) : undefined;
  let rationale = tagIsProxy
    ? `The section's main heading is a ${domTag || 'text element'} (promoted to a heading by its role, not its tag): compare it with SectionHeading's own sizes at the captured viewport — the h2 slot is only the tie-break proxy.`
    : `Compare the actual ${tag} child from SectionHeading at the captured viewport, not its wrapper.`;
  rationale += typography.followsSemanticLevel
    ? ` Nearest DS heading size: ${nearest}.`
    : ` The rendered ${formatPx(actualPx)} is nearest to ${nearest}${own ? `, not the ${tag}'s own level ${tagLevel} (${formatPx(own.px)}, ${formatPx(own.distancePx)} away)` : ''} — the visual level is chosen by size; the semantic tag stays ${tag} and only ever breaks an exact tie.`;
  const decisive = choice.decidedBy === 'distance' || choice.decidedBy === 'only-candidate';
  if (!decisive) {
    rationale += ` ${[choice.chosen, ...choice.tied].map((c) => levelOf(c.id)).join(' and ')} are equally close; settled by ${DECIDED_BY_TEXT[choice.decidedBy]} — the specific level is a judgment call, the family is not.`;
  }
  return { slot: choice.chosen.id, confidence: decisive ? 0.85 : 0.7, rationale, typography };
}

/**
 * Decides one component. Returns a DsMatch in B3's normal shape, so S8's
 * routing, B4 and B6 work unchanged: matched → B4; undecided → `dsComponent:
 * null` → B6, carrying the candidates and the reason for a reviewer.
 */
export function decideMatch(component: DetectedComponent, index: DsIndex, registry: DsRegistry, viewportWidth: number, page?: PageTypography): DsMatch {
  const context = component.domFacts?.context;
  const tokens = contextualTokenMap(registry, context?.surface);
  const pins: Record<string, string> = { active: String(context?.current ?? false) };
  if (context) {
    pins.expanded = String(context.expanded);
    if (context.surface !== 'unknown') { pins.background = context.surface; pins.colorScheme = context.surface; }
  }
  if (context?.breadcrumb) {
    if (!index.byFile.has('molecules/Breadcrumb.tsx')) return {
      dsComponent: null, dsFile: null, dsVariant: null, confidence: 0.4,
      unanswered: false, confidenceOutOfContract: false, possibleMatches: [],
      rationale: 'Breadcrumb context detected, but no readable Breadcrumb component exists in the configured DS.',
      undecidedReason: 'Inspect the configured DS navigation recipes or propose a breadcrumb composition; do not substitute a standalone link/button based on appearance.',
      search: { family: { ruleId: null, files: ['molecules/Breadcrumb.tsx'], deep: [] }, basis: 'undecided' },
    };
    const slot = component.domFacts?.tag === 'a' ? 'link' : component.domFacts?.text ? 'combined-label' : 'trigger';
    const model = index.breadcrumbSlots?.get(slot === 'combined-label' ? 'link' : slot);
    const assignments = { colorScheme: context.surface, current: String(context.current), expanded: String(context.expanded) };
    // A text-bearing dropdown combines the DS's link + caret slots. Do not compare its
    // whole box with either a standalone CTA or the small caret button.
    const supported = Boolean(model && context.surface !== 'unknown');
    return {
      dsComponent: 'Breadcrumb', dsFile: 'molecules/Breadcrumb.tsx', contextSlot: slot,
      dsVariant: `${context.surface} · ${context.current ? 'current' : slot}`,
      confidence: supported ? 0.85 : 0.55, unanswered: false, confidenceOutOfContract: false,
      rationale: `Breadcrumb ${slot} on a ${context.surface} surface. Source: molecules/Breadcrumb.tsx.${slot === 'combined-label' ? ' Compare label typography separately; the combined clickable container and arrow need composition review, not primary CTA styling.' : ''}${supported ? '' : ' Expected styles could not be resolved for this surface/slot; retain observed values and review the composition.'}`,
      assignments: supported ? [assignments] : [], possibleMatches: [],
      search: { family: { ruleId: null, files: ['molecules/Breadcrumb.tsx'], deep: [] }, basis: 'context-slot' },
    };
  }
  const domTag = component.domFacts?.tag ?? '';
  // A promoted main heading (B2: the section's visually dominant text, e.g. a display-size `<p>`) has no
  // heading tag to name a slot; its DS size is chosen by nearest rendered size alone, with h2 only as the
  // tie-break proxy. A heading-tagged element keeps its own tag as before.
  const tag = component.componentType === 'section-heading' && component.headingRole === 'main' && !index.headingSlots?.has(domTag) ? 'h2' : domTag;
  if (component.componentType === 'section-heading' && index.headingSlots?.has(tag)) {
    const subtitle = context?.subtitleCandidate ?? false;
    // The DOM tag (h1/h2/h3) is the element's SEMANTIC heading level — kept as-is for
    // accessibility/hierarchy concerns elsewhere (B4's foundation-rule check still reads it from
    // domFacts.tag directly). It is never the VISUAL typography pick: the DS's own "level 2" only
    // happens to render an <h2> internally. The level audited against is the one whose DS size is
    // NEAREST what is actually rendered (nearestHeadingVariant), so a page's h2 styled at 32px
    // compares against the DS's 31.25px level (level 3), not level 2's 39.06px, while staying an
    // h2. The tag only breaks an exact tie. Unreadable size → the tag's own level, as before.
    const visual = subtitle ? null : nearestHeadingVariant(component, index, tokens, viewportWidth, tag, page, domTag);
    return {
      dsComponent: 'SectionHeading', dsFile: 'atoms/SectionHeading.tsx',
      dsVariant: subtitle ? 'subtitle candidate' : `level ${(visual?.slot ?? tag).slice(1)}`,
      contextSlot: subtitle ? 'subtitle' : 'heading',
      ...(visual ? { visualSlot: visual.slot, typography: visual.typography } : {}),
      confidence: subtitle ? 0.55 : visual?.confidence ?? 0.85, unanswered: false, confidenceOutOfContract: false,
      rationale: subtitle
        ? 'Long descriptive copy below the page title is marked h2. Confirm whether this is a subtitle/paragraph before applying heading typography.'
        : visual?.rationale ?? (tag === domTag ? `Compare the actual ${tag} child from SectionHeading at the captured viewport, not its wrapper.` : `The section's main heading is a ${domTag || 'text element'} promoted by its role: compare it with SectionHeading at the captured viewport.`),
      assignments: [{}], possibleMatches: [],
      search: { family: { ruleId: 'R4.8', files: ['atoms/SectionHeading.tsx'], deep: [] }, basis: 'context-slot' },
    };
  }
  // Body text and stat numerals have no component family in the DS (no RULE_CANDIDATES entry): the
  // foundation rules — colour, type scale, typeface, R1.2 — are what govern them. They are answered
  // here, on purpose, rather than left "undecided" for B6: a paragraph is not a new-component question.
  if (component.componentType === 'paragraph' || component.componentType === 'stat') {
    return {
      dsComponent: null, dsFile: null, dsVariant: null,
      confidence: 0.6, unanswered: false, confidenceOutOfContract: false, possibleMatches: [],
      foundationOnly: true,
      rationale: `deterministic: ${component.componentType === 'stat' ? 'a stat numeral' : 'body text'} has no Design System component family — audited against the foundation rules (colour R1.1/R1.2, type scale R1.3, typeface R1.4) only.`,
      search: { family: null, basis: 'foundation-only' },
    };
  }
  const ruleTitle = (id: string) => registry.rules.rules.find((r) => r.id === id)?.title ?? '';
  const classes = component.domFacts?.classes ?? [];
  const ruleMap = RULE_CANDIDATES[component.componentType];
  // An eyebrow is a SUPPORTING heading — the role was decided by B2 from the section, so its h1–h6 tag
  // (the author's semantic choice) is not evidence about which DS component it is, exactly as a heading's
  // tag never picks its SectionHeading size. Matching it against the DS `<span>`/`<p>` roots by tag would
  // refuse every eyebrow written as a heading.
  const rootTag = component.componentType === 'eyebrow' && /^h[1-6]$/.test(domTag) ? null : (component.domFacts?.tag ?? null);
  // Locked supporting-heading colour rule: on a neutral/light surface the eyebrow is the Ken-red text
  // treatment (SectionLabel text · accent, OverheadText); on a dark surface the DS's own inverse treatment
  // applies instead (SectionLabel's dark tokens) — OverheadText is brand-red only and has no dark form.
  const darkSurface = context?.surface === 'dark';
  if (component.componentType === 'eyebrow' && !darkSurface) { pins.variant = 'accent'; pins.style = 'text'; }
  const ruleFiles = (ruleMap?.files ?? []).filter((f) => !(component.componentType === 'eyebrow' && darkSurface && /OverheadText/.test(f)));
  // The family the DS names for this type, recorded on EVERY answer below so B5 can verify that the
  // right family was searched — and that an element is only sent to B6 when none of it can represent it.
  const family = familyOf(component.componentType, index);
  const searchOf = (basis: DsSearch['basis']): DsSearch => ({ family, basis });

  const byClass = index.components
    .map((c) => ({ c, cls: classScore(classes, c, index) }))
    .filter((x) => x.cls.shared.length >= 2)
    .sort((a, b) => b.cls.score - a.cls.score)
    .slice(0, 3);
  const candidates = new Map<string, Evaluated>();
  for (const { c, cls } of byClass) candidates.set(c.entry.file, { component: c, cls, fit: null, viaRule: false });
  for (const file of ruleFiles) {
    const c = index.byFile.get(file);
    if (!c) continue;
    const existing = candidates.get(file);
    if (existing) existing.viaRule = true;
    else candidates.set(file, { component: c, cls: classScore(classes, c, index), fit: null, viaRule: true });
  }
  for (const e of candidates.values()) e.fit = bestFit(e.component.model, component.style, tokens, viewportWidth, rootTag, pins);
  const evaluated = [...candidates.values()];

  // `fit` overrides the candidate's own when a different variant of it is the one to name (see the
  // brand-red note in 2b); `e` itself is still what is excluded from the possible matches.
  const matched = (e: Evaluated, confidence: number, rationale: string, basis: DsSearch['basis'], fit: Fit | null = e.fit): DsMatch => ({
    dsComponent: e.component.entry.name,
    dsFile: e.component.entry.file,
    dsVariant: fit ? dimensionLabel(e.component.model, fit.assignments[0] ?? {}) || null : null,
    confidence: Math.round(confidence * 1000) / 1000,
    rationale,
    unanswered: false,
    confidenceOutOfContract: false,
    possibleMatches: evaluated.filter((x) => x !== e).map(possibleMatchOf).sort((a, b) => b.score - a.score),
    assignments: fit?.assignments ?? [],
    observed: fit?.observed ?? [],
    search: searchOf(basis),
  });

  // 1. Class fingerprint.
  const [top, second] = [...evaluated].sort((a, b) => b.cls.score - a.cls.score);
  if (top && top.cls.score >= CLASS_MATCH_SCORE && (!second || top.cls.score - second.cls.score >= CLASS_MATCH_MARGIN)) {
    let confidence = Math.min(0.95, 0.5 + top.cls.score / 2);
    // Confidence is capped by the AMOUNT of evidence, not just its ratio (Decision Log #31, M4):
    // the bare-minimum 2 shared classes stays at the MEDIUM floor even at score 1.00.
    if (top.cls.shared.length < CLASS_MATCH_STRONG_EVIDENCE) confidence = Math.min(confidence, BANDS.MEDIUM + 0.05);
    // Built from the component's code but rendering far from any of its variants: still that
    // component (its deviations are real), but the claim is capped below HIGH.
    if (top.fit && top.fit.compared >= 2 && top.fit.score < 0.5) confidence = Math.min(confidence, 0.6);
    return matched(
      top,
      confidence,
      `class fingerprint: ${top.cls.shared.length} of the element's classes come from ${top.component.entry.file} (${top.cls.shared.slice(0, 5).join(' ')}) — score ${top.cls.score.toFixed(2)}${second ? `, next ${second.component.entry.name} ${second.cls.score.toFixed(2)}` : ''}`,
      'class-fingerprint',
    );
  }

  // 2. DS rule mapping, confirmed by fit.
  const fitting = evaluated
    .filter((e) => e.viaRule && e.fit && e.fit.compared >= RULE_FIT_MIN_COMPARED && e.fit.score >= RULE_FIT_SCORE)
    .sort((a, b) => (b.fit?.score ?? 0) - (a.fit?.score ?? 0));
  const [bestRule, nextRule] = fitting;
  if (bestRule && (!nextRule || (bestRule.fit?.score ?? 0) - (nextRule.fit?.score ?? 0) >= 0.15)) {
    const fit = bestRule.fit!;
    return matched(
      bestRule,
      0.6,
      `${ruleMap?.ruleId ?? ''} ${ruleTitle(ruleMap?.ruleId ?? '')}: a ${component.componentType} is audited against ${bestRule.component.entry.file}, and ${fit.passed}/${fit.compared} of its governed properties fit ${dimensionLabel(bestRule.component.model, fit.assignments[0] ?? {}) || 'its default variant'}`,
      'rule-fit',
    );
  }

  // 2b. Component-FAMILY identity, settled BEFORE visual compliance is scored.
  //
  // The DS rule names the family for this element type (one file, or several — a CTA/link can be
  // CTALink, TextLink or InlineLink), so which component a production element IS was never a
  // visual question — it is the rule's answer plus the element's own structure. A CTA that is
  // evidently a Button, or a link that is evidently one of the DS's link variants, does not stop
  // being that family because its colour, gradient, shadow, radius and typeface are all wrong:
  // those differences are precisely what this audit exists to report.
  //
  // That is the bug this branch previously had (single-file families only). `contradicted` was
  // `fit.compared >= 3` — i.e. "enough properties were comparable" — so the WORSE a production
  // button was, the more of R4.1's governed properties it could be measured against and failed,
  // and the more certainly the match was refused. Rejecting it discarded every measurable
  // mismatch with it and left only whatever foundation rule happened to fire, which is why real
  // DS Buttons on this page published as `DS —` with a lone R1.4 font violation and nothing else
  // (observed on deals-and-ipo-consulting-test: "Get in Touch", "Consult Today", "Talk to an
  // Expert" and 16 more, 0 mismatches each, while the two buttons that did match reported 16 and
  // 17). Multi-file families (link, nav-link, card, chip, search) had no fallback here at all —
  // the "only one file" gate excluded them outright, so a badly-implemented CTA link fell straight
  // to undecided/B6 regardless of how confidently it was a link.
  //
  // What still contradicts the rule's answer is unchanged: the element's class fingerprint
  // pointing at a component OUTSIDE this family, and a detection too weak to trust. Root-tag
  // incompatibility already expresses itself here exactly as it always did — `bestFit` returns
  // null for it, so such an element takes the "none of its governed properties can be read"
  // branch below and is matched at the MEDIUM floor for B4 to publish UNVERIFIED, the behaviour a
  // DS-mapped heading whose styling lives on its children depends on. This change adds one thing
  // only: a fit that IS measurable and poor no longer vetoes identity — and among several family
  // candidates, the best-fitting one is published as the closest existing variant, never a reason
  // to invent a new component or fall back to undecided.
  //
  // The fit still does real work: it chooses which family member (and which of its variants) B4
  // audits against, and it sets how confident this claim is. It simply no longer holds a veto over
  // identity. Classification is unaffected either way — B4 decides that from the mismatches and
  // rule violations it measures, never from this confidence — so a poorly-fitting Button or link
  // lands as INCORRECT/DEVIATION with its full property list, not as a new component. When two
  // family members fit almost equally well, the closest is still published (the family is not in
  // doubt) and the tie is named in the rationale rather than silently picked — only the exact
  // variant, never the family, is ever a judgment call here.
  //
  // Two refinements, both about WHEN a family may be claimed — never about how well the element
  // fits it:
  //  - Provenance of the type. A detection below 0.5 normally cannot claim a family (the TYPE is
  //    only a guess — an unlabelled clickable inferred to be a button). A STRUCTURAL type is the
  //    exception: a bordered/filled text leaf typed `badge`, a surfaced repeated block typed `card`
  //    (B2 `structural`) is decided from the very structure the family is defined by; its confidence is
  //    LOW only because no role backs it. Without this exception a badge — an existing Badge family —
  //    fell through to B6 purely because of how it was detected.
  //  - Depth of the search. The rule's named files are searched first; only when none of them can
  //    represent the element (wrong root tag, too few comparable properties) is the rest of the
  //    family searched (`DEEP_FAMILY`: Badge/Tag/Chip/Pill/Label/Status, the other R4.4 card
  //    families), so "no family" is only ever said after the whole family was tried.
  const familyFiles = ruleFiles;
  const identityEligible = component.detectionConfidence >= 0.5 || component.structural === true;
  const viable = (e: Evaluated | undefined): e is Evaluated => e !== undefined && e.fit !== null && e.fit.compared >= RULE_FIT_MIN_COMPARED;
  const byFit = (a: Evaluated, b: Evaluated) => (b.fit as Fit).score - (a.fit as Fit).score;
  let familyCandidates = familyFiles.map((file) => candidates.get(file)).filter(viable).sort(byFit);
  let viaDeepSearch = false;
  if (familyCandidates.length === 0 && family && family.deep.length > 0 && identityEligible) {
    const deep: Evaluated[] = [];
    for (const file of family.deep) {
      const c = index.byFile.get(file);
      if (!c) continue;
      deep.push({ component: c, cls: classScore(classes, c, index), fit: bestFit(c.model, component.style, tokens, viewportWidth, rootTag, pins), viaRule: false });
    }
    evaluated.push(...deep);
    familyCandidates = deep.filter(viable).sort(byFit);
    viaDeepSearch = familyCandidates.length > 0;
  }
  const [closestOfFamily, runnerUpOfFamily] = familyCandidates;
  const classPointsOutsideFamily = top && !(family ? isInFamily(family, top.component.entry.file) : familyFiles.includes(top.component.entry.file)) && top.cls.score >= CLASS_MATCH_SCORE;
  if (closestOfFamily && !classPointsOutsideFamily && identityEligible) {
    // A variant that itself paints brand red is never the "closest" one for a non-CTA element: the
    // finding would tell the element to adopt the colour R1.2 forbids (see `brandRedAvoider`).
    const avoid = brandRedAvoider(component.componentType, tokens);
    const permitted = avoid ? bestFit(closestOfFamily.component.model, component.style, tokens, viewportWidth, rootTag, pins, avoid) : null;
    const fit = permitted && permitted.compared >= RULE_FIT_MIN_COMPARED ? permitted : (closestOfFamily.fit as Fit);
    const setAside = fit === permitted && dimensionLabel(closestOfFamily.component.model, (closestOfFamily.fit as Fit).assignments[0] ?? {}) !== dimensionLabel(closestOfFamily.component.model, fit.assignments[0] ?? {});
    // Identity is the rule's; only the strength of the claim tracks the fit. Capped below the
    // confident rule-match above (0.6) and never below the MEDIUM floor, because the component
    // this IS is not in doubt — only which of its variants it was meant to be.
    const confidence = Math.max(BANDS.MEDIUM, Math.min(0.6, 0.4 + fit.score * 0.2));
    const label = dimensionLabel(closestOfFamily.component.model, fit.assignments[0] ?? {});
    const tiedFit = runnerUpOfFamily?.fit as Fit | undefined;
    const tied = tiedFit && Math.abs(tiedFit.score - fit.score) < VARIANT_TIE_MARGIN;
    return matched(
      closestOfFamily,
      confidence,
      `${ruleMap?.ruleId ?? ''} ${ruleTitle(ruleMap?.ruleId ?? '')}: a ${component.componentType} is this Design System family whatever its rendered style looks like — identity is decided before compliance${viaDeepSearch ? `; none of the files the rule names could represent it, so the rest of the family was searched` : ''}. The closest existing variant is ${closestOfFamily.component.entry.file}${label ? ` (${label})` : ''}, ${fit.passed}/${fit.compared} governed properties fit${
        tied ? `, closely tied with ${(runnerUpOfFamily as Evaluated).component.entry.name} — the specific variant is a judgment call, the family is not` : ''
      }${setAside ? ' (a variant that paints brand red was set aside — R1.2 forbids brand red on a non-CTA element)' : ''}; the rest are reported as deviations from it, not as a different or new component.`,
      'family-identity',
      fit,
    );
  }
  // A single-named family with too little measurable evidence to score a fit at all — still that
  // component (the DS names only one), just too little could be read from its root to say more.
  const onlyRule = familyFiles.length === 1 ? candidates.get(familyFiles[0] as string) : undefined;
  if (onlyRule && !classPointsOutsideFamily && identityEligible) {
    const fit = onlyRule.fit;
    return matched(
      onlyRule,
      BANDS.MEDIUM,
      `${ruleMap?.ruleId ?? ''} ${ruleTitle(ruleMap?.ruleId ?? '')}: a ${component.componentType} is audited against ${onlyRule.component.entry.file} — the only component the DS names for it — so it is that component whatever its rendered style looks like. ${fit ? `Only ${fit.compared} of its governed properties` : 'None of its governed properties'} can be read from the element's root.`,
      'single-component-family',
    );
  }

  // 3. Undecided — say exactly why.
  const possibleMatches = evaluated.map(possibleMatchOf).sort((a, b) => b.score - a.score).slice(0, 4);
  let reason: string;
  if (evaluated.length === 0) {
    reason = `no Design System component is mapped to a ${component.componentType} by the DS rules, and none shares its class fingerprint`;
  } else if (top && second && top.cls.score >= CLASS_MATCH_SCORE) {
    reason = `the element's classes point at ${top.component.entry.name} and ${second.component.entry.name} about equally (${top.cls.score.toFixed(2)} vs ${second.cls.score.toFixed(2)})`;
  } else if (fitting.length > 1) {
    reason = `${fitting.map((e) => e.component.entry.name).join(' and ')} fit its rendered style equally well`;
  } else {
    const closest = [...evaluated].sort((a, b) => (b.fit?.score ?? 0) - (a.fit?.score ?? 0))[0];
    const variant = closest?.fit ? dimensionLabel(closest.component.model, closest.fit.assignments[0] ?? {}) || 'default' : '';
    reason = !closest?.fit
      ? `none of the candidate DS components has a property that could be compared with this element`
      : closest.fit.compared < RULE_FIT_MIN_COMPARED
        ? `the closest DS component, ${closest.component.entry.name} (${variant}), has only ${closest.fit.compared} governed propert${closest.fit.compared === 1 ? 'y' : 'ies'} that could be compared with this element, and the element shares ${closest.cls.shared.length} DS class(es) with it — too little evidence to call it that component`
        : closest.fit.passed === closest.fit.compared
          ? // Not a poor fit (third-pass review F4) — every comparable property matched; there were
            // just too few of them, and too little class evidence, to call it a confident match.
            `the closest DS component, ${closest.component.entry.name} (${variant}), fits all ${closest.fit.compared} of its governed properties that could be compared, but only ${closest.fit.compared} could be, and the element shares ${closest.cls.shared.length} DS class(es) with it — too little evidence to audit it as that component`
          : `the closest DS component, ${closest.component.entry.name} (${variant}), fits only ${closest.fit.passed} of ${closest.fit.compared} governed properties, and the element shares ${closest.cls.shared.length} DS class(es) with it — too little to audit it as that component`;
  }
  const closest = [...evaluated].sort((a, b) => (b.fit?.score ?? 0) - (a.fit?.score ?? 0))[0];
  return {
    dsComponent: null,
    dsFile: null,
    dsVariant: null,
    confidence: 0,
    rationale: `deterministic: ${reason}`,
    unanswered: false,
    confidenceOutOfContract: false,
    possibleMatches,
    undecidedReason: reason,
    observed: closest?.fit?.observed ?? [],
    search: {
      ...searchOf('undecided'),
      undecidedBecause: !family ? 'no-family' : classPointsOutsideFamily ? 'class-evidence-elsewhere' : !identityEligible ? 'type-not-trusted' : 'family-cannot-represent',
    },
  };
}
