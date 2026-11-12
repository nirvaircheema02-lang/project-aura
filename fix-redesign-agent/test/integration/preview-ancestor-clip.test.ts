import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clipsHorizontally, syncAncestorClip } from '../../templates/react-preview/src/runtime/clip.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/**
 * Regression: the page root clips on phones (`max-sm:overflow-hidden`); the preview mirrors it as `display: contents`, which clips
 * nothing, so a 700px decorative gradient made the page 661px wide on a 390px screen (required check "no horizontal overflow" failed).
 */
let pool: BrowserPool;
beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});

const HELPERS = `${clipsHorizontally.toString()}\n${syncAncestorClip.toString()}`;
const SETUP = `${HELPERS}
  const host = document.createElement('div'); host.style.display = 'block'; document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const css = new CSSStyleSheet(); css.replaceSync('.root{position:relative} @media (max-width: 639px){ .root{overflow:hidden} } .deco{position:absolute;top:0;left:0;width:700px;height:20px;background:red}');
  shadow.adoptedStyleSheets = [css];
  const wrapper = document.createElement('div'); wrapper.className = 'root'; wrapper.style.setProperty('display', 'contents', 'important');
  const sec = document.createElement('div'); sec.style.cssText = 'position:relative;width:100%;height:40px'; const deco = document.createElement('div'); deco.className = 'deco'; sec.appendChild(deco); wrapper.appendChild(sec); shadow.appendChild(wrapper);
  window.__wrappers = [wrapper]; window.__host = host;`;

describe('ancestor clip handed to the section host', () => {
  it('clipsHorizontally knows clipping values only', () => {
    for (const v of ['hidden', 'clip', 'scroll', 'auto']) expect(clipsHorizontally(v)).toBe(true);
    expect(clipsHorizontally('visible')).toBe(false);
  });

  it('REGRESSION: on a 390px screen the wrapper\'s clip is applied to the host and the page is no longer wider than the screen', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
      await page.evaluate(`(() => { ${SETUP} })()`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeGreaterThan(390); // display:contents lost the clip
      const clipped = await page.evaluate(`(() => { ${HELPERS}\n return syncAncestorClip(window.__host, window.__wrappers); })()`);
      expect(clipped).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    });
  });

  it('on a desktop screen the original does not clip, so neither does the preview', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
      await page.evaluate(`(() => { ${SETUP} })()`);
      const clipped = await page.evaluate(`(() => { ${HELPERS}\n return syncAncestorClip(window.__host, window.__wrappers); })()`);
      expect(clipped).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { __host: HTMLElement }).__host.style.overflowX)).toBe('');
    });
  });
});
