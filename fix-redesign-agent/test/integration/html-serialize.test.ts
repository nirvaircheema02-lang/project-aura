import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeStandaloneDocument } from '../../src/html/serialize.ts';
import { zeroNetworkCheck } from '../../src/html/export-validate.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * §8.4 CSS isolation export rules, proved against a REAL browser: serializeStandaloneDocument
 * runs entirely inside `page.evaluate`, so only a real DOM/CSSOM settles what "inline every
 * stylesheet, verbatim, in document order" and "preserve sibling position" actually mean.
 */

const FIXTURE_PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/style.css">
<style>.local{color:red}</style>
<script src="https://www.clarity.ms/tag/tb0c94rtg1"></script>
</head><body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-KJNFVRG" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<iframe id="legit" src="https://example.com/embedded-video"></iframe>
<header data-fra-section="header">NAV-CONTENT-MARKER</header>
<main>
<p class="local">Hello</p>
<img id="pic" src="/pic.png" alt="pic">
<img id="broken" src="/does-not-exist.png" alt="broken">
</main>
<footer data-fra-section="footer">FOOTER-CONTENT-MARKER</footer>
<script src="https://sc.lfeeder.com/lftracker"></script>
<script>console.log('inline, no src — left alone, never network-flagged by zeroNetworkCheck')</script>
</body></html>`;

const FIXTURE_CSS = `@font-face{font-family:'TestFont';src:url('/font.woff') format('woff')}
body{font-family:'TestFont',sans-serif}
@media (min-width:100px){.responsive{color:rgb(0, 0, 255)}}`;

// A malformed page where the "header" landmark structurally NESTS a real content section —
// used only by the regression test below; a real page shouldn't be built this way, but the
// export must refuse rather than silently delete the nested content along with the header.
const FIXTURE_PAGE_NESTED = `<!doctype html><html><body>
<header data-fra-section="header">
  NAV-MARKER
  <section data-fra-section="hero">HERO-CONTENT-MARKER</section>
</header>
</body></html>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;

beforeAll(async () => {
  server = await startLocalServer({
    '/page': { body: FIXTURE_PAGE },
    '/nested-page': { body: FIXTURE_PAGE_NESTED },
    '/style.css': { body: FIXTURE_CSS, headers: { 'content-type': 'text/css' } },
    '/font.woff': { body: 'FAKEFONTDATA', headers: { 'content-type': 'font/woff' } },
    '/pic.png': { body: 'FAKEPNGDATA', headers: { 'content-type': 'image/png' } },
  });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSRedesignTest/0.1' });
  await pool.start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.close();
});

async function serializeFixture(excludeSelector: string | null) {
  return pool.withIsolatedPage(async (page) => {
    await page.goto(`${server.origin}/page`, { waitUntil: 'domcontentloaded' });
    return serializeStandaloneDocument(page, { excludeSelector });
  });
}

describe('serializeStandaloneDocument — §8.4 CSS isolation, in a real browser', () => {
  it('rule 1+2: never lifts a subtree — an excluded header/footer is replaced by an inert placeholder, preserving sibling position', async () => {
    const { html } = await serializeFixture('header, footer');

    expect(html).not.toContain('NAV-CONTENT-MARKER');
    expect(html).not.toContain('FOOTER-CONTENT-MARKER');
    expect(html).toMatch(/<div data-fra-removed="header"[^>]*hidden/);
    expect(html).toMatch(/<div data-fra-removed="footer"[^>]*hidden/);

    // sibling position preserved: the placeholders still bracket <main>, in document order —
    // never a bare removal that would renumber a type-based positional selector.
    const headerIdx = html.indexOf('data-fra-removed="header"');
    const mainIdx = html.indexOf('<main>');
    const footerIdx = html.indexOf('data-fra-removed="footer"');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeLessThan(mainIdx);
    expect(mainIdx).toBeLessThan(footerIdx);
  }, 60_000);

  it('rules 3-6: inlines the external stylesheet, the inline <style>, the @font-face and the <img> as data URIs, preserving conditional rules verbatim', async () => {
    const { html, embeddedAssets, missingAssets } = await serializeFixture('header, footer');

    // rule 3: the <link> is replaced in place by an inlined <style>, never merged/reordered.
    expect(html).toContain('data-fra-inlined-from="/style.css"');
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);

    // rule 4: conditional (media) rules copied as-is, verbatim text.
    expect(html).toContain('@media (min-width:100px){.responsive{color:rgb(0, 0, 255)}}');

    // the pre-existing inline <style> survives untouched.
    expect(html).toContain('.local{color:red}');

    // rule 5: @font-face src inlined as a data URI.
    expect(html).toMatch(/url\("data:font\/woff;base64,[^"]+"\)\s*format\('woff'\)/);

    // rule 6: <img> inlined as a data URI.
    const picTag = html.match(/<img id="pic"[^>]*>/)?.[0];
    expect(picTag).toMatch(/src="data:image\/png;base64,/);
  }, 60_000);

  it('rule 6: an asset that cannot be inlined is left as-is (never dropped, never a live URL pretending to work) and recorded as missing', async () => {
    const { html, missingAssets } = await serializeFixture('header, footer');

    const brokenTag = html.match(/<img id="broken"[^>]*>/)?.[0];
    expect(brokenTag).toContain('src="/does-not-exist.png"');
    expect(missingAssets.some((m) => m.includes('does-not-exist.png'))).toBe(true);
  }, 60_000);

  it('reports accurate embedded/missing asset counts: the stylesheet, its @font-face, and the one valid image — the broken image only as missing', async () => {
    const { embeddedAssets, missingAssets } = await serializeFixture('header, footer');
    expect(embeddedAssets).toBe(3);
    expect(missingAssets).toHaveLength(1);
  }, 60_000);

  it('with excludeSelector: null, nothing is removed — both header and footer content survive', async () => {
    const { html } = await serializeFixture(null);
    expect(html).toContain('NAV-CONTENT-MARKER');
    expect(html).toContain('FOOTER-CONTENT-MARKER');
    expect(html).not.toContain('data-fra-removed');
  }, 60_000);

  it('adversarial-review regression: every externally-sourced <script> (a real production page\'s own analytics/tracking tags — Clarity, Leadfeeder) is removed, never left to fire a live network request from an offline "static" export; an inline script with no src is untouched and never network-flagged', async () => {
    const { html } = await serializeFixture('header, footer');
    expect(html).not.toContain('clarity.ms');
    expect(html).not.toContain('lfeeder.com');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("console.log('inline, no src"); // untouched — not what this fix targets
    expect(html).not.toContain('googletagmanager.com'); // the GTM tag inside <noscript> — removed with its wrapper
    expect(html).not.toContain('<noscript');
    expect(html).toContain('id="legit"'); // a genuine embedded iframe is real content — never removed
    // the actual §8.5 check this was found failing — the fixture's OWN deliberately-broken
    // image (a separate, already-covered case above) is the only thing still allowed to trip it.
    expect(zeroNetworkCheck(html).some((f) => f.includes('clarity.ms') || f.includes('lfeeder.com'))).toBe(false);
  }, 60_000);

  it('regression: refuses (never silently deletes) when the excluded subtree structurally CONTAINS a real content section', async () => {
    await expect(
      pool.withIsolatedPage(async (page) => {
        await page.goto(`${server.origin}/nested-page`, { waitUntil: 'domcontentloaded' });
        return serializeStandaloneDocument(page, { excludeSelector: 'header' });
      }),
    ).rejects.toThrow(/structurally contains a content section/);
  }, 60_000);
});
