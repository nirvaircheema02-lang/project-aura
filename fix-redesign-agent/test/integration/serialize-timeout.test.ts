import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeStandaloneDocument } from '../../src/html/serialize.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/**
 * Regression: the static export fetched every stylesheet/image with no timeout, so one hung asset held R7 for
 * 45+ minutes (dealers-voice-survey run). A hung asset is now abandoned after 8 s and reported missing.
 */
let pool: BrowserPool;
beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});

describe('serializeStandaloneDocument', () => {
  it('REGRESSION: an asset that never responds does not hold the export — it finishes in ~8 s and the asset is reported missing', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.route('https://assets.test/**', (route) => {
        if (route.request().url().endsWith('ok.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: 'p{color:red}' });
        return undefined; // never answered: the request hangs
      });
      await page.route('https://page.test/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="https://assets.test/hang.css"><link rel="stylesheet" href="https://assets.test/ok.css"></head><body><p>hi</p></body></html>' }));
      await page.goto('https://page.test/', { waitUntil: 'commit' });
      await page.waitForSelector('p', { state: 'attached' });
      const started = Date.now();
      const out = await serializeStandaloneDocument(page, { excludeSelector: null });
      const took = Date.now() - started;
      expect(took).toBeLessThan(20_000);
      expect(out.missingAssets.some((m) => m.includes('hang.css'))).toBe(true);
      expect(out.html).toContain('p{color:red}'); // the responsive asset was still inlined
    });
  }, 60_000);
});
