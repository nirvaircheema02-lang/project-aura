import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { AuditProperty } from '../audit-link/finding-schema.ts';
import type { DsTokenDef, DsTokenLookup } from '../reference/types.ts';
import type { UnresolvedReason } from './schema.ts';

/**
 * Deterministic Design-System evidence for the Resolver: (1) an index of the DS's CSS custom-property
 * definitions with the selector scope each lives under, (2) a classifier that understands WHY the audit left a
 * property unresolved, and (3) resolution of a token as seen from a page surface. Nothing here calls a model,
 * touches a page, or writes to the DS.
 */

type Surface = 'light' | 'dark' | 'unknown';

const CINEMATIC_DARK_SCOPE = '[data-variant="cinematic-dark"]';
const EDITORIAL_LIGHT_SCOPE = '[data-variant="editorial-light"]';

export function scopeForSurface(surface: Surface): string | null {
  if (surface === 'dark') return CINEMATIC_DARK_SCOPE;
  if (surface === 'light') return EDITORIAL_LIGHT_SCOPE;
  return null;
}

// ── CSS scanning ─────────────────────────────────────────────────────────────────────────────

const MAX_VAR_DEPTH = 8;
const TOKEN_FILE = 'tokens/build/tokens.css';
const STYLES_DIR = 'core-v2/src/styles';
const UNSCOPED_SELECTORS = new Set([':root', 'html', '*', ':host', 'body']);
/** At-rules whose block holds ordinary rules; they are flattened into the enclosing scope. `@layer` is the only unconditional one. */
const GROUP_AT_RULES = new Set(['layer', 'media', 'supports', 'container', 'scope', 'document', 'starting-style']);
const CUSTOM_PROPERTY_START = /^--[^\s:;{}()"'\\]+\s*:/;
const CUSTOM_PROPERTY_DECLARATION = /^(--[^\s:;{}()"'\\]+)\s*:([\s\S]*)$/;

interface RawDefinition {
  token: string;
  value: string;
  scope: string | null;
  /** Declared inside @media / @supports / @container …: applies only when that condition holds. */
  conditional: boolean;
}

interface ScanContext {
  /** Selector items of the enclosing style rule; null outside any style rule. */
  selectors: string[] | null;
  conditional: boolean;
}

/** End index (exclusive) of the string literal starting at `start`. An unterminated string ends at the line break, as in CSS. */
function skipString(text: string, start: number): number {
  const quote = text.charAt(start);
  let i = start + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return i;
    i++;
  }
  return text.length;
}

function stripComments(css: string): string {
  const parts: string[] = [];
  let chunkStart = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css.charAt(i);
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
    } else if (ch === '/' && css.charAt(i + 1) === '*') {
      parts.push(css.slice(chunkStart, i), ' ');
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 2;
      chunkStart = i;
    } else {
      i++;
    }
  }
  parts.push(css.slice(chunkStart));
  return parts.join('');
}

/** Collapses whitespace runs outside string literals to one space. `requote` rewrites simple '…' literals to "…" so attribute selectors compare equal. */
function collapseWhitespace(text: string, requote: boolean): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      const literal = text.slice(i, end);
      const simple = ch === "'" && literal.length >= 2 && literal.endsWith("'") && !/["\\]/.test(literal);
      out += requote && simple ? `"${literal.slice(1, -1)}"` : literal;
      i = end;
    } else if (/\s/.test(ch)) {
      if (!out.endsWith(' ')) out += ' ';
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out.trim();
}

/** Splits on `separator` at nesting depth 0 (outside parentheses, brackets and strings). */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
    i++;
  }
  parts.push(text.slice(from));
  return parts;
}

/** Index of the `}` that closes the `{` at `open`, or `limit` when the block is never closed. */
function findBlockEnd(css: string, open: number, limit: number): number {
  let depth = 0;
  let paren = 0;
  for (let i = open; i < limit; i++) {
    const ch = css.charAt(i);
    if (ch === '"' || ch === "'") {
      i = skipString(css, i) - 1;
    } else if (ch === '(') {
      paren++;
    } else if (ch === ')') {
      if (paren > 0) paren--;
    } else if (paren === 0) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return limit;
}

function scopeOf(selectors: string[]): string | null {
  return selectors.some((s) => UNSCOPED_SELECTORS.has(s.toLowerCase())) ? null : selectors.join(', ');
}

function nestSelectors(parents: string[], children: string[]): string[] {
  const parent = parents.length === 1 ? (parents[0] ?? '') : `:is(${parents.join(', ')})`;
  return children.map((child) => (child.includes('&') ? child.replaceAll('&', parent) : `${parent} ${child}`));
}

function recordDeclaration(text: string, ctx: ScanContext, out: RawDefinition[]): void {
  if (ctx.selectors === null) return;
  const match = CUSTOM_PROPERTY_DECLARATION.exec(text.trim());
  if (!match) return;
  const [, token, raw] = match;
  if (!token) return;
  const value = collapseWhitespace(raw ?? '', false).replace(/\s*!important$/i, '');
  if (value === '') return;
  out.push({ token, value, scope: scopeOf(ctx.selectors), conditional: ctx.conditional });
}

function scanBlock(prelude: string, css: string, bodyStart: number, bodyEnd: number, ctx: ScanContext, out: RawDefinition[]): void {
  if (prelude.startsWith('@')) {
    const name = /^@([A-Za-z-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
    if (GROUP_AT_RULES.has(name)) {
      scanBody(css, bodyStart, bodyEnd, { selectors: ctx.selectors, conditional: ctx.conditional || name !== 'layer' }, out);
    } else if (name === 'theme') {
      scanBody(css, bodyStart, bodyEnd, { selectors: [':root'], conditional: ctx.conditional }, out);
    }
    // @keyframes / @font-face / @property / @page … never define a token that applies to an element
    return;
  }
  const own = splitTopLevel(prelude, ',').map((item) => collapseWhitespace(item, true)).filter((item) => item !== '');
  if (own.length === 0) return;
  const selectors = ctx.selectors === null ? own : nestSelectors(ctx.selectors, own);
  scanBody(css, bodyStart, bodyEnd, { selectors, conditional: ctx.conditional }, out);
}

function scanBody(css: string, start: number, end: number, ctx: ScanContext, out: RawDefinition[]): void {
  let statementStart = start;
  let paren = 0;
  let i = start;
  while (i < end) {
    const ch = css.charAt(i);
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === '(') {
      paren++;
    } else if (ch === ')') {
      if (paren > 0) paren--;
    } else if (paren === 0) {
      if (ch === ';') {
        recordDeclaration(css.slice(statementStart, i), ctx, out);
        statementStart = i + 1;
      } else if (ch === '}') {
        statementStart = i + 1;
      } else if (ch === '{') {
        const prelude = css.slice(statementStart, i).trim();
        const close = findBlockEnd(css, i, end);
        if (CUSTOM_PROPERTY_START.test(prelude)) {
          // `--x: { … }` — the braces belong to the value, the statement continues
          i = close + 1;
          continue;
        }
        scanBlock(prelude, css, i + 1, close, ctx, out);
        i = close + 1;
        statementStart = i;
        continue;
      }
    }
    i++;
  }
  recordDeclaration(css.slice(statementStart, end), ctx, out);
}

function scanCss(source: string): RawDefinition[] {
  const css = stripComments(source);
  const out: RawDefinition[] = [];
  scanBody(css, 0, css.length, { selectors: null, conditional: false }, out);
  return out;
}

// ── token index ──────────────────────────────────────────────────────────────────────────────

export interface DsTokenIndex extends DsTokenLookup {
  all(): DsTokenDef[];
  /** Resolves `token` as seen from `scope` (null = unscoped/base). Follows var(--a, fallback) chains (max depth 8, cycle-safe). A token defined both in `scope` and unscoped resolves to the scoped definition; a token defined only under OTHER scopes resolves to null with an explanatory chain. */
  resolve(token: string, scope: string | null): { value: string | null; chain: string[]; scope: string | null; file: string | null };
}

interface IndexEntry {
  def: DsTokenDef;
  conditional: boolean;
}

function scopeLabel(scope: string | null): string {
  return scope ?? 'unscoped';
}

function scopePhrase(scope: string | null): string {
  return scope ?? 'the unscoped base';
}

function describeScopes(entries: IndexEntry[]): string {
  return [...new Set(entries.map((e) => e.def.scope))].map((s) => scopeLabel(s)).join(' | ');
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

export function buildDsTokenIndex(designSystemPath: string): DsTokenIndex {
  const root = resolvePath(designSystemPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Design System path does not exist or is not a directory: ${root}`);
  }

  const files = [TOKEN_FILE];
  try {
    for (const name of readdirSync(join(root, STYLES_DIR)).sort()) if (name.endsWith('.css')) files.push(`${STYLES_DIR}/${name}`);
  } catch {
    // no core-v2 styles folder: the index simply has fewer files
  }

  const entries: IndexEntry[] = [];
  const byToken = new Map<string, IndexEntry[]>();
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const raw of scanCss(source)) {
      const entry: IndexEntry = { def: { token: raw.token, value: raw.value, scope: raw.scope, file }, conditional: raw.conditional };
      entries.push(entry);
      const list = byToken.get(raw.token);
      if (list) list.push(entry);
      else byToken.set(raw.token, [entry]);
    }
  }

  const copy = (def: DsTokenDef): DsTokenDef => ({ ...def });

  /** The definition `token` has when seen from `scope`: the scope's own, else the unscoped one; within a scope the last unconditional definition wins (later source order overrides earlier). */
  function pick(token: string, scope: string | null): { entry: IndexEntry | null; others: IndexEntry[] } {
    const all = byToken.get(token) ?? [];
    const own = all.filter((e) => e.def.scope === scope);
    const pool = own.length > 0 || scope === null ? own : all.filter((e) => e.def.scope === null);
    const unconditional = pool.filter((e) => !e.conditional);
    const entry = (unconditional.length > 0 ? unconditional : pool).at(-1) ?? null;
    return { entry, others: entry ? [] : all };
  }

  function resolve(token: string, scope: string | null): { value: string | null; chain: string[]; scope: string | null; file: string | null } {
    const chain: string[] = [];
    const cycleMembers = new Set<string>();
    let depthExceeded = false;

    function expand(value: string, depth: number, stack: string[]): string | null {
      let out = '';
      let i = 0;
      while (i < value.length) {
        if (depthExceeded) return null;
        const ch = value.charAt(i);
        if (ch === '"' || ch === "'") {
          const end = skipString(value, i);
          out += value.slice(i, end);
          i = end;
          continue;
        }
        if (value.slice(i, i + 4).toLowerCase() === 'var(' && (i === 0 || !isIdentifierChar(value.charAt(i - 1)))) {
          const close = matchParen(value, i + 3);
          if (close === -1) {
            chain.push(`malformed var() in "${value}"`);
            return null;
          }
          const args = splitTopLevel(value.slice(i + 4, close), ',');
          const name = (args[0] ?? '').trim();
          const fallback = args.length > 1 ? args.slice(1).join(',').trim() : null;
          let replacement = refer(name, depth + 1, stack);
          if (replacement === null && fallback !== null && !depthExceeded) {
            chain.push(`${name} is not usable; using fallback ${fallback}`);
            replacement = expand(fallback, depth, stack);
          }
          if (replacement === null) return null;
          out += replacement;
          i = close + 1;
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    }

    function refer(name: string, depth: number, stack: string[]): string | null {
      if (!name.startsWith('--')) {
        chain.push(`invalid custom property name "${name}"`);
        return null;
      }
      const at = stack.indexOf(name);
      if (at !== -1) {
        for (const member of stack.slice(at)) cycleMembers.add(member);
        chain.push(`cycle ${[...stack.slice(at), name].join(' -> ')}`);
        return null;
      }
      if (depth > MAX_VAR_DEPTH) {
        depthExceeded = true;
        chain.push(`var() chain deeper than ${MAX_VAR_DEPTH} at ${name}`);
        return null;
      }
      const { entry, others } = pick(name, scope);
      if (!entry) {
        chain.push(
          others.length > 0
            ? `${name} is defined only under other scopes (${describeScopes(others)}); not visible from ${scopeLabel(scope)}`
            : `${name} is not defined`,
        );
        return null;
      }
      chain.push(`${name} = ${entry.def.value} [${scopeLabel(entry.def.scope)}; ${entry.def.file}]`);
      const value = expand(entry.def.value, depth, [...stack, name]);
      return cycleMembers.has(name) ? null : value;
    }

    const resolved = refer(token.trim(), 0, []);
    const top = pick(token.trim(), scope).entry;
    return {
      value: resolved === null ? null : collapseWhitespace(resolved, false),
      chain,
      scope: top?.def.scope ?? null,
      file: top?.def.file ?? null,
    };
  }

  return {
    lookup: (token) => (byToken.get(token.trim()) ?? []).map((e) => copy(e.def)),
    all: () => entries.map((e) => copy(e.def)),
    resolve,
  };
}

// ── property knowledge ───────────────────────────────────────────────────────────────────────

export type PropertyCategory = 'layout' | 'dimension' | 'typography' | 'color' | 'spacing' | 'shape' | 'effect' | 'other';

/** First match wins. `grid-gap` & co are legacy aliases of `gap`, so they are spacing, not grid layout. */
const CATEGORY_RULES: ReadonlyArray<readonly [PropertyCategory, RegExp]> = [
  ['spacing', /^(?:gap|row-gap|column-gap|grid-gap|grid-row-gap|grid-column-gap|padding(?:-.+)?|margin(?:-.+)?)$/],
  ['dimension', /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|aspect-ratio)$/],
  ['layout', /^(?:display|position|top|right|bottom|left|float|clear|order|z-index|text-align|translate|scale|rotate|transform(?:-.+)?|(?:inset|flex|grid|align|justify|place|overflow)(?:-.+)?)$/],
  ['effect', /^(?:box-shadow|text-shadow|filter|backdrop-filter|opacity|mix-blend-mode|clip-path|will-change|mask(?:-.+)?|transition(?:-.+)?|animation(?:-.+)?)$/],
  ['color', /(?:^|-)color$|^(?:background|background-image|fill|stroke)$/],
  ['typography', /^(?:font(?:-.+)?|line-height|letter-spacing|word-spacing|white-space|vertical-align|word-break|hyphens|line-clamp|text-.+)$/],
  ['shape', /^(?:border(?:-.+)?|outline(?:-.+)?)$/],
];

/** Composition / alignment / size: never changed merely because an expected value is absent. */
const LAYOUT_PROTECTED = /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|aspect-ratio|display|position|top|right|bottom|left|float|clear|order|z-index|text-align|translate|scale|rotate|transform(?:-.+)?|(?:inset|flex|grid|align|justify|place|overflow|margin)(?:-.+)?)$/;
const GAP_ALIAS = /^grid-(?:row-|column-)?gap$/;
const INHERITABLE = /^(?:font(?:-.+)?|line-height|letter-spacing|word-spacing|text-align|text-transform|text-indent|white-space|color|cursor|visibility|direction|list-style(?:-.+)?|quotes)$/;
const VENDOR_PREFIX = /^-(?:webkit|moz|ms|o)-/;

export function propertyInfo(property: string): { category: PropertyCategory; /** composition/alignment/size: NEVER changed merely because an expected value is absent */ layoutProtected: boolean; /** inherited by default in CSS */ inheritable: boolean } {
  const trimmed = property.trim();
  if (trimmed.startsWith('--')) return { category: 'other', layoutProtected: false, inheritable: true };
  const name = trimmed.toLowerCase().replace(VENDOR_PREFIX, '');
  const category = CATEGORY_RULES.find(([, pattern]) => pattern.test(name))?.[0] ?? 'other';
  return { category, layoutProtected: !GAP_ALIAS.test(name) && LAYOUT_PROTECTED.test(name), inheritable: INHERITABLE.test(name) };
}

// ── classification of the audit's notes ──────────────────────────────────────────────────────

export interface ClassifyContext {
  findingClassification: string;
  dsComponent: string | null;
  dsVariant: string | null;
  surface: Surface;
  /** rendered evidence when the caller has a live page: the element's computed value equals its parent's */
  inheritedFromParent?: boolean | null;
  /** rendered evidence: the element's computed `display` */
  display?: string | null;
}

export interface Classification {
  reason: UnresolvedReason;
  /** true when a change MAY be derivable from evidence (the caller must still obtain/measure the target); false = nothing to change */
  changeable: boolean;
  expectedFromNote: string | null; // e.g. "0.5rem"
  tokenFromNote: string | null; // e.g. "--surface-text-muted"
  actualKeyword: string | null; // e.g. "normal" / "auto" when `actual` is a keyword
  layoutProtected: boolean;
  inheritable: boolean;
  rationale: string; // one checkable sentence
}

const NO_DS_REQUIREMENT = /no verified DS requirement/i;
const LAYOUT_CONTEXT = /length not comparable without layout context \(actual "([^"]*)", expected "([^"]*)"\)/i;
const TOKEN_NOT_DEFINED = /expected token (--[A-Za-z0-9_-]+) is not defined in the Design System/i;
const STATE_NOTE = /\b(?:hover|focus(?:-visible|-within)?|active|disabled|states?)\b/i;
const RESPONSIVE_NOTE = /\b(?:breakpoints?|viewports?|responsive|media quer(?:y|ies))\b/i;
const CSS_KEYWORDS = new Set(['normal', 'auto', 'none', 'inherit', 'initial', 'unset', 'fit-content', 'min-content', 'max-content']);

function keywordOf(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v && CSS_KEYWORDS.has(v) ? v : null;
}

function where(ctx: ClassifyContext): string {
  return ctx.dsComponent ? ` on DS component ${ctx.dsComponent}${ctx.dsVariant ? ` (${ctx.dsVariant})` : ''}` : '';
}

export function classifyProperty(input: AuditProperty, ctx: ClassifyContext): Classification {
  const info = propertyInfo(input.property);
  const note = input.note?.trim() ?? '';
  const done = (c: Pick<Classification, 'reason' | 'changeable' | 'rationale'> & Partial<Pick<Classification, 'expectedFromNote' | 'tokenFromNote' | 'actualKeyword'>>): Classification => ({
    expectedFromNote: null,
    tokenFromNote: null,
    actualKeyword: keywordOf(input.actual),
    layoutProtected: info.layoutProtected,
    inheritable: info.inheritable,
    ...c,
  });

  if (input.status === 'MATCH') {
    return done({ reason: 'audit-expected-present', changeable: false, rationale: `already matches: the audit measured ${input.property} equal to its expected value.` });
  }

  if (input.status === 'DIFFERENT' && input.expected !== null) {
    const token = input.expectedToken ? ` (${input.expectedToken})` : '';
    const protectedNote = info.layoutProtected ? '; it is layout-protected and is changeable only because the audit itself measured this expectation' : '';
    return done({
      reason: 'audit-expected-present',
      changeable: true,
      rationale: `the audit measured ${input.property} as "${input.actual ?? 'unknown'}" against its own expected "${input.expected}"${token}${protectedNote}.`,
    });
  }

  if (NO_DS_REQUIREMENT.test(note)) {
    if (info.inheritable && ctx.inheritedFromParent === true) {
      return done({
        reason: 'inherited-context',
        changeable: false,
        rationale: `${input.property} is inherited by default and the rendered value equals the parent's, so the DS states no requirement at this element${where(ctx)}.`,
      });
    }
    return done({
      reason: 'no-ds-requirement',
      changeable: false,
      rationale: `the audit found no verified DS requirement for ${input.property}${where(ctx)}; nothing is derivable to change.`,
    });
  }

  const layout = LAYOUT_CONTEXT.exec(note);
  if (layout) {
    const [, noteActual, noteExpected] = layout;
    const expectedFromNote = noteExpected?.trim() || null;
    const actualKeyword = keywordOf(noteActual);
    const rendered = ctx.display ? ` (computed display: ${ctx.display})` : '';
    let changeable = false;
    let rationale: string;
    if (expectedFromNote === null) {
      rationale = `the audit could not compare ${input.property} without layout measurements and its note carries no expected value${rendered}.`;
    } else if (input.source === null) {
      rationale = `the note names expected "${expectedFromNote}" for ${input.property} but no DS file backs it (source is null), so it is not a verified requirement${rendered}.`;
    } else {
      changeable = true;
      rationale = `${input.source} states ${input.property} "${expectedFromNote}" but the audit could not compare it with ${actualKeyword ? `the keyword "${actualKeyword}"` : `"${input.actual ?? 'unknown'}"`} without layout measurements; measure the used value on the rendered page${rendered}.`;
    }
    return done({ reason: 'layout-measurement-required', changeable, expectedFromNote, actualKeyword, rationale });
  }

  const undefinedToken = TOKEN_NOT_DEFINED.exec(note);
  if (undefinedToken?.[1]) {
    const tokenFromNote = undefinedToken[1];
    return done({
      reason: 'variant-or-theme-context',
      changeable: true,
      tokenFromNote,
      rationale: `${tokenFromNote} is not defined in the unscoped DS base; it may exist only under a variant/theme scope, so resolve it for the page's ${ctx.surface} surface.`,
    });
  }

  if (STATE_NOTE.test(note)) {
    return done({ reason: 'state-context', changeable: false, rationale: `the audit note refers to an interaction state it did not capture ("${note}"); state evidence must be gathered first.` });
  }
  if (RESPONSIVE_NOTE.test(note)) {
    return done({ reason: 'responsive-context', changeable: false, rationale: `the audit note refers to a viewport/breakpoint it did not capture ("${note}"); viewport evidence must be gathered first.` });
  }

  return done({
    reason: 'capture-capability-gap',
    changeable: false,
    rationale: note ? `unrecognized audit note, not guessed: "${note}"` : `the audit recorded no note and no expected value for ${input.property}; not guessed.`,
  });
}

// ── resolving a token for a surface ──────────────────────────────────────────────────────────

export interface DsResolution {
  outcome: 'resolved-target' | 'unresolved';
  value: string | null;
  token: string | null;
  scope: string | null;
  file: string | null;
  evidence: string[];
  reason: string;
}

export function resolveTokenInScope(index: DsTokenIndex, token: string, surface: Surface): DsResolution {
  const name = token.trim();
  const unresolved = (reason: string, evidence: string[]): DsResolution => ({ outcome: 'unresolved', value: null, token: name, scope: null, file: null, evidence, reason });

  const defs = index.lookup(name);
  if (defs.length === 0) return unresolved('token not defined anywhere in the DS', [`${name}: no definition in ${TOKEN_FILE} or ${STYLES_DIR}/*.css`]);

  const wanted = scopeForSurface(surface);
  const scopes = [...new Set(defs.map((d) => d.scope))];
  const variantScopes = scopes.filter((s): s is string => s !== null);
  const definedAt = defs.map((d) => `${name} defined under ${scopeLabel(d.scope)} in ${d.file}: ${d.value}`);

  let scope: string | null;
  if (wanted !== null && scopes.includes(wanted)) {
    scope = wanted;
  } else if (scopes.includes(null)) {
    scope = null;
  } else if (wanted !== null) {
    return unresolved(`${name} is defined only under ${variantScopes.join(' and ')}; none applies to a ${surface} surface (${wanted})`, definedAt);
  } else if (variantScopes.length > 1) {
    return unresolved(`${name} is defined only under ${variantScopes.join(' and ')} and the page surface is unknown; the theme is not guessed`, definedAt);
  } else {
    scope = variantScopes[0] ?? null;
  }

  const resolved = index.resolve(name, scope);
  if (resolved.value === null || resolved.value === '') {
    const last = resolved.chain.at(-1) ?? 'no resolution chain';
    return unresolved(`${name} could not be resolved to a literal value in ${scopePhrase(scope)}: ${last}`, resolved.chain);
  }

  const evidence = [...resolved.chain];
  if (surface === 'unknown') {
    for (const other of scopes) {
      if (other === scope) continue;
      const alt = index.resolve(name, other);
      if (alt.value !== null && alt.value !== resolved.value) evidence.push(`page surface unknown: ${name} is also ${alt.value} under ${scopeLabel(other)}`);
    }
  }
  return {
    outcome: 'resolved-target',
    value: resolved.value,
    token: name,
    scope: resolved.scope,
    file: resolved.file,
    evidence,
    reason: `${name} resolves to ${resolved.value} in ${scopePhrase(resolved.scope)} (${resolved.file ?? 'unknown file'}); page surface: ${surface}.`,
  };
}
