import type { Page } from 'playwright';
import type { AuditProperty, Finding } from '../audit-link/index.ts';
import type { MappingEntry } from '../mapping/types.ts';
import type { DesignDecisionsFile } from '../preview/types.ts';
import { redesignPolicyViolation } from '../redesign-policy.ts';
import { propertyMatchesExpected } from '../style/compare-expected.ts';
import { lengthToPx } from '../t-layer/computed-style.ts';
import { inferElementKinds, type ElementEvidence, type KindInference, type StructureFacts } from '../reference/element-kind.ts';
import type { PatternQuery } from '../reference/types.ts';
import { assessColour, buildDsColourIndex, COLOUR_RULES, extractColours, parseBackdrop, parseCssColour, roleForProperty, suppliesProperty, summariseMapping, type Rgb } from './ds-colours.ts';
import { classifyProperty, propertyInfo, resolveTokenInScope, type Classification, type DsTokenIndex } from './ds-evidence.ts';
import type { ResolutionDecision, ResolutionJudgment } from './judgment-schema.ts';
import { judgeRenderedColour, measureBackdrop, measureComputed, measureInState, measureUsedGap, renderedFacts, resolveForProperty, settleSelector, sweepScrollReveals, type RenderedFacts, type Settled } from './rendered.ts';
import { probeStructure } from './structure-probe.ts';
import {
  RESOLUTION_SCHEMA_VERSION,
  targetIdFor,
  type AcceptanceCheck,
  type ColourMapping,
  type ComparisonMethod,
  type ElementKindRecord,
  type Provenance,
  type ReferenceProvenance,
  type ResolutionFile,
  type ResolvedTarget,
  type StateName,
  type ThemeName,
  type UnresolvedReason,
} from './schema.ts';

/**
 * RV — the Resolver. For every selected, in-scope Fix finding it turns the audit's per-property record
 * into DERIVED design targets, kept apart from the audit data:
 *
 *   audit DIFFERENT with an expected value → resolved target (provenance: the audit's own measurement)
 *   audit UNRESOLVED                       → classified (why?), then
 *       "no DS requirement" / inherited    → preserve-existing  (nothing is invented because a value is absent)
 *       keyword the audit could not compare (gap: normal/auto) → measured on the rendered page; resolved or preserved
 *       token missing from the unscoped DS → looked up in the page's variant/theme scope
 *       state / viewport / unknown         → unresolved, with the specific gap named
 *   residual design questions (NEEDS_REVIEW / UNVERIFIED) → a judgment, whose every claim is VERIFIED here
 *
 * Resolution order (persistent rules → DS → approved project pattern → local composition from DS tokens →
 * a specific unresolved outcome). Nothing here edits a page or the audit data.
 */

export interface ReferenceHooks {
  registry: { version: string; sha256: string; approvedProjects: string[] };
  /**
   * Candidate approved patterns for a query (no filesystem access): offered to the judgment. Every candidate passes the same surface, viewport and
   * element-kind test `verify` applies, so one offered is never refused for those reasons; `elementKinds` is what the pattern fits.
   */
  find(query: PatternQuery): Array<{
    project: string; pattern: string; purpose: string; declarations: Record<string, string>; preferred: boolean; elementKinds: string[];
    /** Whether every colour of the pattern has a DS mapping on this surface (previewed on the DS section backgrounds), and the gap when not. Absent: not previewed. */
    mappable?: boolean;
    gap?: string | null;
    /** One line per colour: `border: rgba(0,0,0,.06) -> --semantic-hairline-faint (nearest, ΔE 0.54)` or the gap. */
    colourPreview?: string[];
    /** A token ladder: its custom properties cannot be applied to a CSS property; it only helps choose a DS token. */
    evidenceOnly?: boolean;
  }>;
  /** Verifies one pattern for a query (project approved, source present, purpose/surface/viewport/element-kind fit, DS grounding, tokens exist). */
  verify(args: { project: string; pattern: string; query: PatternQuery }): Promise<{ ok: boolean; applied: Record<string, string>; classification: 'approved-project-pattern' | 'proposed-local-variant' | null; provenance: ReferenceProvenance | null; reasons: string[] }>;
}

export interface ResolveDeps {
  page: Page | null;
  dsIndex: DsTokenIndex | null;
  dsRegistryVersion: string | null;
  /** Authored per-finding decisions (design-decisions.json): `preserve-existing` / `unresolved` bind this stage too. */
  decisions: DesignDecisionsFile | null;
  reference: ReferenceHooks | null;
  now?: () => Date;
}

export interface ResolveInput {
  run: { runId: string; projectName: string; dataJsonSha256: string | null; fixPlanSha256: string | null };
  /** Selected Fix findings that are in scope (the caller applies the section/mapping scope). */
  findings: Finding[];
  entries: MappingEntry[];
  /** An already-obtained (validated) judgment — used by tests and by a resumed run. */
  judgment?: ResolutionJudgment | null;
  /** Asks for the judgment on the residual design questions (a session judgment bundle, or an API call). Called at most once, only when there are residuals. */
  judge?: (residuals: ResidualQuestion[]) => Promise<ResolutionJudgment>;
}

/** A finding the deterministic rules cannot settle: its design needs a decision. */
export interface ResidualQuestion {
  findingId: string;
  section: string;
  productionType: string;
  productionLabel: string;
  classification: string;
  reviewReason: string | null;
  signals: string[];
  possibleMatches: Array<{ dsComponent: string; dsVariant: string | null; score: number; why: string }>;
  dsReference: { dsComponent: string | null; dsVariant: string | null; basis: string };
  surface: 'light' | 'dark' | 'unknown';
  /** The colour the element's paint lands on, measured in the page (null + why when it cannot be, e.g. a gradient behind it). A colour is judged on this, not on an assumed surface. */
  backdrop?: { color: string | null; source: 'measured' | 'ds-section-tokens'; why: string | null };
  element: { selector: string | null; tag: string | null; role: string | null };
  /** What the element IS FOR, classified once from the audit, DS, mapping and rendered-structure evidence: the tag above is evidence, not a category. Candidate selection and verification both use these kinds. */
  elementKinds: KindInference;
  properties: Array<{ property: string; actual: string | null; auditStatus: string; reason: UnresolvedReason; rationale: string; currentOutcome: string }>;
  /** The candidates OFFERED for this finding, as the judge saw them: a judgment can only claim one of these (`validateDecision`), so what is offered is what can be verified. */
  candidatePatterns: ReturnType<ReferenceHooks['find']>;
  /** Why there is no candidate (no registry, no component category established, nothing fits); null when there are candidates. */
  candidatePatternsNote: string | null;
}

export interface ResolveOutput {
  file: ResolutionFile;
  residuals: ResidualQuestion[];
}

const ALL_PROPS_DEFAULT = { state: 'default' as StateName, theme: 'inherit' as ThemeName, viewport: { name: 'any' as const, width: null } };

const COLOR_PROP = /(^|-)color$|^background(-image)?$|^fill$|^stroke$/;
const LENGTH_PROP = /^(?:border-.*-(?:width|radius)|border-radius|font-size|letter-spacing|(?:row-|column-)?gap|padding(?:-.+)?|outline-(?:width|offset)|line-height)$/;

export function comparisonFor(property: string, hint?: ComparisonMethod | 'unsupported'): ComparisonMethod {
  if (hint && hint !== 'unsupported') return hint;
  if (COLOR_PROP.test(property)) return 'color-deltaE';
  if (LENGTH_PROP.test(property)) return 'length-px';
  return 'exact';
}

const selectorOf = (entry: MappingEntry | undefined): string | null => (entry ? `[data-fra-element="${entry.element}"]` : null);

/** The audit's per-property record, or — for audits older than that record — the comparable mismatches, so the same path serves both. */
export function propertiesOf(f: Finding): AuditProperty[] {
  const base: AuditProperty[] = f.comparison.properties && f.comparison.properties.length > 0
    ? f.comparison.properties
    : f.comparison.mismatches.map((m) => ({ property: m.property, actual: m.actual, expected: m.expected, expectedToken: m.expectedToken, source: f.component.dsComponent ?? null, status: 'DIFFERENT' as const, note: null }));
  return withUserTypographyOverrides(f, withColourRuleTargets(f, withStatNumeralTargets(f, base)));
}

/** DS type-scale steps a large numeral can land on (docs: core-v2 FOUNDATIONS, Major Third scale). */
const TYPE_STEPS: Array<{ token: string; rem: number }> = [
  { token: '--typography-size-lg', rem: 1.563 }, { token: '--typography-size-xl', rem: 1.953 }, { token: '--typography-size-2xl', rem: 2.441 },
  { token: '--typography-size-3xl', rem: 3.052 }, { token: '--typography-size-4xl', rem: 3.815 }, { token: '--typography-size-5xl', rem: 4.768 },
];
const STAT_NUMERAL = /stat numeral/i;
const R13_CLOSEST = /font-size\s+[\d.]+px is not a step of the Design System type scale \(closest:\s*([\d.]+)px/i;

/**
 * Stat numerals (docs/REDESIGN_RULES.md "Stat numerals and counters", user instruction 2026-10-26). The audit flags a stat numeral with R1.2 ("stat numeral
 * painted in brand red") or R1.1 ("stat numeral colour … is not a Design System colour") and, when its size is off the scale, R1.3 ("closest: 39.06px"). Both name what to do, so both become expected values:
 * colour → the neutral ink `--black-900` (the DS StatPair value colour; brand red is for CTAs only), font-size → the audit's closest DS type-scale step.
 * Runs BEFORE withColourRuleTargets, so R1.1's "closest grey" never replaces the ink. Only a finding that carries a stat-numeral R1.1/R1.2 violation is touched; a colour/size the audit already resolved is never overridden. The hover behaviour
 * (the original turns the numeral into a gradient) and the count-up are not properties: the React Preview runtime handles them (runtime/stats.ts, counters.ts).
 */
export function withStatNumeralTargets(f: Finding, props: AuditProperty[]): AuditProperty[] {
  const violations = f.comparison.ruleViolations ?? [];
  if (!violations.some((r) => (r.ruleId === 'R1.2' || r.ruleId === 'R1.1') && STAT_NUMERAL.test(r.why))) return props;
  let out = props;
  const existing = (name: string) => out.find((p) => p.property === name);
  const put = (p: AuditProperty) => { const e = existing(p.property); out = e ? out.map((x) => (x === e ? p : x)) : [...out, p]; };

  const color = existing('color');
  if (!color || color.status === 'UNRESOLVED') {
    put({ property: 'color', actual: color?.actual ?? '', expected: '#171717', expectedToken: '--black-900', source: 'foundation rule R1.2', status: 'DIFFERENT', note: 'R1.2: stat numerals use the neutral ink --black-900, never brand red (user instruction 2026-10-26)' });
  }
  const size = existing('font-size');
  const hit = violations.filter((r) => r.ruleId === 'R1.3').map((r) => R13_CLOSEST.exec(r.why)).find((m): m is RegExpExecArray => !!m);
  if (hit && (!size || size.status === 'UNRESOLVED')) {
    const rem = Number(hit[1]) / 16;
    const step = TYPE_STEPS.find((s) => Math.abs(s.rem - rem) < 0.02);
    if (step) put({ property: 'font-size', actual: size?.actual ?? '', expected: `${step.rem}rem`, expectedToken: step.token, source: 'foundation rule R1.3', status: 'DIFFERENT', note: `R1.3: ${step.token} (${step.rem}rem) is the closest Design System type-scale step` });
  }
  return out;
}

/**
 * User instruction 2026-10-23 (docs/REDESIGN_RULES.md "Step labels"): "Step NN" labels are NOT upper-cased and stay small. The DS SectionLabel the audit
 * matched is all-caps with 0.2em tracking; the user revised that for step labels, so the audit's text-transform / letter-spacing targets are replaced
 * (no caps, no added tracking) and the size is the DS 2xs token (0.6875rem). Colour and weight keep the audit's DS values.
 */
const STEP_LABEL = /^step\s*\d+$/i;
export function withUserTypographyOverrides(f: Finding, props: AuditProperty[]): AuditProperty[] {
  if (!STEP_LABEL.test((f.component.productionLabel ?? '').trim())) return props;
  const note = 'user instruction: step labels are not upper-cased and stay small';
  return props
    .filter((p) => p.property !== 'letter-spacing')
    .map((p) => p.property === 'text-transform' ? { ...p, expected: 'none', expectedToken: null, status: 'DIFFERENT' as const, note }
      : p.property === 'font-size' ? { ...p, expected: '0.6875rem', expectedToken: '--typography-size-2xs', status: 'DIFFERENT' as const, note }
      : p);
}

/** R1.1 violation text: "<what> colour rgb(…) is not a Design System colour (closest: --color-ramp-black-700 #404040, ΔE 4) …" */
const R11 = /colour\s+(rgba?\([^)]*\)).*?closest:\s*(--[\w-]+)\s+(#[0-9a-fA-F]{6,8})/;

/**
 * The audit names the Design System colour a text colour should be (rule R1.1: "text is drawn from the foundation palette", with the closest
 * token and its value), but only in the rule violation — the per-property record leaves `color` UNRESOLVED ("no verified DS requirement").
 * That value IS in the audit and IS a DS token, so it is the expected value for `color` (design-system application; no layout is touched).
 * A `color` the audit already resolved is never overridden.
 */
export function withColourRuleTargets(f: Finding, props: AuditProperty[]): AuditProperty[] {
  const hit = (f.comparison.ruleViolations ?? []).filter((r) => r.ruleId === 'R1.1').map((r) => R11.exec(r.why)).find((m): m is RegExpExecArray => !!m);
  if (!hit) return props;
  const existing = props.find((p) => p.property === 'color');
  if (existing && existing.status !== 'UNRESOLVED') return props;
  const [, actual, token, hex] = hit as unknown as [string, string, string, string];
  // "closest" is by colour distance over the WHOLE palette: for a neutral grey it can land on a warm ramp (rgb(189,189,189) → --color-ramp-warm-700 #c8bcb8,
  // a beige) — a hue change the page never had. Text that was neutral stays neutral; a token that would tint it is not applied (the finding keeps its colour,
  // reported as unresolved, never "fixed").
  const chroma = (rgb: number[]) => Math.max(...rgb) - Math.min(...rgb);
  const rgbOf = (v: string): number[] | null => { const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
  const hx = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  const from = rgbOf(actual);
  const to = hx ? [parseInt(hx[1]!, 16), parseInt(hx[2]!, 16), parseInt(hx[3]!, 16)] : null;
  if (from && to && chroma(to) - chroma(from) > 10) return props;
  const synthesized: AuditProperty = { property: 'color', actual: existing?.actual ?? actual, expected: hex.toLowerCase(), expectedToken: token, source: 'foundation rule R1.1', status: 'DIFFERENT', note: `R1.1: ${token} (${hex}) is the closest Design System colour` };
  return existing ? props.map((p) => (p === existing ? synthesized : p)) : [...props, synthesized];
}

interface Draft {
  property: string;
  part: string;
  state: StateName;
  theme: ThemeName;
  audit: ResolvedTarget['audit'];
  reason: UnresolvedReason;
  outcome: ResolvedTarget['outcome'];
  target: ResolvedTarget['target'];
  provenance: Provenance;
  decisionReason: string;
  /** Acceptance checks beyond `property-equals`: the colour must also be visible on its backdrop, and a state colour distinguishable from the default. */
  extraAcceptance?: AcceptanceCheck[];
}

const baselineProvenance = (evidence: string[]): Provenance => ({ kind: 'original-baseline', ds: null, reference: null, evidence });

function finalize(findingId: string, d: Draft, routeOk: boolean): ResolvedTarget {
  const resolved = d.outcome === 'resolved-target';
  const acceptance: AcceptanceCheck[] = resolved && d.target
    ? [{ kind: 'property-equals', property: d.property, state: d.state, viewport: ALL_PROPS_DEFAULT.viewport.name, comparison: d.target.comparison, expected: d.target.value }, ...(d.extraAcceptance ?? [])]
    : d.outcome === 'preserve-existing'
      ? [{ kind: 'property-unchanged', property: d.property, state: d.state, viewport: ALL_PROPS_DEFAULT.viewport.name, comparison: null, expected: null }]
      : [];
  const base = { findingId, property: d.property, part: d.part, viewport: ALL_PROPS_DEFAULT.viewport, theme: d.theme, state: d.state };
  return {
    id: targetIdFor(base),
    ...base,
    audit: d.audit,
    reason: d.reason,
    outcome: d.outcome,
    target: d.target,
    provenance: d.provenance,
    decisionReason: d.decisionReason,
    route: resolved && routeOk ? 'css-edit' : 'none',
    acceptance,
    status: {
      design: resolved ? 'resolved' : d.outcome === 'preserve-existing' ? 'preserved' : 'unresolved',
      implementation: resolved ? (routeOk ? 'not-started' : 'blocked') : 'not-applicable',
      verification: 'not-run',
      implementationDetail: resolved && !routeOk ? 'the finding has no usable element mapping, so no edit can be planned for this target' : null,
      verificationDetail: null,
    },
  };
}

const auditObs = (p: AuditProperty): ResolvedTarget['audit'] => ({ status: p.status, actual: p.actual, expected: p.expected, expectedToken: p.expectedToken, note: p.note, source: p.source });

// ── token substitution (judgment values) ────────────────────────────────────────────────────

const SIDE_PART = '(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?';
/**
 * What a judgment with NO DS token behind it may say: keywords, 0 and a 1px hairline - and only where that is a design value, not a way to hide or remove content.
 * Property pattern -> the values (each whitespace/comma separated part) it may take. `none` / `transparent` for a border, outline, rule or background colour and a shadow;
 * `0` for a radius or a border width; a visible border style; the typographic resets that remove no text. NOT allowed without a DS token: a font-size, line-height,
 * letter-spacing or text colour of 0 / transparent / none (the text disappears or collapses), a border-style of none, an icon fill of none, and every property outside
 * this table (`opacity: 0`, `pointer-events: none`, `all: unset` ...).
 */
const ZERO_TOKEN_ALLOWED: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [new RegExp(`^(?:(?:border${SIDE_PART}|outline|column-rule)-color|background(?:-color)?)$`), /^(?:none|transparent|currentcolor)$/i],
  [new RegExp(`^(?:border${SIDE_PART}|outline|column-rule)$`), /^(?:none|transparent|currentcolor|0|0px|1px|solid|dashed|dotted)$/i],
  [/^border-(?:radius|(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end))-radius)$/, /^(?:0|0px)$/],
  [new RegExp(`^(?:border${SIDE_PART}|outline|column-rule)-width$|^border-width$`), /^(?:0|0px|1px)$/],
  [new RegExp(`^(?:border${SIDE_PART}|outline|column-rule)-style$|^border-style$`), /^(?:solid|dashed|dotted)$/i],
  [/^(?:box|text)-shadow$/, /^none$/i],
  [/^text-decoration(?:-line)?$/, /^none$/i],
  [/^(?:letter|word)-spacing$/, /^normal$/i],
  [/^text-transform$/, /^none$/i],
  [/^font-style$/, /^normal$/i],
  [/^(?:color|caret-color)$/, /^(?:currentcolor|inherit)$/i],
];

/** Why a value made only of keywords / 0 / a hairline is not a design value for `property`, or null when it is. */
function zeroTokenRefusal(property: string, value: string): string | null {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean);
  const rules = ZERO_TOKEN_ALLOWED.filter(([name]) => name.test(property));
  if (rules.length > 0 && parts.every((part) => rules.some(([, allowed]) => allowed.test(part)))) return null;
  return ['color', 'shape', 'typography'].includes(propertyInfo(property).category) || /^(?:box|text)-shadow$/.test(property)
    ? `${property}: ${value} names no DS token, and a bare "${value}" is not one of the keywords a ${property} design value may be (\`none\` / \`transparent\` for a border, outline, rule or background colour and a shadow, \`0\` for a radius or border width): it would hide or remove content (a collapsed or invisible text, a removed border style) with nothing from the DS behind it`
    : `${property}: ${value} names no DS token, and ${property} is not a colour, shape, shadow or typography property: a keyword alone is not DS guidance for it`;
}
const LITERAL_OK = /^(?:none|transparent|currentcolor|inherit|initial|unset|solid|dashed|dotted|normal|0|0px|1px)$/i;

/** The properties whose value is a length or a keyword: the only ones for which a reference literal that is not a DS token may be taken (flagged as such). Colour is never one of them. */
const LENGTH_LITERAL_PROPERTY = /^(?:border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?-(?:width|style)|border-(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end))-radius|border-radius|outline-(?:width|offset|style)|(?:row-|column-)?gap|padding(?:-.+)?|letter-spacing|font-size|line-height)$/;

const CSS_UNITS = 'px|rem|em|vh|vw|vmin|vmax|svh|dvh|lvh|ch|ex|lh|rlh|pt|pc|cm|mm|in|%|fr|deg';
const LENGTH_TOKEN = new RegExp(String.raw`^[-+]?(?:\d+\.?\d*|\.\d+)(?:${CSS_UNITS})?$`, 'i');
const LENGTH_KEYWORDS: ReadonlySet<string> = new Set(['normal', 'thin', 'medium', 'thick']);
const STYLE_KEYWORDS: ReadonlySet<string> = new Set(['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset']);
const MATH_FUNCTIONS: ReadonlySet<string> = new Set(['calc', 'clamp', 'min', 'max']);
const UNIT_WORDS: ReadonlySet<string> = new Set(CSS_UNITS.split('|'));

/** `calc()` / `clamp()` / `min()` / `max()` over lengths only: balanced, and every word in it is a unit or one of those four functions (no `var()`, `env()`, `attr()`, colour, url). */
function mathOfLengths(token: string): boolean {
  const m = /^([a-z]+)\(([\s\S]*)\)$/i.exec(token);
  if (!m || !MATH_FUNCTIONS.has(m[1]!.toLowerCase())) return false;
  let depth = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '(') depth++;
    else if (token[i] === ')' && --depth === 0 && i !== token.length - 1) return false;
    if (depth < 0) return false;
  }
  if (depth !== 0 || !/^[\d\s.+\-*/%(),a-z]*$/i.test(m[2]!)) return false;
  return (m[2]!.match(/[a-z]+/gi) ?? []).every((w) => UNIT_WORDS.has(w.toLowerCase()) || MATH_FUNCTIONS.has(w.toLowerCase()));
}

/**
 * Is the WHOLE value a plain length / keyword literal of `property`? An allowlist: lengths, numbers, `calc/clamp/min/max` of lengths and the few keywords of a
 * length (`normal`, `thin` ...) or of a `*-style` property, separated by spaces (and a `/` for `border-radius`) - nothing else. No `var()` (even with a
 * fallback), `;`, `{`, `}`, backslash, comment, `url()` or colour can pass, because none of them is in the grammar.
 */
export function isPlainLengthLiteral(property: string, value: string): boolean {
  const v = value.trim();
  if (v === '' || v.length > 160) return false;
  const tokens: string[] = [];
  let depth = 0; let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return false;
    if (/\s/.test(ch) && depth === 0) { if (cur) tokens.push(cur); cur = ''; } else cur += ch;
  }
  if (depth !== 0) return false;
  if (cur) tokens.push(cur);
  if (tokens.length === 0 || tokens.length > 9) return false;
  if (/-style$/.test(property)) return tokens.length === 1 && STYLE_KEYWORDS.has(tokens[0]!.toLowerCase());
  return tokens.every((t, i) => LENGTH_TOKEN.test(t) || LENGTH_KEYWORDS.has(t.toLowerCase()) || mathOfLengths(t) || (t === '/' && property.endsWith('radius') && i > 0 && i < tokens.length - 1));
}

/**
 * A judgment's value may only be built from DS tokens (`var(--x)`) and a few keywords. Each token is
 * resolved to a literal for the page's surface (the production page does not define DS custom properties).
 */
export function substituteTokens(value: string, index: DsTokenIndex, surface: 'light' | 'dark' | 'unknown'): { ok: true; literal: string; tokens: string[]; evidence: string[] } | { ok: false; reason: string } {
  const tokens: string[] = [];
  const evidence: string[] = [];
  let failure: string | null = null;
  const withoutVars = value.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]*)?\)/g, (_m, token: string) => {
    const r = resolveTokenInScope(index, token, surface);
    if (r.outcome !== 'resolved-target' || r.value === null) { failure = `${token}: ${r.reason}`; return '\u0000'; }
    tokens.push(token);
    evidence.push(...r.evidence.slice(0, 2));
    return `\u0001${r.value}\u0001`;
  });
  if (failure) return { ok: false, reason: failure };
  // everything that is not a resolved token must be a permitted keyword/zero/hairline: no hardcoded colours or lengths
  const leftovers = withoutVars.split(/\u0001[^\u0001]*\u0001/).join(' ').split(/[\s,]+/).filter(Boolean);
  const bad = leftovers.filter((t) => !LITERAL_OK.test(t));
  if (bad.length) return { ok: false, reason: `"${bad.join(' ')}" is a hardcoded value, not a DS token (only var(--token), keywords, 0 and a 1px hairline are allowed)` };
  return { ok: true, literal: withoutVars.replace(/\u0001/g, ''), tokens, evidence };
}

// ── the resolver ────────────────────────────────────────────────────────────────────────────

const PATTERN_CATEGORY = (property: string): PatternQuery['category'] => (/^(?:border(?:-.+)?|box-shadow|outline(?:-.+)?)$/.test(property) ? 'subtle-border' : 'other');

/**
 * What the classifier may read about a finding's element: the audit's type, DS match and signals, the mapping's affordances and DS reference, and
 * the rendered structure. NOT the production label (page text), the review reason or a judgment's reason: none of them is evidence of what it is.
 */
function evidenceFor(f: Finding, entry: MappingEntry | undefined, structure: StructureFacts | null): ElementEvidence {
  const a = entry?.affordances;
  return {
    audit: { productionType: f.component.productionType, dsComponent: f.component.dsComponent, signals: f.review?.signals ?? [], possibleMatches: (f.review?.possibleMatches ?? []).map((m) => ({ dsComponent: m.dsComponent, score: m.score })) },
    mapping: entry && a ? { tagName: a.tagName, role: a.role, href: a.href, type: a.type, ariaExpanded: a.ariaExpanded, ariaControls: a.ariaControls, dsComponent: entry.dsReference.dsComponent, dsBasis: entry.dsReference.basis } : null,
    structure,
  };
}

/** The reference query for one need. The element kinds are the finding's SEMANTIC classification, made once and shared by selection and verification. */
function patternQuery(need: { property: string; purpose: string; surface: 'light' | 'dark' | 'unknown'; inference: KindInference; state?: StateName; backdrop?: ResidualQuestion['backdrop'] | undefined }): PatternQuery {
  const { inference } = need;
  const measured = need.backdrop?.color != null && need.backdrop.source === 'measured';
  return {
    category: PATTERN_CATEGORY(need.property), purpose: need.purpose, surface: need.surface === 'dark' ? 'dark' : 'light', viewport: 'any',
    elementKinds: inference.kinds.map((k) => k.kind),
    elementEvidence: { tag: inference.raw.tag, role: inference.raw.role, productionType: inference.raw.productionType, summary: inference.summary },
    properties: [need.property],
    // the colour is judged in the target's own state, on the backdrop measured in the page (or, unmeasured, on the DS section backgrounds)
    colour: { state: need.state ?? 'default', property: need.property, ...(measured ? { backdrops: [need.backdrop!.color!], backdropSource: 'measured' as const } : { backdropSource: 'ds-section-tokens' as const }) },
  };
}

/**
 * What the need is FOR, from the audit's evidence only: its production type, its own review reason and the kind classification. NOT the page's label (page
 * text) and never a judgment's reason: the purpose a claim is verified against is one the claim cannot word its way into.
 */
function purposeOf(productionType: string, reviewReason: string | null, inference: KindInference): string {
  return `${productionType} ${reviewReason ?? ''} ${inference.summary}`.replace(/\s+/g, ' ').trim();
}

function noCandidatesNote(deps: ResolveDeps, inference: KindInference, surface: string): string {
  if (!deps.reference) return 'no approved-reference registry is available';
  if (inference.kinds.length === 0) return `no approved pattern can be offered: ${inference.summary}`;
  return `no approved pattern fits ${inference.kinds.map((k) => k.kind).join(', ')} on a ${surface === 'dark' ? 'dark' : 'light'} surface`;
}

type Backdrop = NonNullable<ResidualQuestion['backdrop']>;

/**
 * The backdrop a colour of `property` is drawn over on this element, measured now. It belongs to the PROPERTY (a border sits on the element's own background, a
 * background or an outer shadow on what is behind it), so it is measured for the property being decided - never kept per finding, where whichever audit
 * property came last would decide it.
 */
async function backdropFor(deps: ResolveDeps, sel: string | null, property: string): Promise<Backdrop> {
  const page = deps.page;
  if (!page || !sel) return { color: null, source: 'ds-section-tokens', why: page ? 'the finding has no usable element mapping' : 'no live page to measure' };
  const settled = await settledOnce(deps, sel);
  if (!settled.settled) return { color: null, source: 'ds-section-tokens', why: `the element or an ancestor was still animating: ${settled.why}` };
  const m = await measureBackdrop(page, sel, property).catch(() => ({ rgb: null, why: 'the backdrop could not be measured' }));
  return { color: m.rgb, source: m.rgb ? 'measured' : 'ds-section-tokens', why: m.why };
}

/**
 * resolved-targets.json is hashed into the G2 fingerprint, so what is read from the page must not depend on the moment the Resolver happened to start: a section
 * wrapper that fades in or transitions its background changes the surface, the backdrop and the computed values under it. The element and its ancestors are waited
 * out ONCE per selector and run (the memo is reset by each run, so a later run waits again); one that never settles is reported, and its surface and backdrop are
 * not read at all (unknown / unmeasurable - the same answer at any moment).
 */
const settledSelectors = new WeakMap<ResolveDeps, Map<string, Promise<Settled>>>();
function settledOnce(deps: ResolveDeps, sel: string): Promise<Settled> {
  const memo = settledSelectors.get(deps) ?? settledSelectors.set(deps, new Map()).get(deps)!;
  let p = memo.get(sel);
  if (!p) { p = settleSelector(deps.page!, sel).catch(() => ({ settled: true, why: null })); memo.set(sel, p); }
  return p;
}

export async function resolveTargets(deps: ResolveDeps, input: ResolveInput): Promise<ResolveOutput> {
  const now = deps.now ?? (() => new Date());
  const targets: ResolvedTarget[] = [];
  const noTargetFindings: ResolutionFile['noTargetFindings'] = [];
  const residuals: ResidualQuestion[] = [];
  const notes: string[] = [];
  const kindRecords: ElementKindRecord[] = [];
  const surfaceOf = new Map<string, 'light' | 'dark' | 'unknown'>();
  settledSelectors.delete(deps);
  // everything read from the page below starts from the same place: scroll-triggered reveals have run and the page is at scroll 0 (see `sweepScrollReveals`)
  if (deps.page) await sweepScrollReveals(deps.page).catch(() => undefined);

  for (const f of input.findings) {
    const id = f.identity.findingId;
    const entry = input.entries.find((e) => e.findingIds.includes(id));
    const sel = selectorOf(entry);
    const mapped = !!entry && entry.scope === 'content' && entry.resolution.confidence !== 'ambiguous' && entry.resolution.confidence !== 'absent';
    const decision = deps.decisions?.findings[id];
    const props = propertiesOf(f);
    const mismatchFor = (p: string) => f.comparison.mismatches.find((m) => m.property.trim().toLowerCase() === p.trim().toLowerCase());
    const mine: ResolvedTarget[] = [];

    if (props.length === 0) noTargetFindings.push({ findingId: id, reason: 'the audit recorded no per-property data for this finding (rule-driven or component-level only)' });

    // everything read from the page below is read once the element and its ancestors have stopped animating (see `settledOnce`)
    const animating = deps.page && sel ? await settledOnce(deps, sel) : null;
    if (animating && !animating.settled) notes.push(`${id} (${sel}): the element or an ancestor was still animating (${animating.why}); its surface and backdrop are not read`);

    for (const prop of props) {
      if (prop.status === 'MATCH') continue;
      const facts: RenderedFacts | null = deps.page && sel ? await renderedFacts(deps.page, sel, prop.property).catch(() => null) : null;
      const surface = animating && !animating.settled ? 'unknown' : facts?.surface ?? 'unknown';
      if (facts) surfaceOf.set(id, surface);
      const ctx = { findingClassification: f.classification, dsComponent: f.component.dsComponent, dsVariant: f.component.dsVariant, surface, inheritedFromParent: facts?.inheritedFromParent ?? null, display: facts?.display ?? null };
      const cls = classifyProperty(prop, ctx);
      const draft = await resolveOne({ deps, f, entry, sel, prop, cls, surface, facts, mismatchComparison: mismatchFor(prop.property)?.comparison });
      mine.push(finalize(id, draft, mapped));
    }

    // an authored decision for the whole finding binds every target of it
    if (decision?.resolution === 'preserve-existing' || decision?.resolution === 'unresolved') {
      for (let i = 0; i < mine.length; i++) {
        const t = mine[i]!;
        const preserve = decision.resolution === 'preserve-existing';
        mine[i] = {
          ...t,
          outcome: preserve ? 'preserve-existing' : 'unresolved',
          target: null,
          provenance: { kind: 'recorded-decision', ds: null, reference: null, evidence: ['context/design-decisions.json'] },
          decisionReason: `recorded decision "${decision.resolution}"${decision.note ? `: ${decision.note}` : ''}`,
          route: 'none',
          acceptance: preserve ? [{ kind: 'property-unchanged', property: t.property, state: t.state, viewport: 'any', comparison: null, expected: null }] : [],
          status: { ...t.status, design: preserve ? 'preserved' : 'unresolved', implementation: 'not-applicable', implementationDetail: null },
        };
      }
    }
    targets.push(...mine);

    // residual design question: a selected NEEDS_REVIEW / UNVERIFIED finding the deterministic rules cannot settle
    const needsDecision = (f.classification === 'NEEDS_REVIEW' || f.classification === 'UNVERIFIED') && !(decision && (decision.resolution === 'preserve-existing' || decision.resolution === 'unresolved'));
    if (needsDecision) {
      const surface = surfaceOf.get(id) ?? 'unknown';
      // what the element's own border and text sit on, for the prompt; each candidate query and each decision measures the backdrop of ITS property
      const backdrop = await backdropFor(deps, sel, 'border-color');
      // classified once per finding, from every source available (no page, no mapping or no signals only means less evidence); the same kinds then
      // select the candidates below and verify the judgment's claim, so the two can never disagree. What became of the rendered read is recorded.
      let structure: StructureFacts | null = null;
      let structureProbe: NonNullable<ElementKindRecord['structureProbe']> = !deps.page ? 'no-page' : !sel ? 'not-mapped' : 'read';
      if (deps.page && sel) {
        try {
          structure = await probeStructure(deps.page, sel);
          if (structure === null) {
            structureProbe = 'not-found';
            notes.push(`structure probe for ${id} (${sel}): no element matched on the page, so its kind is classified from the audit and mapping evidence only`);
          }
        } catch (err) {
          structureProbe = 'failed';
          notes.push(`structure probe for ${id} (${sel}) failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}; its kind is classified from the audit and mapping evidence only`);
        }
      }
      const inference = inferElementKinds(evidenceFor(f, entry, structure));
      kindRecords.push({ findingId: id, ...inference, structureProbe });
      const purpose = purposeOf(f.component.productionType, f.review?.reason ?? null, inference);
      const offered = deps.reference ? await Promise.all(['border-color', 'box-shadow'].map(async (property) => deps.reference!.find(patternQuery({ property, purpose, surface, inference, backdrop: await backdropFor(deps, sel, property) })))) : [];
      const candidates = offered.flat().filter((c, i, a) => a.findIndex((x) => x.project === c.project && x.pattern === c.pattern) === i).slice(0, 6);
      residuals.push({
        findingId: id, section: f.location.section, productionType: f.component.productionType, productionLabel: f.component.productionLabel, classification: f.classification,
        reviewReason: f.review?.reason ?? null, signals: f.review?.signals ?? [],
        possibleMatches: (f.review?.possibleMatches ?? []).map((m) => ({ dsComponent: m.dsComponent, dsVariant: m.dsVariant, score: m.score, why: m.why })),
        dsReference: { dsComponent: entry?.dsReference.dsComponent ?? null, dsVariant: entry?.dsReference.dsVariant ?? null, basis: entry?.dsReference.basis ?? 'none' },
        surface, backdrop, element: { selector: sel, tag: entry?.affordances.tagName ?? null, role: entry?.affordances.role ?? null },
        properties: mine.map((t) => ({ property: t.property, actual: t.audit.actual, auditStatus: t.audit.status, reason: t.reason, rationale: t.decisionReason, currentOutcome: t.outcome })),
        elementKinds: inference,
        candidatePatterns: candidates,
        candidatePatternsNote: candidates.length > 0 ? null : noCandidatesNote(deps, inference, surface),
      });
    }
  }

  // apply a verified judgment on the residuals — every claim is re-derived and checked, never trusted
  const judgment = input.judgment ?? (residuals.length > 0 && input.judge ? await input.judge(residuals) : null);
  if (judgment) {
    const asked = new Map(residuals.map((r) => [r.findingId, r] as const));
    const seen = new Set<string>();
    for (const d of judgment.decisions) {
      const key = `${d.findingId}|${d.property}|${d.part}|${d.state}`;
      const q = asked.get(d.findingId);
      if (!q) { notes.push(`judgment decision for ${d.findingId} / ${d.property} ignored: that finding was not a residual question`); continue; }
      if (seen.has(key)) { notes.push(`judgment decision for ${d.findingId} / ${d.property} (${d.state}) ignored: duplicate`); continue; }
      seen.add(key);
      const finding = input.findings.find((x) => x.identity.findingId === d.findingId)!;
      const entry = input.entries.find((e) => e.findingIds.includes(d.findingId));
      const mapped = !!entry && entry.scope === 'content' && entry.resolution.confidence !== 'ambiguous' && entry.resolution.confidence !== 'absent';
      // the judgment answers a property the deterministic pass already recorded (preserved / unresolved) for the SAME finding, part, property
      // and state — it replaces that record (whatever theme either carries) instead of sitting beside a contradicting one. An expectation the
      // audit itself measured is never overridden by a judgment.
      const i = targets.findIndex((x) => x.findingId === d.findingId && x.part === d.part && x.property === d.property && x.state === d.state);
      if (i >= 0 && targets[i]!.outcome === 'resolved-target' && targets[i]!.provenance.kind === 'audit-expected') { notes.push(`judgment decision for ${d.findingId} / ${d.property} ignored: the audit measured an expectation for it, which a judgment cannot override`); continue; }
      const t = await validateDecision(deps, finding, entry, q, d, mapped);
      if (i >= 0) targets[i] = t; else targets.push(t);
    }
    for (const n of judgment.notes) notes.push(`judgment: ${n}`);
  }

  const file: ResolutionFile = {
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    sourceRun: input.run,
    generatedAt: now().toISOString(),
    dsRegistryVersion: deps.dsRegistryVersion,
    referenceRegistry: deps.reference ? { version: deps.reference.registry.version, sha256: deps.reference.registry.sha256, approvedProjects: deps.reference.registry.approvedProjects } : null,
    targets,
    noTargetFindings,
    notes,
    ...(kindRecords.length > 0 ? { elementKinds: kindRecords } : {}),
  };
  return { file, residuals };
}

// ── one audit property ──────────────────────────────────────────────────────────────────────

async function resolveOne(a: { deps: ResolveDeps; f: Finding; entry: MappingEntry | undefined; sel: string | null; prop: AuditProperty; cls: Classification; surface: 'light' | 'dark' | 'unknown'; facts: RenderedFacts | null; mismatchComparison: ComparisonMethod | 'unsupported' | undefined }): Promise<Draft> {
  const { deps, f, entry, sel, prop, cls, surface, facts } = a;
  const part = prop.property.includes('.') ? prop.property.split('.', 1)[0]! : 'self';
  const property = prop.property.includes('.') ? prop.property.split('.').slice(1).join('.') : prop.property;
  const base = { property, part, state: ALL_PROPS_DEFAULT.state, theme: ALL_PROPS_DEFAULT.theme, audit: auditObs(prop) };
  const preserve = (reason: UnresolvedReason, why: string, evidence: string[], kind: Provenance['kind'] = 'original-baseline'): Draft => ({ ...base, reason, outcome: 'preserve-existing', target: null, provenance: kind === 'original-baseline' ? baselineProvenance(evidence) : { kind, ds: null, reference: null, evidence }, decisionReason: why });
  const unresolved = (reason: UnresolvedReason, why: string, evidence: string[]): Draft => ({ ...base, reason, outcome: 'unresolved', target: null, provenance: baselineProvenance(evidence), decisionReason: why });
  const dsProv = (kind: Provenance['kind'], over: Partial<NonNullable<Provenance['ds']>>, evidence: string[]): Provenance => ({ kind, ds: { file: prop.source, component: f.component.dsComponent, variant: f.component.dsVariant, token: prop.expectedToken, scope: null, registryVersion: deps.dsRegistryVersion, ...over }, reference: null, evidence });

  // ── the audit measured an expectation
  if (cls.reason === 'audit-expected-present') {
    if (!cls.changeable || prop.expected === null) return preserve('audit-expected-present', cls.rationale, [`audit: ${prop.property} already matches`]);
    // a style edit selects no variant: the finding's MATCHED variant (e.g. a primary Button) must not make every style edit on it look like a request for that variant
    const violation = redesignPolicyViolation({ findingId: f.identity.findingId, selector: sel ?? '', expectedMatches: 1, kind: 'style', property, value: prop.expected, removeValue: null, dsComponent: f.component.dsComponent, dsVariant: null, dsToken: prop.expectedToken, rationale: '', confidence: 1 }, f, entry);
    if (violation) return { ...base, reason: 'policy-conflict', outcome: 'unresolved', target: null, provenance: baselineProvenance([violation]), decisionReason: violation };
    return { ...base, reason: 'audit-expected-present', outcome: 'resolved-target', target: { value: prop.expected, comparison: comparisonFor(property, a.mismatchComparison), token: prop.expectedToken }, provenance: dsProv('audit-expected', {}, [`data.json: ${f.location.section} / ${f.component.productionLabel} / ${prop.property}`]), decisionReason: cls.rationale };
  }

  // ── nothing is derivable: keep what the page has (never changed because a value is absent)
  if (cls.reason === 'no-ds-requirement' || cls.reason === 'inherited-context') {
    return preserve(cls.reason, cls.rationale, [prop.note ?? 'no note'].concat(facts?.found ? [`rendered: ${property} = ${facts.value}${facts.inheritedFromParent ? ' (equal to its parent)' : ''}`] : []));
  }

  // ── the DS states a value but the audit could not compare a keyword (gap: normal/auto): measure the rendered page
  if (cls.reason === 'layout-measurement-required') {
    if (!cls.changeable || !cls.expectedFromNote) return unresolved('layout-measurement-required', cls.rationale, [prop.note ?? '']);
    if (!deps.page || !sel || !facts?.found) return unresolved('capture-capability-gap', `${cls.rationale} No live page is available to measure it.`, [prop.note ?? '']);
    const expectedPx = lengthToPx(cls.expectedFromNote);
    const isGap = /^(?:row-|column-)?gap$/.test(property);
    const evidence = [prop.note ?? '', `DS source: ${prop.source}`];
    if (isGap) {
      const used = await measureUsedGap(deps.page, sel, property.startsWith('column') ? 'column' : 'row');
      if (!used.applicable) return preserve('layout-measurement-required', `${property} has no effect here: the element is display:${used.display ?? 'unknown'}, not a flex/grid container.`, [...evidence, `rendered: display ${used.display}`], 'rendered-measurement');
      if (used.px === null || expectedPx === null) return unresolved('capture-capability-gap', `${property} could not be measured: the container has ${used.children} laid-out child(ren), and the DS value "${cls.expectedFromNote}" ${expectedPx === null ? 'is not a length' : 'needs at least two children to compare'}.`, evidence);
      if (Math.abs(used.px - expectedPx) <= 0.5) return preserve('layout-measurement-required', `the rendered ${property} (${used.px}px) already equals the DS value ${cls.expectedFromNote}.`, [...evidence, `measured used ${property}: ${used.px}px`], 'rendered-measurement');
      return { ...base, reason: 'layout-measurement-required', outcome: 'resolved-target', target: { value: cls.expectedFromNote, comparison: 'rendered-length-px', token: null }, provenance: dsProv('ds-component', {}, [...evidence, `measured used ${property}: ${used.px}px, DS value ${expectedPx}px`]), decisionReason: `${prop.source} states ${property} ${cls.expectedFromNote}; the audit could not compare it with "${prop.actual}", and the rendered spacing is ${used.px}px.` };
    }
    // a dimension/other keyword: only an audit-MEASURED expectation may change it, so report the measurement and keep it
    const rendered = facts.value ?? 'unknown';
    return preserve('layout-measurement-required', `${property} is a protected ${propertyInfo(property).category} property: the DS states "${cls.expectedFromNote}" (${prop.source}) but only an audit-measured expectation may change it; rendered ${rendered}. Reported, not changed.`, [...evidence, `rendered: ${property} = ${rendered}`], 'rendered-measurement');
  }

  // ── a token the unscoped DS base does not define: look in the page's theme scope
  if (cls.reason === 'variant-or-theme-context' && cls.tokenFromNote) {
    if (!deps.dsIndex) return unresolved('capture-capability-gap', `${cls.rationale} The DS token index is not available.`, [prop.note ?? '']);
    const r = resolveTokenInScope(deps.dsIndex, cls.tokenFromNote, surface);
    if (r.outcome !== 'resolved-target' || r.value === null) return unresolved('variant-or-theme-context', r.reason, r.evidence);
    const tokenValue: string = r.value;
    const current = facts?.found ? facts.value : null;
    const comparison = comparisonFor(property);
    const target = deps.page && sel ? await resolveForProperty(deps.page, sel, property, tokenValue).catch(() => tokenValue) : tokenValue;
    if (current !== null && propertyMatchesExpected(comparison === 'rendered-length-px' ? 'length-px' : comparison, current, target).matches) {
      return preserve('variant-or-theme-context', `the rendered ${property} (${current}) already equals ${cls.tokenFromNote} in ${r.scope ?? 'the base scope'} (${target}).`, r.evidence, 'rendered-measurement');
    }
    return { ...base, theme: surface === 'unknown' ? 'inherit' : surface, reason: 'variant-or-theme-context', outcome: 'resolved-target', target: { value: tokenValue, comparison, token: cls.tokenFromNote }, provenance: dsProv('ds-token', { token: cls.tokenFromNote, scope: r.scope, file: r.file }, r.evidence), decisionReason: r.reason };
  }

  // ── state / viewport / unrecognised: a specific gap, never a guess
  return unresolved(cls.reason, cls.rationale, [prop.note ?? 'no note']);
}

// ── a judgment decision, verified ───────────────────────────────────────────────────────────

const PROPERTY_NAME = /^[a-z][a-z-]*$/;

const BORDER_STYLE = /^(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i;
function splitTop(value: string): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The value a verified pattern gives `property`: declared directly, or read out of a `border` / `border-<side>` shorthand it declares. */
export function declaredValue(applied: Record<string, string>, property: string): string | undefined {
  if (applied[property] !== undefined) return applied[property];
  const m = /^border-(?:(top|right|bottom|left)-)?(color|width|style)$/.exec(property);
  if (!m) return undefined;
  // `border-color: X` (one value) is the colour of every side
  if (m[2] === 'color' && applied['border-color'] !== undefined && splitTop(applied['border-color']).length === 1) return applied['border-color'];
  const shorthand = (m[1] ? applied[`border-${m[1]}`] : undefined) ?? applied['border'];
  if (shorthand === undefined) return undefined;
  const parts = splitTop(shorthand);
  const style = parts.find((p) => BORDER_STYLE.test(p));
  const width = parts.find((p) => /^(?:\d|\.\d|thin$|medium$|thick$|0$)/i.test(p) && !BORDER_STYLE.test(p));
  const color = parts.filter((p) => p !== style && p !== width).join(' ') || undefined;
  return m[2] === 'color' ? color : m[2] === 'width' ? width : style;
}

/**
 * The checks a single-colour target adds to `property-equals`: the colour must be VISIBLE on the backdrop it is drawn over (a border by strength, text/icons by
 * contrast), and a hover/focus colour must stay distinguishable from the default state. Not a single static colour (a shorthand, a keyword): none.
 */
function colourChecks(property: string, literal: string, state: StateName, mapped: ColourMapping[]): AcceptanceCheck[] {
  const role = roleForProperty(property);
  const colour = parseCssColour(literal.trim());
  if (!colour || colour.alpha < COLOUR_RULES.transparentAlpha || (role !== 'border' && role !== 'text' && role !== 'icon')) return [];
  const min = role === 'border' ? COLOUR_RULES.borderVisibilityFloor : COLOUR_RULES.textContrastFloor;
  const out: AcceptanceCheck[] = [{ kind: 'colour-visible', property, state, viewport: 'any', comparison: 'color-deltaE', expected: `${role}:${min}` }];
  if (state !== 'default') {
    const required = mapped.map((c) => c.verification.designTime.stateDelta?.required).find((r) => r !== undefined) ?? COLOUR_RULES.stateDistinctMinDeltaE;
    out.push({ kind: 'state-distinct', property, state, viewport: 'any', comparison: 'color-deltaE', expected: String(Math.round(required * 100) / 100) });
  }
  return out;
}

/**
 * The backdrops a colour is judged on: the one measured for its property, else the DS section backgrounds of the surface. Null when neither is known (the
 * surface is unknown and nothing was measured): the colour is then NOT judged here - R5/R8 judge it on the rendered backdrop - and it is not taken for light.
 */
function judgingBackdrops(index: DsTokenIndex, surface: ResidualQuestion['surface'], backdrop: Backdrop): Rgb[] | null {
  const measured = backdrop.color ? parseBackdrop(backdrop.color) : null;
  if (measured !== null) return [measured];
  return surface === 'unknown' ? null : buildDsColourIndex(index).backdrops(surface);
}

/** Why a DS colour is invisible on these backdrops for the role of `property` (a border by strength, text by contrast), or null. */
function invisibleOn(backdrops: Rgb[] | null, property: string, literal: string): string | null {
  const role = roleForProperty(property);
  if (backdrops === null || (role !== 'border' && role !== 'text' && role !== 'icon')) return null;
  for (const span of extractColours(literal)) {
    if (!span.rgba || span.rgba.alpha < COLOUR_RULES.transparentAlpha) continue;
    const a = assessColour({ role, colour: span.rgba, backdrops });
    if (!a.ok) return `${property} ${span.text} ${a.reason}`;
  }
  return null;
}

async function validateDecision(deps: ResolveDeps, f: Finding, entry: MappingEntry | undefined, q: ResidualQuestion, d: ResolutionDecision, mapped: boolean): Promise<ResolvedTarget> {
  const id = f.identity.findingId;
  const state = d.state as StateName;
  // The surface is where the page is RENDERED, not an alternate theme: only a RESOLVED target (a value taken from a surface scope of the DS) is scoped to it. A
  // preserve / unresolved outcome is `inherit` - the fidelity evaluator verifies a preserve only for `inherit`, so scoping it to the measured surface would leave
  // every judged preserve on a dark page permanently unverified. The surface stays in the provenance text.
  const surfaceNote = q.surface === 'unknown' ? 'the surface could not be measured' : `measured on a ${q.surface} surface`;
  const mk = (over: Partial<Draft>): ResolvedTarget => {
    const draft: Draft = {
      property: d.property, part: d.part, state, theme: 'inherit',
      audit: { status: 'NOT-LISTED', actual: q.properties.find((p) => p.property === d.property)?.actual ?? null, expected: null, expectedToken: null, note: null, source: null },
      reason: d.unresolvedReason ?? 'capture-capability-gap', outcome: 'unresolved', target: null, provenance: baselineProvenance(['judgment', surfaceNote]), decisionReason: d.reason, ...over,
    };
    return finalize(id, { ...draft, theme: draft.outcome === 'resolved-target' && q.surface !== 'unknown' ? q.surface : 'inherit' }, mapped);
  };
  const reject = (why: string): ResolvedTarget => mk({ outcome: 'unresolved', reason: 'policy-conflict', decisionReason: `judgment claim not accepted: ${why}` });

  if (!PROPERTY_NAME.test(d.property)) return reject(`"${d.property}" is not a CSS property name`);
  if (d.outcome === 'preserve-existing') return mk({ outcome: 'preserve-existing', reason: d.unresolvedReason ?? 'no-ds-requirement', provenance: baselineProvenance(['judgment: preserve', surfaceNote]), decisionReason: d.reason });
  if (d.outcome === 'unresolved') return mk({ outcome: 'unresolved', reason: d.unresolvedReason ?? 'capture-capability-gap', decisionReason: d.reason });

  // resolved-target: composition is never changed from a judgment
  if (propertyInfo(d.property).layoutProtected) return reject(`${d.property} is a protected composition/dimension property; only an audit-measured expectation may change it`);
  if (d.value === null || d.value.trim() === '') return reject('a resolved target needs a value');
  if (!deps.dsIndex) return reject('the DS token index is not available, so no token claim can be verified');
  const surface = q.surface;
  // the backdrop of THIS decision's property, measured now: nothing the audit's other properties did can change it
  const backdrop = await backdropFor(deps, q.element.selector, d.property);
  const judging = judgingBackdrops(deps.dsIndex, surface, backdrop);

  if (d.source === 'approved-project-pattern') {
    if (!d.reference) return reject('source is approved-project-pattern but no reference (project, pattern) was named');
    if (!deps.reference) return reject('no approved-reference registry is available');
    // the kinds are those of the finding's element, so a reference treatment can only be planned for that element — not its label or a descendant, whose
    // kind was never established (and whose property would otherwise be authorized for the element itself)
    if (d.part !== 'self') return reject(`reference treatments apply to the finding element; part "${d.part}" cannot be planned from one`);
    // selection == verification: only a candidate that was OFFERED for this finding (the ones the judge saw) can be claimed
    if (!q.candidatePatterns.some((c) => c.project === d.reference!.project && c.pattern === d.reference!.patternId)) {
      return reject(`${d.reference.project} / ${d.reference.patternId} is not among the candidates offered for this finding (${q.candidatePatterns.map((c) => c.pattern).join(', ') || 'none'}); only an offered candidate can be claimed`);
    }
    const query = patternQuery({ property: d.property, purpose: purposeOf(q.productionType, q.reviewReason, q.elementKinds), surface, inference: q.elementKinds, state, backdrop });
    const v = await deps.reference.verify({ project: d.reference.project, pattern: d.reference.patternId, query });
    if (!v.ok || !v.provenance) return reject(`the reference ${d.reference.project} / ${d.reference.patternId} was not accepted: ${v.reasons.join('; ') || 'verification failed'}`);
    // a reference colour reaches a target only as a DS token chosen by the colour mapper — whatever the hook says, an unmapped colour is refused here
    const colours = v.provenance.colours ?? [];
    const gaps = colours.filter((c) => c.outcome === 'unmapped' || (c.dsToken === null && c.keyword === null));
    if (gaps.length > 0) return reject(`the reference colour has no DS mapping: ${gaps.map(summariseMapping).join('; ')}`);
    const declared = declaredValue(v.applied, d.property);
    if (declared === undefined) return reject(`the verified pattern does not declare ${d.property}`);
    const sub = substituteTokens(declared, deps.dsIndex, surface);
    // a value that is not fully DS tokens is taken ONLY as a plain length/keyword of a length property (flagged as not DS guidance), by ALLOWLIST: the whole value
    // must be a strict length grammar, and a var() that failed to resolve is never kept as text. Anything else - a colour in any property, named, system or
    // functional, escaped or in a var() fallback, a shadow, a filter, a second declaration, a property that is not a length - is refused: "proposed local variant"
    // is not a way to keep it
    if (!sub.ok && !(LENGTH_LITERAL_PROPERTY.test(d.property) && isPlainLengthLiteral(d.property, declared))) return reject(`the reference value "${declared}" has no DS mapping: ${sub.reason}`);
    const literal = sub.ok ? sub.literal : declared;
    // the DS tokens the pattern keeps by NAME were never seen by the colour mapper: they are judged on the real backdrop of this property like a ds-token judgment
    const unseen = sub.ok ? invisibleOn(judging, d.property, sub.literal) : null;
    if (unseen) return reject(unseen);
    const mine = colours.filter((c) => suppliesProperty(c.property, d.property) && c.state === state);
    const grounded = sub.ok;
    const classification = grounded && v.classification === 'approved-project-pattern' && mine.every((c) => c.outcome === 'exact') ? 'approved-project-pattern' : 'proposed-local-variant';
    const first = mine.find((c) => c.dsToken !== null);
    const token = sub.ok ? (sub.tokens[0] ?? null) : null;
    const checks = colourChecks(d.property, literal, state, mine);
    const unjudged = judging === null && checks.length > 0 ? '; the surface is unknown and nothing could be measured, so its visibility is judged only on the rendered page (R5/R8)' : '';
    const why = classification === 'approved-project-pattern' ? 'every value is DS-grounded' : mine.some((c) => c.outcome === 'nearest') ? 'recorded as a proposed local variant: a colour was mapped to the nearest suitable DS token, not an identical one' : 'recorded as a proposed local variant: not every value is a DS token';
    return mk({
      outcome: 'resolved-target', reason: 'missing-ds-treatment', target: { value: literal, comparison: comparisonFor(d.property), token },
      provenance: { kind: 'approved-project-pattern', ds: sub.ok ? { file: first?.dsFile ?? null, component: null, variant: null, token, scope: first?.dsScope ?? null, registryVersion: deps.dsRegistryVersion } : null, reference: { ...v.provenance, colours: mine, classification }, evidence: ['judgment', ...mine.map(summariseMapping), ...(sub.ok ? sub.evidence : [sub.reason])] },
      decisionReason: `${d.reason} (adapted from the approved project ${d.reference.project}, pattern ${d.reference.patternId}${v.provenance.elementKinds?.matched.length ? `, which fits this ${v.provenance.elementKinds.matched.join('/')}` : ''}; ${mine.length ? `${mine.map(summariseMapping).join('; ')}; ` : ''}${why}${unjudged})`,
      extraAcceptance: checks,
    });
  }

  if (d.source === 'original-baseline') return mk({ outcome: 'preserve-existing', reason: d.unresolvedReason ?? 'no-ds-requirement', provenance: baselineProvenance(['judgment: original baseline', surfaceNote]), decisionReason: d.reason });

  const sub = substituteTokens(d.value, deps.dsIndex, surface);
  if (!sub.ok) return reject(sub.reason);
  if (sub.tokens.length === 0 && d.source === 'ds-token') return reject('source is ds-token but the value names no DS token');
  // a judgment is built from DS tokens: with none, it is only keywords / 0 / a hairline. Those are design values for some colours, shapes, shadows and type resets
  // (`transparent`, `none`, `0`: `ZERO_TOKEN_ALLOWED`), but `opacity: 0`, `pointer-events: none`, `all: unset` - and a `font-size: 0`, `line-height: 0` or transparent text colour
  // that hides the text - change behaviour, composition or content with nothing from the DS behind them (R3 would apply them)
  if (sub.tokens.length === 0) {
    const refusal = zeroTokenRefusal(d.property, d.value);
    if (refusal) return reject(refusal);
  }
  if (d.source === 'ds-token' && d.dsToken && !sub.tokens.includes(d.dsToken)) return reject(`the value does not use the claimed token ${d.dsToken}`);
  // a DS token is not exempt from being seen: a hairline that disappears on the real backdrop is refused like an invisible reference colour
  const unseen = invisibleOn(judging, d.property, sub.literal);
  if (unseen) return reject(unseen);
  const kind: Provenance['kind'] = d.source === 'ds-token' ? 'ds-token' : 'proposed-local-variant';
  const resolvedScope = sub.tokens[0] ? (resolveTokenInScope(deps.dsIndex, sub.tokens[0], surface).scope ?? null) : null;
  return mk({
    outcome: 'resolved-target', reason: d.unresolvedReason ?? 'missing-ds-treatment', target: { value: sub.literal, comparison: comparisonFor(d.property), token: sub.tokens[0] ?? null },
    provenance: { kind, ds: { file: null, component: f.component.dsComponent, variant: f.component.dsVariant, token: sub.tokens[0] ?? null, scope: resolvedScope, registryVersion: deps.dsRegistryVersion }, reference: null, evidence: ['judgment', ...sub.evidence] },
    decisionReason: kind === 'proposed-local-variant' ? `${d.reason} (a proposed local variant composed of DS tokens ${sub.tokens.join(', ') || '—'}; not an official DS component)` : d.reason,
    extraAcceptance: colourChecks(d.property, sub.literal, state, []),
  });
}

/**
 * Measures one target on a live page, in its state: used by R5 (live DOM). A colour target is met only if the rendered value equals the target AND the colour is
 * visible on the backdrop it is drawn over (and, for a hover/focus colour, distinguishable from the default state). `unverified`: the value matches but the
 * backdrop could not be measured — never a pass. The outcome is written into the target's reference provenance.
 */
export async function measureTarget(page: Page, selector: string, t: ResolvedTarget): Promise<{ actual: string | null; matches: boolean; note: string; unverified?: boolean }> {
  if (!t.target) return { actual: null, matches: false, note: 'not a resolved target' };
  if (t.target.comparison === 'rendered-length-px' && /^(?:row-|column-)?gap$/.test(t.property)) {
    const used = await measureUsedGap(page, selector, t.property.startsWith('column') ? 'column' : 'row');
    const exp = lengthToPx(t.target.value);
    if (!used.applicable) return { actual: 'not applicable (not a flex/grid container)', matches: false, note: 'gap has no effect on this element' };
    if (used.px === null || exp === null) return { actual: null, matches: false, note: 'the spacing could not be measured' };
    return { actual: `${used.px}px`, matches: Math.abs(used.px - exp) <= 0.5, note: `${used.px}px vs expected ${exp}px` };
  }
  const wanted = t.acceptance.filter((a) => (a.kind === 'colour-visible' || a.kind === 'state-distinct') && a.property === t.property && a.state === t.state);
  // the default colour belongs to the element at rest, so it is read BEFORE the state is applied; the colour and its backdrop are both read IN the state
  const defaultColour = t.state !== 'default' && wanted.some((a) => a.kind === 'state-distinct') ? await measureComputed(page, selector, t.property, 'default') : null;
  // a state is read once it has SETTLED, colour and backdrop together; one that never settles is unverified (the value may match mid-transition and not after it)
  const inState = wanted.length > 0 || t.state !== 'default' ? await measureInState(page, selector, t.property, t.state) : null;
  const actual = inState ? inState.value : await measureComputed(page, selector, t.property, t.state);
  if (actual === null) return { actual: null, matches: false, note: 'the element or state could not be measured' };
  if (inState && !inState.settled) return { actual: null, matches: false, unverified: true, note: `the ${t.state} state did not settle, so its ${t.property} is not judged: ${inState.why ?? 'it kept changing'}` };
  const expected = await resolveForProperty(page, selector, t.property, t.target.value).catch(() => t.target!.value);
  const method = t.target.comparison === 'rendered-length-px' ? 'length-px' : t.target.comparison;
  const cmp = propertyMatchesExpected(method, actual, expected);
  if (!cmp.matches || wanted.length === 0) return { actual, matches: cmp.matches, note: cmp.note };
  const judged = judgeRenderedColour(t, { by: 'R5', colour: actual, defaultColour, backdrop: inState?.backdrop ?? { rgb: null, why: 'the element or state could not be measured' } });
  return judged.status === 'passed' || judged.status === 'not-required'
    ? { actual, matches: true, note: `${cmp.note}; ${judged.note}` }
    : { actual, matches: false, ...(judged.status === 'unverified' ? { unverified: true } : {}), note: `the value matches (${cmp.note}) but ${judged.note}` };
}
