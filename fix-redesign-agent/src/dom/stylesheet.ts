import type { Page } from 'playwright';

/**
 * §7.5/§8.7: style edits are applied as rules in an INJECTED STYLESHEET, never as inline
 * `style=""` attributes — inline styles would win over every stylesheet rule at every
 * breakpoint unconditionally, which is exactly what would NOT let responsive rules survive.
 * A stylesheet rule scoped to one property, on one stamped element, with `!important` (since
 * we cannot know the page's own specificity in advance) touches only that property, only on
 * that element, and is cleanly grouped, revertible and idempotent — re-applying the same
 * (element, property) key replaces its own rule text, never appends a duplicate.
 */

export const INJECTED_EDITS_STYLE_ID = 'fra-injected-edits';
export const INJECTED_DS_STYLESHEET_ID = 'fra-ds-stylesheet';
/** The <style> that holds rules addressed by a DESCENDANT selector (the stamp route's rules live in `INJECTED_EDITS_STYLE_ID`). */
export const INJECTED_EDITS_EXTRA_STYLE_ID = 'fra-injected-edits-extra';

export async function ensureInjectedEditsStyleTag(page: Page): Promise<void> {
  await page.evaluate((id) => {
    if (!document.getElementById(id)) {
      const style = document.createElement('style');
      style.id = id;
      style.setAttribute('data-fra-injected', 'edits');
      document.head.appendChild(style);
    }
  }, INJECTED_EDITS_STYLE_ID);
}

/**
 * What a rule's VALUE and PROPERTY may not carry: a `<` or `>` (no value or property name needs either). The rule is mirrored into the <style>'s textContent and a
 * serialization emits that text RAW, so `</style><script>` would be markup there. This is the first line; the mirror itself (`upsertRuleInPage`) is the second:
 * it never writes a `<` at all, so no spelling that gets past a text check can break out.
 */
export const MARKUP_IN_RULE = 'a "<" or ">" (markup characters: the exported page would carry them as HTML)';
export const hasMarkup = (...parts: string[]): boolean => parts.some((p) => /[<>]/.test(p));

export interface RuleArgs {
  /** The id of the injected <style>; created when absent. */
  styleId: string;
  /** The rule's selector exactly as the browser will serialise it back (`selectorText`), also how an earlier rule of the same (selector, property) is found. */
  selector: string;
  property: string;
  value: string;
}

/**
 * Runs IN the page (so it may reference only globals; it is passed to `page.evaluate` as it is, and exported so a test can drive the mirror directly).
 * Replaces the rule for this (selector, property) in place - never a duplicate, never a growing stylesheet - then mirrors the CSSOM into the <style>'s textContent.
 *
 * `insertRule` / `deleteRule` mutate the CSSOM only and never touch textContent, so a `cloneNode` / `outerHTML` / `page.content()` serialization (every export in
 * §8.4, R2/R7's `originalHtml` / `redesignHtml`) would silently miss every edit: the text is rebuilt from the live rules after every change. `cssText` decodes CSS
 * escapes, so a `\3c ` inside a string or an attribute selector comes back as a literal `<`, and a serialization emits a <style>'s text raw: every `<` is therefore
 * written back as the escape `\3c ` (the trailing space ends the escape), which is the same character to the parser and can never spell `</style`. `>` and `&` are
 * harmless in raw text.
 */
export function upsertRuleInPage({ styleId, selector, property, value }: RuleArgs): void {
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    style.setAttribute('data-fra-injected', 'edits');
    document.head.appendChild(style);
  }
  const sheet = style.sheet!;
  for (let i = 0; i < sheet.cssRules.length; i++) {
    const rule = sheet.cssRules[i] as CSSStyleRule;
    if (rule.selectorText === selector && rule.style.length === 1 && rule.style[0] === property) {
      sheet.deleteRule(i);
      break;
    }
  }
  // the value as it is: a quote of an accepted value opens or closes one of ITS strings (an unterminated string is refused before this), so escaping it would
  // corrupt `font-family: "Noto Serif"` and every `content` string
  sheet.insertRule(`${selector} { ${property}: ${value} !important; }`, sheet.cssRules.length);
  style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText.replace(/</g, '\\3c ')).join('\n');
}

/** Upserts one property's rule for one stamped element, keyed `(elementId, property)` — idempotent by construction. */
export async function upsertStyleRule(page: Page, elementId: string, property: string, value: string): Promise<void> {
  if (hasMarkup(elementId, property, value)) throw new Error(`style rule for "${property}" refused: it carries ${MARKUP_IN_RULE}`);
  // the id is interpolated into an attribute selector STRING, and the browser decodes a CSS escape in a string (`\3c ` is `<`)
  if (elementId.includes('\\')) throw new Error(`style rule for "${property}" refused: the element id carries a backslash (a CSS escape is decoded by the browser, so it can spell any character)`);
  await ensureInjectedEditsStyleTag(page);
  await ensureInjectedEditsStyleTag(page);
  await page.evaluate(upsertRuleInPage, { styleId: INJECTED_EDITS_STYLE_ID, selector: `[data-fra-element="${elementId}"]`, property, value });
}

/** Injects the DS's own stylesheet(s) once per session, so component-swap markup renders with real tokens (§8.7). */
export async function injectDsStylesheetOnce(page: Page, cssText: string): Promise<boolean> {
  return page.evaluate(
    ({ id, css }) => {
      if (document.getElementById(id)) return false;
      const style = document.createElement('style');
      style.id = id;
      style.setAttribute('data-fra-injected', 'design-system');
      style.textContent = css;
      document.head.appendChild(style);
      return true;
    },
    { id: INJECTED_DS_STYLESHEET_ID, css: cssText },
  );
}
