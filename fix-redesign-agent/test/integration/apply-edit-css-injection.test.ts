import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { applyEdit } from '../../src/dom/apply-edit.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Round 2, defect 1: a style edit's VALUE is interpolated into an injected rule (`insertRule`). A value that carries structure - a second declaration, a
 * closed block, a comment, an escape, url() - would smuggle CSS past every value guard that only reads the first declaration. The applier refuses it itself,
 * whatever the policy let through, on both routes (the stamp rule and the descendant-selector rule).
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
const fresh = async () => { await page.setContent('<div data-fra-element="card" style="border:1px solid rgb(0,0,255)"><span class="icon">i</span></div>'); };
const borderColour = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-fra-element="card"]')!).borderTopColor);
const injectedRules = () => page.evaluate(() => Array.from(document.querySelectorAll('style[data-fra-injected]')).map((s) => s.textContent ?? '').join('\n'));

describe('applyEdit refuses a value that is more than one value', () => {
  const smuggled = ['4px; border-top-color: red', '4px; border-top-color: var(--nope, red)', '4px } [data-fra-element="card"] { border-top-color: red', '4px /* x */', '\\72 ed', '4px !important; border-top-color: red'];

  it.each(smuggled)('stamp route: %s is not applied and paints nothing', async (value) => {
    await fresh();
    const out = await applyEdit(page, edit({ value }), null);
    expect(out.applied, value).toBe(false);
    expect(out.error).toMatch(/value|declaration|structure|escape|comment/i);
    expect(await borderColour(), value).toBe('rgb(0, 0, 255)');
    expect(await injectedRules()).not.toMatch(/red/);
  });

  it.each(smuggled)('descendant route: %s is not applied and paints nothing', async (value) => {
    await fresh();
    const out = await applyEdit(page, edit({ selector: '[data-fra-element="card"] .icon', value }), null);
    expect(out.applied, value).toBe(false);
    expect(await borderColour(), value).toBe('rgb(0, 0, 255)');
    expect(await injectedRules()).not.toMatch(/red/);
  });

  it('a property name that carries more than a name is refused (the property is interpolated too)', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ property: 'padding-top: 1px; border-top-color', value: 'red' }), null);
    expect(out.applied).toBe(false);
    expect(await borderColour()).toBe('rgb(0, 0, 255)');
  });

  it('url() is refused (a value never loads a resource)', async () => {
    await fresh();
    const out = await applyEdit(page, edit({ property: 'background-image', value: 'url(https://evil.example/x.png)' }), null);
    expect(out.applied).toBe(false);
  });

  it('an ordinary value, a custom property, a token and a font stack are still applied', async () => {
    await fresh();
    for (const [property, value] of [['padding-top', '12px'], ['border-top-color', 'rgb(1, 2, 3)'], ['--x', 'var(--y)'], ['font-family', 'Georgia, serif'], ['border-top-width', 'calc(1px + 2px)']] as const) {
      const out = await applyEdit(page, edit({ property, value }), null);
      expect(out.error, `${property}: ${value}`).toBeNull();
      expect(out.applied).toBe(true);
    }
    expect(await borderColour()).toBe('rgb(1, 2, 3)');
  });
});
