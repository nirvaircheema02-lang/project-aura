import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { applyEdit } from '../../src/dom/apply-edit.ts';
import { upsertStyleRule } from '../../src/dom/stylesheet.ts';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Reference lane round 3: (4) the injected rules are mirrored into the <style>'s textContent, which a serialization (page.content(), outerHTML, the exported
 * redesign.html) emits RAW - a value or selector carrying `</style><script>` would break out of the stylesheet; (13) a double quote of an accepted value must
 * reach the rule as it is (the blanket backslash escaping corrupted `font-family: "Noto Serif"` and every `content` string).
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
const BREAKOUT = '</style><script>window.pwned=2</script>';
const fresh = async () => {
  await page.setContent(`<div data-fra-element="card"><span class="icon" title="${BREAKOUT.replace(/"/g, '&quot;')}">i</span></div>`);
  await page.evaluate(() => { delete (window as unknown as { pwned?: number }).pwned; });
};
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

describe('markup characters never reach the exported stylesheet text', () => {
  const values: Array<[string, string]> = [['--x', BREAKOUT], ['content', `'${BREAKOUT}'`], ['--x', '<b>'], ['padding-top', '1px >']];

  it.each(values)('stamp route: %s: %s is not applied and the export carries no live script', async (property, value) => {
    await fresh();
    const out = await applyEdit(page, edit({ property, value }), null);
    expect(out.applied).toBe(false);
    const html = await page.content();
    expect(html).not.toMatch(/<\/style><script>/);
    expect(await reloadedExecutes(html)).toEqual({ pwned: undefined, scripts: 0 });
  });

  it.each(values)('descendant route: %s: %s is not applied and the export carries no live script', async (property, value) => {
    await fresh();
    const out = await applyEdit(page, edit({ selector: '[data-fra-element="card"] .icon', property, value }), null);
    expect(out.applied).toBe(false);
    const html = await page.content();
    expect(html).not.toMatch(/<\/style><script>/);
    expect(await reloadedExecutes(html)).toEqual({ pwned: undefined, scripts: 0 });
  });

  it('a SELECTOR with markup is mirrored too: the descendant route refuses it, even when the page has a matching element', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ selector: `[data-fra-element="card"] [title="${BREAKOUT}"]` }), null);
    // round 4: the text of the selector is refused before any element is counted (the page does hold a matching one)
    expect(out.matched).toBe(0);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/markup|"<"/);
    const html = await page.content();
    expect(html.match(/<style[^>]*data-fra-injected/)).toBeNull();
    expect(await reloadedExecutes(html)).toEqual({ pwned: undefined, scripts: 0 });
  });

  it('upsertStyleRule itself refuses markup (defence in depth: the mirror is not safe for any caller)', async () => {
    await fresh();
    await expect(upsertStyleRule(page, 'card', '--x', BREAKOUT)).rejects.toThrow(/markup|"<"/);
    await expect(upsertStyleRule(page, 'card', '--x', 'a>b')).rejects.toThrow(/markup|">"/);
    await expect(upsertStyleRule(page, 'card"]</style><script>window.pwned=4</script>', 'padding-top', '1px')).rejects.toThrow(/markup|"<"/);
    const html = await page.content();
    expect(html).not.toMatch(/<\/style><script>/);
    expect(await reloadedExecutes(html)).toEqual({ pwned: undefined, scripts: 0 });
  });

  it('an ordinary edit exports as plain CSS and re-loading it runs nothing', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ property: 'padding-top', value: '9px' }), null);
    expect(out.applied).toBe(true);
    const html = await page.content();
    expect(html).toContain('padding-top: 9px !important');
    expect(await reloadedExecutes(html)).toEqual({ pwned: undefined, scripts: 0 });
  });
});

describe('a double quote of an accepted value reaches the rule as written', () => {
  const ruleValue = (property: string) => page.evaluate((prop) => {
    for (const style of Array.from(document.querySelectorAll('style[data-fra-injected]'))) {
      for (const rule of Array.from((style as HTMLStyleElement).sheet!.cssRules) as CSSStyleRule[]) {
        const v = rule.style.getPropertyValue(prop);
        if (v) return v;
      }
    }
    return null;
  }, property);

  for (const [route, selector] of [['stamp', '[data-fra-element="card"]'], ['descendant', '[data-fra-element="card"] .icon']] as const) {
    it(`${route} route: font-family '"Noto Serif", serif' computes to the family it names`, async () => {
      await fresh();
      const out = await applyEdit(page, edit({ selector, property: 'font-family', value: '"Noto Serif", serif' }), null);
      expect(out.error).toBeNull();
      expect(out.applied).toBe(true);
      const computed = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).fontFamily, selector);
      expect(computed).toBe('"Noto Serif", serif');
      expect(await ruleValue('font-family')).toBe('"Noto Serif", serif');
    });

    it(`${route} route: a content string survives`, async () => {
      await fresh();
      const out = await applyEdit(page, edit({ selector, property: 'content', value: '"x"' }), null);
      expect(out.applied).toBe(true);
      expect(await ruleValue('content')).toBe('"x"');
      const exported = await page.content();
      expect(exported).toContain('content: "x"');
    });

    it(`${route} route: a single-quoted string survives`, async () => {
      await fresh();
      const out = await applyEdit(page, edit({ selector, property: 'font-family', value: "'Noto Serif', serif" }), null);
      expect(out.applied).toBe(true);
      expect(await ruleValue('font-family')).toBe('"Noto Serif", serif');
    });
  }
});

describe('applyEdit refuses a selector list (defence in depth behind R4\'s stamp check)', () => {
  it.each(['[data-fra-element="card"] , #o', '[data-fra-element="card"] .icon, #o', '[data-fra-element="card"] :is(.icon'])('%s is not applied to anything', async (selector) => {
    await page.setContent('<div data-fra-element="card"><span class="icon">i</span></div><p id="o">o</p>');
    const out = await applyEdit(page, edit({ selector, expectedMatches: 2 }), null);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/selector list|not closed/);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('o')!).paddingTop)).toBe('0px');
  });
});
