import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachAccordion, handleAccordionClick, panelOf, setOpen } from '../../templates/react-preview/src/runtime/accordion.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/**
 * Real Chromium. Markup copied from the production FAQ: li.cursor-pointer > svg + h3 + p.h-0[style=height:0px] with the answer inside.
 * Behaviour recorded on production: single-open, chevron rotates, click again closes.
 */
let pool: BrowserPool;
beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});

const item = (q: string, a: string) => `<li class="cursor-pointer relative"><svg width="18" height="18" style="transition:all .3s"><path d="M0 0"/></svg><h3>${q}</h3><div class="h-0 overflow-hidden" style="height: 0px;transition:height .3s"><div>${a}<br>${a}<br>${a}</div></div></li>`;
const PAGE = `<!doctype html><html><body><ul id="faq">${item('Q1', 'answer one')}${item('Q2', 'answer two')}${item('Q3', 'answer three')}</ul></body></html>`;
const FNS = `${panelOf.toString()}\n${setOpen.toString()}\n${handleAccordionClick.toString()}\n${attachAccordion.toString()}`;
// the module-level helpers (chevronOf, isOpen) are not exported: inline equivalents are provided to the page
const HELPERS = `function chevronOf(item){return item.querySelector(':scope > svg');}\nfunction isOpen(item){return item.getAttribute('data-pv-open')==='true';}\n${FNS}`;

const heights = (page: import('playwright').Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('li')).map((li) => li.querySelector<HTMLElement>('.h-0')!.style.height));
const rotated = (page: import('playwright').Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('li')).map((li) => li.querySelector('svg')!.style.transform));

describe('FAQ accordion replay', () => {
  it('opens on click, closes the previously open item, rotates the chevron, and closes again on a second click', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent(PAGE);
      await page.evaluate(`(() => { ${HELPERS}\n attachAccordion(document); })()`);
      expect(await heights(page)).toEqual(['0px', '0px', '0px']);

      await page.locator('li').nth(0).locator('h3').click();
      let h = await heights(page);
      expect(parseInt(h[0]!)).toBeGreaterThan(20);
      expect(h.slice(1)).toEqual(['0px', '0px']);
      expect((await rotated(page))[0]).toBe('rotate(180deg)');

      await page.locator('li').nth(1).locator('h3').click(); // single-open: Q1 closes
      h = await heights(page);
      expect(h[0]).toBe('0px');
      expect(parseInt(h[1]!)).toBeGreaterThan(20);
      expect(await rotated(page)).toEqual(['', 'rotate(180deg)', '']);

      await page.locator('li').nth(1).locator('h3').click(); // same item again: closes
      expect(await heights(page)).toEqual(['0px', '0px', '0px']);
      expect(await rotated(page)).toEqual(['', '', '']);
    });
  });

  it('clicking inside the open answer also toggles, like the original (the whole item is the click target)', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent(PAGE);
      await page.evaluate(`(() => { ${HELPERS}\n attachAccordion(document); })()`);
      await page.locator('li').nth(2).locator('h3').click();
      expect(parseInt((await heights(page))[2]!)).toBeGreaterThan(20);
      await page.locator('li').nth(2).locator('.h-0 div').first().click({ force: true });
      expect((await heights(page))[2]).toBe('0px');
    });
  });

  it('ignores clicks outside any accordion item and items without a collapsed panel', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent(`${PAGE}<p id="out">outside</p><div class="cursor-pointer" id="plain">no panel</div>`);
      await page.evaluate(`(() => { ${HELPERS}\n attachAccordion(document); })()`);
      await page.locator('#out').click();
      await page.locator('#plain').click();
      expect(await heights(page)).toEqual(['0px', '0px', '0px']);
    });
  });
});
