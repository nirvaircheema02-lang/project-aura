import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { PageObserver, waitForRenderSettled } from '../../src/t-layer/render-settled.ts';
import { expandSafely, findDisclosureCandidates } from '../../src/t-layer/disclosure.ts';
import { elementFingerprint, locatorFor, parseAriaSnapshot, stampRef, takeAriaSnapshot } from '../../src/t-layer/element-registry.ts';
import { extractComputedStyle, normalizeColor } from '../../src/t-layer/computed-style.ts';
import { captureElement, captureOverviewTiles } from '../../src/t-layer/screenshot.ts';
import { withCapturedPage } from '../../src/t-layer/capture.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Real Chromium (the pinned Chrome for Testing build) against a LOCAL
 * server — exercises the actual browser mechanisms offline, with no
 * production traffic. Live checks against kenresearch.com are recorded
 * separately as fixtures (scripts/record-fixtures.ts).
 */

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let outDir: string;
const politeness = new Politeness(0);

const SETTLE_PAGE = `<!doctype html><html><head><title>settle</title></head><body>
<h1 id="h">Loading</h1>
<script>
  fetch('/api/slow').then(r => r.text()).then(t => { document.getElementById('h').textContent = t; });
  fetch('/other-route?_rsc=abc', { headers: { RSC: '1' } }).catch(() => {});
</script></body></html>`;

const HANG_PAGE = `<!doctype html><html><body><p>x</p><script>fetch('/api/hang').catch(() => {});</script></body></html>`;

const DISCLOSURE_PAGE = `<!doctype html><html><body>
<div role="tablist">
  <button role="tab" aria-selected="true" id="t1" onclick="show('p1')">Trending</button>
  <button role="tab" aria-selected="false" id="t2" type="button" onclick="show('p2')">New This Week</button>
</div>
<div id="p1">trending panel</div><div id="p2" hidden>new panel</div>
<button type="button" aria-expanded="false" id="acc" onclick="this.setAttribute('aria-expanded','true');document.getElementById('accp').hidden=false">FAQ</button>
<div id="accp" hidden>faq answer</div>
<details><summary>More details</summary><p>details body</p></details>
<p id="chapter" style="max-height:20px;overflow:hidden">long chapter text</p>
<button type="button" id="rm" onclick="document.getElementById('chapter').style.maxHeight='none'">Read More</button>
<form><input type="email" name="email"><button aria-expanded="false" id="danger">Submit Enquiry</button></form>
<a href="/somewhere-else" aria-expanded="false" id="offpage">Other page</a>
<button type="button" aria-expanded="false" id="spa" onclick="history.pushState({}, '', '/moved')">Go</button>
<script>
function show(id){ for (const p of ['p1','p2']) document.getElementById(p).hidden = p !== id;
  for (const t of document.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t.getAttribute('onclick').includes(id))); }
</script></body></html>`;

const STYLE_PAGE = `<!doctype html><html><head><style>
  :root { --brand-red: #b01f24; }
  #cta { color: var(--brand-red); padding: 1rem; line-height: 1.6; font-size: 16px; border-radius: 15px; }
  #modern { color: oklch(0.4911 0.1796 25.62); }
</style></head><body>
<main><section><a id="cta" href="#">Talk to a Strategy Expert</a><span id="modern">modern</span></section>
<div id="sib">sibling</div></main></body></html>`;

const TALL_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:2500px;background:linear-gradient(#fff,#ccc)">tall</div></body></html>`;

// Count-up that only starts when the stat scrolls into view via a REAL scroll
// (IntersectionObserver), below the initial viewport — the kenresearch.com pattern.
const COUNTUP_PAGE = `<!doctype html><html><body style="margin:0">
<div style="height:1200px">hero</div>
<div id="stat"><span id="n">0+</span> Clients Served</div>
<div id="stuck"><span id="s">0%</span> never animates</div>
<div style="height:1200px"></div>
<script>
  const el = document.getElementById('n');
  new IntersectionObserver((entries, io) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    let v = 0; const t = setInterval(() => { v += 10; el.textContent = v + '+'; if (v >= 150) clearInterval(t); }, 60);
  }).observe(el);
</script></body></html>`;

const CAPTURE_PAGE = `<!doctype html><html><head>
<link rel="canonical" href="/consulting/strategy-consulting/market-entry-consulting">
<meta property="og:url" content="/consulting/strategy-consulting/market-entry-consulting">
</head><body>
<div class="stat"><span class="n">0+</span> Clients Served</div>
<button type="button">Talk to a Strategy Expert</button>
<script>
  console.warn('The resource /x.woff2 was preloaded using link preload but not used within a few seconds from the window load event.');
  console.warn('Swiper Loop Warning: The number of slides is not enough for loop mode, it will be disabled and not function properly.');
</script></body></html>`;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'audit-agent-tlayer-'));
  server = await startLocalServer({
    '/settle': { body: SETTLE_PAGE },
    '/api/slow': { body: 'Loaded', delayMs: 800, headers: { 'content-type': 'text/plain' } },
    '/other-route': { hang: true },
    '/hang': { body: HANG_PAGE },
    '/api/hang': { hang: true },
    '/disclosure': { body: DISCLOSURE_PAGE },
    '/somewhere-else': { body: '<p>elsewhere</p>' },
    '/moved': { body: '<p>moved</p>' },
    '/style': { body: STYLE_PAGE },
    '/tall': { body: TALL_PAGE },
    '/market-entry-consulting': { body: CAPTURE_PAGE },
    '/countup': { body: COUNTUP_PAGE },
    '/moved-report': { status: 302, headers: { location: '/industry-reports/moved-report' } },
    '/industry-reports/moved-report': {
      body: `<!doctype html><html><body><p>report</p><script>fetch(location.pathname + '?_rsc=refresh', { headers: { RSC: '1' } });</script></body></html>`,
    },
    '/gone': { status: 404, body: 'nope' },
  });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
}, 60_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe('BrowserPool (§2.7 isolation + pinned rendering policy)', () => {
  it('pins the rendering environment and sends an honest, non-headless-branded UA with the product token', () => {
    const p = pool.renderingPolicy();
    expect(p.engine).toBe('chromium');
    expect(p.channel).toBe('chromium');
    // The EXACT build (four-part Chromium version), not just a major — this is what run metadata records.
    expect(p.browserVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // Pinned by the exact playwright version in package.json, read from the installed package.
    expect(p.playwrightVersion).toBe(JSON.parse(readFileSync(join(process.cwd(), 'node_modules/playwright/package.json'), 'utf-8')).version);
    expect(p.viewport).toEqual({ width: 1440, height: 900 });
    expect(p.userAgent).toContain('KenResearchDSAudit/0.1');
    expect(p.userAgent).not.toContain('HeadlessChrome');
  });

  it('isolates contexts: storage and cookies set in one audit are invisible to another', async () => {
    const seenInA = await pool.withIsolatedPage(async (page) => {
      await page.goto(`${server.origin}/style`);
      await page.evaluate(() => { localStorage.setItem('k', 'v'); document.cookie = 'session=abc'; });
      return page.evaluate(() => localStorage.getItem('k') + '|' + document.cookie);
    });
    const seenInB = await pool.withIsolatedPage(async (page) => {
      await page.goto(`${server.origin}/style`);
      return page.evaluate(() => String(localStorage.getItem('k')) + '|' + document.cookie);
    });
    expect(seenInA).toBe('v|session=abc');
    expect(seenInB).toBe('null|');
  }, 30_000); // two fresh browser contexts — the 5s default is too tight under a full parallel suite
});

describe('render-settled composite gate (§2.7) + network-noise scoping (§2.4)', () => {
  it('waits for a slow critical-path fetch but NOT for a hanging RSC prefetch of another route', async () => {
    await pool.withIsolatedPage(async (page) => {
      const observer = new PageObserver(page, `${server.origin}/settle`).attach();
      await page.goto(`${server.origin}/settle`);
      const result = await waitForRenderSettled(page, observer, { networkCapMs: 6_000 });
      expect(result.network.settled).toBe(true); // the hanging /other-route?_rsc was excluded
      expect(await page.textContent('#h')).toBe('Loaded'); // the slow critical fetch was waited for
      expect(result.fonts.status).toBe('loaded');
      const rsc = observer.requests.find((r) => r.url.includes('/other-route'));
      expect(rsc?.noise).toBe('rsc-fetch-for-other-pathname');
    });
  }, 30_000);

  it('regression: after a redirect, the page\'s own RSC fetch (no prefetch header) stays critical-path', async () => {
    await pool.withIsolatedPage(async (page) => {
      const observer = new PageObserver(page, `${server.origin}/moved-report`).attach();
      await page.goto(`${server.origin}/moved-report`);
      await waitForRenderSettled(page, observer, { networkCapMs: 5_000 });
      const own = observer.requests.find((r) => r.url.includes('/industry-reports/moved-report?_rsc=refresh'));
      expect(own, 'own RSC fetch should be recorded').toBeDefined();
      expect(own!.noise).toBeNull();
    });
  }, 30_000);

  it('caps a hanging critical request and reports partial — never hangs, never fails', async () => {
    await pool.withIsolatedPage(async (page) => {
      const observer = new PageObserver(page, `${server.origin}/hang`).attach();
      await page.goto(`${server.origin}/hang`);
      const t0 = Date.now();
      const result = await waitForRenderSettled(page, observer, { networkCapMs: 1_500 });
      expect(Date.now() - t0).toBeLessThan(6_000);
      expect(result.settled).toBe(false);
      expect(result.network.stillInFlight.some((u) => u.includes('/api/hang'))).toBe(true);
    });
  }, 30_000);
});

describe('disclosure expansion safety (§2.7 — a correctness requirement on a lead-gen site)', () => {
  it('finds candidates and refuses the dangerous ones: form submit with email, off-page link', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.goto(`${server.origin}/disclosure`);
      const cands = await findDisclosureCandidates(page);
      const byLabel = (l: string) => cands.find((c) => c.label.startsWith(l));
      expect(byLabel('New This Week')).toMatchObject({ kind: 'tab', safe: true });
      expect(byLabel('FAQ')).toMatchObject({ kind: 'accordion', safe: true });
      expect(byLabel('More details')).toMatchObject({ kind: 'details', safe: true });
      expect(byLabel('Read More')).toMatchObject({ kind: 'read-more', safe: true });
      expect(byLabel('Submit Enquiry')).toMatchObject({ safe: false, unsafeReason: 'inside a form collecting personal data' });
      expect(byLabel('Other page')).toMatchObject({ safe: false, unsafeReason: 'link to another page' });
      expect(byLabel('Trending')).toBeUndefined(); // already-selected tab is not a candidate
    });
  }, 30_000);

  it('expands safe candidates, never clicks unsafe ones, and restores after an SPA navigation', async () => {
    await pool.withIsolatedPage(async (page) => {
      const url = `${server.origin}/disclosure`;
      const observer = new PageObserver(page, url).attach();
      await page.goto(url);
      const cands = await findDisclosureCandidates(page);
      const get = (l: string) => cands.find((c) => c.label.startsWith(l))!;

      expect(await expandSafely(page, observer, get('New This Week'), url)).toMatchObject({ expanded: true });
      expect(await page.isVisible('#p2')).toBe(true);

      expect(await expandSafely(page, observer, get('FAQ'), url)).toMatchObject({ expanded: true });
      expect(await page.isVisible('#accp')).toBe(true);

      expect(await expandSafely(page, observer, get('More details'), url)).toMatchObject({ expanded: true });
      expect(await page.evaluate(() => document.querySelector('details')!.open)).toBe(true);

      const danger = await expandSafely(page, observer, get('Submit Enquiry'), url);
      expect(danger).toMatchObject({ expanded: false, reason: 'unsafe' });

      const spa = await expandSafely(page, observer, get('Go'), url);
      expect(spa).toMatchObject({ expanded: false, reason: 'navigated-away-restored' });
      expect(page.url()).toBe(url);
    });
  }, 30_000);
});

describe('element registry — B2→B4 handoff (§5.2)', () => {
  it('resolves an aria ref to the exact element, stamps it, and the stamp survives unrelated DOM mutation', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.goto(`${server.origin}/style`);
      const els = parseAriaSnapshot(await takeAriaSnapshot(page));
      const link = els.find((e) => e.role === 'link' && e.name === 'Talk to a Strategy Expert');
      expect(link, 'aria snapshot should expose the CTA link with a ref').toBeDefined();
      expect(link!.box).toBeDefined();

      await stampRef(page, link!.ref, 'el-1');
      await page.evaluate(() => { document.getElementById('sib')!.textContent = 'mutated'; document.body.prepend(document.createElement('div')); });
      expect(await locatorFor(page, 'el-1').getAttribute('id')).toBe('cta'); // exact element, not a wrapper

      const fp = await elementFingerprint(locatorFor(page, 'el-1'));
      expect(fp.structuralPath).toBe('#cta');
      expect(fp.textPrefix).toBe('Talk to a Strategy Expert');
    });
  }, 30_000);

  it('fails closed on a stale ref after the element is gone — no silent re-derivation', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.goto(`${server.origin}/style`);
      const link = parseAriaSnapshot(await takeAriaSnapshot(page)).find((e) => e.role === 'link')!;
      await page.evaluate(() => document.getElementById('cta')!.remove());
      await expect(stampRef(page, link.ref, 'el-stale')).rejects.toThrow();
    });
  }, 30_000);
});

describe('computed-style extraction against the pinned Chromium build', () => {
  it('returns resolved values that normalize back to the DS token values', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.goto(`${server.origin}/style`);
      const cta = await extractComputedStyle(page.locator('#cta'));
      expect(cta.connected).toBe(true);
      if (!cta.connected) return;
      expect(normalizeColor(cta.raw.color!)).toBe('#b01f24ff');
      expect(cta.raw['padding-top']).toBe('16px'); // 1rem resolved
      expect(cta.raw['border-top-left-radius']).toBe('15px');
      expect(cta.raw['line-height']).toBe('25.6px'); // pinned-build fact: unitless 1.6 comes back as used px
      expect(cta.rootFontSizePx).toBe(16);

      const modern = await extractComputedStyle(page.locator('#modern'));
      if (!modern.connected) throw new Error('detached');
      // Whatever notation the browser serializes, normalization lands on the same color.
      expect(normalizeColor(modern.raw.color!)).toBe('#b01f24ff');
    });
  }, 30_000);
});

describe('screenshot evidence', () => {
  it('writes an element crop, and tiles a tall page with an explicit truncation flag', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.goto(`${server.origin}/style`);
      const crop = join(outDir, 'crop.png');
      await captureElement(page.locator('#cta'), crop);
      expect(statSync(crop).size).toBeGreaterThan(100);

      await page.goto(`${server.origin}/tall`);
      const full = await captureOverviewTiles(page, (i) => join(outDir, `tile-${i}.png`), { settleMs: 50 });
      expect(full.tiles).toHaveLength(3); // 2500px / 900px viewport
      expect(full.truncated).toBe(false);
      const capped = await captureOverviewTiles(page, (i) => join(outDir, `cap-${i}.png`), { maxTiles: 2, settleMs: 50 });
      expect(capped.truncated).toBe(true); // bounded, and says so
    });
  }, 30_000);
});

describe('dynamic-content settling (§2.7) — real scroll, stable final value', () => {
  it('triggers an IntersectionObserver count-up via real wheel events and reports the FINAL value, not a mid-animation frame', async () => {
    const url = `${server.origin}/countup`;
    const capture = await withCapturedPage(pool, politeness, url, async (_p, c) => c);
    const counter = capture.placeholders.find((p) => p.detectedAs === '0+');
    const stuck = capture.placeholders.find((p) => p.detectedAs === '0%');
    expect(counter).toMatchObject({ after: '150+', changed: true, stabilized: true, stillPlaceholder: false });
    expect(stuck).toMatchObject({ after: '0%', changed: false, stabilized: true, stillPlaceholder: true }); // → S8 LOW confidence
  }, 30_000);
});

describe('capturePage end-to-end (local)', () => {
  it('captures canonical, console evidence and a persistent placeholder in one pass', async () => {
    const url = `${server.origin}/market-entry-consulting`;
    const capture = await withCapturedPage(pool, politeness, url, async (_page, c) => c);
    expect(capture.httpStatus).toBe(200);
    expect(capture.canonical.pageUrl).toBe(`${server.origin}/consulting/strategy-consulting/market-entry-consulting`);
    expect(capture.console.kept.map((k) => k.verdict.keep && 'pattern' in k.verdict ? k.verdict.pattern : null)).toContain('swiper-loop-misconfiguration');
    expect(capture.console.suppressedByReason['benign-preload-warning']).toBe(1);
    expect(capture.placeholders).toHaveLength(1);
    expect(capture.placeholders[0]).toMatchObject({ before: '0+', stillPlaceholder: true });
    expect(capture.ariaElementCount).toBeGreaterThan(0);
  }, 30_000);

  it('classifies a 404 as TERMINAL (no retry budget burned on a page that does not exist)', async () => {
    const { classify } = await import('../../src/graph/retry.ts');
    const err = await withCapturedPage(pool, politeness, `${server.origin}/gone`, async () => null).catch((e) => e);
    expect(classify(err)).toBe('TERMINAL');
  }, 30_000);
});
