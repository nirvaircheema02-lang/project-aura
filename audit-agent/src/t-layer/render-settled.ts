import type { Page, Request } from 'playwright';
import { noiseReason, type NoiseReason, type RequestFacts } from './network-noise.ts';
import type { ConsoleFacts } from './console-noise.ts';

/**
 * ARCHITECTURE.md §2.7 render-settled precondition, implemented as the
 * COMPOSITE gate the grounding research requires — NOT
 * waitForLoadState('networkidle'), which Playwright's current docs mark
 * DISCOURAGED and which hangs on prefetch-heavy Next.js pages:
 *   1. critical-path network idle (in-flight set of non-noise requests,
 *      500 ms quiet window — mirrors Playwright's own networkidle definition —
 *      with a hard cap; on cap, continue with `partial: true`, never fail);
 *   2. a bounded DOM-mutation quiet window;
 *   3. `document.fonts.ready` (must settle before any typography measurement).
 *
 * PageObserver must be attached BEFORE page.goto — page.requests() is a
 * bounded 100-entry buffer and page.consoleMessages() ~200, but real pages
 * produced 343 requests / 1198+ console messages during validation.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  resourceType: string;
  isMainFrame: boolean;
  isNavigationRequest: boolean;
  /** Only the headers the noise predicates read — recorded so fixtures replay offline. */
  headers: Record<string, string>;
  noise: NoiseReason | null;
  status: number | null;
  failure: string | null;
  /** ms since the observer was attached — calibration evidence for the gate's caps (and §2.6 tracing). */
  startedAtMs: number;
  endedAtMs: number | null;
  /** Playwright request.timing(), ms relative to the request's own start (-1 = unavailable). Separates queueing from slow servers. */
  timing: { requestStart: number; responseStart: number; responseEnd: number } | null;
}

const RELEVANT_HEADERS = ['next-router-prefetch', 'next-router-segment-prefetch', 'rsc', 'next-url', 'sec-purpose', 'purpose'];

function pickHeaders(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of RELEVANT_HEADERS) if (all[k] !== undefined) out[k] = all[k] as string;
  return out;
}

export class PageObserver {
  readonly requests: RecordedRequest[] = [];
  readonly consoleMessages: ConsoleFacts[] = [];
  readonly pageErrors: string[] = [];
  private readonly inFlight = new Set<Request>();
  private readonly records = new Map<Request, RecordedRequest>();
  private lastCriticalActivity = Date.now();
  /**
   * Updated on every main-frame commit: after a redirect (real case:
   * /malaysia-… → /industry-reports/malaysia-…), the page's own RSC fetches
   * target the FINAL pathname and must not be classified as another route's.
   */
  private auditedPathname: string;
  private readonly page: Page;
  readonly attachedAt = Date.now();

  constructor(page: Page, auditedUrl: string) {
    this.page = page;
    this.auditedPathname = new URL(auditedUrl).pathname;
  }

  private facts(req: Request, headers: Record<string, string>): RequestFacts {
    return {
      url: req.url(),
      resourceType: req.resourceType(),
      headers,
      isMainFrame: req.frame() === this.page.mainFrame(),
      isNavigationRequest: req.isNavigationRequest(),
    };
  }

  attach(): this {
    this.page.on('request', (req) => {
      // Phase 1 (sync): headers() carries the app-set Next.js headers; URL rules are sync.
      const syncHeaders = pickHeaders(req.headers());
      const record: RecordedRequest = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        isMainFrame: false,
        isNavigationRequest: req.isNavigationRequest(),
        headers: syncHeaders,
        noise: null,
        status: null,
        failure: null,
        startedAtMs: Date.now() - this.attachedAt,
        endedAtMs: null,
        timing: null,
      };
      let facts: RequestFacts;
      try {
        facts = this.facts(req, syncHeaders);
      } catch {
        facts = { url: req.url(), resourceType: req.resourceType(), headers: syncHeaders, isMainFrame: false, isNavigationRequest: false };
      }
      record.isMainFrame = facts.isMainFrame;
      record.noise = noiseReason(facts, this.auditedPathname);
      this.requests.push(record);
      this.records.set(req, record);
      if (record.noise === null) {
        this.inFlight.add(req);
        this.lastCriticalActivity = Date.now();
      }
      // Phase 2 (async): allHeaders() includes security headers (sec-purpose) that
      // headers() omits — refine, and drop from in-flight if it's actually speculative.
      void req
        .allHeaders()
        .then((all) => {
          const refined = pickHeaders(all);
          record.headers = refined;
          const verdict = noiseReason({ ...facts, headers: refined }, this.auditedPathname);
          if (verdict !== null && record.noise === null) {
            record.noise = verdict;
            this.inFlight.delete(req);
          }
        })
        .catch(() => {});
    });
    const settle = (req: Request, failure: string | null) => {
      const record = this.records.get(req);
      if (record) {
        record.failure = failure;
        record.endedAtMs = Date.now() - this.attachedAt;
        try {
          const t = req.timing();
          record.timing = { requestStart: t.requestStart, responseStart: t.responseStart, responseEnd: t.responseEnd };
        } catch {
          /* timing unavailable for this request */
        }
      }
      if (this.inFlight.delete(req)) this.lastCriticalActivity = Date.now();
    };
    this.page.on('requestfinished', (req) => {
      void req
        .response()
        .then((res) => {
          const record = this.records.get(req);
          if (record && res) record.status = res.status();
        })
        .catch(() => {});
      settle(req, null);
    });
    this.page.on('requestfailed', (req) => settle(req, req.failure()?.errorText ?? 'unknown failure'));
    this.page.on('console', (msg) => {
      this.consoleMessages.push({ type: msg.type(), text: msg.text(), locationUrl: msg.location().url || undefined });
    });
    this.page.on('pageerror', (err) => this.pageErrors.push(err.message));
    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page.mainFrame()) return;
      try {
        this.auditedPathname = new URL(frame.url()).pathname;
      } catch {
        /* about:blank etc. — keep the previous pathname */
      }
    });
    return this;
  }

  /**
   * Resolves once no LIVE critical-path request has been in flight for
   * `quietMs`, or at `capMs`. A request in flight longer than `staleAfterMs`
   * stops blocking and is reported as stale instead — calibrated on live
   * captures (2026-09-11): 96/96 normal critical requests finished well inside
   * the cap, while the only blockers were image requests that never emitted
   * ANY finished/failed event (cancelled loads, e.g. cloned carousel slides),
   * which no amount of waiting resolves. Whether those images actually
   * rendered is checked from the DOM in waitForRenderSettled, which is the
   * signal a visual audit needs.
   */
  async waitForCriticalIdle(
    quietMs = 500,
    capMs = 15_000,
    staleAfterMs = 8_000,
  ): Promise<{ settled: boolean; stillInFlight: string[]; staleInFlight: string[] }> {
    const start = Date.now();
    const live = () => [...this.inFlight].filter((r) => {
      const rec = this.records.get(r);
      return !rec || Date.now() - this.attachedAt - rec.startedAtMs < staleAfterMs;
    });
    const stale = () => [...this.inFlight].filter((r) => !live().includes(r)).map((r) => r.url());
    while (Date.now() - start < capMs) {
      if (live().length === 0 && Date.now() - this.lastCriticalActivity >= quietMs) {
        return { settled: true, stillInFlight: [], staleInFlight: stale() };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { settled: false, stillInFlight: live().map((r) => r.url()), staleInFlight: stale() };
  }

  speculativeUrls(): Set<string> {
    return new Set(this.requests.filter((r) => r.noise !== null).map((r) => r.url));
  }
}

export interface RenderSettledResult {
  /** False when any leg hit its cap — S8 may down-weight findings from a partially-settled capture. */
  settled: boolean;
  network: { settled: boolean; stillInFlight: string[]; staleInFlight: string[] };
  /**
   * Images intersecting the viewport, checked in the DOM (ground truth for
   * what a screenshot will show): `incomplete` = still loading (blocks
   * `settled`); `broken` = finished but failed to decode/load (naturalWidth 0)
   * — itself potential B5 evidence, never silently ignored.
   */
  viewportImages: { total: number; incomplete: string[]; broken: string[] };
  /**
   * CONTENT stability: structural (childList) + text (characterData)
   * mutations only. Attribute mutations are counted but deliberately don't
   * block — carousels/animations toggle inline styles and classes forever;
   * a live capture (2026-09-11) showed an attribute-inclusive quiet window
   * never settling on any real kenresearch.com page, which would make
   * `settled` false everywhere and S8's down-weighting meaningless.
   */
  domQuiet: boolean;
  mutationCounts: { childList: number; characterData: number; attributes: number };
  fonts: { status: string };
  /** When the gate began, in ms since the observer attached (same clock as RecordedRequest.startedAtMs). */
  gateStartedAtMs: number;
  elapsedMs: number;
}

/** In-viewport <img> state from the DOM. Lazy images below the fold are legitimately unloaded and are not counted. */
export async function readViewportImages(page: Page): Promise<RenderSettledResult['viewportImages']> {
  return page.evaluate(() => {
    const incomplete: string[] = [];
    const broken: string[] = [];
    let total = 0;
    for (const img of Array.from(document.images)) {
      const r = img.getBoundingClientRect();
      const inViewport = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      if (!inViewport) continue;
      const style = getComputedStyle(img);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      total++;
      const src = img.currentSrc || img.src;
      if (!img.complete) incomplete.push(src);
      else if (img.naturalWidth === 0 && src) broken.push(src);
    }
    return { total, incomplete, broken };
  });
}

export async function waitForRenderSettled(
  page: Page,
  observer: PageObserver,
  opts: { networkQuietMs?: number; networkCapMs?: number; domQuietMs?: number; domCapMs?: number } = {},
): Promise<RenderSettledResult> {
  const start = Date.now();
  const network = await observer.waitForCriticalIdle(opts.networkQuietMs ?? 500, opts.networkCapMs ?? 15_000);
  const dom = await page.evaluate(
    ({ quietMs, capMs }) =>
      new Promise<{ quiet: boolean; counts: { childList: number; characterData: number; attributes: number } }>((resolve) => {
        const counts = { childList: 0, characterData: 0, attributes: 0 };
        let timer = setTimeout(() => done(true), quietMs);
        const cap = setTimeout(() => done(false), capMs);
        const mo = new MutationObserver((records) => {
          let contentChanged = false;
          for (const r of records) {
            counts[r.type as keyof typeof counts]++;
            if (r.type !== 'attributes') contentChanged = true;
          }
          if (contentChanged) {
            clearTimeout(timer);
            timer = setTimeout(() => done(true), quietMs);
          }
        });
        function done(quiet: boolean) {
          clearTimeout(timer);
          clearTimeout(cap);
          mo.disconnect();
          resolve({ quiet, counts });
        }
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      }),
    { quietMs: opts.domQuietMs ?? 500, capMs: opts.domCapMs ?? 5_000 },
  );
  const fontsStatus = await page.evaluate(() => document.fonts.ready.then(() => document.fonts.status));
  const viewportImages = await readViewportImages(page);
  return {
    settled: network.settled && dom.quiet && fontsStatus === 'loaded' && viewportImages.incomplete.length === 0,
    network,
    viewportImages,
    domQuiet: dom.quiet,
    mutationCounts: dom.counts,
    fonts: { status: fontsStatus },
    gateStartedAtMs: start - observer.attachedAt,
    elapsedMs: Date.now() - start,
  };
}
