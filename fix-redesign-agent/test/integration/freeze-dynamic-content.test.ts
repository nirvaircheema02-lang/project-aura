import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freezeDynamicContent, FREEZE_INIT_SCRIPT } from '../../src/t-layer/dynamic-content.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Carousels must be captured on their FIRST state so every resume sees the same page (the
 * dealers-voice-survey run restarted its plan loop forever because the rotating text changed).
 * Real Chromium, no mocks: a slow setInterval rotator, a fast UI timer, and a Swiper-shaped carousel.
 */
const FIXTURE = `<!doctype html><html><head><title>freeze</title></head><body>
<p id="slow">first</p><p id="fast">0</p>
<div class="swiper" id="sw"><div id="slide">slide-0</div></div>
<script>
  let i = 0; const names = ['first','second','third'];
  setInterval(() => { i = (i + 1) % 3; document.getElementById('slow').textContent = names[i]; }, 2000);
  let n = 0; setInterval(() => { n++; document.getElementById('fast').textContent = String(n); }, 100);
  let idx = 0;
  document.getElementById('sw').swiper = {
    params: { loop: true }, autoplay: { stop() { window.__stopped = true; } },
    slideToLoop(k) { idx = k; document.getElementById('slide').textContent = 'slide-' + k; window.__to = k; }, slideTo() {},
  };
  idx = 2; document.getElementById('slide').textContent = 'slide-2';
</script></body></html>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
beforeAll(async () => {
  server = await startLocalServer({ '/f': { body: FIXTURE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
  await server?.close();
});

async function withFrozenPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const context = await pool.newIsolatedContext();
  try {
    await context.addInitScript(FREEZE_INIT_SCRIPT);
    const page = await context.newPage();
    await page.goto(`${server.origin}/f`);
    return await fn(page);
  } finally {
    await context.close();
  }
}

describe('freezeDynamicContent', () => {
  it('REGRESSION: a slow auto-rotate timer never changes the captured text, while fast UI timers still run', async () => {
    await withFrozenPage(async (page) => {
      await page.waitForTimeout(2600);
      expect(await page.locator('#slow').textContent()).toBe('first');
      expect(Number(await page.locator('#fast').textContent())).toBeGreaterThan(3);
    });
  });

  it('stops carousel autoplay and returns the carousel to its first slide', async () => {
    await withFrozenPage(async (page) => {
      expect(await page.locator('#slide').textContent()).toBe('slide-2');
      const out = await freezeDynamicContent(page);
      expect(out).toEqual({ carousels: 1, returnedToFirst: 1 });
      expect(await page.locator('#slide').textContent()).toBe('slide-0');
      expect(await page.evaluate(() => (window as unknown as { __stopped?: boolean }).__stopped)).toBe(true);
    });
  });

  it('reports 0 carousels on a page without any', async () => {
    const context = await pool.newIsolatedContext();
    try {
      const page = await context.newPage();
      await page.setContent('<p>no carousel</p>');
      expect(await freezeDynamicContent(page)).toEqual({ carousels: 0, returnedToFirst: 0 });
    } finally {
      await context.close();
    }
  });
});
