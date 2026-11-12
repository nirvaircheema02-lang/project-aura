import type { BrowserContext } from 'playwright';
import { serializeStandaloneDocument } from './serialize.ts';
import { openStandinPage } from './temp-page.ts';

/**
 * The pre-edit page as ONE standalone document (every stylesheet and asset inlined) — the same form R7 writes to
 * `original.html` and R8 builds the preview from. The design baseline must be measured on THIS form: the raw
 * stamped DOM only references its stylesheets by `<link>`, and an offline load of it renders with no CSS at all
 * (font "Times", no borders, blue links), so every styled element of the preview then looked like a regression
 * against a baseline that was never styled (18 800 false "regressions" on the dealers-voice-survey run).
 */
export async function standaloneOriginalHtml(context: BrowserContext, url: string, rawHtml: string): Promise<string> {
  const page = await openStandinPage(context, url);
  try {
    await page.setContent(rawHtml, { waitUntil: 'domcontentloaded' });
    return (await serializeStandaloneDocument(page, { excludeSelector: null })).html;
  } finally {
    await page.close().catch(() => {});
  }
}
