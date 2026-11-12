import type { BrowserContext, Page } from 'playwright';

/**
 * A page loaded via `page.setContent(html)` alone — never actually navigated — stays at the
 * `about:blank` origin. `document.baseURI`/`location.href` never becomes the audited page's
 * real URL, so the browser refuses any relative-URL `fetch()` a stylesheet/font/image inliner
 * issues from inside it (confirmed empirically: `about:blank` → `fetch('/x.css')` throws
 * "Failed to fetch", even with a `<base href>` correcting the URL *string* — a `<base>` tag
 * only fixes how relative URLs are resolved to absolute ones, never the page's actual origin,
 * which is what same-origin `fetch()` is actually gated on).
 *
 * The fix: navigate to the real URL first — but with its own network response INTERCEPTED
 * and fulfilled locally, so the navigation itself never leaves this process (confirmed
 * empirically: the target URL is never hit; only the genuinely-needed asset fetches that
 * follow go out for real, and those typically hit this same browser context's HTTP cache
 * from R2's original capture anyway). The page's origin/`location.href` become the real URL,
 * so every subsequent relative-URL fetch resolves and authenticates exactly as it would on
 * the real page — then `page.setContent()` overwrites the DOM with whatever HTML the caller
 * actually wants to inline/measure from.
 */
export async function openStandinPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  // A stand-in page holds a STATIC snapshot. The captured page's own scripts (framework hydration, carousel timers) must not run
  // in it: they re-render the DOM and drop the data-fra-* stamps (a baseline taken on such a page found none of its sections) and
  // keep the browser busy. Script files are not loaded; inline data scripts stay inert without their runtime.
  await page.route('**/*', (route) => (route.request().resourceType() === 'script' ? route.abort() : route.fallback()));
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`^${escaped}$`);
  await page.route(exact, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
  try {
    await page.goto(url, { waitUntil: 'commit' });
  } finally {
    await page.unroute(exact);
  }
  return page;
}

/**
 * `setContent(..., 'domcontentloaded')` does not wait for `<link rel="stylesheet">`: a measurement taken straight after it can run
 * BEFORE the page's CSS applies (an element hidden only by an external stylesheet then looked visible, and was reported lost).
 * Waits until every stylesheet link has loaded or failed, at most `ms` — a stylesheet that never answers is given up on, not waited for.
 */
export async function waitForStylesheets(page: Page, ms = 8000): Promise<void> {
  await page.evaluate(
    (limit) =>
      new Promise<void>((resolve) => {
        const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).filter((l) => !l.sheet);
        if (links.length === 0) return resolve();
        let left = links.length;
        const done = () => { if (--left <= 0) resolve(); };
        for (const l of links) { l.addEventListener('load', done, { once: true }); l.addEventListener('error', done, { once: true }); }
        setTimeout(resolve, limit);
      }),
    ms,
  );
}
