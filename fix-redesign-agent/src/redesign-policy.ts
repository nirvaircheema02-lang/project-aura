import { readFileSync } from 'node:fs';
import { cssValueInjection, isCssPropertyName, RAW_TEXT_ELEMENTS, selectorInjection, selectorSubjectTag, selectorWithoutStateConditions } from './dom/apply-edit.ts';
import type { Finding } from './audit-link/index.ts';
import type { TargetedEdit } from './llm/schemas/r-nodes.ts';
import type { MappingEntry } from './mapping/types.ts';
import { stateOfEdit } from './resolution/progress.ts';
import { canonicalValue, colourLikeTokens, coveredByAny, extractColours, isColourFunction, roleForProperty, shorthandCovers, suppliesProperty } from './resolution/ds-colours.ts';
import { resolveTokenInScope, type DsTokenIndex } from './resolution/ds-evidence.ts';
import { authorizedProperties, type ResolutionFile, type ResolvedTarget, type StateName } from './resolution/schema.ts';
import { propertyMatchesExpected } from './style/compare-expected.ts';

/** One canonical policy, shared by future coding sessions and runtime judgments. */
export const REDESIGN_RULES = readFileSync(new URL('../docs/REDESIGN_RULES.md', import.meta.url), 'utf8');
export const POLICY_REFUSAL = 'Project redesign policy:';
const DARK_CTA_TOKEN = '--composition-gradient-brand-dark-shimmer';
const PRIMARY = /(?:^|[^a-z0-9_-])primary(?:$|[^a-z0-9_-])/i;
const BUTTON = /button|cta/i;
const PROTECTED_PROPERTY = /^(?:text-align|display|position|top|right|bottom|left|inset(?:-.+)?|float|clear|order|grid(?:-.+)?|flex(?:-.+)?|align(?:-.+)?|justify(?:-.+)?|overflow(?:-.+)?|scroll(?:-.+)?|transform|translate)$/;

function isCta(edit: TargetedEdit, finding?: Finding, entry?: MappingEntry): boolean {
  return BUTTON.test([edit.dsComponent, finding?.component.dsComponent, finding?.component.productionType,
    entry?.dsReference.dsComponent, entry?.affordances.tagName, entry?.affordances.role].filter(Boolean).join(' '));
}

/** What the colour guard may consult beyond the resolution: the DS index, to recognise a `var()` alias of the target's own colour (style edits) and a DS token in a class's arbitrary value. Without it neither can be shown, and both are refused. */
export interface PolicyContext {
  dsIndex?: DsTokenIndex | null;
}

/** A target whose value is a colour, a shadow, a border or an outline: a resolved target the Resolver derived with a colour comparison, or on a colour-bearing property. */
const isColourTarget = (t: ResolvedTarget): boolean => t.outcome === 'resolved-target' && t.target !== null && (t.target.comparison === 'color-deltaE' || roleForProperty(t.property) !== 'unknown');

const norm = (v: string): string => v.replace(/\s*!important\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The `var()` names of a value and the text with every `var(...)` replaced by its FALLBACK text: the colour-bearing text a scanner must read (a fallback is a colour the page would paint). */
function splitVars(value: string): { vars: string[]; text: string } {
  const vars: string[] = [];
  let text = '';
  let i = 0;
  while (i < value.length) {
    const open = /(?:^|[^\w-])var\s*\(/i.exec(value.slice(i));
    if (!open) { text += value.slice(i); break; }
    const at = i + open.index + open[0].search(/var/i);
    const parenAt = value.indexOf('(', at);
    let depth = 0; let end = value.length;
    for (let j = parenAt; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')' && --depth === 0) { end = j; break; }
    }
    text += `${value.slice(i, at)} `;
    const inner = value.slice(parenAt + 1, end);
    let comma = -1; let d = 0;
    for (let j = 0; j < inner.length; j++) { if (inner[j] === '(') d++; else if (inner[j] === ')') d--; else if (inner[j] === ',' && d === 0) { comma = j; break; } }
    vars.push((comma < 0 ? inner : inner.slice(0, comma)).trim());
    if (comma >= 0) { const sub = splitVars(inner.slice(comma + 1)); vars.push(...sub.vars); text += ` ${sub.text} `; }
    i = end + 1;
  }
  return { vars, text };
}

/** Every function name of a value (strings skipped), lower case. */
const functionNames = (text: string): string[] => [...text.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/(?<![\w-])(-?[a-z][\w-]*)\s*\(/gi)].map((m) => (m[1] ?? '').toLowerCase());

/** The functions a colour-bearing value may use besides the ones that write a colour (those are read as colours and compared with the target): length arithmetic. `attr()`, `env()`, `element()`, `paint()` ... can paint a colour no scanner of the text can see. */
const MATH_FUNCTIONS: ReadonlySet<string> = new Set(['calc', 'min', 'max', 'clamp', 'abs', 'sign', 'round', 'mod', 'rem', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log', 'exp']);
const FILTER_FUNCTIONS: ReadonlySet<string> = new Set(['blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia']);
/** Properties whose value is made of NAMES, not colours: `background` in `transition: background .2s` is a property name, `Menu` in `font-family` a font - neither is the system colour of the same spelling. */
const NAME_LIST_PROPERTY = /^(?:transition(?:-property)?|will-change|animation(?:-name)?|font(?:-family)?|grid(?:-(?:area|row|column|template-areas))?|view-transition-name|anchor-name|container(?:-name)?|counter-(?:reset|increment|set)|list-style(?:-type)?|content|quotes|cursor)$/;
/** Colour-taking properties that `roleForProperty` has no role for (`accent-color`, `stop-color`, `scrollbar-color` ... and the filters / masks that carry colours). */
const COLOUR_PROPERTY = /(?:^|-)color$|^(?:filter|backdrop-filter|text-emphasis|-webkit-text-stroke|mask(?:-image)?|-webkit-mask(?:-image)?|border-image(?:-source)?)$/;

/** What a colour edit of one property may be: a resolved target's value (and token), or - for a finding with no target - the colour the audit itself measured for that property. */
interface Want { property: string; value: string; token: string | null; theme: ResolvedTarget['theme'] }

/** The state the audit measured a finding in: its `captureState` when that names an interaction state, else the default. */
const auditStateOf = (finding?: Finding): StateName => {
  const s = (finding?.location.captureState ?? '').trim().toLowerCase();
  return s === 'hover' || s === 'focus' || s === 'focus-visible' || s === 'active' ? s : 'default';
};

/** Is `selector` the stamped element itself (a bare stamp, at most with interaction-state conditions)? Anything else addresses a descendant. */
const addressesStampItself = (selector: string): boolean => /^\[data-fra-element="[^"]+"\]$/.test(selectorWithoutStateConditions(selector).trim());

/** The audit's own mismatch list for the finding: property (a `label.` part prefix removed), the part it names, and what it expected. */
const auditMismatches = (finding?: Finding): Array<{ property: string; part: string; expected: string; token: string | null }> =>
  (finding?.comparison.mismatches ?? []).map((m) => {
    const dot = m.property.indexOf('.');
    return { property: (dot < 0 ? m.property : m.property.slice(dot + 1)).trim().toLowerCase(), part: dot < 0 ? 'self' : m.property.slice(0, dot), expected: m.expected, token: m.expectedToken };
  });

/**
 * Colour is bound by CONTENT, not by the name of the property it is written in - and by the FINDING, not by the one property it is mostly written in.
 *
 * Boundary (exact), for a `resolution` that exists (no resolution => the Resolver's own audit-expected pre-check and legacy calls: nothing is enforced):
 *  - a finding that HAS targets (any outcome): a style edit that is colour-bearing - a colour property or a shorthand that sets one (`roleForProperty`, `*-color`,
 *    filters), a custom property is NOT judged here (see `customPropertyViolation`), or any value with a colour-like token (named, system, vendor, hex, functional, a
 *    gradient, inside a `var()` fallback) - is refused unless a RESOLVED colour target of this finding and this state supplies the property and the edit states that
 *    target: its own value (whatever colour forms that is written in: a gradient, a shadow list), a colour parse-equal to it within the verifier tolerance,
 *    `var(<its token>)`, or a DS token the DS index shows to be the same colour. `var(--x)` of anything else - a page custom property above all - is refused, and so is
 *    any function that is not a colour or length arithmetic (`attr()`, `env()` ...). A KEYWORD (`transparent`, `currentcolor`, `none`, `inherit`) is free only on a
 *    property no colour target of this state supplies.
 *  - a finding with NO target (rule-driven / component-level, `noTargetFindings`) is bound the same way, with the AUDIT as the only source of a wanted colour: the
 *    value the audit's own mismatch list expects for a property that supplies this one, in the audit's state (its token, its value in any spelling, a DS alias of it).
 *    Beyond that a colour is limited to a keyword, and `var(--x)` to a DS token the DS INDEX has (so without an index no variable passes); a raw colour, a page
 *    custom property and any other function are refused. A rule-driven edit is a DS token or a keyword, never a colour of the model's choosing.
 * Values of non-colour properties (lengths, durations, names) are not touched here. Binding by property name left every shorthand, sibling longhand, other state and
 * `exact` shadow / border / outline target open to a raw colour that only R5/R8 would see - after the page had been painted with it.
 *
 * The resolved-target `value` is what R3 synthesizes, R4 applies and R5/R8 measure; a different colour is by definition not the target.
 */
function colourValueViolation(edit: TargetedEdit, property: string, ownTargets: ResolvedTarget[], finding: Finding | undefined, ctx: PolicyContext | undefined): string | null {
  const state = stateOfEdit(edit);
  const bound = ownTargets.length > 0;
  const supplying = ownTargets.filter((t) => isColourTarget(t) && t.state === state && suppliesProperty(t.property.trim().toLowerCase(), property));
  const itself = addressesStampItself(edit.selector);
  const wants: Want[] = bound
    ? supplying.map((t) => ({ property: t.property, value: t.target!.value, token: t.target!.token, theme: t.theme }))
    : state !== auditStateOf(finding) ? [] : auditMismatches(finding).filter((m) => (m.part === 'self') === itself && suppliesProperty(m.property, property)).map((m) => ({ property: m.property, value: m.expected, token: m.token, theme: 'inherit' as const }));
  const { vars, text } = splitVars(norm(edit.value));
  const names = NAME_LIST_PROPERTY.test(property);
  const spans = extractColours(text).filter((c) => !names || /^#|\(/.test(c.text));
  const current = !names && /\bcurrentcolor\b/i.test(text);
  const badFunctions = names ? [] : [...new Set(functionNames(text).filter((f) => !MATH_FUNCTIONS.has(f) && !isColourFunction(f) && !(/filter$/.test(property) && FILTER_FUNCTIONS.has(f))))];
  const bearing = roleForProperty(property) !== 'unknown' || COLOUR_PROPERTY.test(property) || spans.length > 0 || current;
  if (!bearing) return null;

  // an edit that IS a wanted value is the target, whatever colour forms it is written in
  const canonical = canonicalValue(edit.value);
  if (wants.some((w) => canonicalValue(w.value) === canonical)) return null;

  const wantColours = wants.flatMap((w) => extractColours(norm(w.value))).filter((c) => c.rgba !== null);
  const wantsCurrent = wants.some((w) => /\bcurrentcolor\b/i.test(w.value));
  const ds = ctx?.dsIndex ?? null;
  const aliasOfWant = (name: string): boolean => ds !== null && wants.some((w) => {
    const r = resolveTokenInScope(ds, name, w.theme === 'light' || w.theme === 'dark' ? w.theme : 'unknown');
    return r.outcome === 'resolved-target' && r.value !== null && (norm(r.value) === norm(w.value) || propertyMatchesExpected('color-deltaE', r.value, w.value.trim()).matches);
  });

  const problems: string[] = [];
  for (const name of vars) {
    if (!/^--[\w-]+$/.test(name)) problems.push(`"${name}" is not a custom-property name`);
    else if (wants.length === 0) {
      // a finding with targets takes no variable on a property no colour target supplies; one without any takes a DS token of the index
      if (bound) problems.push(`var(${name})`);
      else if (ds === null) problems.push(`var(${name}) (no DS index is available to show it is a DS token)`);
      else if (ds.lookup(name).length === 0) problems.push(`var(${name}) is not a DS token`);
    } else if (!wants.some((w) => w.token !== null && w.token.toLowerCase() === name.toLowerCase()) && !aliasOfWant(name)) {
      problems.push(`var(${name}) is not the ${bound ? "target's" : "audit's"} token${ds === null ? ' (and no DS index is available to show it resolves to that colour)' : ' and does not resolve to that colour'}`);
    }
  }
  for (const c of spans) {
    if (c.rgba === null) problems.push(`${c.text} (${c.unsupported ?? 'not a static colour'})`);
    else if (c.keyword === 'transparent' && wants.length === 0) continue;
    else if (!wantColours.some((w) => propertyMatchesExpected('color-deltaE', c.text, w.text).matches)) problems.push(c.text);
  }
  if (current && wants.length > 0 && !wantsCurrent) problems.push('currentcolor');
  for (const f of badFunctions) problems.push(`${f}() (a function that is neither a colour nor length arithmetic: it can paint a colour no scan of the text sees)`);
  // a value of a supplied property that names neither a colour nor a token is not the target either (`none`, `inherit`, `1px solid` resetting the border colour to currentcolor): it must be the target's text
  const named = vars.length + spans.length + (current ? 1 : 0) > 0;
  if (problems.length === 0 && wants.length > 0 && !named) problems.push(`"${edit.value}" names no colour or token`);
  if (problems.length === 0) return null;

  const source = bound ? 'resolved target colour' : 'DS token or audit-expected colour';
  const targets = wants.length === 0
    ? bound ? `no colour target of the ${state} state sets ${property}` : `the finding has no resolved target and the audit expects no colour for ${property} in the ${state} state`
    : wants.map((w) => `${w.property} = ${w.value}${w.token ? ` (${w.token})` : ''}`).join('; ');
  return `${POLICY_REFUSAL} ${property} (${state} state): "${edit.value}" carries ${problems.join(', ')}, which is not a ${source} (${targets}). A colour that is not the resolved target is never applied, in any property or shorthand: use ${wants[0] ? `the ${bound ? "target's" : "audit's"} value or var(${wants[0].token ?? '<its token>'})` : bound ? 'the resolved target' : 'a DS token'}.`;
}

/**
 * A custom property carries anything a rule of the page consumes - a colour channel triple (`hsl(var(--c))`), a length, a name - so what it holds cannot be read from
 * its value. A redesign edit of one is refused unless its value is exactly a RESOLVED target's value or `var(<that target's token>)`, and always for a finding that has
 * no target: no property is wanted, so nothing can be written into a custom one.
 */
function customPropertyViolation(edit: TargetedEdit, property: string, ownTargets: ResolvedTarget[]): string | null {
  const resolved = ownTargets.filter((t) => t.outcome === 'resolved-target' && t.target !== null);
  const flat = (v: string): string => norm(v).replace(/\s+/g, '');
  const given = flat(edit.value);
  if (resolved.some((t) => canonicalValue(t.target!.value) === canonicalValue(edit.value) || (t.target!.token !== null && given === `var(${t.target!.token.toLowerCase()})`))) return null;
  return `${POLICY_REFUSAL} custom property ${property}: "${edit.value}" is not a resolved target's value or var(<its token>)${resolved.length === 0 ? ' (the finding has no resolved target)' : ''}. A custom property can carry anything the page's own rules consume - a colour channel triple, a length - so a redesign edit of one is refused unless it states a target exactly.`;
}

// ── class / component-swap edits ────────────────────────────────────────────────────────────────

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe';
/** Tailwind's built-in palette (`text-red-500`, `border-sky-400/50`, `from-indigo-500`) and `black` / `white` on a colour utility: raw colours, not DS tokens. */
const PALETTE_UTILITY = new RegExp(`^(?:[a-z]+-)+(?:${PALETTE})-(?:50|[1-9]00|950)(?:/.+)?$|^(?:bg|text|border(?:-[a-z]+)?|ring(?:-offset)?|outline|divide|accent|caret|fill|stroke|decoration|shadow|from|via|to|placeholder|inset-ring)-(?:black|white)(?:/.+)?$`);
/** The utilities that take a colour: a `var()` in their arbitrary value is a colour and must be a DS token. (`rounded-[var(--radius-sm)]`, `w-[var(--w)]` are not.) */
const COLOUR_UTILITY = /^(?:bg|text|border|ring|outline|divide|accent|caret|fill|stroke|decoration|shadow|drop-shadow|inset-ring|inset-shadow|text-shadow|from|via|to|placeholder|stop|scrollbar|selection)(?:-[a-z]+)*$/;
/** Functions that load or read something the text does not show: never in an arbitrary class value. */
const OPAQUE_FUNCTION: ReadonlySet<string> = new Set(['attr', 'env', 'url', 'image', 'image-set', '-webkit-image-set', 'element', 'paint', 'src', 'cross-fade', '-webkit-cross-fade']);

/** The utility of a class token: variants (`md:hover:`), the important marker and a negative sign removed, brackets respected (`[&:hover]:bg-x`, `[color:red]`). */
function utilityOf(token: string): string {
  let depth = 0; let from = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token.charAt(i);
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) from = i + 1;
  }
  return token.slice(from).replace(/^!|!$/g, '').replace(/^-(?=[a-z[(])/, '');
}

/**
 * What an arbitrary-value utility holds: the CSS text of its brackets (`_` is a space, a `color:` / `length:` type hint or the property of `[prop:value]` removed),
 * whether that text is a variable NAME (`bg-(--x)`), and whether it is a colour (a colour utility with no other type hint, or a colour / custom property).
 */
function arbitraryOf(utility: string): { content: string; variable: boolean; colour: boolean } | null {
  const bracket = /^(?:(.+?)-)?\[(.+)\](?:\/.+)?$/.exec(utility);
  const paren = bracket ? null : /^(.+?)-\((.+)\)$/.exec(utility);
  const m = bracket ?? paren;
  if (!m) return null;
  const prefix = m[1] ?? '';
  const head = /^([\w-]+):(.*)$/s.exec((m[2] ?? '').replace(/_/g, ' '));
  const content = head ? (head[2] ?? '') : (m[2] ?? '').replace(/_/g, ' ');
  const hint = head?.[1];
  const colour = prefix === ''
    ? hint === undefined || hint.startsWith('--') || roleForProperty(hint) !== 'unknown' || COLOUR_PROPERTY.test(hint)
    : COLOUR_UTILITY.test(prefix) && (hint === undefined || hint === 'color');
  return { content, variable: paren !== null, colour };
}

/**
 * Class and component-swap edits add Tailwind utilities, and the preview scaffold (Tailwind v4, JIT) generates real CSS for whatever arbitrary value or palette
 * utility the source contains: a class is a style edit in another spelling. For a finding in a resolution - with targets or without (the same boundary as
 * `colourValueViolation`; a finding with none has no target token, so only a DS-index token passes) - a class value is refused when it carries a raw colour: an
 * arbitrary value or property whose bracket holds a colour, a gradient or a colour function (`border-[#ff00aa]`, `bg-[color:red]`, `shadow-[0_0_0_1px_#ff00aa]`,
 * `[color:red]`), a `var()` of a colour utility that is not the finding's target token or a DS token (`bg-(--page-raw)`, and its v3 spellings `bg-[--page-raw]` /
 * `bg-[color:--page-raw]`),
 * a function that is not length arithmetic in a colour utility, or that loads or reads something anywhere (`attr()`, `env()`, `url()`), or a default-palette
 * utility (`text-red-500`, `border-sky-400/50`, `bg-black`, `text-white`).
 * Stays allowed: layout / spacing / sizing / typography utilities, arbitrary LENGTHS and calculations (`w-[calc(100%-2rem)]`, `grid-cols-[repeat(2,1fr)]`),
 * `transparent` / `current` / `inherit` utilities, DS-token-backed utilities (`bg-surface-card`: not in the palette), and `var(--ds-token)` where the DS index has
 * the token. The black-CTA rule has its own, earlier message.
 *
 * Not seen: a class the PAGE's own CSS defines (`bg-brand-red`, `.is-promo`) - its colour is not in its name. The rendered measurement (R5 on the live page, R8 in the
 * preview) reads what it painted, and a target that is not met is never reported fixed.
 */
function classValueViolation(edit: TargetedEdit, ownTargets: ResolvedTarget[], ctx: PolicyContext | undefined): string | null {
  const ds = ctx?.dsIndex ?? null;
  const tokens = new Set(ownTargets.flatMap((t) => (t.target?.token ? [t.target.token.toLowerCase()] : [])));
  const knownVar = (name: string): boolean => /^--[\w-]+$/.test(name) && (tokens.has(name.toLowerCase()) || (ds !== null && ds.lookup(name).length > 0));
  const refuse = (token: string, why: string): string => `${POLICY_REFUSAL} class "${token}" ${why}; a class is a style edit in another spelling, and a raw colour is never applied: use a DS-token-backed utility or the resolved target.`;

  for (const token of edit.value.split(/\s+/).filter(Boolean)) {
    const utility = utilityOf(token);
    if (PALETTE_UTILITY.test(utility)) return refuse(token, 'is a default-palette colour utility, not a DS token');
    const arbitrary = arbitraryOf(utility);
    if (!arbitrary) continue;
    // `bg-(--x)` (v4) and `bg-[--x]` / `bg-[color:--x]` (v3 shorthand) are `var(--x)` with no var() text to see
    const bare = arbitrary.variable || /^--[\w-]+$/.test(arbitrary.content.trim());
    const { vars, text } = bare ? { vars: [arbitrary.content.split(',')[0]?.trim() ?? ''], text: '' } : splitVars(arbitrary.content.toLowerCase());
    const unknown = arbitrary.colour ? vars.find((name) => !knownVar(name)) : undefined;
    if (unknown !== undefined) return refuse(token, `uses var(${unknown}), which is neither the target's token nor a DS token${ds === null ? ' (no DS index is available to show it is one)' : ''}`);
    const colours = colourLikeTokens(text).filter((c) => !/^(?:transparent|currentcolor)$/i.test(c));
    if (colours.length > 0) return refuse(token, `carries the raw colour ${colours.join(', ')}`);
    const bad = functionNames(text).find((f) => (arbitrary.colour ? !MATH_FUNCTIONS.has(f) : OPAQUE_FUNCTION.has(f)));
    if (bad !== undefined) return refuse(token, `uses ${bad}(), which can paint a colour no scan of the text sees`);
  }
  return null;
}

/**
 * Layout-neutral style properties: they change how an element is painted, not where it or its neighbours sit or what it says, so a finding with no target of its own
 * (a rule-driven or component-level one) may still set them - to a DS token (colour-bearing ones are bound by `colourValueViolation`). Radius, border width / style
 * (a hairline), outline, a transition, the cursor and the underline. Everything else needs a resolved target or the audit's own mismatch to name it.
 */
const LAYOUT_NEUTRAL_PROPERTY = /^(?:border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?-(?:width|style)|border-(?:width|style)|border-radius|border-(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end))-radius|outline-(?:width|style|offset)|transition(?:-.+)?|cursor|text-decoration-(?:line|style|thickness)|text-underline-offset)$/;

/** A property that is a colour (a role, or `*-color`): the colour guard binds it, so it is not also authorised by name. */
const isColourProperty = (property: string): boolean => roleForProperty(property) !== 'unknown' || /(?:^|-)color$/.test(property);

/**
 * Authorization of a NON-colour style property (the rule text: an edit of a property that is not a resolved target is refused). An edit may change only what a
 * RESOLVED target of this finding and this state supplies, and what the audit's own mismatch list names (the audit measured it for this finding, in its state), and
 * never more than that: `padding` is refused when only `padding-left` was granted, `padding-inline-start` is covered by it (`coveredByAny`: every longhand the edit
 * writes is granted; logical and physical names are one property). The stamped element itself is authorised by a `self` target; a descendant selector, which cannot say
 * which part it addresses, by a target of any part. Layout-neutral properties (`LAYOUT_NEUTRAL_PROPERTY`) are free. `all` and custom properties never get here.
 */
function propertyAuthorizationViolation(edit: TargetedEdit, property: string, ownTargets: ResolvedTarget[], finding: Finding | undefined): string | null {
  if (LAYOUT_NEUTRAL_PROPERTY.test(property)) return null;
  const state = stateOfEdit(edit);
  const itself = addressesStampItself(edit.selector);
  const granted = ownTargets.filter((t) => t.outcome === 'resolved-target' && t.state === state && (!itself || t.part === 'self')).map((t) => t.property.trim().toLowerCase());
  if (state === auditStateOf(finding)) granted.push(...auditMismatches(finding).filter((m) => (m.part === 'self') === itself).map((m) => m.property));
  if (coveredByAny(property, granted)) return null;
  return `${POLICY_REFUSAL} ${property} (${state} state) is not authorized: no resolved target of this finding in the ${state} state${state === auditStateOf(finding) ? " and no mismatch of the audit's own list" : ''} supplies ${granted.length > 0 && granted.some((g) => suppliesProperty(g, property)) ? `all of it (${granted.join(', ')} supply only part)` : 'it'}. A style edit changes only a property that is a resolved target or one the audit measured.`;
}

/**
 * Conservative edit guard, not a general CSS/interaction verifier; see policy boundary.
 * With a `resolution` (the Resolver's derived targets) the guard also enforces AUTHORIZATION, for a finding with targets and for one without:
 *  - a property resolved as preserve-existing or unresolved IN THE EDIT'S STATE is refused, whatever the value (keywords included), together with every shorthand /
 *    longhand / logical alias that would change it (`suppliesProperty`); a decision in another state does not block this one;
 *  - a colour-bearing edit is bound (`colourValueViolation`), a custom-property edit is bound (`customPropertyViolation`), a class or component-swap edit is scanned
 *    (`classValueViolation`), and a non-colour style property must be a resolved target or one the audit measured (`propertyAuthorizationViolation`);
 *  - an authorized target (not only an audit mismatch) lifts the protection of composition properties.
 * Without a resolution (the Resolver's own audit-expected pre-check, a legacy or manual call) nothing of that is enforced: the structural checks below still are.
 * `ctx.dsIndex` lets a `var()` alias of the target's colour - or, for a finding with no target, a DS token - pass.
 */
export function redesignPolicyViolation(edit: TargetedEdit, finding?: Finding, entry?: MappingEntry, resolution?: ResolutionFile | null, ctx?: PolicyContext): string | null {
  const cta = isCta(edit, finding, entry);
  const property = edit.property?.trim().toLowerCase() ?? '';
  if (cta && (PRIMARY.test(edit.dsVariant ?? '') ||
    (edit.kind === 'attribute' && /^(?:data-ds-variant|data-variant|variant)$/.test(property) && PRIMARY.test(edit.value)))) {
    return `${POLICY_REFUSAL} black Button primary is prohibited; use the existing red brand variant for primary actions.`;
  }
  if (cta && `${edit.value} ${edit.dsToken ?? ''}`.includes(DARK_CTA_TOKEN)) {
    return `${POLICY_REFUSAL} dark-shimmer CTA fill is prohibited; use --composition-gradient-brand-red-shimmer.`;
  }
  const value = edit.value.toLowerCase().replace(/\s*!important\s*$/, '').trim();
  if (cta && ((edit.kind === 'style' && /^(?:background(?:-color|-image)?|--.*)$/.test(property) &&
    /^(?:black|#000(?:000)?|rgb\(0(?:\s*,\s*|\s+)0(?:\s*,\s*|\s+)0\))$/.test(value)) ||
    ((edit.kind === 'class' || edit.kind === 'component-swap') && /(?:^|[\s:])bg-(?:black|\[#000(?:000)?\])(?:$|[\s/])/.test(value)))) {
    return `${POLICY_REFUSAL} black CTA fill is prohibited; use the existing red brand variant.`;
  }
  // the selector is interpolated into an injected rule and mirrored into the stylesheet text: no comment (any kind), no `<` or backslash (a style edit)
  const badSelector = selectorInjection(edit.selector, edit.kind);
  if (badSelector) return `${POLICY_REFUSAL} the selector carries ${badSelector}; a selector is plain.`;
  // `textContent` replaces every child: into a raw-text element it is injected markup or script. applyEdit also checks the matched element and its children.
  if (edit.kind === 'text') {
    const tag = selectorSubjectTag(edit.selector);
    if (tag !== null && RAW_TEXT_ELEMENTS.has(tag)) return `${POLICY_REFUSAL} a text edit cannot write into <${tag}>: it is a raw-text or non-visual element, not visible text.`;
  }
  if (edit.kind === 'style' && property) {
    // a style edit is ONE property with ONE plain value: the applier interpolates both into a rule, so structure in either would carry CSS past every check below
    if (!isCssPropertyName(property)) return `${POLICY_REFUSAL} "${edit.property}" is not a CSS property name; a style edit sets one property.`;
    const injected = cssValueInjection(edit.value);
    if (injected) return `${POLICY_REFUSAL} the value of ${property} carries ${injected}; a style edit is one property with one plain value.`;
    // `all` resets every property (colours, layout, content, interaction) that no per-property check below could see: never a redesign edit
    if (property === 'all') return `${POLICY_REFUSAL} "all: ${edit.value}" resets every property of the element (colour, spacing, layout, interaction); a style edit sets only the properties it is authorized for.`;
  }
  // no resolution => nothing below is enforced; a finding without a target of its own is bound by the audit and the DS index (see `colourValueViolation`)
  const own = resolution ? resolution.targets.filter((t) => t.findingId === edit.findingId) : [];
  const state = stateOfEdit(edit);
  if (edit.kind === 'style' && property && resolution) {
    // preserved / unresolved properties block every property that SUPPLIES them, in both directions: `border-color` and `border` would overwrite a preserved
    // `border-top-color`. A decision binds ITS state: a hover decision never blocks the default state, and a state that preserves a property refuses any value for it.
    const resolvedHere = new Set(own.filter((t) => t.part === 'self' && t.outcome === 'resolved-target' && t.state === state).map((t) => t.property));
    for (const t of own) {
      if (t.part !== 'self' || t.outcome === 'resolved-target' || t.state !== state) continue;
      const name = t.property.trim().toLowerCase();
      // a longhand with its own resolved target is the finding's explicit change, whatever a preserved shorthand of it says
      if (!suppliesProperty(name, property) || (resolvedHere.has(property) && shorthandCovers(name, property))) continue;
      return `${POLICY_REFUSAL} ${name} was resolved as ${t.outcome} (${t.reason}) in the ${state} state: ${t.decisionReason}${name === property ? '' : ` (${property} would change it)`}`;
    }
    if (property.startsWith('--')) {
      const custom = customPropertyViolation(edit, property, own);
      if (custom) return custom;
    } else {
      const wrongColour = colourValueViolation(edit, property, own, finding, ctx);
      if (wrongColour) return wrongColour;
    }
  }
  if ((edit.kind === 'class' || edit.kind === 'component-swap') && resolution) {
    const wrongClass = classValueViolation(edit, own, ctx);
    if (wrongClass) return wrongClass;
  }
  if (edit.kind === 'style' && PROTECTED_PROPERTY.test(property) &&
    !finding?.comparison.mismatches.some((m) => m.property.trim().toLowerCase() === property) &&
    !authorizedProperties(resolution ?? null, edit.findingId).has(property)) {
    return `${POLICY_REFUSAL} preserve original layout/interaction property ${property}; no selected mismatch or resolved target authorizes changing it.`;
  }
  if (edit.kind === 'style' && property && resolution && !property.startsWith('--') && !isColourProperty(property)) {
    const unauthorized = propertyAuthorizationViolation(edit, property, own, finding);
    if (unauthorized) return unauthorized;
  }
  return null;
}
