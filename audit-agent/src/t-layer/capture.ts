import type { BrowserContext, Page } from 'playwright';
import { TerminalError } from '../graph/retry.ts';
import type { BrowserPool, RenderingPolicy } from './browser.ts';
import { readCanonicalCandidates, resolveCanonical, type CanonicalResult } from './canonicalize.ts';
import { readRootFontSizePx } from './computed-style.ts';
import { summarizeConsole, type ConsoleSummary } from './console-noise.ts';
import { findPlaceholderCandidates, settleAndRecheck, type SettleOutcome } from './dynamic-content.ts';
import { parseAriaSnapshot, takeAriaSnapshot } from './element-registry.ts';
import type { Politeness } from './politeness.ts';
import { PageObserver, waitForRenderSettled, type RecordedRequest, type RenderSettledResult } from './render-settled.ts';

/**
 * One page, captured through the whole T-layer in the order the
 * architecture requires: isolated context → listeners attached BEFORE
 * navigation → politeness-paced goto → composite render-settled gate →
 * canonical read (after settling — Next.js streams metadata into <body>)
 * → console/network noise scoping → aria snapshot → placeholder settle.
 */

export interface PageCapture {
  requestedUrl: string;
  canonical: CanonicalResult;
  httpStatus: number | null;
  renderSettled: RenderSettledResult;
  network: {
    total: number;
    critical: number;
    noiseByReason: Record<string, number>;
    criticalFailures: Array<{ url: string; failure: string | null; status: number | null }>;
    /** Failures of speculative requests — recorded for auditability ("the prefetch aborted, the page was fine"), never classified as page failures. */
    speculativeFailures: Array<{ url: string; failure: string | null; noise: string | null }>;
  };
  console: ConsoleSummary;
  pageErrors: string[];
  ariaSnapshot: string;
  ariaElementCount: number;
  placeholders: Array<{ id: string } & SettleOutcome>;
  /**
   * The page's root font size in px, measured once after the page settled (`readRootFontSizePx`) — the
   * value its `rem` lengths resolve against. Persisted with the page's capture summary so a report can
   * show an expected `rem` value as the px it renders at on THIS page. null when it could not be read.
   */
  rootFontSizePx: number | null;
  renderingPolicy: RenderingPolicy;
  capturedAt: string;
  /** Raw request log — what fixtures record so noise classifiers can be replayed offline. */
  requests: RecordedRequest[];
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryAfter: string | null;

  constructor(status: number, url: string, retryAfter: string | null) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

function summarizeNetwork(requests: RecordedRequest[]): PageCapture['network'] {
  const noiseByReason: Record<string, number> = {};
  for (const r of requests) if (r.noise) noiseByReason[r.noise] = (noiseByReason[r.noise] ?? 0) + 1;
  const isFailure = (r: RecordedRequest) => r.failure !== null || (r.status !== null && r.status >= 400);
  return {
    total: requests.length,
    critical: requests.filter((r) => r.noise === null).length,
    noiseByReason,
    criticalFailures: requests.filter((r) => r.noise === null && isFailure(r)).map((r) => ({ url: r.url, failure: r.failure, status: r.status })),
    speculativeFailures: requests.filter((r) => r.noise !== null && isFailure(r)).map((r) => ({ url: r.url, failure: r.failure, noise: r.noise })),
  };
}

export async function withCapturedPage<T>(
  pool: BrowserPool,
  politeness: Politeness,
  url: string,
  fn: (page: Page, capture: PageCapture, observer: PageObserver, context: BrowserContext) => Promise<T>,
  opts: { settlePlaceholders?: boolean } = {},
): Promise<T> {
  return pool.withIsolatedPage(async (page, context) => {
    const observer = new PageObserver(page, url).attach();
    await politeness.beforeNavigation(url);
    // 'domcontentloaded', not 'load': the full load event waits on every subresource
    // and timed out at 30 s on two real kenresearch.com pages (2026-09-11 capture).
    // The bounded composite gate below does the actual waiting, with a cap.
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? null;
    if (status !== null && status >= 400) {
      const retryAfter = response ? await response.headerValue('retry-after') : null;
      if (status === 429 || status === 503) politeness.backOff(url, retryAfter);
      if (status === 404 || status === 410) throw new TerminalError(`HTTP ${status} for ${url} — page does not exist`);
      throw new HttpStatusError(status, url, retryAfter); // `.status` lets graph/retry.ts classify 429/5xx as RETRYABLE, other 4xx TERMINAL
    }

    const renderSettled = await waitForRenderSettled(page, observer);
    const canonical = resolveCanonical(await readCanonicalCandidates(page, url, response));
    const ariaSnapshot = await takeAriaSnapshot(page);

    const placeholders: PageCapture['placeholders'] = [];
    if (opts.settlePlaceholders ?? true) {
      for (const c of await findPlaceholderCandidates(page)) {
        const outcome = await settleAndRecheck(page, page.locator(`[data-audit-placeholder="${c.id}"]`));
        placeholders.push({ id: c.id, ...outcome, detectedAs: c.text });
      }
    }

    const capture: PageCapture = {
      requestedUrl: url,
      canonical,
      httpStatus: status,
      renderSettled,
      network: summarizeNetwork(observer.requests),
      console: summarizeConsole(observer.consoleMessages, {
        auditedOrigin: new URL(url).origin,
        speculativeUrls: observer.speculativeUrls(),
      }),
      pageErrors: [...observer.pageErrors],
      ariaSnapshot,
      ariaElementCount: parseAriaSnapshot(ariaSnapshot).length,
      placeholders,
      rootFontSizePx: await readRootFontSizePx(page),
      renderingPolicy: pool.renderingPolicy(),
      capturedAt: new Date().toISOString(),
      requests: observer.requests,
    };
    return fn(page, capture, observer, context);
  });
}
