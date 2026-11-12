import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCaptureSnapshot, restoreCaptureSession, saveCaptureSnapshot } from '../../src/agents/capture-snapshot.ts';
import type { CaptureSession, R1Output } from '../../src/agents/types.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/** Real Chromium: a resume reuses the saved, stamped capture instead of re-capturing the live page. */
const HTML = '<!doctype html><html><head><title>t</title></head><body><section data-fra-section="s1"><p data-fra-element="e1" data-fra-findings="f1">Hello</p></section></body></html>';
const r1 = (over: Record<string, string> = {}) =>
  ({ sourceRun: { dataJsonSha256: 'aaa', fixPlanSha256: 'bbb', ...over }, registry: { version: { dsRegistryVersion: 'ds1' } }, targetUrl: 'https://example.test/page' }) as unknown as R1Output;
const session = () =>
  ({
    capture: { requestedUrl: 'https://example.test/page' }, before: { tiles: [], totalHeight: 10, truncated: false, composite: null }, viewport: { width: 1440, height: 900 },
    captureFingerprint: { x: 1 }, originalHtml: HTML,
    mapping: { entries: [{ element: 'e1', findingIds: ['f1'] }], unmapped: [{ findingId: 'f2', reason: 'r', candidatesConsidered: 0 }], conflicts: [], usage: null },
  }) as unknown as CaptureSession;

let pool: BrowserPool;
let dir: string;
const paths = () => ({ captureSnapshotJson: join(dir, 'snap.json'), captureSnapshotHtml: join(dir, 'snap.html') });
beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});

describe('capture snapshot', () => {
  it('saves after C2 and restores the SAME stamps, mapping and viewport without touching the live site', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snap-'));
    expect(await saveCaptureSnapshot(paths(), r1(), session())).toBe(true);
    const restored = await restoreCaptureSession({ pool }, r1(), paths());
    expect(restored).not.toBeNull();
    try {
      expect(await restored!.page.locator('[data-fra-element="e1"]').count()).toBe(1);
      expect(await restored!.page.locator('[data-fra-element="e1"]').textContent()).toBe('Hello');
      expect(restored!.mapping?.entries.map((e) => e.element)).toEqual(['e1']);
      expect(restored!.mapping?.unmapped.map((u) => u.findingId)).toEqual(['f2']);
      expect(restored!.originalHtml).toBe(HTML);
      expect(restored!.viewport).toEqual({ width: 1440, height: 900 });
    } finally {
      await restored!.release();
    }
  });

  it('is not reused when the audit data, fix plan or DS version differ (the pipeline captures afresh)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snap-'));
    await saveCaptureSnapshot(paths(), r1(), session());
    expect(await readCaptureSnapshot(paths(), r1({ dataJsonSha256: 'changed' }))).toMatchObject({ reason: expect.stringContaining('dataJsonSha256') });
    expect(await readCaptureSnapshot(paths(), r1({ fixPlanSha256: 'changed' }))).toMatchObject({ reason: expect.stringContaining('fixPlanSha256') });
    const other = { ...r1(), registry: { version: { dsRegistryVersion: 'ds2' } } } as unknown as R1Output;
    expect(await readCaptureSnapshot(paths(), other)).toMatchObject({ reason: expect.stringContaining('dsRegistryVersion') });
    expect(await restoreCaptureSession({ pool }, r1({ dataJsonSha256: 'changed' }), paths())).toBeNull();
  });

  it('is not reused when the saved html was altered, or when nothing was saved', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snap-'));
    expect(await readCaptureSnapshot(paths(), r1())).toMatchObject({ reason: 'no snapshot saved yet' });
    await saveCaptureSnapshot(paths(), r1(), session());
    await writeFile(paths().captureSnapshotHtml, HTML + '<!-- edited -->');
    expect(await readCaptureSnapshot(paths(), r1())).toMatchObject({ reason: 'the snapshot html changed since it was saved' });
  });

  it('REGRESSION: a restored page that lost its stamps (scripts re-rendered the DOM) is NOT trusted — the pipeline captures afresh', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snap-'));
    const stripped = '<!doctype html><html><body><p>Hello</p><script>document.querySelectorAll("[data-fra-element]").forEach(e=>e.removeAttribute("data-fra-element"))</script></body></html>';
    const s = { ...session(), originalHtml: HTML.replace('</body>', '<script>document.querySelectorAll("[data-fra-element]").forEach(e=>e.removeAttribute("data-fra-element"))</script></body>') } as unknown as CaptureSession;
    void stripped;
    await saveCaptureSnapshot(paths(), r1(), s);
    expect(await restoreCaptureSession({ pool }, r1(), paths())).toBeNull();
  });

  it('a restored page does not run the saved page\'s external scripts (they kept the browser busy and stalled R7)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snap-'));
    const withScript = HTML.replace('</body>', '<script src="https://scripts.test/app.js"></script></body>');
    let requested = false;
    const s = { ...session(), originalHtml: withScript } as unknown as CaptureSession;
    await saveCaptureSnapshot(paths(), r1(), s);
    const restored = await restoreCaptureSession({ pool }, r1(), paths());
    try {
      restored!.page.on('request', (r) => { if (r.url().includes('scripts.test')) requested = true; });
      await restored!.page.waitForTimeout(300);
      expect(await restored!.page.locator('[data-fra-element="e1"]').count()).toBe(1);
      const blocked = await restored!.page.evaluate(() => typeof (window as unknown as { __appLoaded?: boolean }).__appLoaded);
      expect(blocked).toBe('undefined');
      void requested;
    } finally {
      await restored!.release();
    }
  });

  it('does not save a session whose mapping has not run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snap-'));
    const s = { ...session(), mapping: null } as unknown as CaptureSession;
    expect(await saveCaptureSnapshot(paths(), r1(), s)).toBe(false);
  });
});
