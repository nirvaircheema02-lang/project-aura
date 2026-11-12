import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  buildDsColourIndex,
  colourLikeTokens,
  extractColours,
  mapReferenceColour,
  mapReferenceShadow,
  parseBackdrop,
  parseCssColour,
  roleForProperty,
  stateDistinctness,
  subRolesForKinds,
  suppliesProperty,
  summariseMapping,
  unmappedColour,
  type ColourContext,
  type ColourSpan,
  type DsColourIndex,
  type Rgb,
} from '../resolution/ds-colours.ts';
import { resolveTokenInScope, type DsTokenIndex } from '../resolution/ds-evidence.ts';
import type { ColourMapping, ReferenceProvenance, StateName } from '../resolution/schema.ts';
import { kindCompatibility, type SemanticKind } from './element-kind.ts';
import { isSafeRelative, rejectedResolution, resolveProject } from './registry.ts';
import type {
  ApprovedPattern,
  ApprovedRegistry,
  DsColourSource,
  DsTokenDef,
  DsTokenLookup,
  PatternCheck,
  PatternQuery,
  PatternVerification,
  ProjectResolution,
} from './types.ts';

/**
 * Approved-project patterns: reading the declarations a pattern points at, finding candidate patterns for a
 * need, and verifying one before it may be adapted.
 *
 * A pattern is "approved" because its project is on the allowlist, not because every value in it is official
 * DS guidance. `verifyPattern` therefore separates the two: values that resolve to DS tokens are kept as
 * `var(--token)`; a COLOUR is read (alpha included) and mapped to the exact or the nearest suitable DS token for its
 * role and surface (`resolution/ds-colours.ts`) — and a colour with no suitable token refuses the pattern, it is never
 * applied raw; a length that exists only in the reference project is inlined and flagged. The result is classified an
 * approved pattern only when every colour is an EXACT DS equivalent and nothing is hardcoded, otherwise a proposed local
 * variant — never a DS component.
 */

// ── CSS scanning ────────────────────────────────────────────────────────────────────────────────
// A small scanner, not a CSS engine: no cascade, no specificity, no nested-rule (`&`) resolution. It never throws;
// malformed input yields fewer rules, not an exception.

interface CssRule {
  selectors: string[];
  decls: Array<[string, string]>;
  /** The conditional at-rules this rule sits in, outermost first (`@media (max-width: 600px)`). `@layer` is no condition: it only orders the cascade. */
  conds: string[];
}

/** Blocks whose rules are read. `layer` always applies; the others only when their condition holds for the need's surface and viewport (see `conditionHolds`). */
const AT_RULES_READ: ReadonlySet<string> = new Set(['media', 'layer', 'supports', 'container', 'scope', 'document']);
/** Deeper at-rule nesting is skipped, so hostile input cannot exhaust the stack. */
const MAX_AT_RULE_DEPTH = 32;

function isWs(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
}

/** Index just past the string that opens at `i`; an unterminated string ends at the line break. */
function skipString(src: string, i: number): number {
  const quote = src.charAt(i);
  let j = i + 1;
  while (j < src.length) {
    const c = src.charAt(j);
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === '\n') return j;
    j++;
  }
  return src.length;
}

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === '"' || c === "'") {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (c === '/' && src.charAt(i + 1) === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Reads from `i` up to the first `{`, `;` or `}` that is outside strings, parentheses and brackets. */
function readUntil(src: string, i: number): { text: string; end: number; term: '{' | ';' | '}' | '' } {
  let paren = 0;
  let bracket = 0;
  let j = i;
  while (j < src.length) {
    const c = src.charAt(j);
    if (c === '"' || c === "'") {
      j = skipString(src, j);
      continue;
    }
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') bracket++;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (paren === 0 && bracket === 0 && (c === '{' || c === ';' || c === '}')) return { text: src.slice(i, j), end: j, term: c };
    j++;
  }
  return { text: src.slice(i), end: src.length, term: '' };
}

/** `i` is at a `{`; returns the index just past its matching `}` (or the end of input). */
function skipBlock(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src.charAt(j);
    if (c === '"' || c === "'") {
      j = skipString(src, j);
      continue;
    }
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth <= 0) return j + 1;
    }
    j++;
  }
  return src.length;
}

/** Collapses whitespace and gives the combinators `>` `+` `~` single surrounding spaces (outside parentheses/brackets). */
function normalizeSelector(selector: string): string {
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < selector.length) {
    const c = selector.charAt(i);
    if (c === '"' || c === "'") {
      const end = skipString(selector, i);
      out += selector.slice(i, end);
      i = end;
      continue;
    }
    if (c === '\\') {
      out += selector.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (isWs(c)) {
      if (out.length > 0 && !out.endsWith(' ')) out += ' ';
      i++;
      continue;
    }
    if (depth === 0 && (c === '>' || c === '+' || c === '~')) {
      out = `${out.trimEnd()} ${c} `;
      i++;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    out += c;
    i++;
  }
  return out.trim();
}

function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < prelude.length) {
    const c = prelude.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(prelude, i);
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(prelude.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(prelude.slice(start));
  return parts.map(normalizeSelector).filter((s) => s.length > 0);
}

/** Property names are case-insensitive except custom properties. */
function normalizeProperty(prop: string): string {
  const p = prop.trim();
  return p.startsWith('--') ? p : p.toLowerCase();
}

function normalizeValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const PROPERTY_NAME = /^(?:--[^\s:;{}]+|-?[A-Za-z][\w-]*)$/;

function parseDeclarationBlock(src: string, from: number): { decls: Array<[string, string]>; next: number } {
  const decls: Array<[string, string]> = [];
  let i = from;
  while (i < src.length) {
    while (i < src.length && (isWs(src.charAt(i)) || src.charAt(i) === ';')) i++;
    if (i >= src.length) break;
    if (src.charAt(i) === '}') return { decls, next: i + 1 };
    const { text, end, term } = readUntil(src, i);
    if (term === '{') {
      // a nested rule: its selectors are not resolved here, so it contributes nothing
      i = skipBlock(src, end);
      continue;
    }
    const colon = text.indexOf(':');
    if (colon > 0) {
      const prop = text.slice(0, colon).trim();
      const value = normalizeValue(text.slice(colon + 1));
      if (PROPERTY_NAME.test(prop) && value.length > 0) decls.push([normalizeProperty(prop), value]);
    }
    if (term === '') {
      i = src.length;
      break;
    }
    i = term === ';' ? end + 1 : end;
  }
  return { decls, next: i };
}

function parseRuleList(src: string, from: number, out: CssRule[], nested: boolean, depth: number, conds: readonly string[]): number {
  let i = from;
  while (i < src.length) {
    while (i < src.length && (isWs(src.charAt(i)) || src.charAt(i) === ';')) i++;
    if (i >= src.length) break;
    if (src.charAt(i) === '}') {
      i++;
      if (nested) return i;
      continue;
    }
    const { text, end, term } = readUntil(src, i);
    if (term === '') {
      i = src.length;
      break;
    }
    if (term === ';') {
      i = end + 1; // `@import …;`, `@layer a, b;`, or junk
      continue;
    }
    if (term === '}') {
      i = end; // a prelude with no block; the `}` is handled at the top of the loop
      continue;
    }
    const prelude = text.trim();
    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      // @media / @layer / @supports are read (each rule remembers the conditions it sits in); @keyframes, @font-face, … are not selector rules at all
      i = AT_RULES_READ.has(name) && depth < MAX_AT_RULE_DEPTH ? parseRuleList(src, end + 1, out, true, depth + 1, name === 'layer' ? conds : [...conds, normalizeValue(prelude)]) : skipBlock(src, end);
      continue;
    }
    const { decls, next } = parseDeclarationBlock(src, end + 1);
    const selectors = splitSelectorList(prelude);
    if (selectors.length > 0) out.push({ selectors, decls, conds: [...conds] });
    i = next;
  }
  return i;
}

function parseCss(content: string): CssRule[] {
  const out: CssRule[] = [];
  parseRuleList(stripComments(content), 0, out, false, 0, []);
  return out;
}

// ── conditions ──────────────────────────────────────────────────────────────────────────────────

/** What a need is read FOR: a rule inside a conditional block applies only when the block's condition holds for this surface and viewport. */
export interface ReadEnv {
  surface: 'light' | 'dark' | null;
  /** The viewport width the need is for; null when it names no viewport. */
  viewportWidth: number | null;
}

/** Nothing conditional applies: only the unconditional rules. The "base" a registry declaration is checked against. */
export const BASE_ENV: ReadEnv = { surface: null, viewportWidth: null };
/** The widths the fidelity capture uses for desktop and mobile (ARCHITECTURE 8d.3). */
const VIEWPORT_WIDTH = { desktop: 1440, mobile: 390 } as const;

const readEnvFor = (query: Pick<PatternQuery, 'surface' | 'viewport'>): ReadEnv => ({ surface: query.surface, viewportWidth: query.viewport === 'any' ? null : VIEWPORT_WIDTH[query.viewport] });

function cssPx(n: string, unit: string): number {
  return Number(n) * (unit === 'px' ? 1 : 16);
}

function mediaTermHolds(term: string, env: ReadEnv): boolean {
  const t = term.trim();
  if (t === 'screen' || t === 'all') return true;
  const feature = /^\(([\s\S]*)\)$/.exec(t)?.[1]?.trim();
  if (feature === undefined) return false; // print, speech, `not`, an unknown media type
  const scheme = /^prefers-color-scheme\s*:\s*(dark|light)$/.exec(feature);
  if (scheme) return env.surface === scheme[1];
  const classic = /^(min-|max-)?width\s*:\s*(\d*\.?\d+)(px|em|rem)$/.exec(feature);
  const range = /^width\s*(>=|<=|>|<|=)\s*(\d*\.?\d+)(px|em|rem)$/.exec(feature);
  if (!classic && !range) return false; // a feature this reader cannot evaluate is not satisfied: the base rule is read instead
  if (env.viewportWidth === null) return false;
  const w = env.viewportWidth;
  if (classic) {
    const px = cssPx(classic[2]!, classic[3]!);
    return classic[1] === 'min-' ? w >= px : classic[1] === 'max-' ? w <= px : w === px;
  }
  const px = cssPx(range![2]!, range![3]!);
  const op = range![1];
  return op === '>=' ? w >= px : op === '<=' ? w <= px : op === '>' ? w > px : op === '<' ? w < px : w === px;
}

/**
 * Does one enclosing conditional at-rule hold for `env`? Only `@media` can: `(prefers-color-scheme: dark|light)` against the surface, width queries against the
 * viewport, and the `screen`/`all` types. `@supports`, `@container`, `@scope`, every other media feature, `not` and a query for a viewport the need does not
 * name are NOT satisfied - the base rule is read instead and the property is reported as conditioned, never silently taken as the default.
 */
function conditionHolds(prelude: string, env: ReadEnv): boolean {
  const m = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude.trim());
  if (!m || m[1]!.toLowerCase() !== 'media') return false;
  const query = m[2]!.trim().toLowerCase();
  if (query === '') return true;
  return query.split(',').some((q) => {
    const text = q.trim().replace(/^only\s+/, '');
    return text !== '' && !/^not\b/.test(text) && text.split(/\s+and\s+/).every((term) => mediaTermHolds(term, env));
  });
}

/** A property that some conditional block of the matched rule sets, and whether that block applied for this need. */
export interface ConditionedProperty {
  property: string;
  condition: string;
  applied: boolean;
}

/** One declaration of a matched rule that is in force for the need, in cascade order (`seq`): what a LATER or `!important` one of a related property can override. */
interface DeclaredProperty {
  property: string;
  important: boolean;
  seq: number;
  unconditional: boolean;
}

interface RuleRead {
  decls: Record<string, string>;
  conditioned: ConditionedProperty[];
  declared: DeclaredProperty[];
}

/** The declarations of every rule matching `locator` whose conditions hold for `env`, the last one winning per property; null when no rule matches at all. */
function readRules(rules: CssRule[], kind: 'css-rule' | 'css-tokens', locator: string, env: ReadEnv): RuleRead | null {
  const wanted = normalizeSelector(locator);
  let matched = false;
  const decls: Record<string, string> = {};
  const seen = new Map<string, ConditionedProperty>();
  const declared: DeclaredProperty[] = [];
  for (const rule of rules) {
    if (!rule.selectors.includes(wanted)) continue;
    matched = true;
    const holds = rule.conds.every((c) => conditionHolds(c, env));
    for (const [prop, value] of rule.decls) {
      if (kind === 'css-tokens' && !prop.startsWith('--')) continue;
      if (rule.conds.length > 0) seen.set(`${prop}|${rule.conds.join(' > ')}`, { property: prop, condition: rule.conds.join(' > '), applied: holds });
      if (holds) {
        decls[prop] = value; // the last matching rule wins, per property
        declared.push({ property: prop, important: /!\s*important\s*$/i.test(value), seq: declared.length, unconditional: rule.conds.length === 0 });
      }
    }
  }
  return matched ? { decls, conditioned: [...seen.values()], declared } : null;
}

/**
 * The declarations of every rule whose selector list contains `locator`, the last rule winning per property. Rules inside `@media`/`@supports`/`@container`
 * count only when their condition holds for `env` (default: none does, so only the unconditional rules are read); `@layer` always counts.
 * `css-tokens` keeps only custom properties (use locator `:root`). Null when no rule matches.
 */
export function readDeclarations(fileContent: string, kind: 'css-rule' | 'css-tokens', locator: string, env: ReadEnv = BASE_ENV): Record<string, string> | null {
  return readRules(parseCss(fileContent), kind, locator, env)?.decls ?? null;
}

// ── var() grounding ─────────────────────────────────────────────────────────────────────────────

interface VarRef {
  start: number;
  end: number;
  name: string;
  fallback: string | null;
}

/** The outermost `var(--x[, fallback])` expressions of a value. */
function findVarRefs(value: string): VarRef[] {
  const refs: VarRef[] = [];
  const lower = value.toLowerCase();
  let i = 0;
  while (i < value.length) {
    const at = lower.indexOf('var(', i);
    if (at === -1) break;
    if (at > 0 && /[\w-]/.test(value.charAt(at - 1))) {
      i = at + 4;
      continue;
    }
    let depth = 1;
    let j = at + 4;
    let comma = -1;
    while (j < value.length && depth > 0) {
      const c = value.charAt(j);
      if (c === '"' || c === "'") {
        j = skipString(value, j);
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 1 && comma === -1) comma = j;
      j++;
    }
    if (depth > 0) break; // unbalanced: the rest is plain text
    const inner = value.slice(at + 4, j - 1);
    const name = (comma === -1 ? inner : value.slice(at + 4, comma)).trim();
    const fallback = comma === -1 ? null : value.slice(comma + 1, j - 1).trim();
    if (name.startsWith('--')) refs.push({ start: at, end: j, name, fallback: fallback === '' ? null : fallback });
    i = j;
  }
  return refs;
}

const LENGTH = /(?<![\w#.-])[-+]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|vh|vw|vmin|vmax|ch|ex|pt|pc|cm|mm|in)\b/gi;
/** Colour-like tokens the rules permit as keywords: they stand for no fixed colour, so they are not "hardcoded". */
const PERMITTED_COLOUR_KEYWORDS: ReadonlySet<string> = new Set(['transparent', 'currentcolor']);

/** True when text outside var() still carries a literal colour (hex, function, named or system colour: in ANY property) or length. `0` and a 1px border/outline hairline width are not magic numbers. */
function hasLiteralColourOrLength(prop: string, textOutsideVar: string): boolean {
  const text = textOutsideVar.replace(/"[^"]*"|'[^']*'/g, ' ').replace(/url\([^)]*\)/gi, ' ');
  if (colourLikeTokens(text).some((t) => !PERMITTED_COLOUR_KEYWORDS.has(t.toLowerCase()))) return true;
  const hairlineProperty = prop.startsWith('border') || prop.startsWith('outline');
  for (const m of text.matchAll(LENGTH)) {
    const literal = m[0];
    if (Number.parseFloat(literal) === 0) continue;
    if (hairlineProperty && literal === '1px') continue;
    return true;
  }
  return false;
}

interface GroundingContext {
  ds: DsTokenLookup;
  /** Custom properties the pattern's own source file defines on `:root`, as they read for the need's surface and viewport. */
  projectTokens: Record<string, string>;
  tokens: Map<string, { existsInDs: boolean; dsScope: string | null }>;
  unresolved: string[];
  /** A DS token's value on the need's surface (null: it has none there); null when the DS source carries no resolved values (a lookup-only double). */
  resolveDs: ((token: string) => string | null) | null;
  /** The project tokens the grounded declarations went through (their conditional overrides matter). */
  usedProjectTokens: Set<string>;
}

const MAX_TOKEN_DEPTH = 8;

function noteUnresolved(ctx: GroundingContext, note: string): void {
  if (!ctx.unresolved.includes(note)) ctx.unresolved.push(note);
}

function dsScopeOf(defs: DsTokenDef[]): string | null {
  if (defs.length === 0 || defs.some((d) => d.scope === null)) return null;
  return defs[0]?.scope ?? null;
}

/** A project token that was inlined (its definition read instead of the DS token of that name, or a var() fallback). */
interface Region {
  token: string;
  parts: Part[];
  /** The DS defines a token of this name too. */
  inDs: boolean;
  /** The text came from a var() fallback, not from a definition. */
  fallback: boolean;
}
type Part = string | Region;

const isRegion = (p: Part): p is Region => typeof p !== 'string';
const flatten = (parts: readonly Part[]): string => parts.map((p) => (isRegion(p) ? flatten(p.parts) : p)).join('');
const regionNames = (parts: readonly Part[]): string[] => parts.flatMap((p) => (isRegion(p) ? [p.token, ...regionNames(p.parts)] : []));

/** `text` with every outermost DS `var(--x)` replaced by its value on this surface; null when one has no value there. */
function inlineDsVars(text: string, ctx: GroundingContext): string | null {
  let out = '';
  let pos = 0;
  for (const ref of findVarRefs(text)) {
    out += text.slice(pos, ref.start);
    pos = ref.end;
    const value = ctx.resolveDs?.(ref.name) ?? null;
    if (value === null) return null;
    out += value;
  }
  return out + text.slice(pos);
}

function inlineDs(parts: readonly Part[], ctx: GroundingContext): Part[] | null {
  const out: Part[] = [];
  for (const p of parts) {
    if (isRegion(p)) {
      const inner = inlineDs(p.parts, ctx);
      if (inner === null) return null;
      out.push({ ...p, parts: inner });
    } else {
      const text = inlineDsVars(p, ctx);
      if (text === null) return null;
      out.push(text);
    }
  }
  return out;
}

/**
 * Reads a declared value into text and inlined project tokens. A token the DS defines and the project does not stays `var(--x)` (its fallback dropped: it can
 * never apply where the token resolves, and where the DS has no value for it on this surface the pattern is refused instead). A token the project defines is
 * inlined: its DEFINITION is what the reference looks like. When the DS defines the same name, the DS token is kept by name only if the definition holds no colour
 * (a length, a keyword); a colour is judged by VALUE - read through any DS tokens the definition aliases - because a DS token of the same name can be a different colour.
 */
function groundParts(prop: string, value: string, ctx: GroundingContext, trail: readonly string[]): Part[] {
  const parts: Part[] = [];
  let pos = 0;
  for (const ref of findVarRefs(value)) {
    if (ref.start > pos) parts.push(value.slice(pos, ref.start));
    pos = ref.end;
    const original = value.slice(ref.start, ref.end);
    const defs = ctx.ds.lookup(ref.name);
    if (!ctx.tokens.has(ref.name)) ctx.tokens.set(ref.name, { existsInDs: defs.length > 0, dsScope: dsScopeOf(defs) });
    const own = ctx.projectTokens[ref.name];
    if (own === undefined) {
      if (defs.length > 0) {
        if (ctx.resolveDs !== null && ctx.resolveDs(ref.name) === null) noteUnresolved(ctx, `${ref.name} (the DS defines it, but not for this surface, so it has no value here; its fallback never applies and is not used)`);
        parts.push(`var(${ref.name})`);
      } else if (ref.fallback !== null) {
        parts.push({ token: ref.name, parts: groundParts(prop, ref.fallback, ctx, trail), inDs: false, fallback: true });
      } else {
        noteUnresolved(ctx, `${ref.name} (defined neither in the DS nor in the project, and has no fallback)`);
        parts.push(original);
      }
      continue;
    }
    ctx.usedProjectTokens.add(ref.name);
    if (trail.includes(ref.name) || trail.length >= MAX_TOKEN_DEPTH) {
      noteUnresolved(ctx, `${ref.name} (cyclic or too deeply nested in the project's tokens)`);
      parts.push(original);
      continue;
    }
    if (defs.length === 0) {
      parts.push({ token: ref.name, parts: groundParts(prop, own, ctx, [...trail, ref.name]), inDs: false, fallback: false });
      continue;
    }
    // both define it: read the project's definition on the side, and inline it only when it holds a colour
    const scratch: GroundingContext = { ...ctx, tokens: new Map(ctx.tokens), unresolved: [...ctx.unresolved] };
    const sub = groundParts(prop, own, scratch, [...trail, ref.name]);
    // the colour the reference really renders: its definition read through the DS tokens it points at (an alias of a DS token is a colour, not a name)
    const read = ctx.resolveDs === null ? sub : inlineDs(sub, ctx);
    if (read === null) {
      noteUnresolved(ctx, `${ref.name} (the project defines it through DS tokens that have no value for this surface, so it cannot be compared with the DS token of that name)`);
      parts.push(original);
      continue;
    }
    if (extractColours(flatten(read)).length === 0) {
      parts.push(original);
      continue;
    }
    for (const [k, v] of scratch.tokens) ctx.tokens.set(k, v);
    for (const u of scratch.unresolved) noteUnresolved(ctx, u);
    parts.push({ token: ref.name, parts: read, inDs: true, fallback: false });
  }
  if (pos < value.length) parts.push(value.slice(pos));
  return parts;
}

function textOutsideVar(value: string): string {
  let out = '';
  let pos = 0;
  for (const ref of findVarRefs(value)) {
    out += `${value.slice(pos, ref.start)} `;
    pos = ref.end;
  }
  return out + value.slice(pos);
}

// ── colours ─────────────────────────────────────────────────────────────────────────────────────

interface ColourEnv {
  surface: 'light' | 'dark';
  state: StateName;
  hints: string[];
  backdrops: Rgb[] | undefined;
  backdropSource: 'measured' | 'ds-section-tokens';
  textColour: Rgb | null;
  /** Null when the DS source carries no resolved values: every colour then fails closed. */
  index: DsColourIndex | null;
}

interface RenderedDeclaration {
  text: string;
  mappings: ColourMapping[];
  unmapped: ColourMapping[];
  /** Project-only tokens (and var() fallbacks) that were inlined, and whether their final text is free of literal colours/lengths. */
  inlined: Array<{ token: string; names: string[]; fallback: boolean; clean: boolean }>;
}

/**
 * Turns one grounded declaration into its applied text: every colour is mapped (exact, then nearest suitable) and spliced back as `var(--token)` or a keyword.
 * A `box-shadow` is mapped as a whole. A colour with no suitable token stays unmapped in `unmapped`; the caller refuses or drops the declaration — the raw
 * colour is never part of `text` a caller may use.
 */
function renderDeclaration(key: string, original: string, parts: Part[], env: ColourEnv): RenderedDeclaration {
  const mappings: ColourMapping[] = [];
  const inlined: RenderedDeclaration['inlined'] = [];
  const role = roleForProperty(key);
  const ctx: ColourContext = {
    property: key, role, subRoles: env.hints, state: env.state, surface: env.surface, backdropSource: env.backdropSource, textColour: env.textColour,
    ...(env.backdrops ? { backdrops: env.backdrops } : {}),
  };
  const done = (text: string): RenderedDeclaration => ({ text, mappings, unmapped: mappings.filter((m) => m.outcome === 'unmapped'), inlined });
  const note = (region: Region, rendered: string): void => {
    if (!region.inDs) inlined.push({ token: region.token, names: [region.token, ...regionNames(region.parts)], fallback: region.fallback, clean: !hasLiteralColourOrLength(key, textOutsideVar(rendered)) });
  };

  if (role === 'shadow') {
    const flat = flatten(parts);
    const spans = extractColours(flat);
    const finish = (text: string): RenderedDeclaration => {
      for (const p of parts) if (isRegion(p)) note(p, text);
      return done(text);
    };
    if (spans.length === 0) return finish(flat);
    const carrier = parts.length === 1 && isRegion(parts[0]!) ? (parts[0] as Region) : null;
    const ref = { text: original, resolved: flat, token: carrier?.token ?? null, chain: carrier ? [carrier.token, ...regionNames(carrier.parts)] : regionNames(parts), declaration: original };
    const first = spans[0]!.rgba ?? { r: 0, g: 0, b: 0, alpha: 1 };
    const m =
      key !== 'box-shadow'
        ? unmappedColour({ ...ref, rgba: first }, ctx, env.index, `no DS token set covers ${key}: it cannot be mapped`)
        : env.index === null
          ? unmappedColour({ ...ref, rgba: first }, ctx, null, 'DS colour values are unavailable, so the shadow cannot be mapped to a DS shadow token')
          : mapReferenceShadow({ ...ref, rgba: first }, ctx, env.index);
    mappings.push(m);
    return finish(m.outcome === 'unmapped' ? flat : `var(${m.dsToken})`);
  }

  const mapOne = (span: ColourSpan, text: string, token: string | null, chain: string[]): string | null => {
    const ref = { text, resolved: span.text, token, chain, declaration: original };
    const m =
      span.rgba === null
        ? unmappedColour({ ...ref, rgba: null }, ctx, env.index, `unsupported colour expression: ${span.unsupported ?? span.text}; it is not passed through`)
        : env.index === null
          ? unmappedColour({ ...ref, rgba: span.rgba }, ctx, null, 'DS colour values are unavailable (the DS token source carries no resolved values), so this colour cannot be mapped to a DS token')
          : mapReferenceColour({ ...ref, rgba: span.rgba }, ctx, env.index);
    mappings.push(m);
    return m.outcome === 'unmapped' ? null : (m.keyword ?? `var(${m.dsToken})`);
  };
  const renderText = (text: string, carrier: Region | null): string => {
    const spans = extractColours(text);
    if (spans.length === 0) return text;
    const single = carrier !== null && spans.length === 1 && text.trim() === spans[0]!.text;
    // a custom-property declaration (a token ladder) IS the reference token: `--border-soft: rgba(...)` is compared with the DS's --border-soft by value
    const selfNamed = carrier === null && key.startsWith('--') && spans.length === 1 && text.trim() === spans[0]!.text;
    const chain = carrier ? [carrier.token, ...regionNames(carrier.parts)] : selfNamed ? [key] : [];
    let out = '';
    let pos = 0;
    for (const span of spans) {
      out += text.slice(pos, span.start);
      pos = span.end;
      out += mapOne(span, single ? `var(${carrier!.token})` : span.text, single ? carrier!.token : selfNamed ? key : null, chain) ?? span.text;
    }
    return out + text.slice(pos);
  };

  let out = '';
  for (const part of parts) {
    if (!isRegion(part)) {
      out += renderText(part, null);
      continue;
    }
    const rendered = renderText(flatten(part.parts), part);
    note(part, rendered);
    out += rendered;
  }
  return done(out);
}

/** Does the DS source carry resolved values (so colours can be mapped), or is it a lookup-only double? */
export const canMapColours = (ds: DsTokenLookup): ds is DsColourSource => typeof (ds as Partial<DsColourSource>).all === 'function' && typeof (ds as Partial<DsColourSource>).resolve === 'function';

// ── find ────────────────────────────────────────────────────────────────────────────────────────

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface Applicability {
  ok: boolean;
  detail: string;
}

/**
 * Does the pattern fit the need's surface, viewport and element kinds? The ONE definition, used by `findPatterns` (what is offered) and by
 * `verifyPattern` (what is accepted), so a candidate offered can never be refused for these reasons. The element kind is the SEMANTIC classification
 * in `query.elementKinds` (see element-kind.ts); with none, nothing fits.
 */
export function patternApplicability(pattern: ApprovedPattern, query: PatternQuery): { surface: Applicability; viewport: Applicability; elementKind: Applicability & { matched: SemanticKind[] } } {
  const surfaceOk = pattern.appliesTo.surfaces.includes(query.surface);
  const viewports = pattern.appliesTo.viewports;
  const viewportOk = viewports.includes('any') || viewports.includes(query.viewport) || (query.viewport === 'any' && viewports.includes('desktop') && viewports.includes('mobile'));
  const kind = kindCompatibility(query.elementKinds, pattern.appliesTo.elementKinds, query.elementEvidence?.summary);
  return {
    surface: { ok: surfaceOk, detail: surfaceOk ? `the pattern applies to ${query.surface} surfaces` : `the pattern applies to ${pattern.appliesTo.surfaces.join('/') || 'no'} surfaces, the need is on a ${query.surface} surface` },
    viewport: { ok: viewportOk, detail: viewportOk ? `the pattern applies to ${viewports.join('/')}; the need is ${query.viewport}` : `the pattern applies only to ${viewports.join('/') || 'no viewport'}; the need is ${query.viewport}` },
    elementKind: kind,
  };
}

/**
 * Candidates for a need: same category, every requested property declared, and a fit for the need's surface, viewport and element kinds (the same
 * test `verifyPattern` applies, so nothing offered is refused for those reasons). Projects that are the PREFERRED reference for the category come
 * first (registry order within each group), then patterns by id. Pure: no I/O.
 */
export function findPatterns(registry: ApprovedRegistry, query: PatternQuery): Array<{ project: string; pattern: ApprovedPattern; preferred: boolean }> {
  const wanted = query.properties.map(normalizeProperty);
  const rows: Array<{ project: string; pattern: ApprovedPattern; preferred: boolean; order: number }> = [];
  registry.projects.forEach((project, order) => {
    const preferred = project.preferredFor.includes(query.category);
    for (const pattern of project.patterns) {
      if (pattern.category !== query.category) continue;
      const declared = new Set(Object.keys(pattern.declarations).map(normalizeProperty));
      if (!wanted.every((p) => declared.has(p))) continue;
      const fit = patternApplicability(pattern, query);
      if (!fit.surface.ok || !fit.viewport.ok || !fit.elementKind.ok) continue;
      rows.push({ project: project.name, pattern, preferred, order });
    }
  });
  rows.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.order - b.order || byCodeUnit(a.pattern.id, b.pattern.id));
  return rows.map(({ project, pattern, preferred }) => ({ project, pattern, preferred }));
}

// ── verify ──────────────────────────────────────────────────────────────────────────────────────

export interface VerifyPatternArgs {
  registry: ApprovedRegistry;
  projectName: string;
  patternId: string;
  query: PatternQuery;
  /** A lookup-only double works for everything but colours: a pattern with a colour then fails closed (see `DsColourSource`). */
  dsTokens: DsTokenLookup;
  root?: string | undefined;
  /** The project's resolution when the caller already has it (hashing a project is the expensive step); it must be for `projectName`. */
  projectResolution?: ProjectResolution | undefined;
  checkServer?: boolean | undefined;
  fetchImpl?: typeof fetch | undefined;
  serverTimeoutMs?: number | undefined;
}

const CHECK_ORDER: PatternCheck['id'][] = [
  'project-approved',
  'source-available',
  'declarations-present',
  'purpose-matches',
  'surface-compatible',
  'viewport-applicable',
  'element-kind-compatible',
  'ds-grounded',
  'tokens-exist',
  'colours-mapped',
];

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'without', 'within', 'between', 'around', 'from', 'into', 'onto', 'over', 'under', 'than', 'that', 'this', 'these', 'those',
  'its', 'their', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'any', 'all', 'also', 'more', 'when', 'where', 'which', 'while', 'use', 'used', 'using',
  'via', 'each', 'both', 'one', 'pattern', 'treatment', 'component', 'element', 'style', 'styling',
]);

function purposeTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    // fold a plain plural so "cards" matches "card" (applied to both sides)
    terms.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return terms;
}

/**
 * The meaningful words a need's purpose and a pattern's own purpose / description have in common (sorted): the `purpose-matches` check of verification. Exported so
 * the candidates a caller is OFFERED (`hooks.find`) are exactly those that check would accept.
 */
export function sharedPurposeTerms(pattern: Pick<ApprovedPattern, 'purpose' | 'description'>, purpose: string): string[] {
  const patternTerms = purposeTerms(`${pattern.purpose} ${pattern.description}`);
  return [...purposeTerms(purpose)].filter((t) => patternTerms.has(t)).sort(byCodeUnit);
}

async function readPatternFile(sourcePath: string, file: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; detail: string }> {
  if (!isSafeRelative(file)) return { ok: false, detail: `pattern file "${file}" is not a relative path inside the project` };
  const real = await realpath(resolve(sourcePath, file)).catch(() => null);
  if (real === null) return { ok: false, detail: `pattern file "${file}" does not exist in ${sourcePath}` };
  if (!real.startsWith(sourcePath + sep)) return { ok: false, detail: `pattern file "${file}" resolves outside the project (${real})` };
  if (!(await stat(real)).isFile()) return { ok: false, detail: `pattern file "${file}" is not a regular file` };
  return { ok: true, bytes: await readFile(real) };
}

function sameValue(a: string, b: string): boolean {
  return normalizeValue(a) === normalizeValue(b);
}

/**
 * Every check a pattern must pass before it may be adapted. Reads the pattern's source file NOW (nothing is
 * trusted from the registry's memory of it) and classifies the outcome:
 *  - `ok` is false unless every check but `ds-grounded` passed (`colours-mapped` is required: a reference colour with
 *    no suitable DS token refuses the pattern, it is never applied raw);
 *  - `approved-project-pattern`: ok, every colour an EXACT DS equivalent, every var() a DS token, nothing hardcoded;
 *  - `proposed-local-variant`: ok, but a colour was mapped to the NEAREST suitable token, or a length exists only in the
 *    reference project and was inlined/flagged. Never an official DS component.
 * `tokens-exist` asks whether each var() resolves to SOME definition (the DS, or the project's own `:root`, or a
 * fallback). `applied` holds only the requested properties, and is empty unless `ok`; a declaration that cannot supply
 * `query.colour.property` and has an unmappable colour is left out of it (and said so in `reasons`).
 */
export async function verifyPattern(args: VerifyPatternArgs): Promise<PatternVerification> {
  const { registry, projectName, patternId, query, dsTokens } = args;
  const results = new Map<PatternCheck['id'], PatternCheck>();
  const set = (id: PatternCheck['id'], ok: boolean, detail: string): void => {
    results.set(id, { id, ok, detail });
  };
  let elementKinds: PatternVerification['elementKinds'] = { matched: [], inferred: [], evidence: '' };
  const finish = (r: Omit<PatternVerification, 'checks' | 'ok' | 'reasons' | 'elementKinds' | 'colours' | 'conditioned'> & { reasons?: string[]; colours?: ColourMapping[]; conditioned?: string[] }): PatternVerification => {
    const checks = CHECK_ORDER.map((id) => results.get(id) ?? { id, ok: false, detail: 'not evaluated' });
    const ok = checks.every((c) => c.ok || c.id === 'ds-grounded');
    const reasons = [...checks.filter((c) => !c.ok && !(ok && c.id === 'ds-grounded')).map((c) => `${c.id}: ${c.detail}`), ...(r.reasons ?? [])];
    return {
      ok,
      checks,
      project: r.project,
      pattern: r.pattern,
      declarationsFound: r.declarationsFound,
      fileSha256: r.fileSha256,
      tokens: r.tokens,
      elementKinds,
      classification: ok ? r.classification : null,
      applied: ok ? r.applied : {},
      colours: r.colours ?? [],
      conditioned: r.conditioned ?? [],
      hardcoded: r.hardcoded,
      reasons,
    };
  };

  const projectEntry = registry.projects.find((p) => p.name === projectName);
  const pattern = projectEntry?.patterns.find((p) => p.id === patternId) ?? null;
  const empty = { declarationsFound: {}, fileSha256: null, tokens: [], classification: null, applied: {}, hardcoded: [], colours: [], conditioned: [] };

  if (projectEntry === undefined) {
    const project = rejectedResolution(projectName, `"${projectName}" is not an approved reference project. Approved projects (exact names): ${registry.projects.map((p) => p.name).join(', ')}.`);
    set('project-approved', false, project.reason);
    return finish({ project, pattern: null, ...empty });
  }
  const project: ProjectResolution =
    args.projectResolution ??
    (await resolveProject(registry, projectName, {
      root: args.root,
      checkServer: args.checkServer,
      fetchImpl: args.fetchImpl,
      serverTimeoutMs: args.serverTimeoutMs,
    }));
  if (pattern === null) {
    set('project-approved', false, `pattern "${patternId}" is not in the approved catalog of "${projectName}" (catalog: ${projectEntry.patterns.map((p) => p.id).join(', ') || 'empty'})`);
    return finish({ project, pattern: null, ...empty });
  }
  set('project-approved', true, `"${projectName}" and its pattern "${patternId}" are in the approved registry (version ${registry.version})`);

  // Registry-only checks: they need the pattern, not the source.
  const shared = sharedPurposeTerms(pattern, query.purpose);
  const sameCategory = pattern.category === query.category;
  set(
    'purpose-matches',
    sameCategory && shared.length > 0,
    !sameCategory
      ? `the pattern is a "${pattern.category}" pattern, the need is "${query.category}"`
      : shared.length === 0
        ? `no meaningful word in common between the need ("${query.purpose}") and the pattern purpose ("${pattern.purpose}")`
        : `shared terms: ${shared.join(', ')}`,
  );
  const fit = patternApplicability(pattern, query);
  set('surface-compatible', fit.surface.ok, fit.surface.detail);
  set('viewport-applicable', fit.viewport.ok, fit.viewport.detail);
  set('element-kind-compatible', fit.elementKind.ok, fit.elementKind.detail);
  elementKinds = { matched: fit.elementKind.matched, inferred: query.elementKinds, evidence: query.elementEvidence?.summary ?? '' };

  // Source checks.
  const base = { project, pattern };
  if (project.status !== 'approved-available' || project.sourcePath === null) {
    set('source-available', false, project.reason);
    return finish({ ...base, ...empty });
  }
  const file = await readPatternFile(project.sourcePath, pattern.source.file);
  if (!file.ok) {
    set('source-available', false, file.detail);
    return finish({ ...base, ...empty });
  }
  const fileSha256 = createHash('sha256').update(file.bytes).digest('hex');
  set('source-available', true, `${pattern.source.file} read from ${project.sourcePath} (sha256 ${fileSha256.slice(0, 12)})`);

  const kind = pattern.source.kind;
  if (kind !== 'css-rule' && kind !== 'css-tokens') {
    set('declarations-present', false, `source kind "${kind}" is not supported; only css-rule and css-tokens patterns can be verified`);
    return finish({ ...base, ...empty, fileSha256 });
  }
  const rules = parseCss(file.bytes.toString('utf8').replace(/^﻿/, ''));
  // the registry remembers the BASE rule: it is checked against the unconditional declarations. What is APPLIED is read for the need's surface and viewport,
  // so a dark-scheme or mobile override is used only for a need it is for - never because it happens to come last in the file.
  const readEnv = readEnvFor(query);
  const baseRead = readRules(rules, kind, pattern.source.locator, BASE_ENV);
  const appliedRead = readRules(rules, kind, pattern.source.locator, readEnv);
  if (baseRead === null || appliedRead === null) {
    set('declarations-present', false, `no rule "${pattern.source.locator}" in ${pattern.source.file} any more`);
    return finish({ ...base, ...empty, fileSha256 });
  }
  const found = baseRead.decls;
  const valueOf = (key: string): string => appliedRead.decls[key] ?? (found[key] as string);
  const declarationsFound: Record<string, string> = {};
  const drift: string[] = [];
  for (const [key, expected] of Object.entries(pattern.declarations)) {
    const foundKey = normalizeProperty(key);
    const now = Object.hasOwn(found, foundKey) ? found[foundKey] : undefined;
    if (now === undefined) drift.push(`${key}: no longer declared in "${pattern.source.locator}" (registry has "${expected}")`);
    else {
      declarationsFound[key] = now;
      if (!sameValue(now, expected)) drift.push(`${key}: registry has "${expected}", source now has "${now}"`);
    }
  }
  const declaredKeys = new Map(Object.keys(pattern.declarations).map((k) => [normalizeProperty(k), k]));
  const requested = query.properties.map(normalizeProperty);
  const notDeclared = requested.filter((p) => !declaredKeys.has(p));
  const problems = [...drift, ...(notDeclared.length > 0 ? [`the pattern does not declare the requested ${notDeclared.join(', ')}`] : [])];
  set('declarations-present', problems.length === 0, problems.length === 0 ? `all ${Object.keys(pattern.declarations).length} registered declarations still hold in "${pattern.source.locator}"` : problems.join('; '));

  // The declarations that would be applied (the requested ones; the whole pattern when none are named), grounded and their colours mapped.
  const tokenRead = readRules(rules, 'css-tokens', ':root', readEnv);
  const projectTokens = tokenRead?.decls ?? {};
  const toApply = (requested.length === 0 ? [...declaredKeys.values()] : requested.map((p) => declaredKeys.get(p)).filter((k): k is string => k !== undefined)).filter((k) => declarationsFound[k] !== undefined);
  const index = canMapColours(dsTokens) ? buildDsColourIndex(dsTokens as DsTokenIndex) : null;
  const ctx: GroundingContext = {
    ds: dsTokens, projectTokens, tokens: new Map(), unresolved: [], usedProjectTokens: new Set(),
    resolveDs: index === null ? null : (token) => { const r = resolveTokenInScope(dsTokens as DsTokenIndex, token, query.surface); return r.outcome === 'resolved-target' ? r.value : null; },
  };

  const cq = query.colour ?? {};
  const state: StateName = cq.state ?? 'default';
  const need = cq.property;
  const measuredBackdrops = (cq.backdrops ?? []).map(parseBackdrop).filter((c): c is Rgb => c !== null);
  const env: ColourEnv = {
    surface: query.surface,
    state,
    hints: subRolesForKinds(query.elementKinds),
    backdrops: measuredBackdrops.length > 0 ? measuredBackdrops : undefined,
    backdropSource: measuredBackdrops.length > 0 ? (cq.backdropSource ?? 'measured') : 'ds-section-tokens',
    textColour: cq.textColour ? parseBackdrop(cq.textColour) : null,
    index,
  };
  const required = (key: string): boolean => kind === 'css-tokens' || suppliesProperty(key, need);

  // Which declarations are mapped: the default ones, or — for a hover/focus target — only those the reference declares for that state.
  let entries: Array<{ key: string; value: string }> = toApply.map((k) => ({ key: k, value: valueOf(k) }));
  let stateProblem: string | null = null;
  const stateConditioned: ConditionedProperty[] = [];
  if (state !== 'default' && toApply.length > 0) {
    const selectors = state === 'hover' ? [':hover'] : state === 'focus' || state === 'focus-visible' ? [':focus', ':focus-visible'] : [];
    const declared = selectors.map((sel) => ({ sel, read: kind === 'css-rule' ? readRules(rules, 'css-rule', `${pattern.source.locator}${sel}`, readEnv) : null })).filter((x) => x.read !== null);
    stateConditioned.push(...declared.flatMap((x) => x.read!.conditioned));
    if (selectors.length === 0) stateProblem = `the ${state} state of a reference cannot be read (only hover, focus and focus-visible are)`;
    else if (declared.length === 0) stateProblem = `the reference declares no ${selectors.join(' or ')} treatment for "${pattern.source.locator}"; its default declarations are not reused as a ${state} treatment`;
    else {
      const merged: Record<string, string> = Object.assign({}, ...declared.map((x) => x.read!.decls));
      entries = Object.entries(merged).filter(([key]) => suppliesProperty(key, need)).map(([key, value]) => ({ key, value }));
      if (entries.length === 0) stateProblem = `the reference's ${selectors.join('/')} rule for "${pattern.source.locator}" does not declare ${need ?? 'a property'} the target needs`;
    }
  }

  const applied: Record<string, string> = {};
  const colours: ColourMapping[] = [];
  const hardcoded: string[] = [];
  const dropped: string[] = [];
  const failures: string[] = [];
  const groundedByMapping = new Set<string>();
  let nearest = false;
  const renderedByKey = new Map<string, ColourMapping[]>();
  for (const { key, value } of entries) {
    const parts = groundParts(key, value, ctx, []);
    const r = renderDeclaration(key, value, parts, env);
    renderedByKey.set(key, r.mappings);
    const gaps = r.unmapped.map((m) => `${m.property}: ${m.referenceResolved} - ${m.reason}`);
    if (r.unmapped.length > 0 && !required(key)) {
      dropped.push(`${key} is not applied: ${gaps.join('; ')}`);
      continue; // an unmappable colour that this need does not depend on is left out, never applied raw
    }
    colours.push(...r.mappings);
    if (r.unmapped.length > 0) {
      failures.push(...gaps);
      continue;
    }
    applied[key] = r.text;
    if (r.mappings.some((m) => m.outcome === 'nearest')) nearest = true;
    const open = r.inlined.filter((i) => !i.clean);
    for (const i of r.inlined.filter((x) => x.clean)) for (const n of i.names) groundedByMapping.add(n);
    if (open.length > 0) {
      const names = open.map((i) => i.token).join(', ');
      hardcoded.push(
        open.some((i) => i.fallback)
          ? `${key}: ${value} -> ${r.text} (${names} is defined neither in the DS nor in the project; its fallback literal is used)`
          : `${key}: ${value} -> ${r.text} (${names} is defined only in the reference project, not in the DS)`,
      );
    } else if (hasLiteralColourOrLength(normalizeProperty(key), textOutsideVar(r.text))) hardcoded.push(`${key}: ${value}`);
  }

  // A hover/focus colour must stay distinguishable from the default colour exactly as far as the reference's own two states are. The default colour is read
  // through the same grounding as the mapped one (a project var() included); with no default colour there is no pair to hold the states to, and the
  // mapping records none, so the rendered check stays unverified instead of inventing a number.
  if (state !== 'default' && stateProblem === null && env.index !== null) {
    const stateMap = colours.find((m) => m.outcome !== 'unmapped' && m.state === state && suppliesProperty(m.property, need));
    const defaultKey = toApply.find((k) => suppliesProperty(k, need));
    if (stateMap && defaultKey) {
      const defaultValue = valueOf(defaultKey);
      const defaultRendered = renderDeclaration(defaultKey, defaultValue, groundParts(defaultKey, defaultValue, { ...ctx, tokens: new Map(), unresolved: [] }, []), { ...env, state: 'default' });
      const defaultMapped = defaultRendered.mappings.find((m) => m.outcome !== 'unmapped');
      const toRgba = (m: ColourMapping) => (m.keyword === 'transparent' ? { r: 0, g: 0, b: 0, alpha: 0 } : parseCssColour(m.dsValue ?? ''));
      const a = defaultMapped ? toRgba(defaultMapped) : null;
      const b = toRgba(stateMap);
      const backdrops = stateMap.backdrops.map(parseBackdrop).filter((c): c is Rgb => c !== null);
      if (defaultMapped && a && b && backdrops.length > 0) {
        const d = stateDistinctness({ reference: [defaultMapped.referenceRgba, stateMap.referenceRgba], mapped: [a, b], backdrops });
        stateMap.verification.designTime.stateDistinct = d.distinct;
        stateMap.verification.designTime.stateDelta = { reference: d.referenceDelta, mapped: d.mappedDelta, required: d.required };
        if (!d.distinct) failures.push(`${stateMap.property}: the ${state} colour ${stateMap.referenceResolved} and the default colour collapse onto indistinguishable DS colours (ΔE ${Math.round(d.mappedDelta * 100) / 100}, the reference's own two states differ by ΔE ${Math.round(d.referenceDelta * 100) / 100}); the states would no longer be distinguishable`);
      }
    }
  }

  // properties and project tokens that conditional blocks also set: reported, so a base value is never mistaken for "the" value at every surface and viewport.
  // That includes a RELATED property of a declared one (suppliesProperty, both directions: a declared `border` overridden by an `@media { border-color }`, a declared
  // longhand overridden by a shorthand) - not read here, so when its condition HOLDS for this need the value read is not the value in force: refused, named.
  const used = new Set([...toApply, ...entries.map((e) => e.key)]);
  const related = (property: string): boolean => !used.has(property) && (need !== undefined && need !== '' ? suppliesProperty(property, need) : [...used].some((k) => suppliesProperty(property, k)));
  const relatedConditioned = appliedRead.conditioned.filter((c) => related(c.property));
  const overridden = relatedConditioned.filter((c) => c.applied);
  // an UNCONDITIONAL related declaration of the same rule list wins over a used one when it is `!important` and the used one is not, or when it comes later: the declared
  // `border` followed by `border-color`, the declared `border-top-color` followed by `border`. (Earlier ones are reset by the used declaration; an unrelated property is no business of the need.)
  const outranks = (r: DeclaredProperty, u: DeclaredProperty): boolean => (r.important && !u.important) || (r.important === u.important && r.seq > u.seq);
  const inForce = (key: string): DeclaredProperty | undefined => appliedRead.declared.filter((d) => d.property === key).reduce<DeclaredProperty | undefined>((best, d) => (best === undefined || outranks(d, best) ? d : best), undefined);
  const later = appliedRead.declared.filter((r) => r.unconditional && related(r.property) && [...used].some((k) => { const u = inForce(k); return u !== undefined && suppliesProperty(r.property, k) && outranks(r, u); }));
  const conditioned = [
    ...appliedRead.conditioned.filter((c) => used.has(c.property)),
    ...relatedConditioned,
    ...stateConditioned.filter((c) => used.has(c.property) || suppliesProperty(c.property, need)),
    ...(tokenRead?.conditioned ?? []).filter((c) => ctx.usedProjectTokens.has(c.property)),
  ].map((c) => `${c.property}: ${c.condition} ${c.applied ? 'applies to this need and was read' : 'does not apply to this need; the base rule was read'}`);
  if (overridden.length > 0 || later.length > 0) {
    const prior = results.get('declarations-present');
    const how = [...overridden.map((c) => `${c.property} is set under ${c.condition}`), ...[...new Set(later.map((r) => `${r.property} is declared ${r.important ? 'with !important' : 'later'} in the same rule`))]];
    set('declarations-present', false, `${prior && !prior.ok ? `${prior.detail}; ` : ''}the declared ${[...used].join(', ')} is not the value in force for this need: ${how.join('; ')} (a related property the registry does not catalogue, so the pattern is not applied)`);
  }

  const tokens = [...ctx.tokens].map(([token, t]) => ({ token, existsInDs: t.existsInDs, dsScope: t.dsScope }));
  const grounded = hardcoded.length === 0 && ctx.unresolved.length === 0 && tokens.every((t) => t.existsInDs || groundedByMapping.has(t.token));
  if (toApply.length === 0) {
    set('ds-grounded', false, 'not evaluated: none of the requested declarations could be read from the source');
    set('tokens-exist', false, 'not evaluated: none of the requested declarations could be read from the source');
    set('colours-mapped', false, 'not evaluated: none of the requested declarations could be read from the source');
  } else {
    set(
      'ds-grounded',
      grounded,
      grounded
        ? tokens.length > 0 || colours.length > 0
          ? `every var() resolves to a DS token (${tokens.map((t) => t.token).join(', ') || 'none'}) or its colour was mapped to one, and no literal colour or length is hardcoded`
          : 'no token or literal colour/length is involved'
        : `not official DS guidance: ${[...hardcoded, ...ctx.unresolved].join('; ')}`,
    );
    set(
      'tokens-exist',
      ctx.unresolved.length === 0,
      ctx.unresolved.length > 0
        ? `unresolvable: ${ctx.unresolved.join('; ')}`
        : tokens.length === 0
          ? 'the applied declarations use no var() tokens'
          : tokens.map((t) => `${t.token} (${t.existsInDs ? `DS${t.dsScope === null ? '' : ` ${t.dsScope}`}` : 'reference project only'})`).join(', '),
    );
    const problems = [...(stateProblem ? [stateProblem] : []), ...failures];
    set(
      'colours-mapped',
      problems.length === 0,
      problems.length > 0
        ? `${problems.length} reference colour problem(s), nothing is applied raw: ${problems.join('; ')}`
        : colours.length > 0
          ? colours.map(summariseMapping).join('; ')
          : 'no colour is involved',
    );
  }

  const classification: PatternVerification['classification'] = grounded && toApply.length > 0 && !nearest ? 'approved-project-pattern' : 'proposed-local-variant';
  const reasons = [
    ...dropped,
    ...(classification === 'proposed-local-variant' && (hardcoded.length > 0 || nearest)
      ? [`proposed local variant, not an official DS component: ${[...hardcoded, ...colours.filter((m) => m.outcome === 'nearest').map(summariseMapping)].join('; ')}`]
      : classification === 'approved-project-pattern'
        ? [`approved project pattern "${pattern.id}" of "${project.name}", used as found and fully DS-grounded`]
        : []),
  ];
  return finish({ ...base, declarationsFound, fileSha256, tokens, classification, applied, hardcoded, reasons, colours, conditioned: [...new Set(conditioned)] });
}

// ── provenance ──────────────────────────────────────────────────────────────────────────────────

/** The run-artifact record of a successful verification; null when the pattern may not be used. */
export function toReferenceProvenance(v: PatternVerification): ReferenceProvenance | null {
  if (!v.ok || v.pattern === null || v.classification === null) return null;
  if (v.project.sourcePath === null || v.project.projectHash === null || v.fileSha256 === null) return null;
  const notes: string[] = [];
  if (v.hardcoded.length > 0) notes.push(`not official DS guidance: ${v.hardcoded.join('; ')}`);
  if (v.conditioned.length > 0) notes.push(`theme/responsive-conditioned (not the default value everywhere): ${v.conditioned.join('; ')}`);
  if (v.project.kind === 'legacy-readonly') notes.push('the project is LEGACY-READONLY');
  return {
    project: v.project.name,
    pattern: v.pattern.id,
    sourcePath: v.project.sourcePath,
    file: v.pattern.source.file,
    fileSha256: v.fileSha256,
    projectHash: v.project.projectHash,
    classification: v.classification,
    dsGrounded: v.checks.find((c) => c.id === 'ds-grounded')?.ok === true,
    tokens: v.tokens,
    renderingEvidence: v.project.serverStatus === 'reachable' ? 'server-reachable' : 'source-only',
    note: notes.length > 0 ? notes.join(' | ') : null,
    elementKinds: v.elementKinds,
    colours: v.colours,
    ...(v.conditioned.length > 0 ? { conditioned: v.conditioned } : {}),
  };
}
