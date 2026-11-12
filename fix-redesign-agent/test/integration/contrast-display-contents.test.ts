import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { textRunsInPage } from '../../src/preview/contrast.ts';

/**
 * Found by running the real generated preview: the app mirrors the page's html/body as `display: contents` elements, and the original
 * body carried `overflow: auto`. A display:contents element has no box (its rect is 0×0), so treating that overflow as a clip removed every
 * text run and the contrast check silently measured nothing ("could not run") on every real page.
 */

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

describe('textRunsInPage', () => {
  const runsFor = async (wrapperStyle: string) => {
    const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    await page.setContent(`<div id="host"></div><script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<div style="${wrapperStyle}"><section style="padding:20px;background:#fff"><h2 style="color:#222">Readable heading</h2></section></div>';
    </script>`);
    const host = (await page.$('#host'))!;
    return host.evaluate(textRunsInPage, { section: 's', origin: { x: 0, y: 0 } });
  };

  it('collects the text under a display:contents ancestor that carries overflow:auto', async () => {
    const runs = await runsFor('display:contents;overflow:auto');
    expect(runs.map((r) => r.text)).toEqual(['Readable heading']);
  });

  it('still clips by a real overflow box: text scrolled out of an overflow:hidden container is not a readable run', async () => {
    const runs = await runsFor('display:block;overflow:hidden;height:0');
    expect(runs).toEqual([]);
  });
});
