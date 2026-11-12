import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

/**
 * "What Makes Our Way Different": hovering a numbered card fades the others to 20%, as on the live page. The cards are mounted into the shadow root AFTER
 * the behaviours are attached, so the behaviour must work for content that arrives later.
 */
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const SRC = readFileSync(new URL('../../templates/react-preview/src/runtime/cardFocus.ts', import.meta.url), 'utf8');
const JS = ts.transpileModule(SRC, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText.replace(/export /g, '');

const CARD = 'border border-[#EDECFB] h-[140px] flex';

describe('card focus (hover fades the other cards)', () => {
  it('fades every other card, restores them when the pointer leaves a card, and works for cards mounted after attach', async () => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
    try {
      const page = await ctx.newPage();
      await page.setContent('<div id="host" style="width:700px;height:300px"></div>');
      await page.evaluate(JS);
      await page.evaluate(() => {
        const host = document.getElementById('host')!;
        const shadow = host.attachShadow({ mode: 'open' });
        (window as any).__stop = (window as any).attachCardFocus(shadow); // attached BEFORE the content exists
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,200px);gap:20px;padding:20px';
        for (let i = 0; i < 3; i++) { const c = document.createElement('div'); c.className = 'border border-[#EDECFB] h-[140px] flex'; c.textContent = `card ${i}`; c.style.cssText = 'height:140px;opacity:1'; grid.appendChild(c); }
        const other = document.createElement('div'); other.className = 'unrelated'; other.textContent = 'x'; other.style.height = '40px'; grid.appendChild(other);
        shadow.appendChild(grid);
      });
      const ops = () => page.evaluate(() => [...document.getElementById('host')!.shadowRoot!.querySelectorAll('div[class*="h-[140px]"]')].map((c) => getComputedStyle(c).opacity));
      expect(await ops()).toEqual(['1', '1', '1']);
      await page.mouse.move(120, 80); await page.mouse.move(325, 90, { steps: 4 }); // second card
      expect(await ops()).toEqual(['0.2', '1', '0.2']);
      await page.mouse.move(540, 90, { steps: 4 }); // third card
      expect(await ops()).toEqual(['0.2', '0.2', '1']);
      await page.mouse.move(330, 230, { steps: 4 }); // the unrelated element below the cards
      expect(await ops()).toEqual(['1', '1', '1']);
      await page.mouse.move(325, 90, { steps: 4 }); // back on a card …
      expect(await ops()).toEqual(['0.2', '1', '0.2']);
      await page.mouse.move(870, 590, { steps: 6 }); // … then out of the shadow tree altogether (empty page area outside the host's content)
      expect(await ops()).toEqual(['1', '1', '1']);
    } finally { await ctx.close(); }
  });
  it('ignores touch pointers (no hover on a phone, as on the live page)', () => {
    expect(SRC).toContain("pointerType !== 'mouse'");
    expect(CARD).toContain('h-[140px]');
  });
});
