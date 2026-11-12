import { join } from 'node:path';
import { readCanonicalCandidates, resolveCanonical } from '../../t-layer/canonicalize.ts';
import { summarizeConsole } from '../../t-layer/console-noise.ts';
import { findPlaceholderCandidates, freezeDynamicContent, FREEZE_INIT_SCRIPT, settleAndRecheck } from '../../t-layer/dynamic-content.ts';
import { parseAriaSnapshot, takeAriaSnapshot } from '../../t-layer/element-registry.ts';
import type { BrowserPool } from '../../t-layer/browser.ts';
import type { Politeness } from '../../t-layer/politeness.ts';
import { HttpStatusError, type PageCapture } from '../../t-layer/capture.ts';
import { captureOverviewTiles } from '../../t-layer/screenshot.ts';
import { compositeTilesToFile } from '../../imaging/index.ts';
import { computeCaptureFingerprint } from '../../mapping/stamp.ts';
import { TerminalError } from '../../retry.ts';
import type { RedesignPaths } from '../../output/redesign-store.ts';
import type { R1Output, R2Output } from '../types.ts';

/**
 * R2 — Capture (deterministic, §8.6). Deliberately does NOT use the vendored
 * `withCapturedPage`/`BrowserPool.withIsolatedPage` convenience wrapper: both close their
 * context in a `finally` the instant their callback returns, which is correct for
 * audit-agent's B1 (capture, extract, done) but wrong here — this repo's whole point is
 * keeping the SAME live page open from R2 through the last R5 so R4 mutates it in place
 * (§6.7's hydration note; the v1 `CaptureSession.release()` contract). So R2 replicates the
 * same capture sequence `capture.ts` documents (isolated context → listeners attached BEFORE
 * navigation → politeness-paced goto → composite render-settled gate → canonical read →
 * console/network noise scoping → aria snapshot → placeholder settle), manually, and hands
 * the still-open context back to the caller instead of closing it.
 */

export const R2_STATUS = 'implemented' as const;

export interface R2Deps {
  pool: BrowserPool;
  politeness: Politeness;
  paths: RedesignPaths;
  log?: (line: string) => void;
}

// Duplicated from t-layer/render-settled.ts's PageObserver + waitForRenderSettled usage pattern
// is avoided by importing them directly — see below.
import { PageObserver, waitForRenderSettled } from '../../t-layer/render-settled.ts';

export async function runR2(deps: R2Deps, r1: R1Output): Promise<R2Output> {
  const log = deps.log ?? (() => {});
  const url = r1.targetUrl;
  const context = await deps.pool.newIsolatedContext();
  let page;
  try {
    await context.addInitScript(FREEZE_INIT_SCRIPT);
    page = await context.newPage();
    const observer = new PageObserver(page, url).attach();
    await deps.politeness.beforeNavigation(url);
    log(`R2 · navigating to ${url}`);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? null;
    if (status !== null && status >= 400) {
      const retryAfter = response ? await response.headerValue('retry-after') : null;
      if (status === 429 || status === 503) deps.politeness.backOff(url, retryAfter);
      if (status === 404 || status === 410) throw new TerminalError(`HTTP ${status} for ${url} — page does not exist`);
      throw new HttpStatusError(status, url, retryAfter);
    }

    const renderSettled = await waitForRenderSettled(page, observer);
    const frozen = await freezeDynamicContent(page);
    log(`R2 · carousels frozen on their first state (${frozen.returnedToFirst}/${frozen.carousels}); slow auto-rotate timers disabled`);
    const canonical = resolveCanonical(await readCanonicalCandidates(page, url, response));
    const ariaSnapshot = await takeAriaSnapshot(page);

    const placeholders: PageCapture['placeholders'] = [];
    for (const c of await findPlaceholderCandidates(page)) {
      const outcome = await settleAndRecheck(page, page.locator(`[data-audit-placeholder="${c.id}"]`));
      placeholders.push({ id: c.id, ...outcome, detectedAs: c.text });
    }

    const capture: PageCapture = {
      requestedUrl: url,
      canonical,
      httpStatus: status,
      renderSettled,
      network: {
        total: observer.requests.length,
        critical: observer.requests.filter((r) => r.noise === null).length,
        noiseByReason: observer.requests.reduce<Record<string, number>>((acc, r) => {
          if (r.noise) acc[r.noise] = (acc[r.noise] ?? 0) + 1;
          return acc;
        }, {}),
        criticalFailures: observer.requests.filter((r) => r.noise === null && (r.failure !== null || (r.status !== null && r.status >= 400))).map((r) => ({ url: r.url, failure: r.failure, status: r.status })),
        speculativeFailures: observer.requests.filter((r) => r.noise !== null && (r.failure !== null || (r.status !== null && r.status >= 400))).map((r) => ({ url: r.url, failure: r.failure, noise: r.noise })),
      },
      console: summarizeConsole(observer.consoleMessages, { auditedOrigin: new URL(url).origin, speculativeUrls: observer.speculativeUrls() }),
      pageErrors: [...observer.pageErrors],
      ariaSnapshot,
      ariaElementCount: parseAriaSnapshot(ariaSnapshot).length,
      placeholders,
      renderingPolicy: deps.pool.renderingPolicy(),
      capturedAt: new Date().toISOString(),
      requests: observer.requests,
    };

    if (!renderSettled.settled) log(`R2 · warning: render did not fully settle (network ${renderSettled.network.settled}, dom ${renderSettled.domQuiet}, fonts ${renderSettled.fonts.status})`);

    // The audit's OWN viewport when recorded (§8.9's "audit's viewport" default), else the
    // engine's own default — both are 1440×900 in practice, but this reads it rather than assumes it.
    const auditViewport = (r1.audit.run as { renderingPolicy?: { viewport?: { width: number; height: number } } }).renderingPolicy?.viewport;
    if (auditViewport && (auditViewport.width !== deps.pool.renderingPolicy().viewport.width || auditViewport.height !== deps.pool.renderingPolicy().viewport.height)) {
      log(`R2 · note: the audit ran at ${auditViewport.width}×${auditViewport.height}; this capture's viewport is ${deps.pool.renderingPolicy().viewport.width}×${deps.pool.renderingPolicy().viewport.height} (the browser pool's fixed viewport) — recorded, never silently reconciled`);
    }

    const captureFingerprint = await computeCaptureFingerprint(page, capture.renderingPolicy);

    log('R2 · capturing overview tiles');
    const tiles = await captureOverviewTiles(page, (i) => join(deps.paths.beforeTilesDir, `page-tile-${i}.png`));
    const compositeResult = await compositeTilesToFile(tiles.tiles.map((t) => t.path), deps.paths.beforePng);

    return {
      page,
      context,
      observer,
      capture,
      before: { tiles: tiles.tiles, totalHeight: tiles.totalHeight, truncated: tiles.truncated, composite: compositeResult ? { path: compositeResult.outPath, plan: compositeResult.plan } : null },
      viewport: capture.renderingPolicy.viewport,
      captureFingerprint,
      originalHtml: null,
      mapping: null,
      release: async () => {
        await context.close();
      },
    };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}
