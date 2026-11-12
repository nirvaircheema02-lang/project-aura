import type { Page } from 'playwright';

/**
 * §8.4 — CSS isolation for exported documents, implemented IN the live browser (not a
 * hand-rolled Node-side HTML parser) so real DOM semantics decide what "the whole document,
 * minus an excluded subtree" means, exactly as the page itself renders it:
 *
 *  1. never lift a subtree — clone the WHOLE document, remove only the excluded subtrees;
 *  2. preserve sibling position — a removed subtree becomes an inert placeholder;
 *  3. inline every stylesheet at the position of its `<link>`, verbatim, in document order;
 *  4. conditional rules (media/container/support queries) are copied as-is — CSS text is
 *     never re-parsed or rewritten, only the delivery mechanism (link → inline) changes;
 *  5. fonts inlined as data URIs (via each stylesheet's own `@font-face src: url(...)`);
 *  6. images/media inlined as data URIs; anything unreachable is recorded, never left live;
 *  7. the DS stylesheet, when injected, is appended after the page's own and marked as such.
 */

export interface SerializeResult {
  html: string;
  embeddedAssets: number;
  missingAssets: string[];
}

interface RawSerializeResult {
  html: string;
  embedded: number;
  missing: string[];
}

/**
 * Runs entirely inside the page — everything below executes in-browser via `page.evaluate`.
 * Playwright serializes only this function's OWN source text to run there; it must not close
 * over any outer (Node-scope) helper — every helper it needs is declared inside it.
 */
async function serializeInPage(opts: { excludeSelector: string | null }): Promise<RawSerializeResult> {
  const missing: string[] = [];
  let embedded = 0;

  function errorDetail(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function toBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
  }

  // One slow or hung asset must never hold the whole export: every fetch (headers and body) is aborted after 8 s and the
  // asset is reported missing, like any other asset that cannot be fetched.
  function timedFetch(abs: string): Promise<Response> {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 8000);
    // A script `fetch` sends `Accept: */*`, and an image optimizer (Next.js `/_next/image`, `Vary: Accept`) then answers with a JPEG, which drops the alpha
    // channel of a logo/icon/avatar (black square in the export). An <img> request names webp/png first; so does this one. (Literal inside the function:
    // it is serialized into the page.)
    return fetch(abs, { cache: 'force-cache', signal: ctl.signal, headers: { Accept: 'image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' } });
  }

  async function fetchAsDataUri(url: string, fallbackMime?: string): Promise<string | null> {
    try {
      const abs = new URL(url, document.baseURI).href;
      const res = await timedFetch(abs);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const mime = res.headers.get('content-type') || fallbackMime || 'application/octet-stream';
      const buf = await res.arrayBuffer();
      embedded++;
      return 'data:' + mime.split(';')[0] + ';base64,' + toBase64(buf);
    } catch (err) {
      missing.push(url + ' — ' + errorDetail(err));
      return null;
    }
  }

  async function inlineUrlsInCss(cssText: string, baseHref?: string): Promise<string> {
    const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(cssText))) matches.push(m);
    let out = cssText;
    for (const match of matches.reverse()) {
      const raw = match[2]!;
      if (raw.startsWith('data:')) continue;
      const abs = new URL(raw, baseHref || document.baseURI).href;
      const dataUri = await fetchAsDataUri(abs);
      if (dataUri) out = out.slice(0, match.index) + 'url("' + dataUri + '")' + out.slice(match.index + match[0].length);
    }
    return out;
  }

  const root = document.documentElement.cloneNode(true) as HTMLElement;

  if (opts.excludeSelector) {
    const toRemove = Array.from(root.querySelectorAll(opts.excludeSelector));
    for (const el of toRemove) {
      // A matched (global/excluded) subtree that structurally CONTAINS a content section is
      // never silently deleted whole — that would drop real content along with the header/
      // footer wrapper (§8.1: findings outside scope are listed with a reason, never dropped;
      // this is the export-time equivalent of that rule). A landmark legitimately nesting a
      // content section this way is itself a page-structure problem worth surfacing loudly.
      const nested = el.querySelector('[data-fra-section]');
      if (nested) {
        throw new Error(`excludeSelector "${opts.excludeSelector}" matched an element that structurally contains a content section (data-fra-section="${nested.getAttribute('data-fra-section')}") — refusing to delete it silently`);
      }
      const placeholder = document.createElement('div');
      placeholder.setAttribute('data-fra-removed', el.getAttribute('data-fra-section') || 'excluded');
      placeholder.setAttribute('hidden', '');
      el.replaceWith(placeholder);
    }
  }

  // 1. Inline every <link rel=stylesheet>, in document order, verbatim CSS text.
  const links = Array.from(root.querySelectorAll('link[rel~="stylesheet"]'));
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const abs = new URL(href, document.baseURI).href;
      const res = await timedFetch(abs);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let cssText = await res.text();
      cssText = await inlineUrlsInCss(cssText, abs);
      const style = document.createElement('style');
      style.setAttribute('data-fra-inlined-from', href);
      style.textContent = cssText;
      link.replaceWith(style);
      embedded++;
    } catch (err) {
      missing.push(href + ' (stylesheet) — ' + errorDetail(err));
    }
  }

  // 2. Inline url(...) references inside every <style> tag already in the document (including
  // the fra-injected-edits / fra-ds-stylesheet tags, which may reference DS assets).
  const styleTags = Array.from(root.querySelectorAll('style'));
  for (const style of styleTags) {
    if (style.textContent && style.textContent.includes('url(')) {
      style.textContent = await inlineUrlsInCss(style.textContent, document.baseURI);
    }
  }

  // 3. Remove every externally-sourced <script> (analytics/tag-manager/tracking tags a real
  // production page embeds — Clarity, Leadfeeder, etc. are what this was actually found
  // against). §10 already documents that script-driven behavior never runs in this snapshot;
  // LEAVING one of these in would go further than "doesn't run" — opening the file would fire
  // a real network request to a live, third-party tracking endpoint. Never inlined (unlike
  // CSS/fonts/images, executing arbitrary third-party JS offline has real side effects this
  // system does not want), only removed outright — a `<script>` has no visual layout to
  // preserve a placeholder for, unlike a removed content subtree (point 2 above).
  const externalScripts = Array.from(root.querySelectorAll('script[src]'));
  for (const script of externalScripts) script.remove();

  // 3b. Remove every <noscript> element outright (found via a real page's own Google Tag
  // Manager fallback: `<noscript><iframe src="googletagmanager.com/ns.html?...">`). The live
  // page was captured with scripting ENABLED (same as this export will normally be opened
  // with), so a browser NEVER parses <noscript> content into real elements — it is opaque TEXT,
  // unreachable by querySelectorAll/remove on the element it might textually describe. That
  // text still contains a literal live tracking URL, though, which the exported HTML carries
  // verbatim either way — dropping the whole (inert, in the normal case) <noscript> element
  // removes that text along with it, without touching anything that actually renders.
  const noscripts = Array.from(root.querySelectorAll('noscript'));
  for (const el of noscripts) el.remove();

  // 4. Inline every <img> — currentSrc/src as a data URI; srcset dropped (documented limit:
  // the browser would otherwise re-select a non-inlined candidate).
  const imgs = Array.from(root.querySelectorAll('img'));
  const liveImgs = Array.from(document.images);
  for (const img of imgs) {
    const idx = imgs.indexOf(img);
    const liveSrc = liveImgs[idx] ? liveImgs[idx].currentSrc || liveImgs[idx].src : img.getAttribute('src');
    if (!liveSrc) continue;
    const dataUri = await fetchAsDataUri(liveSrc);
    if (dataUri) {
      img.setAttribute('src', dataUri);
      img.removeAttribute('srcset');
    }
  }

  return { html: '<!doctype html>\n' + root.outerHTML, embedded, missing };
}

export async function serializeStandaloneDocument(page: Page, opts: { excludeSelector: string | null } = { excludeSelector: null }): Promise<SerializeResult> {
  const result = await page.evaluate(serializeInPage, opts);
  return { html: result.html, embeddedAssets: result.embedded, missingAssets: result.missing };
}
