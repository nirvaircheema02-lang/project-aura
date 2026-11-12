import { buildComponentCatalog, effectiveTokenMap, type CatalogComponent } from '../../ds/catalog.ts';
import { buildComponentStyleModel, dimensionLabel, expectationsFor, type Assignment, type ComponentStyleModel } from '../../ds/component-styles.ts';
import { resolveToken } from '../../ds/d3-tokens/resolve.ts';
import { compareToExpected } from '../../t-layer/token-comparator.ts';
import { BANDS } from '../../skills/s8-confidence-escalation-policy.ts';
import type { DsRegistry } from '../../ds/d2-registry/index.ts';
import type { PossibleMatch } from '../../skills/s0-result-contract.ts';
import type { ExtractedStyle } from '../../t-layer/computed-style.ts';
import type { DetectedComponent, DsMatch } from '../types.ts';

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
    return { components, byFile: new Map(components.map((c) => [c.entry.file, c])), idf, unknownIdf: Math.log(n + 1) + 1 };
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
export function bestFit(model: ComponentStyleModel, style: ExtractedStyle, tokens: Map<string, string>, viewportWidth: number, rootTag?: string | null): Fit | null {
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
    const root = assignment[ROOT_DIMENSION];
    if (rootIds.length > 0 && root !== undefined && !rootIds.includes(root)) continue;
    const expected = expectationsFor(model, assignment, { viewportWidth });
    if (expected.length === 0) continue;
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
 * Decides one component. Returns a DsMatch in B3's normal shape, so S8's
 * routing, B4 and B6 work unchanged: matched → B4; undecided → `dsComponent:
 * null` → B6, carrying the candidates and the reason for a reviewer.
 */
export function decideMatch(component: DetectedComponent, index: DsIndex, registry: DsRegistry, viewportWidth: number): DsMatch {
  const tokens = effectiveTokenMap(registry, 'editorial-light');
  const ruleTitle = (id: string) => registry.rules.rules.find((r) => r.id === id)?.title ?? '';
  const classes = component.domFacts?.classes ?? [];
  const ruleMap = RULE_CANDIDATES[component.componentType];

  const byClass = index.components
    .map((c) => ({ c, cls: classScore(classes, c, index) }))
    .filter((x) => x.cls.shared.length >= 2)
    .sort((a, b) => b.cls.score - a.cls.score)
    .slice(0, 3);
  const candidates = new Map<string, Evaluated>();
  for (const { c, cls } of byClass) candidates.set(c.entry.file, { component: c, cls, fit: null, viaRule: false });
  for (const file of ruleMap?.files ?? []) {
    const c = index.byFile.get(file);
    if (!c) continue;
    const existing = candidates.get(file);
    if (existing) existing.viaRule = true;
    else candidates.set(file, { component: c, cls: classScore(classes, c, index), fit: null, viaRule: true });
  }
  for (const e of candidates.values()) e.fit = bestFit(e.component.model, component.style, tokens, viewportWidth, component.domFacts?.tag ?? null);
  const evaluated = [...candidates.values()];

  const matched = (e: Evaluated, confidence: number, rationale: string): DsMatch => ({
    dsComponent: e.component.entry.name,
    dsFile: e.component.entry.file,
    dsVariant: e.fit ? dimensionLabel(e.component.model, e.fit.assignments[0] ?? {}) || null : null,
    confidence: Math.round(confidence * 1000) / 1000,
    rationale,
    unanswered: false,
    confidenceOutOfContract: false,
    possibleMatches: evaluated.filter((x) => x !== e).map(possibleMatchOf).sort((a, b) => b.score - a.score),
    assignments: e.fit?.assignments ?? [],
    observed: e.fit?.observed ?? [],
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
    );
  }

  // 2b. The DS rule names ONE component for this element type and nothing about the element
  // contradicts it — but its governed properties cannot be read from the element's root (the
  // component styles children, or per-prop runtime values). Its identity is not in doubt, its
  // compliance is: matched at the MEDIUM floor, so B4 publishes it UNVERIFIED (or INCORRECT on a
  // measured foundation breach) instead of calling it undecided.
  const onlyRule = ruleMap && ruleMap.files.length === 1 ? candidates.get(ruleMap.files[0] as string) : undefined;
  const contradicted = onlyRule?.fit && onlyRule.fit.compared >= RULE_FIT_MIN_COMPARED;
  const classPointsElsewhere = top && top !== onlyRule && top.cls.score >= CLASS_MATCH_SCORE;
  if (onlyRule && !contradicted && !classPointsElsewhere && component.detectionConfidence >= 0.5) {
    return matched(
      onlyRule,
      0.5,
      `${ruleMap?.ruleId ?? ''} ${ruleTitle(ruleMap?.ruleId ?? '')}: a ${component.componentType} is audited against ${onlyRule.component.entry.file} — the only component the DS names for it — but ${onlyRule.fit ? `only ${onlyRule.fit.compared} of its governed properties` : 'none of its governed properties'} can be read from the element's root`,
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
  };
}
