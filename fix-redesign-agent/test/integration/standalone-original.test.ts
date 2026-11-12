import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { standaloneOriginalHtml } from '../../src/html/standalone-original.ts';
import { openOfflineSnapshot } from '../../src/preview/extract.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/**
 * Regression: the design baseline was measured on the raw stamped DOM loaded offline, where stylesheets referenced by <link>
 * never load — so the "original" had font Times / no borders and every styled element of the preview looked like a regression.
 */
const RAW = '<!doctype html><html><head><link rel="stylesheet" href="https://assets.test/a.css"></head><body><p id="t" style="">Hello</p></body></html>';
const CSS = 'p{font-family:Arial;border:2px solid red;line-height:30px}';

let pool: BrowserPool;
beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});

const styleOf = async (page: import('playwright').Page) =>
  page.locator('#t').evaluate((el) => { const c = getComputedStyle(el); return { font: c.fontFamily, border: c.borderTopStyle, lh: c.lineHeight }; });

describe('standaloneOriginalHtml', () => {
  it('REGRESSION: the raw DOM measured offline has no CSS, the standalone form carries it — the baseline must use the latter', async () => {
    const context = await pool.newIsolatedContext();
    try {
      await context.route('https://assets.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: CSS }));
      const rawOffline = await openOfflineSnapshot(context, RAW);
      const rawStyle = await styleOf(rawOffline.page);
      await rawOffline.close();
      expect(rawStyle.border).toBe('none'); // unstyled: what the old baseline measured
      expect(rawStyle.lh).toBe('normal');

      const html = await standaloneOriginalHtml(context, 'https://page.test/', RAW);
      expect(html).toContain('font-family:Arial');
      expect(html).not.toContain('rel="stylesheet"');
      const styled = await openOfflineSnapshot(context, html);
      const style = await styleOf(styled.page);
      await styled.close();
      expect(style).toEqual({ font: 'Arial', border: 'solid', lh: '30px' });
    } finally {
      await context.close();
    }
  }, 60_000);
});
