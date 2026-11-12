import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compositeTilesToFile } from '../../src/imaging/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { withCapturedPage } from '../../src/t-layer/capture.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { captureElement, captureOverviewTiles } from '../../src/t-layer/screenshot.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Real Chromium (Playwright's pinned build) against a LOCAL server: proves the vendored
 * capture chain works in THIS repo end to end — the exact composition R2 will use — and
 * that the new flatten step turns its tiles into one page image. No production traffic.
 */

const HIDDEN_PAGE = `<!doctype html><html><head><title>hidden</title><link rel="canonical" href="/hidden"></head>
<body style="margin:0"><button id="shown">Visible</button><div style="display:none"><button id="closed">Inside a closed panel</button></div></body></html>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let outDir: string;

// A sticky header plus two high-contrast bands: tile 0's rows below the header are white, tile 1's
// (900px further down) are black, so the repeated band is exactly the header. (A smooth gradient
// would NOT do: 900px of a 2200px gradient shifts a channel by ~104 — under the detector's
// 150 threshold, which is tuned for real pages' content contrast.)
const TALL_PAGE = `<!doctype html><html><head><title>tall</title><link rel="canonical" href="/tall"></head>
<body style="margin:0"><header style="position:sticky;top:0;height:80px;background:#111;color:#fff">Sticky header</header>
<main><div style="height:900px;background:#fff"></div><div style="height:1220px;background:#000"><button id="cta" style="margin:0">Talk to us</button></div></main></body></html>`;

beforeAll(async () => {
  server = await startLocalServer({ '/tall': { body: TALL_PAGE }, '/hidden': { body: HIDDEN_PAGE } });
  outDir = mkdtempSync(join(tmpdir(), 'fra-browser-'));
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSRedesignTest/0.1' });
  await pool.start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe('vendored t-layer + imaging, composed as R2 will compose them', () => {
  it('captures a settled page, tiles it top to bottom, and flattens the tiles into one composite PNG', async () => {
    const url = `${server.origin}/tall`;
    const result = await withCapturedPage(pool, new Politeness(0), url, async (page, capture) => {
      expect(capture.httpStatus).toBe(200);
      expect(capture.canonical.pageUrl).toBe(url);
      expect(capture.renderSettled).toBeDefined();
      expect(capture.renderingPolicy.engine).toBe('chromium');
      expect(capture.ariaElementCount).toBeGreaterThan(0);
      const tiles = await captureOverviewTiles(page, (i) => join(outDir, `page-tile-${i}.png`));
      return { tiles, viewport: page.viewportSize() };
    });
    expect(result.tiles.truncated).toBe(false);
    expect(result.tiles.tiles.length).toBeGreaterThanOrEqual(3); // 2280px page / 900px viewport
    expect(result.tiles.tiles[0]).toMatchObject({ scrollY: 0, height: 900 });

    const composite = await compositeTilesToFile(
      result.tiles.tiles.map((t) => t.path),
      join(outDir, 'before.png'),
    );
    expect(composite).not.toBeNull();
    const png = PNG.sync.read(readFileSync(composite!.outPath));
    expect(png.width).toBe(result.viewport!.width);
    expect(png.height).toBe(composite!.plan.totalHeightPx);
    // The sticky header repeats in every raw tile; the plan must have measured and removed exactly it.
    expect(composite!.plan.headerHeightPx).toBeGreaterThanOrEqual(78);
    expect(composite!.plan.headerHeightPx).toBeLessThanOrEqual(82);
    expect(png.height).toBe(900 + (result.tiles.tiles.length - 1) * (900 - composite!.plan.headerHeightPx));
  }, 60_000);

  it('captureElement fails fast on an element inside a closed panel instead of waiting out Playwright\'s 30 s actionability timeout', async () => {
    await withCapturedPage(pool, new Politeness(0), `${server.origin}/hidden`, async (page) => {
      const started = Date.now();
      await expect(captureElement(page.locator('#closed'), join(outDir, 'closed.png'))).rejects.toThrow(/no visible box/);
      expect(Date.now() - started).toBeLessThan(3_000);
      // a visible element is still captured
      await captureElement(page.locator('#shown'), join(outDir, 'shown.png'));
      expect(readFileSync(join(outDir, 'shown.png')).length).toBeGreaterThan(50);
    });
  }, 30_000);
});
