import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { BrowserContext } from 'playwright';
import { openStandinPage } from '../html/temp-page.ts';
import { PageObserver } from '../t-layer/render-settled.ts';
import type { BrowserPool } from '../t-layer/browser.ts';
import type { RedesignPaths } from '../output/redesign-store.ts';
import type { CaptureSession, R1Output } from './types.ts';

/**
 * A resume used to re-capture the live site (R2) and re-run the element mapper (C2) every time. The
 * page's rotating content then differed, stamp ids were renumbered, the G1 fingerprint and every
 * judgment bundle changed, and the plan loop restarted forever. Once C2 has finished, the stamped
 * pre-edit page, the mapping and the capture are saved ONCE; a resume rebuilds the session from that
 * file instead of touching the site again.
 *
 * Reuse is only allowed when the snapshot was made from exactly these inputs (audit data, fix plan,
 * Design System version, target URL) and its html still matches its recorded hash; anything else
 * returns null and the pipeline captures afresh. The snapshot never replaces the audit's own files.
 */

export const SNAPSHOT_VERSION = 1;

export interface SnapshotKey {
  version: number;
  dataJsonSha256: string;
  fixPlanSha256: string;
  dsRegistryVersion: string;
  targetUrl: string;
}

export function snapshotKeyOf(r1: R1Output): SnapshotKey {
  return {
    version: SNAPSHOT_VERSION,
    dataJsonSha256: r1.sourceRun.dataJsonSha256 ?? '',
    fixPlanSha256: r1.sourceRun.fixPlanSha256 ?? '',
    dsRegistryVersion: r1.registry.version.dsRegistryVersion,
    targetUrl: r1.targetUrl,
  };
}

interface SnapshotFile {
  key: SnapshotKey;
  htmlSha256: string;
  savedAt: string;
  capture: CaptureSession['capture'];
  before: CaptureSession['before'];
  viewport: CaptureSession['viewport'];
  captureFingerprint: CaptureSession['captureFingerprint'];
  mapping: NonNullable<CaptureSession['mapping']>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function saveCaptureSnapshot(paths: Pick<RedesignPaths, 'captureSnapshotJson' | 'captureSnapshotHtml'>, r1: R1Output, session: CaptureSession): Promise<boolean> {
  if (!session.mapping || !session.originalHtml) return false;
  await writeFile(paths.captureSnapshotHtml, session.originalHtml);
  const file: SnapshotFile = {
    key: snapshotKeyOf(r1),
    htmlSha256: sha256(session.originalHtml),
    savedAt: new Date().toISOString(),
    capture: session.capture,
    before: session.before,
    viewport: session.viewport,
    captureFingerprint: session.captureFingerprint,
    mapping: session.mapping,
  };
  await writeFile(paths.captureSnapshotJson, JSON.stringify(file));
  return true;
}

/** The saved snapshot when it is valid for these inputs, else null with the reason (so the caller can say why it re-captured). */
export async function readCaptureSnapshot(paths: Pick<RedesignPaths, 'captureSnapshotJson' | 'captureSnapshotHtml'>, r1: R1Output): Promise<{ file: SnapshotFile; html: string } | { reason: string }> {
  if (!existsSync(paths.captureSnapshotJson) || !existsSync(paths.captureSnapshotHtml)) return { reason: 'no snapshot saved yet' };
  let file: SnapshotFile;
  try {
    file = JSON.parse(await readFile(paths.captureSnapshotJson, 'utf8')) as SnapshotFile;
  } catch {
    return { reason: 'the snapshot file is unreadable' };
  }
  const want = snapshotKeyOf(r1);
  for (const k of Object.keys(want) as Array<keyof SnapshotKey>) {
    if (file.key?.[k] !== want[k]) return { reason: `the snapshot was made for a different ${k}` };
  }
  const html = await readFile(paths.captureSnapshotHtml, 'utf8');
  if (/<link\b[^>]*rel=["']?stylesheet/i.test(html)) return { reason: 'the snapshot still points at the live site\'s stylesheets (not frozen); a redeploy would leave it unstyled' };
  if (sha256(html) !== file.htmlSha256) return { reason: 'the snapshot html changed since it was saved' };
  if (!file.mapping || !file.capture || !file.before || !file.viewport || !file.captureFingerprint) return { reason: 'the snapshot is incomplete' };
  return { file, html };
}

export async function stampsMissing(page: import('playwright').Page, elementIds: string[]): Promise<string[]> {
  return page.evaluate((ids) => ids.filter((id) => document.querySelectorAll(`[data-fra-element="${id}"]`).length !== 1), elementIds);
}

/**
 * Rebuilds a session from a valid snapshot: the stamped pre-edit html is loaded into a stand-in
 * page of the real URL (navigation answered locally — the site is not contacted; the same device R7
 * uses for its "before" page), so every later node sees the SAME stamps, ids and mapping as before.
 */
export async function restoreCaptureSession(deps: { pool: Pick<BrowserPool, 'newIsolatedContext'>; log?: (line: string) => void }, r1: R1Output, paths: Pick<RedesignPaths, 'captureSnapshotJson' | 'captureSnapshotHtml'>): Promise<CaptureSession | null> {
  const log = deps.log ?? (() => {});
  const snap = await readCaptureSnapshot(paths, r1);
  if ('reason' in snap) {
    log(`R2 · capturing the live page (${snap.reason})`);
    return null;
  }
  const base = await deps.pool.newIsolatedContext();
  const browser = base.browser();
  const context: BrowserContext = browser ? await browser.newContext({ bypassCSP: true, viewport: snap.file.viewport, serviceWorkers: 'block' }) : base;
  try {
    // The saved page is a frozen, stamped DOM: its own scripts (framework hydration, carousel timers) are not needed and, left
    // running, kept the browser busy enough to stall the next steps (R7's "before" page never opened). Script files are not loaded.
    await context.route('**/*', (route) => (route.request().resourceType() === 'script' ? route.abort() : route.continue()));
    const page = await openStandinPage(context, r1.targetUrl);
    await page.setViewportSize(snap.file.viewport);
    await page.setContent(snap.html, { waitUntil: 'domcontentloaded' });
    // The page's own scripts may run again on load and re-render the DOM, dropping the stamps: a restore is trusted only if
    // every mapped element is still found exactly once. Otherwise the pipeline captures afresh.
    await page.waitForTimeout(500);
    const missing = await stampsMissing(page, snap.file.mapping.entries.map((e) => e.element));
    if (missing.length > 0) throw new Error(`${missing.length} of ${snap.file.mapping.entries.length} stamped element(s) are not on the restored page (e.g. ${missing.slice(0, 3).join(', ')})`);
    const observer = new PageObserver(page, r1.targetUrl).attach();
    log(`R2/C2 · reusing the saved capture from ${snap.file.savedAt} (${snap.file.mapping.entries.length} mapped element(s), ${snap.file.mapping.unmapped.length} unmapped) — the live page is not re-captured`);
    return {
      page,
      context,
      observer,
      capture: snap.file.capture,
      before: snap.file.before,
      viewport: snap.file.viewport,
      captureFingerprint: snap.file.captureFingerprint,
      originalHtml: snap.html,
      mapping: snap.file.mapping,
      release: async () => {
        await context.close().catch(() => {});
        if (context !== base) await base.close().catch(() => {});
      },
    };
  } catch (err) {
    await context.close().catch(() => {});
    if (context !== base) await base.close().catch(() => {});
    log(`R2 · saved capture could not be restored (${(err as Error).message}) — capturing the live page`);
    return null;
  }
}
