import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * ARCHITECTURE.md §2.7 per-instance isolation: one long-lived Browser per
 * process, one BrowserContext per B instance (incognito-like, fully
 * isolated — no cookies/storage/session/autofill shared between concurrent
 * audits or carried across runs), explicit close in `finally`. Never
 * `browser.newPage()` — Playwright's own docs reserve that for scripts.
 *
 * The rendering environment is pinned so findings are comparable run to
 * run; `renderingPolicy()` returns exactly what gets recorded into
 * policy_version (grounding risk: an unpinned headless variant pollutes
 * REGRESSION deltas with browser upgrades).
 *
 * Engine lock (open decision #4, closed at build step 11): the engine is
 * Playwright's own bundled Chromium — never a system Chrome/Edge install —
 * and `playwright` is pinned to an exact version in package.json, which pins
 * the Chromium build. The exact browser version is recorded per run, so a
 * browser change is visible in run metadata instead of surfacing as a fake
 * REGRESSION.
 */

export type BrowserChannel = 'chromium' | 'chromium-headless-shell';

/** The Playwright release that pins the Chromium build. Read from the installed package, never hardcoded. */
export const PLAYWRIGHT_VERSION: string = (createRequire(import.meta.url)('playwright/package.json') as { version: string }).version;

export interface RenderingPolicy {
  /** Always Playwright's bundled Chromium (see the engine lock above). */
  engine: 'chromium';
  channel: BrowserChannel;
  /** Exact build reported by the running browser, e.g. "141.0.7390.37". */
  browserVersion: string;
  playwrightVersion: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  colorScheme: 'light';
  locale: string;
  timezoneId: string;
  userAgent: string;
}

export interface BrowserPoolOptions {
  channel: BrowserChannel;
  userAgentProduct: string;
  contactEmail?: string | undefined;
  viewport?: { width: number; height: number };
}

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

export class BrowserPool {
  private browser: Browser | undefined;
  private userAgent: string | undefined;
  private readonly options: BrowserPoolOptions;

  constructor(options: BrowserPoolOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    // `channel: 'chromium'` = Chrome for Testing in new-headless mode; omitting it
    // = the legacy chromium-headless-shell. Both are pinned by the playwright version.
    this.browser = await chromium.launch(
      this.options.channel === 'chromium' ? { channel: 'chromium', headless: true } : { headless: true },
    );
    const engine = this.browser.browserType().name();
    if (engine !== 'chromium') {
      await this.browser.close();
      this.browser = undefined;
      throw new Error(`Browser engine is locked to Playwright Chromium, but "${engine}" was launched.`);
    }
    // Honest, identifiable UA: a real desktop Chrome UA plus a product token. The
    // token deliberately avoids Next.js's HTML-limited-bot regex (Googlebot,
    // Bingbot, …) — matching it would switch the site to blocking-metadata
    // rendering, i.e. auditing a page real users never see (grounding finding).
    const probe = await this.browser.newContext();
    const baseUa = await (await probe.newPage()).evaluate(() => navigator.userAgent);
    await probe.close();
    this.userAgent = `${baseUa.replace('HeadlessChrome', 'Chrome')} ${this.options.userAgentProduct}`;
  }

  renderingPolicy(): RenderingPolicy {
    if (!this.browser || !this.userAgent) throw new Error('BrowserPool.start() must be awaited before renderingPolicy()');
    return {
      engine: 'chromium',
      channel: this.options.channel,
      browserVersion: this.browser.version(),
      playwrightVersion: PLAYWRIGHT_VERSION,
      viewport: this.options.viewport ?? DESKTOP_VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
      userAgent: this.userAgent,
    };
  }

  async newIsolatedContext(): Promise<BrowserContext> {
    if (!this.browser) throw new Error('BrowserPool.start() must be awaited before newIsolatedContext()');
    const policy = this.renderingPolicy();
    const context = await this.browser.newContext({
      viewport: policy.viewport,
      deviceScaleFactor: policy.deviceScaleFactor,
      colorScheme: policy.colorScheme,
      locale: policy.locale,
      timezoneId: policy.timezoneId,
      userAgent: policy.userAgent,
      // Required for any page.route() interception (routes don't see SW-served
      // requests) and keeps every audit's cache behaviour identical.
      serviceWorkers: 'block',
      ...(this.options.contactEmail ? { extraHTTPHeaders: { From: this.options.contactEmail } } : {}),
    });
    context.setDefaultNavigationTimeout(30_000);
    context.setDefaultTimeout(15_000);
    return context;
  }

  /** Runs `fn` with a fresh page in its own isolated context; the context is always closed afterwards. */
  async withIsolatedPage<T>(fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
    const context = await this.newIsolatedContext();
    try {
      const page = await context.newPage();
      return await fn(page, context);
    } finally {
      await context.close();
    }
  }

  async stop(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}
