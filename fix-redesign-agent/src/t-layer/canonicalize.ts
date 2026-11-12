// Vendored verbatim from audit-agent src/t-layer/canonicalize.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
import type { Page, Response } from 'playwright';

/**
 * ARCHITECTURE.md §0 URL canonicalization. Precedence (grounding research):
 *   HTTP `Link: <…>; rel="canonical"` header → first `<link rel~=canonical>`
 *   (more than one ⇒ treated as absent, logged) → `og:url` → conservative
 *   generic normalization (scheme/host case, default port, fragment, a fixed
 *   tracking-param list, trailing slash).
 *
 * Explicit precedence rule for the conflict the research flagged between
 * §0's two rules ("prefer the declared canonical" vs "never strip a query
 * parameter that could change rendered content"): if the observed URL has
 * any non-tracking query parameter that the canonical drops, the OBSERVED
 * (generically normalized) URL is kept as the page identity and the
 * canonical is recorded as metadata only. Rationale: kenresearch.com's
 * tabbed/faceted listings declare a canonical pointing at the bare listing,
 * and those tabs were validated as distinct API-backed states — merging
 * them would silently corrupt §4.4 re-audit diffing. This errs toward NOT
 * merging, which is the safer failure.
 */

const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref_src)$/i;

export type CanonicalSource = 'http-link-header' | 'link-rel-canonical' | 'og-url' | 'generic';

export interface CanonicalCandidates {
  requestedUrl: string;
  finalUrl: string; // location.href after redirects
  linkHeader: string | null;
  linkRelCanonical: string[]; // every <link rel~=canonical> href, resolved
  ogUrl: string | null;
}

export interface CanonicalResult {
  /** The URL page_id is derived from (§2.5 rule 1 / §2.5 rule 6's run key). */
  pageUrl: string;
  /** The page's own declared canonical, if any — always recorded, even when not used as pageUrl. */
  declaredCanonical: string | null;
  source: CanonicalSource;
  notes: string[];
}

export function genericNormalize(input: string): string {
  const url = new URL(input);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

/** Naive registrable domain (last two labels) — fails closed for multi-part TLDs, which only means falling back to generic normalization. */
function registrableDomain(hostname: string): string {
  return hostname.toLowerCase().split('.').slice(-2).join('.');
}

function parseLinkHeaderCanonical(header: string | null, base: string): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;(.*)$/);
    if (m && /rel\s*=\s*"?[^";]*\bcanonical\b/i.test(m[2] as string)) {
      try {
        return new URL(m[1] as string, base).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

function nonTrackingParams(url: string): Set<string> {
  const keys = new Set<string>();
  for (const k of new URL(url).searchParams.keys()) if (!TRACKING_PARAM.test(k)) keys.add(k);
  return keys;
}

export function resolveCanonical(c: CanonicalCandidates): CanonicalResult {
  const notes: string[] = [];
  const observed = genericNormalize(c.finalUrl);
  const siteDomain = registrableDomain(new URL(c.finalUrl).hostname);

  const candidates: Array<{ source: CanonicalSource; value: string | null }> = [
    { source: 'http-link-header', value: parseLinkHeaderCanonical(c.linkHeader, c.finalUrl) },
    {
      source: 'link-rel-canonical',
      value: c.linkRelCanonical.length === 1 ? (c.linkRelCanonical[0] as string) : null,
    },
    { source: 'og-url', value: c.ogUrl },
  ];
  if (c.linkRelCanonical.length > 1) {
    notes.push(`${c.linkRelCanonical.length} <link rel=canonical> tags found — treated as absent (ambiguous)`);
  }

  for (const { source, value } of candidates) {
    if (!value) continue;
    let normalized: string;
    try {
      normalized = genericNormalize(value);
    } catch {
      notes.push(`${source} "${value}" is not a valid URL — ignored`);
      continue;
    }
    if (registrableDomain(new URL(normalized).hostname) !== siteDomain) {
      notes.push(`${source} "${value}" points off-site (${new URL(normalized).hostname}) — ignored (misconfigured metadataBase guard)`);
      continue;
    }
    const dropped = [...nonTrackingParams(observed)].filter((k) => !nonTrackingParams(normalized).has(k));
    if (dropped.length > 0) {
      notes.push(
        `${source} drops query param(s) [${dropped.join(', ')}] present on the observed URL — kept the observed URL as page identity, canonical recorded as metadata (possible distinct state, e.g. a tab)`,
      );
      return { pageUrl: observed, declaredCanonical: normalized, source: 'generic', notes };
    }
    if (normalized !== observed) notes.push(`${source} canonical differs from the observed URL — using the declared canonical`);
    return { pageUrl: normalized, declaredCanonical: normalized, source, notes };
  }

  return { pageUrl: observed, declaredCanonical: null, source: 'generic', notes };
}

/**
 * Reads canonical candidates from a RENDERED page (after the render-settled
 * gate): Next.js streaming metadata can append tags to <body>, so this reads
 * the whole document, not just <head>, and uses resolved `.href`.
 */
export async function readCanonicalCandidates(page: Page, requestedUrl: string, response: Response | null): Promise<CanonicalCandidates> {
  const inPage = await page.evaluate(() => ({
    finalUrl: location.href,
    linkRelCanonical: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="canonical" i]')).map((l) => l.href),
    ogUrl: document.querySelector<HTMLMetaElement>('meta[property="og:url" i]')?.content ?? null,
  }));
  return {
    requestedUrl,
    finalUrl: inPage.finalUrl,
    linkHeader: response ? await response.headerValue('link') : null,
    linkRelCanonical: inPage.linkRelCanonical,
    ogUrl: inPage.ogUrl,
  };
}
