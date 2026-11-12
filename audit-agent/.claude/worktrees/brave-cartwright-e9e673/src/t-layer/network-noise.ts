/**
 * ARCHITECTURE.md §2.4 network-noise scoping: failure classification
 * applies ONLY to the current page's critical-path resources. Speculative
 * requests (Next.js prefetch/RSC for OTHER routes) are filtered out first —
 * validated necessity: a real page audit saw `GET /survey/...?_rsc=... →
 * net::ERR_ABORTED`, a hover-prefetch for an unrelated page, while the
 * audited page rendered fine.
 *
 * Pure functions over a plain request shape (not Playwright's Request) so
 * they are testable offline against recorded real traffic. Grounding rule:
 * header detection alone is NOT sufficient (Next sets prefetch headers only
 * for some prefetch kinds) — the pathname rule (d) is the load-bearing one.
 */

export interface RequestFacts {
  url: string;
  resourceType: string; // Playwright's request.resourceType()
  /** Lower-cased header names, from request.allHeaders() (NOT headers(), which strips security headers). */
  headers: Record<string, string>;
  isMainFrame: boolean;
  isNavigationRequest: boolean;
}

export type NoiseReason =
  | 'next-router-prefetch-header'
  | 'next-router-segment-prefetch-header'
  | 'sec-purpose-prefetch'
  | 'rsc-fetch-for-other-pathname'
  | 'long-lived-stream'
  | 'non-main-frame'
  | 'third-party-analytics';

/** Hosts whose traffic is never this page's critical path (measurement/beacons). Extend as observed. */
const ANALYTICS_HOST_PATTERNS: RegExp[] = [
  // GA4 beacons go to analytics.google.com/g/collect — found in a live capture
  // (2026-09-11) where their routine ERR_ABORTEDs were being miscounted as
  // critical-page failures before this entry existed.
  /^analytics\.google\.com$/,
  /(^|\.)google-analytics\.com$/,
  /(^|\.)googletagmanager\.com$/,
  /(^|\.)doubleclick\.net$/,
  /(^|\.)leadfeeder\.(com|net)$/,
  /(^|\.)lfeeder\.com$/,
  /(^|\.)contentsquare\.(com|net)$/,
  /(^|\.)clarity\.ms$/,
  /(^|\.)facebook\.(com|net)$/,
  /(^|\.)linkedin\.com$/,
  /(^|\.)hotjar\.com$/,
];

function normalizePathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/** Returns why a request is speculative (not this page's work), or null if it may be critical-path. */
export function speculativeReason(req: RequestFacts, auditedPathname: string): NoiseReason | null {
  const h = req.headers;
  if (h['next-router-prefetch'] === '1') return 'next-router-prefetch-header';
  if (h['next-router-segment-prefetch'] !== undefined) return 'next-router-segment-prefetch-header';
  const secPurpose = h['sec-purpose'] ?? h['purpose'];
  if (secPurpose && /prefetch/i.test(secPurpose)) return 'sec-purpose-prefetch';

  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    return null;
  }
  const isRsc = h['rsc'] === '1' || parsed.searchParams.has('_rsc');
  if (isRsc && normalizePathname(parsed.pathname) !== normalizePathname(auditedPathname)) {
    // Passive audit, no clicks: ANY RSC fetch for a different pathname is by construction
    // not this page's critical path. Same-pathname RSC (router.refresh) stays critical.
    return 'rsc-fetch-for-other-pathname';
  }
  return null;
}

/** Full noise verdict: speculative, or excluded from the critical path for another reason. */
export function noiseReason(req: RequestFacts, auditedPathname: string): NoiseReason | null {
  const speculative = speculativeReason(req, auditedPathname);
  if (speculative) return speculative;
  if (['eventsource', 'websocket', 'media'].includes(req.resourceType)) return 'long-lived-stream'; // never "finish"
  if (!req.isMainFrame) return 'non-main-frame'; // third-party iframes, chat widgets
  try {
    const host = new URL(req.url).hostname;
    if (ANALYTICS_HOST_PATTERNS.some((re) => re.test(host))) return 'third-party-analytics';
  } catch {
    /* unparseable URL: let it through as critical rather than silently dropping it */
  }
  return null;
}

export function isCriticalPath(req: RequestFacts, auditedPathname: string): boolean {
  return noiseReason(req, auditedPathname) === null;
}
