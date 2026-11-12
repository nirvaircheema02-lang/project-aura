import { genericNormalize } from '../../t-layer/canonicalize.ts';
import type { BrowserPool } from '../../t-layer/browser.ts';
import type { Politeness } from '../../t-layer/politeness.ts';

/**
 * A1 — Site Mapper (v1.0 §3): discover URLs, canonicalize, remove duplicates,
 * build the auditable inventory. Deterministic by design — the spec is
 * explicit that site mapping should be scripts, not model reasoning.
 *
 * Sitemap first (cheap, authoritative, and polite: one request instead of a
 * crawl), falling back to a bounded same-origin crawl.
 */

export interface DiscoveredUrl {
  url: string;
  source: 'sitemap' | 'crawl' | 'seed';
}

export interface SiteMap {
  root: string;
  urls: DiscoveredUrl[];
  /** Named limits that actually bit, so a partial inventory is never mistaken for the whole site. */
  limits: { maxPages: number; truncated: boolean; crawlDepth: number };
  sitemapUrl: string | null;
}

const NON_HTML = /\.(pdf|jpe?g|png|gif|svg|webp|ico|css|js|zip|xml|json|woff2?|mp4|webm)$/i;

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Extracts <loc> entries, following one level of sitemap index. */
export async function fetchSitemap(root: string, fetchImpl: typeof fetch = fetch): Promise<{ urls: string[]; sitemapUrl: string | null }> {
  const candidate = new URL('/sitemap.xml', root).toString();
  try {
    const response = await fetchImpl(candidate, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { urls: [], sitemapUrl: null };
    const xml = await response.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1] as string);
    const isIndex = /<sitemapindex/i.test(xml);
    if (!isIndex) return { urls: locs, sitemapUrl: candidate };

    const nested: string[] = [];
    for (const child of locs.slice(0, 20)) {
      try {
        const childResponse = await fetchImpl(child, { signal: AbortSignal.timeout(15_000) });
        if (!childResponse.ok) continue;
        const childXml = await childResponse.text();
        nested.push(...[...childXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1] as string));
      } catch {
        /* a broken child sitemap must not sink discovery */
      }
    }
    return { urls: nested, sitemapUrl: candidate };
  } catch {
    return { urls: [], sitemapUrl: null };
  }
}

/** Bounded same-origin BFS crawl, paced by the politeness limiter. */
export async function crawl(
  root: string,
  pool: BrowserPool,
  politeness: Politeness,
  opts: { maxPages: number; maxDepth: number },
): Promise<string[]> {
  const seen = new Set<string>([genericNormalize(root)]);
  const queue: Array<{ url: string; depth: number }> = [{ url: root, depth: 0 }];
  const found: string[] = [];

  while (queue.length > 0 && found.length < opts.maxPages) {
    const next = queue.shift();
    if (!next || next.depth > opts.maxDepth) continue;
    await politeness.beforeNavigation(next.url);
    try {
      const links = await pool.withIsolatedPage(async (page) => {
        await page.goto(next.url, { waitUntil: 'domcontentloaded' });
        return page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href));
      });
      found.push(next.url);
      for (const href of links) {
        if (!sameOrigin(href, root) || NON_HTML.test(new URL(href).pathname)) continue;
        const normalized = genericNormalize(href);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        queue.push({ url: normalized, depth: next.depth + 1 });
      }
    } catch {
      // A page that will not load is not discoverable; B will report it properly if seeded.
    }
  }
  return found;
}

export async function buildSiteMap(
  root: string,
  deps: { pool: BrowserPool; politeness: Politeness; fetchImpl?: typeof fetch },
  opts: { maxPages?: number; maxDepth?: number } = {},
): Promise<SiteMap> {
  const maxPages = opts.maxPages ?? 50;
  const maxDepth = opts.maxDepth ?? 2;

  const { urls: sitemapUrls, sitemapUrl } = await fetchSitemap(root, deps.fetchImpl ?? fetch);
  const fromSitemap = sitemapUrls.filter((u) => sameOrigin(u, root) && !NON_HTML.test(new URL(u).pathname));

  let discovered: DiscoveredUrl[];
  if (fromSitemap.length > 0) {
    discovered = fromSitemap.map((url) => ({ url: genericNormalize(url), source: 'sitemap' as const }));
  } else {
    const crawled = await crawl(root, deps.pool, deps.politeness, { maxPages, maxDepth });
    discovered = crawled.map((url) => ({ url: genericNormalize(url), source: 'crawl' as const }));
  }

  // The root itself is always auditable, even if no discovery method returned it.
  const rootNormalized = genericNormalize(root);
  if (!discovered.some((d) => d.url === rootNormalized)) discovered.unshift({ url: rootNormalized, source: 'seed' });

  const unique = new Map<string, DiscoveredUrl>();
  for (const d of discovered) if (!unique.has(d.url)) unique.set(d.url, d);
  const all = [...unique.values()];
  const truncated = all.length > maxPages;

  return {
    root: rootNormalized,
    urls: all.slice(0, maxPages),
    limits: { maxPages, truncated, crawlDepth: maxDepth },
    sitemapUrl,
  };
}
