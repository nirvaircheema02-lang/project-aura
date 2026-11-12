import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStandinPage, waitForStylesheets } from '../../src/html/temp-page.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/**
 * Regression: a stand-in page ran the captured page's own scripts, which re-rendered the DOM and removed the data-fra-* stamps;
 * the design baseline taken on it found none of its sections ("section root not found on this page" ×22).
 */
let pool: BrowserPool;
beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});

describe('openStandinPage', () => {
  it('REGRESSION: does not load script files, so a hydrating framework cannot strip the stamps', async () => {
    const context = await pool.newIsolatedContext();
    try {
      await context.route('https://assets.test/app.js', (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: 'document.querySelectorAll("[data-fra-section]").forEach(e=>e.removeAttribute("data-fra-section")); window.__ran = true;' }),
      );
      const page = await openStandinPage(context, 'https://page.test/x');
      await page.setContent('<!doctype html><html><body><section data-fra-section="s1"><p>hi</p></section><script src="https://assets.test/app.js"></script></body></html>', { waitUntil: 'load' });
      expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined();
      expect(await page.locator('[data-fra-section="s1"]').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('still lets stylesheets and images load (the static snapshot keeps its look)', async () => {
    const context = await pool.newIsolatedContext();
    try {
      await context.route('https://assets.test/a.css', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: 'p{border:3px solid red}' }));
      const page = await openStandinPage(context, 'https://page.test/x');
      await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="https://assets.test/a.css"></head><body><p id="t">x</p></body></html>', { waitUntil: 'load' });
      expect(await page.locator('#t').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('3px');
    } finally {
      await context.close();
    }
  });

  it('REGRESSION: waitForStylesheets makes a measurement taken right after setContent see a SLOW external stylesheet (R5 reported a CSS-hidden button as lost)', async () => {
    const context = await pool.newIsolatedContext();
    try {
      await context.route('https://assets.test/slow.css', async (route) => {
        await new Promise((r) => setTimeout(r, 400));
        await route.fulfill({ status: 200, contentType: 'text/css', body: '.hidden-by-css{display:none}' });
      });
      const page = await openStandinPage(context, 'https://page.test/x');
      await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="https://assets.test/slow.css"></head><body><button class="hidden-by-css" id="b">x</button></body></html>', { waitUntil: 'domcontentloaded' });
      await waitForStylesheets(page);
      expect(await page.locator('#b').evaluate((el) => getComputedStyle(el).display)).toBe('none');
    } finally {
      await context.close();
    }
  });

  it('gives up on a stylesheet that never answers instead of waiting for it', async () => {
    const context = await pool.newIsolatedContext();
    try {
      await context.route('https://assets.test/never.css', () => undefined);
      const page = await openStandinPage(context, 'https://page.test/x');
      await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="https://assets.test/never.css"></head><body>x</body></html>', { waitUntil: 'domcontentloaded' });
      const started = Date.now();
      await waitForStylesheets(page, 600);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await context.close();
    }
  });
});
