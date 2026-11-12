import type { Page } from 'playwright';
import type { TargetedEdit } from '../llm/schemas/r-nodes.ts';
import { STAMP_ATTR_ELEMENT } from '../mapping/stamp.ts';
import { hasMarkup, INJECTED_EDITS_EXTRA_STYLE_ID, MARKUP_IN_RULE, upsertRuleInPage, upsertStyleRule } from './stylesheet.ts';

/**
 * §8.6's R4 — the DOM-patch mechanism. R3 can only ever describe what this module is able to
 * apply; this module can only ever touch what one `TargetedEdit` explicitly names — that
 * narrowness is the structural guarantee of content/functionality preservation (Q7's own
 * framing, unchanged from v1.0), never a stated policy this code could quietly ignore.
 */

export interface ApplyEditOutcome {
  matched: number;
  applied: boolean;
  previousValue: string | null;
  error: string | null;
}

/**
 * §security: an `attribute` edit's property NAME comes straight from R3's (model) output,
 * which is itself derived from audit-finding free text (§0.2's only human-authored text, plus
 * whatever the model infers) — never treat that as trusted enough to set on a live page. An
 * event-handler attribute (`onclick`, …) executes model-composed JS the instant it fires;
 * `href`/`src`/`action`/`formaction`/`srcdoc` can carry a `javascript:`/`data:` URI; `style`
 * has its own dedicated, injected-stylesheet edit kind and must never be set inline here. This
 * is an ALLOWLIST, not a denylist, on purpose — a new dangerous attribute added to a future
 * HTML spec is refused by default, not silently permitted until someone remembers to block it.
 */
const SAFE_ATTRIBUTE_ALLOWLIST = new Set([
  'alt', 'title', 'placeholder', 'role', 'tabindex', 'lang', 'dir', 'name', 'type', 'inputmode',
  'disabled', 'readonly', 'required', 'checked', 'selected', 'autocomplete', 'draggable', 'contenteditable',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-expanded', 'aria-controls',
  'aria-haspopup', 'aria-live', 'aria-current', 'aria-disabled', 'aria-required', 'aria-invalid',
  'aria-checked', 'aria-pressed', 'aria-selected', 'aria-modal', 'aria-atomic', 'aria-relevant',
]);

export function isSafeEditableAttribute(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower || lower.startsWith('on')) return false; // event handlers — never
  if (lower.startsWith('data-fra-')) return false; // reserved for this system's own stamps
  if (lower.startsWith('data-')) return true; // custom data attributes carry no browser behavior
  return SAFE_ATTRIBUTE_ALLOWLIST.has(lower);
}

async function readPreviousValue(page: Page, selector: string, edit: TargetedEdit): Promise<string | null> {
  return page.evaluate(
    ({ sel, kind, prop }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      if (kind === 'style' && prop) return getComputedStyle(el).getPropertyValue(prop);
      if (kind === 'attribute' && prop) return el.getAttribute(prop);
      if (kind === 'text') return el.textContent;
      if (kind === 'class' || kind === 'component-swap') return el.getAttribute('class');
      return null;
    },
    { sel: selector, kind: edit.kind, prop: edit.property },
  );
}

/**
 * A style edit's property and value are interpolated into an injected rule (`<selector> { <property>: <value> !important; }`), so either one that carries
 * more than a name / one value would smuggle CSS past every guard that reads only the first declaration. These are the only checks that are sound on text:
 * the declaration cannot end or open a block, carry a comment or an escape (`\72 ed` is `red` to the parser, not to a scanner), load a resource, or add its own
 * priority (the applier adds `!important`), nor leave a string open (its quote would swallow the `!important` the applier appends). Null when the text is one plain
 * property / one plain value.
 */
export function cssValueInjection(value: string): string | null {
  const v = value.replace(/\s*!important\s*$/i, '');
  if (/[;{}]/.test(v)) return 'a ";", "{" or "}" that would end the declaration or open a rule';
  if (hasMarkup(v)) return MARKUP_IN_RULE;
  if (/\/\*|\*\//.test(v)) return 'a CSS comment';
  if (v.includes('\\')) return 'a backslash escape';
  if (v.includes('!')) return 'a "!" (the applier adds the only !important)';
  if (/(?:^|[^\w-])(?:url|image|image-set|src|-webkit-image-set)\s*\(/i.test(v)) return 'a url() / image() (a value never loads a resource)';
  if (hasOpenString(v)) return 'an unterminated string';
  return null;
}

/** A quote that is never closed (a backslash escape is already refused, so a quote closes at the next one of its own kind). */
function hasOpenString(v: string): boolean {
  let quote = '';
  for (const c of v) {
    if (quote === '') { if (c === '"' || c === "'") quote = c; } else if (c === quote) quote = '';
  }
  return quote !== '';
}

const PROPERTY_NAME = /^(?:--[\w-]+|-?[a-z][a-z0-9-]*)$/i;
/** A CSS property or custom-property name and nothing else. */
export const isCssPropertyName = (property: string): boolean => PROPERTY_NAME.test(property.trim());

/**
 * Is `selector` ONE selector - a compound or complex one - and not a selector LIST? No comma outside brackets, parentheses, strings and comments (`:is(.a, .b)`
 * and `[title="a,b"]` are one selector), every bracket, string and comment closed, a backslash escapes the next character. A list lets one edit reach elements its
 * finding never selected (`[data-fra-element="e1"] , #o`); a comment is read as the parser reads it, so a quote INSIDE one cannot hide a comma from this scan.
 */
export function isSingleSelector(selector: string): boolean {
  const open: string[] = [];
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const c = selector.charAt(i);
    if (c === '\\') { i++; continue; }
    if (quote !== '') { if (c === quote) quote = ''; continue; }
    if (c === '/' && selector.charAt(i + 1) === '*') {
      const end = selector.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') open.push(c === '(' ? ')' : ']');
    else if (c === ')' || c === ']') { if (open.pop() !== c) return false; }
    else if (c === ',' && open.length === 0) return false;
  }
  return open.length === 0 && quote === '';
}

/**
 * What a style edit's SELECTOR may not carry, because it is interpolated into an injected rule and its serialised form is mirrored into the stylesheet text: a `<`
 * (markup in a raw-text element; `>` is the child combinator and is fine), and a backslash anywhere - the browser decodes a CSS escape (`\3c /style\3e `) inside an
 * attribute string or an identifier, so the text of the selector says nothing about the characters it will spell. A comment is refused for every kind of edit: no
 * selector needs one, and it is how a list or a stamp escape was once hidden from a text scan. Null when the selector is plain.
 */
export function selectorInjection(selector: string, kind: TargetedEdit['kind']): string | null {
  if (/\/\*|\*\//.test(selector)) return 'a CSS comment';
  if (kind !== 'style') return null;
  if (selector.includes('<')) return 'a "<" (markup: the exported page would carry it as HTML)';
  if (selector.includes('\\')) return 'a backslash (a CSS escape is decoded by the browser, so it can spell any character, "<" included)';
  return null;
}

/** The elements a `text` edit may never write into: their text is not visible content - raw text that a serialization emits unescaped, or markup that is not rendered. */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['style', 'script', 'noscript', 'xmp', 'iframe', 'textarea', 'template', 'title', 'object', 'embed', 'noembed', 'noframes', 'plaintext', 'head', 'meta', 'link', 'base']);

/** The type selector of the last compound of a selector (the element it addresses): `[stamp] > style:hover` -> `style`; null when that compound has none (`.a`, `*`, `[x]`). */
export function selectorSubjectTag(selector: string): string | null {
  let depth = 0; let quote = ''; let from = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector.charAt(i);
    if (c === '\\') { i++; continue; }
    if (quote !== '') { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) from = i + 1;
  }
  return /^([a-z][a-z0-9-]*)/i.exec(selector.slice(from))?.[1]?.toLowerCase() ?? null;
}

const STATE = '(?:hover|focus-visible|focus-within|focus|active)';

/** The selector with its interaction-state conditions removed: which ELEMENTS it addresses, whatever state they are in. */
export const selectorWithoutStateConditions = (selector: string): string =>
  selector.replace(new RegExp(`:not\\(\\s*:${STATE}\\s*\\)`, 'g'), '').replace(new RegExp(`:${STATE}(?![\\w-])`, 'g'), '');

/**
 * Applies ONE targeted edit to the live page, enforcing `expectedMatches` strictly (§7.6: a
 * selector matching the wrong count is never guessed at — it is reported, unapplied). Reuses
 * `previousValue` from an earlier application of the SAME (findingId, property) key when one
 * is given, rather than re-measuring an already-mutated value as if it were original (§7.5's
 * idempotent-retry rule).
 */
export async function applyEdit(page: Page, edit: TargetedEdit, reuse: { previousValue: string | null } | null): Promise<ApplyEditOutcome> {
  // refused before anything is counted or interpolated (the text of the selector decides, not the elements it happens to match)
  const badSelector = selectorInjection(edit.selector, edit.kind);
  if (badSelector) return { matched: 0, applied: false, previousValue: null, error: `the selector carries ${badSelector} — never interpolated into a rule or applied` };
  if (!isSingleSelector(edit.selector)) return { matched: 0, applied: false, previousValue: null, error: `selector "${edit.selector}" is a selector list or is not closed — an edit addresses one selector, never applied` };
  // an interaction-state pseudo-class (:hover …) is a CONDITION of the rule, not part of which elements it addresses: the count is taken without it
  // (a `:not(:hover)` guard is the same kind of condition and goes first: stripping only its inner pseudo-class would leave an invalid `:not()`)
  const addressed = selectorWithoutStateConditions(edit.selector);
  const matched = await page.locator(addressed).count();
  if (matched !== edit.expectedMatches) {
    return { matched, applied: false, previousValue: null, error: `selector "${edit.selector}" matched ${matched} element(s), expected ${edit.expectedMatches} — never applied to an uncertain count` };
  }
  if (matched === 0) return { matched: 0, applied: false, previousValue: null, error: 'selector matched 0 elements' };
  // a selector that begins with a stamp reaches only that element's subtree (R4 checks the text; a sibling combinator or a clever spelling is caught here, on the elements)
  const stamp = new RegExp(`^\\[${STAMP_ATTR_ELEMENT}="([^"]+)"\\]`).exec(edit.selector);
  if (stamp) {
    const outside = await page.locator(addressed).evaluateAll((els, { attr, id }) => els.filter((el) => {
      for (let n: Node | null = el; n; n = (n as Element).parentElement ?? (n.parentNode as ShadowRoot | null)?.host ?? null) if ((n as Element).getAttribute?.(attr) === id) return false;
      return true;
    }).length, { attr: STAMP_ATTR_ELEMENT, id: stamp[1] as string });
    if (outside > 0) return { matched, applied: false, previousValue: null, error: `selector "${edit.selector}" matches ${outside} element(s) outside the stamped element "${stamp[1]}" — never applied beyond the finding's own element` };
  }

  const previousValue = reuse ? reuse.previousValue : await readPreviousValue(page, edit.selector, edit);

  try {
    switch (edit.kind) {
      case 'style': {
        if (!edit.property) return { matched, applied: false, previousValue, error: 'kind=style but property is null' };
        if (!isCssPropertyName(edit.property)) return { matched, applied: false, previousValue, error: `"${edit.property}" is not a CSS property name — never interpolated into a rule` };
        const injected = cssValueInjection(edit.value);
        if (injected) return { matched, applied: false, previousValue, error: `the value of ${edit.property} carries ${injected}; a style edit is one property with one plain value — never interpolated into a rule` };
        // Style edits go through the injected stylesheet, keyed by the STAMPED element id —
        // the selector may address a descendant, but the CSS rule always targets the stamp
        // itself unless the edit explicitly names a descendant selector as the edit target.
        // Anchored to the WHOLE selector: a bare stamp selector ("[data-fra-element=\"e1\"]")
        // routes through the shared, elementId-keyed upsertStyleRule below. A DESCENDANT
        // selector that merely CONTAINS a stamp reference ("[data-fra-element=\"e1\"] .icon")
        // must not match here — extracting just the stamp id and discarding everything after
        // it would silently apply the rule to the stamp element instead of the descendant the
        // edit actually named; it falls through to the raw-selector branch instead, which
        // preserves the selector exactly as given.
        const stampMatch = edit.selector.match(/^\[data-fra-element="([^"]+)"\]$/);
        if (stampMatch) {
          await upsertStyleRule(page, stampMatch[1] as string, edit.property, edit.value);
        } else {
          // A descendant selector (or no stamp reference at all) — apply directly via a rule
          // keyed on the selector text itself (still idempotent: same selector+property always
          // replaces its own prior rule, never duplicates).
          await page.evaluate(upsertRuleInPage, { styleId: INJECTED_EDITS_EXTRA_STYLE_ID, selector: edit.selector, property: edit.property, value: edit.value });
        }
        break;
      }
      case 'attribute': {
        if (!edit.property) return { matched, applied: false, previousValue, error: 'kind=attribute but property is null' };
        if (!isSafeEditableAttribute(edit.property)) {
          return { matched, applied: false, previousValue, error: `attribute "${edit.property}" is not on the allowed list for a redesign edit — event-handler, navigation/resource (href/src/action/…) and style attributes are refused; use kind=style for styling` };
        }
        await page.locator(edit.selector).evaluateAll((els, { prop, val }) => els.forEach((el) => el.setAttribute(prop, val)), { prop: edit.property, val: edit.value });
        break;
      }
      case 'text': {
        // `textContent` replaces every child: into a raw-text element (<style>, <script>, <noscript>, <xmp> ...) that is injected markup or script - a serialization
        // emits it unescaped -, and over element children it is destroyed content. Only an element whose children are all text nodes is visible text to replace.
        const refusal = await page.locator(edit.selector).evaluateAll((els, { raw, val }) => {
          for (const el of els) {
            if (raw.includes(el.localName)) return `a text edit cannot write into <${el.localName}>: it is a raw-text or non-visual element, not visible text`;
            if (!Array.from(el.childNodes).every((n) => n.nodeType === 3)) return `a text edit replaces every child, and <${el.localName}> holds child elements or comments (its children are not all text nodes): its content would be destroyed`;
          }
          els.forEach((el) => (el.textContent = val));
          return null;
        }, { raw: [...RAW_TEXT_ELEMENTS], val: edit.value });
        if (refusal) return { matched, applied: false, previousValue, error: refusal };
        break;
      }
      case 'class': {
        await page.locator(edit.selector).evaluateAll(
          (els, { add, remove }) => {
            const addList = add.split(/\s+/).filter(Boolean);
            const removeList = remove ? remove.split(/\s+/).filter(Boolean) : [];
            for (const el of els) {
              for (const c of addList) el.classList.add(c);
              for (const c of removeList) el.classList.remove(c);
            }
          },
          { add: edit.value, remove: edit.removeValue },
        );
        break;
      }
      case 'component-swap': {
        // §9's swap approximation for Workflow A: class-level alignment to the DS component's
        // own conventions, plus traceability attributes — never a markup/tree restructuring,
        // which is explicitly Workflow B's job (see docs/ARCHITECTURE.md §10's snapshot-vs-code table).
        await page.locator(edit.selector).evaluateAll(
          (els, { classes, dsComponent, dsVariant }) => {
            for (const el of els) {
              for (const c of classes.split(/\s+/).filter(Boolean)) el.classList.add(c);
              el.setAttribute('data-fra-component-swap', dsComponent ?? '');
              if (dsVariant) el.setAttribute('data-fra-ds-variant', dsVariant);
            }
          },
          { classes: edit.value, dsComponent: edit.dsComponent, dsVariant: edit.dsVariant },
        );
        break;
      }
    }
  } catch (err) {
    return { matched, applied: false, previousValue, error: err instanceof Error ? err.message : String(err) };
  }

  return { matched, applied: true, previousValue, error: null };
}

export { STAMP_ATTR_ELEMENT };
