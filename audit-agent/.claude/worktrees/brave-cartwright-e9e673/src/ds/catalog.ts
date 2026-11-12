import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DsRegistry } from './d2-registry/index.ts';
import { resolveToken } from './d3-tokens/resolve.ts';

/**
 * A compact, model-facing view of the Design System registry. The registry
 * itself is large (286 source tokens, 289 component files, 700+ effective CSS
 * properties); this narrows it to what a matching/compliance decision needs,
 * without ever inventing values — every entry traces to a real DS file.
 */

export interface CatalogComponent {
  name: string;
  category: string;
  file: string;
  variants: Array<{ typeName: string; values: string[] }>;
  hasCva: boolean;
  /** True when the component's styling is applied at runtime and is invisible to any stylesheet (D4 finding). */
  runtimeStyled: boolean;
}

export function buildComponentCatalog(registry: DsRegistry): CatalogComponent[] {
  const byFile = new Map<string, CatalogComponent>();
  for (const file of registry.components.componentFiles) {
    const parts = file.split('/');
    byFile.set(file, {
      name: basename(file, '.tsx'),
      category: parts[0] ?? 'unknown',
      file,
      variants: [],
      hasCva: false,
      runtimeStyled: false,
    });
  }
  for (const v of registry.components.stringUnionVariants) {
    byFile.get(v.file)?.variants.push({ typeName: v.typeName, values: v.values });
  }
  for (const c of registry.components.cvaConfigs) {
    const entry = byFile.get(c.file);
    if (entry) entry.hasCva = true;
  }
  for (const l of registry.components.iifeLogic) {
    const entry = byFile.get(l.file);
    if (entry && l.runtimeOnly) entry.runtimeStyled = true;
  }
  return [...byFile.values()];
}

/**
 * The unique key a model must answer with. Names are NOT unique in this DS —
 * nine are shared between a hand-written atom and its shadcn/ui counterpart
 * (Button, Card, Badge, Breadcrumb, …) — so the key is the file path.
 */
export function catalogKey(c: CatalogComponent): string {
  return c.file.replace(/\.tsx$/, '');
}

/** One line per component — cheap enough to put the whole DS in a prompt. */
export function renderCatalogForPrompt(catalog: CatalogComponent[]): string {
  return catalog
    .filter((c) => c.category !== 'types' && c.category !== 'hooks' && c.category !== 'lib')
    .map((c) => {
      const variants = c.variants.map((v) => `${v.typeName}=[${v.values.join('|')}]`).join(' ');
      return `${catalogKey(c)} — ${c.name}${variants ? ` ${variants}` : ''}${c.hasCva ? ' [shadcn/cva]' : ''}`;
    })
    .join('\n');
}

/** Where a bare name is ambiguous, the hand-written DS layers win over the shadcn primitives underneath them. */
const CATEGORY_PREFERENCE = ['atoms', 'molecules', 'organisms', 'patterns', 'templates', 'ui', 'charts'];

/**
 * Resolves a model's answer to exactly one catalog entry, or none. Accepts
 * the unique key (`atoms/Button`), the key with `.tsx`, or a bare name when
 * that name is unambiguous or disambiguated by category preference. Never a
 * substring match: "Link" must not silently become CTALink and hand B4 the
 * wrong component's source.
 */
export function resolveCatalogEntry(catalog: CatalogComponent[], answer: string | null): CatalogComponent | null {
  if (!answer) return null;
  const cleaned = answer
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '') // "Button (atoms)"
    .replace(/\s+—.*$/, '') // "atoms/Button — Button"
    .replace(/\.tsx$/, '')
    .replace(/^(?:\.?\/)?(?:design-system\/)?(?:core-v2\/)?(?:src\/)?(?:components\/)?/i, '') // "core-v2/src/atoms/Button"
    .trim()
    .toLowerCase();
  if (!cleaned) return null;
  const byKey = catalog.find((c) => catalogKey(c).toLowerCase() === cleaned);
  if (byKey) return byKey;
  // "atoms/Button/primary": a trailing segment that is one of the entry's own variants.
  const slash = cleaned.lastIndexOf('/');
  if (slash > 0) {
    const head = catalog.find((c) => catalogKey(c).toLowerCase() === cleaned.slice(0, slash));
    const tail = cleaned.slice(slash + 1);
    if (head && head.variants.some((v) => v.values.some((value) => value.toLowerCase() === tail))) return head;
  }
  const byName = catalog.filter((c) => c.name.toLowerCase() === cleaned);
  if (byName.length === 0) return null;
  return [...byName].sort((a, b) => rank(a.category) - rank(b.category))[0] ?? null;
}

function rank(category: string): number {
  const i = CATEGORY_PREFERENCE.indexOf(category);
  return i === -1 ? CATEGORY_PREFERENCE.length : i;
}

/** A variant is kept only if it is one the entry actually declares. */
export function resolveVariant(entry: CatalogComponent, answer: string | null): string | null {
  if (!answer) return null;
  const target = answer.trim().toLowerCase();
  for (const v of entry.variants) {
    const hit = v.values.find((value) => value.toLowerCase() === target);
    if (hit) return hit;
  }
  return null;
}

/**
 * Effective token names for the active variant, as a prompt-friendly list —
 * with each alias's RESOLVED value, so the model sees `--space-4: 1rem
 * (= var(--space-md))` rather than having to chase the chain itself.
 */
export function renderTokensForPrompt(registry: DsRegistry, variant: 'editorial-light' | 'cinematic-dark', filter?: RegExp): string {
  const effective = registry.tokens.effective.find((e) => e.variant === variant);
  if (!effective) return '';
  return [...effective.values.entries()]
    .filter(([name]) => (filter ? filter.test(name) : true))
    .map(([name, value]) => {
      if (!value.includes('var(')) return `${name}: ${value}`;
      const resolved = resolveToken(name, effective.values);
      return resolved === null ? `${name}: ${value} (not statically resolvable)` : `${name}: ${resolved} (= ${value})`;
    })
    .join('\n');
}

export function effectiveTokenMap(registry: DsRegistry, variant: 'editorial-light' | 'cinematic-dark'): Map<string, string> {
  return registry.tokens.effective.find((e) => e.variant === variant)?.values ?? new Map();
}

/** Rules as short lines: id, title, the mechanic, and the prohibition. ALL rules — a rule id the validator accepts must be one the model was shown. */
export function renderRulesForPrompt(registry: DsRegistry): string {
  return registry.rules.rules
    .map((r) => {
      const what = r.fields.WHAT ? ` WHAT: ${r.fields.WHAT.slice(0, 200)}` : '';
      const whenNot = r.fields['WHEN NOT'] ? ` WHEN NOT: ${r.fields['WHEN NOT'].slice(0, 200)}` : '';
      return `${r.id} · ${r.title}${what}${whenNot}`;
    })
    .join('\n');
}

/** The set of rule ids that actually exist — model-cited rule ids are validated against it. */
export function ruleIds(registry: DsRegistry): Set<string> {
  return new Set(registry.rules.rules.map((r) => r.id));
}

/**
 * A DS component's real source, so expectations are derived from the code.
 * Verbatim, comments included — the DS documents intent in them ("secondary
 * light · brand-red ON HOVER · black/70 rest … per R4.1.1"), which is exactly
 * what B4 needs. The cap is generous (the largest component is ~39k): the
 * old blind 12k head cut Button.tsx (19k) before its radius and tracking
 * classes, so those properties were never governed. Only a file over the cap
 * loses its line-start comments first, and if it is STILL over, the model is
 * told so explicitly, so an omission is never read as "not governed".
 */
export async function readComponentSource(registry: DsRegistry, file: string, maxChars = 60_000): Promise<string> {
  const abs = join(registry.designSystemPath, 'core-v2/src', file);
  const raw = await readFile(abs, 'utf-8');
  if (raw.length <= maxChars) return raw;
  const text = stripComments(raw);
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n/* SOURCE TRUNCATED at ${maxChars} chars of ${text.length} — properties defined after this point are NOT shown; do not treat them as ungoverned. */`
    : text;
}

/**
 * Removes comments that START a line — the JSDoc blocks and `//` notes that
 * make up most of a documented atom. Deliberately conservative: a mid-line
 * `//` may be a URL inside a class string or JSX text, and a tokenizer that
 * tracks quotes can be derailed by an apostrophe in JSX text (`Don't`) into
 * deleting real code. Leaving an inline comment in costs a few tokens;
 * deleting a className would silently un-govern a property.
 */
export function stripComments(source: string): string {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*\r?\n?/gm, '')
    .replace(/^[ \t]*\/\/.*\r?\n?/gm, '')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
}

/** Exact resolution only — see resolveCatalogEntry. Kept for callers that have a name, not a model answer. */
export function findCatalogEntry(catalog: CatalogComponent[], dsComponent: string): CatalogComponent | undefined {
  return resolveCatalogEntry(catalog, dsComponent) ?? undefined;
}
