import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveCandidate } from '../../src/mapping/candidates.ts';
import { stampElementDetailed, STAMP_ATTR_ELEMENT, STAMP_ATTR_FINDINGS } from '../../src/mapping/stamp.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Regression for the C2 failure on dealers-voice-survey (a 15 s `locator.evaluate` timeout):
 * a hidden header menu item's box overlapped a visible stat, so the stamp step hit-tested onto
 * the STAT, appended the menu finding to the stat's findings list and reported success without
 * writing the id C2 had allocated — C2 then waited on `[data-fra-element="eN"]`, which existed
 * nowhere. Real Chromium, no mocks.
 */

const FIXTURE = `<!doctype html><html><head><title>stamp-integrity</title>
<style>body{margin:0;font-family:sans-serif} #stat{position:absolute;left:20px;top:100px;width:200px;height:40px;margin:0}
#ghost{position:absolute;left:20px;top:100px;width:200px;height:40px;opacity:0;pointer-events:none}
#other{position:absolute;left:20px;top:300px;width:200px;height:40px;margin:0}</style></head>
<body><p id="stat">34+ NPS uplift</p><a id="ghost" href="/x">Defense &amp; Security</a><p id="other">Another paragraph</p></body></html>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
beforeAll(async () => {
  server = await startLocalServer({ '/fixture': { body: FIXTURE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
  await server?.close();
});
async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return pool.withIsolatedPage(async (page) => {
    await page.goto(`${server.origin}/fixture`);
    return fn(page);
  });
}
async function candidateFor(page: Page, selector: string): Promise<LiveCandidate> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    return {
      candidateId: `cand-${sel}`, tagName: el.tagName.toLowerCase(), role: null,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200), classes: Array.from(el.classList),
      box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
      href: el.getAttribute('href'), type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null,
      disabled: false, cursor: null, formAssociated: false,
    };
  }, selector);
}
const attrs = (elementId: string, findingId: string) => ({ elementId, findingId, signature: null, instanceIndex: null, productionType: 'paragraph' });
const findingsOf = (page: Page, sel: string) => page.locator(sel).getAttribute(STAMP_ATTR_FINDINGS);
const idOf = (page: Page, sel: string) => page.locator(sel).getAttribute(STAMP_ATTR_ELEMENT);

describe('stampElementDetailed — identity and unique stamps', () => {
  it('stamps a visible element and reports the id that resolves to exactly one element', async () => {
    await withPage(async (page) => {
      const out = await stampElementDetailed(page, await candidateFor(page, '#other'), attrs('e1', 'f-other'));
      expect(out).toMatchObject({ stamped: true, elementId: 'e1', merged: false, reason: null });
      expect(await page.locator(`[${STAMP_ATTR_ELEMENT}="e1"]`).count()).toBe(1);
    });
  });

  it('REGRESSION: a hidden candidate overlapping an already-stamped element is NOT merged into it — nothing is written, no phantom id', async () => {
    await withPage(async (page) => {
      await stampElementDetailed(page, await candidateFor(page, '#stat'), attrs('e1', 'f-stat'));
      const ghost = await candidateFor(page, '#ghost');
      const out = await stampElementDetailed(page, ghost, attrs('e2', 'f-ghost'));
      expect(out.stamped).toBe(false);
      expect(out.elementId).toBeNull();
      expect(out.reason).toBe('identity-mismatch');
      expect(await findingsOf(page, '#stat')).toBe('f-stat'); // the stat is untouched
      expect(await idOf(page, '#stat')).toBe('e1');
      expect(await page.locator(`[${STAMP_ATTR_ELEMENT}="e2"]`).count()).toBe(0);
      expect(await page.locator(`[${STAMP_ATTR_FINDINGS}~="f-ghost"]`).count()).toBe(0);
    });
  });

  it('merging a second finding into the SAME element returns that element\'s existing id (not the freshly allocated one)', async () => {
    await withPage(async (page) => {
      await stampElementDetailed(page, await candidateFor(page, '#stat'), attrs('e1', 'f1'));
      const out = await stampElementDetailed(page, await candidateFor(page, '#stat'), attrs('e9', 'f2'));
      expect(out).toMatchObject({ stamped: true, elementId: 'e1', merged: true });
      expect(await findingsOf(page, '#stat')).toBe('f1 f2');
      expect(await page.locator(`[${STAMP_ATTR_ELEMENT}="e9"]`).count()).toBe(0);
    });
  });

  it('refuses an id that another element already carries (unique stamps) and writes nothing', async () => {
    await withPage(async (page) => {
      await stampElementDetailed(page, await candidateFor(page, '#stat'), attrs('e1', 'f1'));
      const out = await stampElementDetailed(page, await candidateFor(page, '#other'), attrs('e1', 'f2'));
      expect(out).toMatchObject({ stamped: false, reason: 'stamp-not-unique' });
      expect(await idOf(page, '#other')).toBeNull();
      expect(await page.locator(`[${STAMP_ATTR_ELEMENT}="e1"]`).count()).toBe(1);
    });
  });

  it('reports a candidate that is off-screen after scrolling as unresolved, never stamped', async () => {
    await withPage(async (page) => {
      const c = await candidateFor(page, '#other');
      c.box = { ...c.box, y: 50000 };
      const out = await stampElementDetailed(page, c, attrs('e1', 'f1'));
      expect(out.stamped).toBe(false);
      expect(['off-screen', 'no-element-at-box']).toContain(out.reason);
    });
  });
});
