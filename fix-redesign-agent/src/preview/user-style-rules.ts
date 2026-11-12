import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { PreviewNode } from './types.ts';

/**
 * Project-level user style rules (`projects/<project>/user-style-rules.json`): a page-specific design instruction from the user that is not a general
 * pipeline rule ("these cards have square corners — only these"). Read by the preview generator, so it survives `preview --regenerate`, and labelled in
 * the run's artifacts as a user instruction. It never touches the audit, the Fix Plan or the Design System, and it only restyles — no content, link or
 * structure changes.
 *
 * ```json
 * { "schemaVersion": 1, "rules": [{
 *   "id": "what-sets-us-apart-square-cards",
 *   "section": "what-sets-us-apart",
 *   "match": { "tag": "div", "classIncludes": ["border-[#EDECFB]", "h-[140px]"] },
 *   "style": { "border-radius": "0" },
 *   "descendants": [{ "match": { "classIncludes": ["rounded-"] }, "style": { "border-radius": "0" } }],
 *   "reason": "User (chat): square corners on the 01–09 cards only"
 * }] }
 * ```
 * `match` selects element nodes of the section by tag and class substrings (all must be present, a class is the original's own class attribute).
 * `descendants` restyle DIRECT children of a matched element the same way. A value is limited to what the project's rules allow without a design-system
 * token: `0`, `none`, `transparent`, `currentcolor`, `1px`, or `var(--token)`. Two alignment keywords are allowed for exactly one property each
 * (user instruction 2026-10-27, "CTA on the right as on the Brand Perception page"): `justify-content: flex-end` and `margin-left: auto` (and, since 2026-10-29, `height: auto`, to give a pill back the height a DS button target forced on it). A matched
 * element that the generator replaces with a design-system island (a CTALink) hands these two to the island's slot wrapper, which is the box that
 * holds the replacement's place in its parent (`islandStyles`).
 */
export interface UserStyleMatch { tag?: string; classIncludes?: string[] }
export interface UserStyleRule {
  id: string;
  section: string;
  match: UserStyleMatch;
  style: Record<string, string>;
  descendants?: Array<{ match: UserStyleMatch; style: Record<string, string> }>;
  reason: string;
  shared?: boolean;
}
export interface UserStyleRulesFile { schemaVersion: 1; rules: UserStyleRule[] }

/** `section: "*"` in the shared file: the rule is tried in every section of the page (it still needs a tag or class match — it never selects "everything"). */
export const ALL_SECTIONS = '*';

/** Marks the rules of the repo-level shared file (`user-style-rules.shared.json`): a section that is the same on several pages gets the same design on every one of them. */
export function markShared(file: UserStyleRulesFile | null): UserStyleRulesFile | null {
  return file ? { schemaVersion: 1, rules: file.rules.map((r) => ({ ...r, shared: true })) } : null;
}

/** The shared rules first, then the project's own; an id used by both is an error (a project never silently redefines a shared rule). */
export function mergeUserStyleRules(shared: UserStyleRulesFile | null, project: UserStyleRulesFile | null): UserStyleRulesFile | null {
  if (!shared && !project) return null;
  for (const r of project?.rules ?? []) if (r.section === ALL_SECTIONS) throw new Error(`user style rule "${r.id}": section "*" (every section) is only allowed in the shared file`);
  const rules = [...(markShared(shared)?.rules ?? []), ...(project?.rules ?? [])];
  const seen = new Set<string>();
  for (const r of rules) { if (seen.has(r.id)) throw new Error(`user style rule id "${r.id}" is defined in both the shared file and the project file`); seen.add(r.id); }
  return { schemaVersion: 1, rules };
}

const PROP = /^[a-z][a-z-]*$/;
const VALUE = /^(0|none|transparent|currentcolor|1px|var\(--[\w-]+\))$/;
/** The only keyword values that are not a token or a zero: one alignment value per property, nothing else. */
const ALIGNMENT_VALUE: Record<string, string> = { 'justify-content': 'flex-end', 'margin-left': 'auto', 'height': 'auto' };
/** The two alignment keywords that belong to an island's slot wrapper (`height: auto` only restyles the matched element itself). */
const SLOT_ALIGNMENT = new Set(['justify-content', 'margin-left']);
const allowedValue = (prop: string, v: string) => VALUE.test(v) || ALIGNMENT_VALUE[prop] === v;
const ID = /^[a-z0-9][a-z0-9-]*$/;

function checkStyle(where: string, style: unknown): Record<string, string> {
  if (typeof style !== 'object' || style === null || Array.isArray(style) || Object.keys(style).length === 0) throw new Error(`${where}: "style" must be a non-empty object of CSS properties`);
  for (const [k, v] of Object.entries(style as Record<string, unknown>)) {
    if (!PROP.test(k) || typeof v !== 'string' || !allowedValue(k, v)) throw new Error(`${where}: "${k}: ${String(v)}" is not allowed — properties are lower-case CSS names and values are 0, none, transparent, currentcolor, 1px or var(--design-system-token) (plus justify-content: flex-end, margin-left: auto and height: auto)`);
  }
  return style as Record<string, string>;
}
function checkMatch(where: string, m: unknown): UserStyleMatch {
  if (typeof m !== 'object' || m === null) throw new Error(`${where}: "match" is required`);
  const { tag, classIncludes } = m as UserStyleMatch;
  if (tag !== undefined && !/^[a-z][a-z0-9]*$/.test(tag)) throw new Error(`${where}: match.tag "${tag}" is not a tag name`);
  if (classIncludes !== undefined && (!Array.isArray(classIncludes) || classIncludes.some((c) => typeof c !== 'string' || c.length === 0))) throw new Error(`${where}: match.classIncludes must be a list of non-empty strings`);
  if (tag === undefined && (classIncludes ?? []).length === 0) throw new Error(`${where}: match needs a tag or at least one class substring — a rule never selects "everything"`);
  return { ...(tag ? { tag } : {}), ...(classIncludes ? { classIncludes } : {}) };
}

/** Reads and validates the file; null when the project has none. A malformed file is an error, never silently ignored. */
export async function readUserStyleRules(path: string): Promise<UserStyleRulesFile | null> {
  if (!existsSync(path)) return null;
  const j = JSON.parse(await readFile(path, 'utf8')) as Partial<UserStyleRulesFile>;
  if (j.schemaVersion !== 1 || !Array.isArray(j.rules)) throw new Error(`${path} is not a user-style-rules file (expected { "schemaVersion": 1, "rules": [ … ] })`);
  const ids = new Set<string>();
  const rules = j.rules.map((r, i): UserStyleRule => {
    const where = `${path} rules[${i}]`;
    if (typeof r?.id !== 'string' || !ID.test(r.id) || ids.has(r.id)) throw new Error(`${where}: "id" must be a unique lower-case slug`);
    ids.add(r.id);
    if (typeof r.section !== 'string' || !r.section) throw new Error(`${where}: "section" (a section id) is required`);
    if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error(`${where}: "reason" (who asked, and what) is required — it is shown in the run's artifacts`);
    return {
      id: r.id, section: r.section, reason: r.reason, match: checkMatch(where, r.match), style: checkStyle(where, r.style),
      ...(r.descendants ? { descendants: r.descendants.map((d, k) => ({ match: checkMatch(`${where} descendants[${k}]`, d.match), style: checkStyle(`${where} descendants[${k}]`, d.style) })) } : {}),
    };
  });
  return { schemaVersion: 1, rules };
}

const matches = (n: PreviewNode, m: UserStyleMatch): n is PreviewNode & { t: 'el' } => {
  if (n.t !== 'el') return false;
  if (m.tag && n.tag !== m.tag) return false;
  const cls = n.attrs['class'] ?? '';
  return (m.classIncludes ?? []).every((c) => cls.includes(c));
};

export interface AppliedUserRule { id: string; section: string; matched: number; reason: string; /** from the repo-level shared file: applies to every page that has this section */ shared?: boolean }

/**
 * Marks the matched nodes (`data-pv-user-rule`) and returns the CSS that restyles them, plus what each rule matched. Mutates the trees of `sections`.
 * A rule that matches nothing is reported with `matched: 0` — never silently dropped. The selector is doubled so it outranks the Resolver's per-element
 * `[data-fra-element="eN"]` edits (both are !important); it is appended after them.
 */
export function applyUserStyleRules(file: UserStyleRulesFile | null, sections: ReadonlyArray<{ id: string; tree: PreviewNode }>): { css: string; applied: AppliedUserRule[]; islandStyles: Map<string, Record<string, string>> } {
  const islandStyles = new Map<string, Record<string, string>>();
  if (!file) return { css: '', applied: [], islandStyles };
  const css: string[] = [];
  const applied: AppliedUserRule[] = [];
  const decl = (style: Record<string, string>) => Object.entries(style).map(([k, v]) => `${k}: ${v} !important;`).join(' ');
  for (const rule of file.rules) {
    // `*` (shared file only): every section of the page, so a rule about the site's own ink or card look holds on every page whatever the section is called
    const targets = rule.section === ALL_SECTIONS ? sections : sections.filter((s) => s.id === rule.section);
    let matched = 0;
    // An element can be named by several rules (a shared ink rule and a card rule): ids are space-joined and the styles merged (a later rule wins per property), so none is lost.
    const mark = (n: PreviewNode, id: string, style: Record<string, string>) => {
      if (n.t !== 'el') return;
      const prevIds = n.attrs['data-pv-user-rule'];
      const merged = new Map<string, string>(parseUserStyle(n.attrs['data-pv-user-style'] ?? null));
      for (const [k, v] of Object.entries(style)) merged.set(k, v);
      n.attrs = { ...n.attrs, 'data-pv-user-rule': prevIds ? `${prevIds} ${id}` : id, 'data-pv-user-style': [...merged].map(([k, v]) => `${k}:${v}`).join(';') };
    };
    const walk = (n: PreviewNode) => {
      if (n.t !== 'el') return;
      if (matches(n, rule.match)) {
        matched++;
        mark(n, rule.id, rule.style);
        // the alignment keywords belong to the box that holds the element's place; when the element becomes an island, that box is the island's slot wrapper
        const align = Object.fromEntries(Object.entries(rule.style).filter(([k, v]) => SLOT_ALIGNMENT.has(k) && ALIGNMENT_VALUE[k] === v));
        if (n.elementStamp && Object.keys(align).length) islandStyles.set(n.elementStamp, { ...(islandStyles.get(n.elementStamp) ?? {}), ...align });
        (rule.descendants ?? []).forEach((d, k) => { for (const c of n.children) if (matches(c, d.match)) mark(c, `${rule.id}-d${k}`, d.style); });
      }
      n.children.forEach(walk);
    };
    for (const s of targets) walk(s.tree);
    applied.push({ id: rule.id, section: rule.section, matched, reason: rule.reason, ...(rule.shared ? { shared: true } : {}) });
    if (matched === 0) continue;
    css.push(`/* user style rule "${rule.id}" — ${rule.reason.replace(/\*\//g, '')} */`);
    css.push(`[data-pv-user-rule~="${rule.id}"][data-pv-user-rule] { ${decl(rule.style)} }`);
    (rule.descendants ?? []).forEach((d, k) => css.push(`[data-pv-user-rule~="${rule.id}-d${k}"][data-pv-user-rule] { ${decl(d.style)} }`));
  }
  return { css: css.join('\n'), applied, islandStyles };
}

/** Folds a rule's alignment keywords into an island's slot wrapper style (camel-cased for the generated JSX). `margin-left: auto` replaces the left margin of the shorthand. */
export function applyIslandAlignment(wrapper: Record<string, string>, align: Record<string, string> | undefined): Record<string, string> {
  if (!align) return wrapper;
  const out = { ...wrapper };
  if (align['justify-content'] === 'flex-end') out['justifyContent'] = 'flex-end';
  if (align['margin-left'] === 'auto') {
    const parts = (out['margin'] ?? '0px 0px 0px 0px').split(/\s+/);
    out['margin'] = `${parts[0] ?? '0px'} ${parts[1] ?? '0px'} ${parts[2] ?? parts[0] ?? '0px'} auto`;
  }
  return out;
}

/** Parses `data-pv-user-style` ("border-radius:0;color:var(--x)") back into property/value pairs. */
export function parseUserStyle(attr: string | null): Array<[string, string]> {
  return (attr ?? '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf(':'); return [p.slice(0, i), p.slice(i + 1)] as [string, string]; });
}
