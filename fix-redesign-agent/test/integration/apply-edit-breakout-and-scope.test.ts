import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { applyEdit } from '../../src/dom/apply-edit.ts';
import { INJECTED_EDITS_STYLE_ID, upsertRuleInPage, upsertStyleRule } from '../../src/dom/stylesheet.ts';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Reference lane, round 4 (final). Three routes by which something other than the finding's own stamped element - or something other than a style - reached
 * the exported page:
 *  (1) a CSS hex escape in a SELECTOR string (`\3c /style\3e`) is decoded by the browser, re-serialised by `cssText` as a literal `</style>`, and mirrored into the
 *      <style>'s textContent, which a serialization emits RAW. Closed twice: no backslash in a style edit's selector (nor in the element id of `upsertStyleRule`),
 *      AND the mirror itself writes every `<` as the CSS escape `\3c ` so no spelling can ever produce `</style`.
 *  (2) a `text` edit writes `el.textContent` - into a raw-text element (<style>, <script>, <noscript>, <xmp>) that is injected markup, or over the element children of
 *      an ordinary element (content destroyed).
 *  (6) a selector can leave the stamp: sibling combinators after it, or a comment pair that hides a top-level comma from the list check.
 */

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
});
afterAll(async () => { await browser.close(); });

const edit = (over: Partial<TargetedEdit>): TargetedEdit => ({
  findingId: 'f1', selector: '[data-fra-element="card"]', expectedMatches: 1, kind: 'style', property: 'padding-top', value: '4px', removeValue: null,
  dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1, ...over,
});
/** What the export carries: serialize, load that HTML in a fresh page and report whether anything ran. */
const reloadedExecutes = async (html: string): Promise<{ pwned: unknown; scripts: number }> => {
  const other = await (await browser.newContext()).newPage();
  try {
    await other.setContent(html);
    return await other.evaluate(() => ({ pwned: (window as unknown as { pwned?: unknown }).pwned, scripts: document.querySelectorAll('script').length }));
  } finally {
    await other.close();
  }
};
/** `scripts`: how many <script> elements the fixture itself carries (the export may hold those and no more). */
const noBreakout = async (scripts = 0): Promise<void> => {
  const html = await page.content();
  expect(html).not.toMatch(/<\/(?:style|noscript|xmp|textarea)>\s*<script>[^<]*pwned/i);
  expect(await reloadedExecutes(html)).toEqual({ pwned: undefined, scripts });
};

// the report's repro: `\3c /style\3e \3c script\3e window.pwned=5\3c /script\3e` (hex escapes of `<` and `>`)
const ESCAPED = '\\3c /style\\3e \\3c script\\3e window.pwned=5\\3c /script\\3e';

describe('(1) a hex escape in a selector never reaches the exported stylesheet text', () => {
  const fresh = async () => { await page.setContent('<div data-fra-element="card"><span class="icon">i</span></div>'); };

  it('the descendant route refuses a backslash anywhere in the selector - in an attribute string too', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ selector: `[data-fra-element="card"] .icon:not([title="${ESCAPED}"])` }), null);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/backslash/);
    expect(await page.locator('style[data-fra-injected]').count()).toBe(0);
    await noBreakout();
  });

  it('a backslash outside a string is refused as well (an escaped identifier is the same spelling problem)', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ selector: '[data-fra-element="card"] .ic\\6f n' }), null);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/backslash/);
  });

  it('the stamp route cannot be reached with an escaped element id either (upsertStyleRule refuses it itself)', async () => {
    await fresh();
    await expect(upsertStyleRule(page, ESCAPED, 'padding-top', '1px')).rejects.toThrow(/backslash/);
    expect(await page.locator('style[data-fra-injected]').count()).toBe(0);
    await noBreakout();
  });

  it('applyEdit refuses the stamp-shaped selector whose id carries the escape, before it is routed', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ selector: `[data-fra-element="${ESCAPED}"]`, expectedMatches: 0 }), null);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/backslash/);
    await noBreakout();
  });

  it('the mirror is structurally safe: a rule whose STRING holds </style><script> is written with every "<" escaped, and the export re-loads as the same rule', async () => {
    await fresh();
    // a perfectly valid CSS string: no guard of a style edit would let it through, but no future spelling may be able to break out either
    const evil = '"</style><script>window.pwned=6</script>"';
    await page.evaluate(upsertRuleInPage, { styleId: INJECTED_EDITS_STYLE_ID, selector: '[data-fra-element="card"]', property: 'content', value: evil });
    const text = await page.evaluate((id) => document.getElementById(id)!.textContent ?? '', INJECTED_EDITS_STYLE_ID);
    expect(text).not.toContain('<');
    expect(text).toContain('\\3c ');
    await noBreakout();
    // the escape is the SAME value to the parser
    const html = await page.content();
    const other = await (await browser.newContext()).newPage();
    try {
      await other.setContent(html);
      const value = await other.evaluate((id) => (document.getElementById(id) as HTMLStyleElement).sheet!.cssRules[0] instanceof CSSStyleRule ? ((document.getElementById(id) as HTMLStyleElement).sheet!.cssRules[0] as CSSStyleRule).style.getPropertyValue('content') : null, INJECTED_EDITS_STYLE_ID);
      expect(value).toBe(evil);
    } finally {
      await other.close();
    }
  });

  it('an ordinary edit still exports as plain CSS and can still be replaced in place', async () => {
    await fresh();
    expect((await applyEdit(page, edit({ property: 'padding-top', value: '9px' }), null)).applied).toBe(true);
    expect((await applyEdit(page, edit({ property: 'padding-top', value: '11px' }), null)).applied).toBe(true);
    const html = await page.content();
    expect(html).toContain('padding-top: 11px !important');
    expect(html).not.toContain('padding-top: 9px');
    await noBreakout();
  });

  it('a child combinator in a descendant selector is a legitimate selector (">" is not markup without a "<")', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ selector: '[data-fra-element="card"] > .icon' }), null);
    expect(out.error).toBeNull();
    expect(out.applied).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.icon')!).paddingTop)).toBe('4px');
  });
});

describe('(2) a text edit changes visible text only', () => {
  const RAW = '<div data-fra-element="card"><style>.k{color:red}</style><script>window.a=1</script><noscript>x</noscript><xmp>q</xmp><textarea>t</textarea><span class="t">text</span><p class="mixed">Hello <b>bold</b> end</p></div>';
  const fresh = async () => {
    await page.setContent(RAW);
    await page.evaluate(() => { delete (window as unknown as { pwned?: number }).pwned; });
  };
  const text = (selector: string, value: string): TargetedEdit => edit({ kind: 'text', property: null, selector, value });

  it.each([
    ['style', '</style><script>window.pwned=7</script>'],
    ['script', 'window.pwned=9'],
    ['noscript', '</noscript><script>window.pwned=10</script>'],
    ['xmp', '</xmp><script>window.pwned=11</script>'],
    ['textarea', '</textarea><script>window.pwned=12</script>'],
  ])('is not applied to a <%s> inside a stamped section (the report\'s repro)', async (tag, value) => {
    await fresh();
    const before = await page.evaluate((t) => document.querySelector(`[data-fra-element="card"] ${t}`)!.textContent, tag);
    const out = await applyEdit(page, text(`[data-fra-element="card"] ${tag}`, value), null);
    expect(out.matched).toBe(1);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/text edit|raw-text|not visible text/i);
    expect(await page.evaluate((t) => document.querySelector(`[data-fra-element="card"] ${t}`)!.textContent, tag)).toBe(before);
    await noBreakout(1);
  });

  it('is not applied over the element children of an ordinary element (their content would be destroyed)', async () => {
    await fresh();
    const out = await applyEdit(page, text('[data-fra-element="card"] .mixed', 'replaced'), null);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/child|text nodes/i);
    expect(await page.evaluate(() => document.querySelector('.mixed')!.innerHTML)).toBe('Hello <b>bold</b> end');
  });

  it('is applied to an element whose children are text nodes, and a "<" in the value stays text', async () => {
    await fresh();
    const out = await applyEdit(page, text('[data-fra-element="card"] .t', 'a <b> & c'), null);
    expect(out.error).toBeNull();
    expect(out.applied).toBe(true);
    expect(await page.evaluate(() => document.querySelector('.t')!.textContent)).toBe('a <b> & c');
    expect(await page.evaluate(() => document.querySelector('.t')!.children.length)).toBe(0);
    await noBreakout(1);
  });
});

describe('(6) a selector that begins with the stamp stays inside it', () => {
  const fresh = async () => { await page.setContent('<div data-fra-element="card"><span class="a">a</span><span class="b">b</span></div><section id="o">o</section><p id="p">p</p>'); };
  const paddingOf = (id: string) => page.evaluate((i) => getComputedStyle(document.getElementById(i)!).paddingTop, id);

  it.each([
    ['[data-fra-element="card"] ~ #o', 1],
    ['[data-fra-element="card"] + #o', 1],
    ['[data-fra-element="card"]~#o', 1],
    ['[data-fra-element="card"] + #o ~ #p', 1],
  ])('%s matches outside the stamped element: not applied', async (selector, expectedMatches) => {
    await fresh();
    const out = await applyEdit(page, edit({ selector, expectedMatches }), null);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/outside|inside|stamp/i);
    expect(await paddingOf('o')).toBe('0px');
    expect(await paddingOf('p')).toBe('0px');
  });

  it.each(['class', 'attribute', 'text'] as const)('the same holds for a %s edit', async (kind) => {
    await fresh();
    const over: Partial<TargetedEdit> = kind === 'class' ? { kind, property: null, value: 'x-new' } : kind === 'attribute' ? { kind, property: 'title', value: 'hello' } : { kind, property: null, value: 'changed' };
    const out = await applyEdit(page, edit({ selector: '[data-fra-element="card"] ~ #o', ...over }), null);
    expect(out.applied).toBe(false);
    expect(await page.evaluate(() => document.getElementById('o')!.outerHTML)).toBe('<section id="o">o</section>');
  });

  it('a comment pair that hides a top-level comma from the quote scan is refused (a selector never needs a comment)', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ selector: '[data-fra-element="card"] .a /*"*/, #o /*"*/', expectedMatches: 2 }), null);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/comment|selector list/);
    expect(await paddingOf('o')).toBe('0px');
  });

  it('a descendant and a child selector inside the stamp are applied', async () => {
    await fresh();
    for (const selector of ['[data-fra-element="card"] .a', '[data-fra-element="card"] > .b', '[data-fra-element="card"] .a ~ .b']) {
      const out = await applyEdit(page, edit({ selector }), null);
      expect(out.error, selector).toBeNull();
      expect(out.applied, selector).toBe(true);
    }
  });
});
