import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeSnapshotDom } from '../../src/html/snapshot-dom.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/**
 * Regression: a <p> inside a <p> (built by JS) was split by the HTML parser on the round trip, so the collapsed FAQ
 * answers fell out of their height:0 container and showed fully open in the preview.
 */
let pool: BrowserPool;
beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});

const BUILD = `
  const li = document.createElement('li');
  const h = document.createElement('h3'); h.textContent = 'Question?'; h.setAttribute('data-fra-element', 'e1');
  const outer = document.createElement('p'); outer.id = 'ans'; outer.className = 'h-0 overflow-hidden'; outer.style.height = '0px'; outer.style.overflow = 'hidden'; outer.setAttribute('data-fra-element', 'e2');
  for (const t of ['Answer one.', 'Answer two.']) { const inner = document.createElement('p'); inner.textContent = t; outer.appendChild(inner); }
  li.append(h, outer); document.body.appendChild(li);
  const plain = document.createElement('p'); plain.id = 'plain'; plain.textContent = 'plain paragraph'; document.body.appendChild(plain);`;

describe('serializeSnapshotDom', () => {
  it('REGRESSION: the collapsed container keeps its children after the HTML round trip (answers stay hidden, not spilled)', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.evaluate(BUILD);
      // what the old snapshot did: raw page.content() — the parser splits <p><p>
      const naive = await page.content();
      await page.setContent(naive);
      expect(await page.locator('#ans').evaluate((el) => el.children.length)).toBe(0); // the answers fell out
      // the fixed snapshot
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.evaluate(BUILD);
      const html = await serializeSnapshotDom(page);
      await page.setContent(html);
      expect(await page.locator('#ans').evaluate((el) => el.children.length)).toBe(2);
      expect(await page.locator('#ans').evaluate((el) => el.tagName)).toBe('DIV');
      expect(await page.locator('#ans').evaluate((el) => getComputedStyle(el).height)).toBe('0px');
      expect(await page.locator('#ans').evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden'); // children clipped inside, not spilled
      expect(await page.locator('[data-fra-element="e2"]').count()).toBe(1); // stamp travelled with the element
    });
  });

  it('leaves ordinary paragraphs as <p> and does not touch the live page', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.evaluate(BUILD);
      const html = await serializeSnapshotDom(page);
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('<p id="plain">plain paragraph</p>');
      expect(await page.locator('#ans').evaluate((el) => el.tagName)).toBe('P'); // live DOM untouched
    });
  });

  it('FROZEN CAPTURE: a stylesheet link becomes an inline <style> with absolute urls; an empty one stops the capture', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.route('https://site.test/**', (route) => {
        const u = route.request().url();
        if (u.endsWith('/page')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/_next/a.css"></head><body><p id="x">hi</p></body></html>' });
        if (u.endsWith('/a.css')) return route.fulfill({ contentType: 'text/css', body: '@font-face{font-family:F;src:url(/m/f.woff2)} #x{color:rgb(1,2,3)}' });
        if (u.endsWith('/empty.css')) return route.fulfill({ contentType: 'text/css', body: '' });
        return route.fulfill({ status: 404, body: '' });
      });
      await page.goto('https://site.test/page');
      const html = await serializeSnapshotDom(page);
      expect(html).not.toMatch(/<link[^>]*stylesheet/);
      expect(html).toContain('data-fra-inlined-from="/_next/a.css"');
      expect(html).toContain('url(https://site.test/m/f.woff2)');
      await page.evaluate(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/empty.css'; document.head.appendChild(l); });
      await expect(serializeSnapshotDom(page)).rejects.toThrow(/stylesheet\(s\) could not be frozen/);
    });
  });
});
