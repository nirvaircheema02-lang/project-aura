import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Locator, Page } from 'playwright';

/**
 * B5 evidence capture — three artifact kinds (grounding research):
 *  1. element crop  — locator.screenshot, animations disabled, caret hidden;
 *  2. context shot  — clip of the element's box expanded by a margin, so a
 *     reviewer sees the component inside its section;
 *  3. page overview — viewport-height TILES with recorded scroll offsets, not
 *     one fullPage image: Chromium's ~16384 px capture limit silently
 *     truncates/corrupts tall pages, and /report-store-class pages exceed it.
 * scale:'css' everywhere so 1 image px = 1 CSS px — issue-marker positions
 * for Figma come from getBoundingClientRect, never from a model's guess.
 *
 * Masks use a NEUTRAL grey, never Playwright's default #FF00FF: a vision
 * model reads a saturated magenta block as a design element. Callers must
 * say in the B5 prompt that flat grey blocks are redactions.
 */

export const MASK_COLOR = '#808080';

export interface Tile {
  path: string;
  scrollY: number;
  height: number;
}

async function ensureDir(path: string) {
  await mkdir(dirname(path), { recursive: true });
}

/**
 * Tallest single evidence image. Opus 5 reads images up to a 2576px long edge
 * without downscaling; anything taller is shrunk until its text is unreadable,
 * and past 8000px the API rejects the request outright.
 */
export const MAX_EVIDENCE_HEIGHT_PX = 2000;
/** Section slices are the largest strip Opus 5 reads at native resolution (1440 × 2576 = its 4784-token cap). */
export const SECTION_SLICE_HEIGHT_PX = 2576;
export const MAX_SECTION_SLICES = 4;

type PageBox = { x: number; y: number; width: number; height: number };

/**
 * Page-absolute geometry. Clips are taken with `fullPage: true`, whose
 * coordinates are page-absolute regardless of scroll position — verified.
 * The earlier viewport-relative clip broke for any element taller than the
 * viewport: after scrolling it sat at a negative viewport y, so the clip was
 * wrong or rejected outright.
 */
async function pageBoxOf(locator: Locator): Promise<PageBox> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
  });
}

/** Clip a page-absolute box to what is actually visible horizontally, capped in height. */
function boundedClip(page: Page, box: PageBox, maxHeight: number): PageBox | null {
  const viewportWidth = page.viewportSize()?.width ?? 1440;
  const x = Math.max(0, box.x);
  const right = Math.min(box.x + box.width, viewportWidth);
  const width = right - x;
  const height = Math.min(box.height, maxHeight);
  if (width < 1 || height < 1) return null; // entirely off-canvas (e.g. a carousel slide scrolled out) — not visible, not evidence
  return { x, y: Math.max(0, box.y), width, height };
}

/**
 * The element crop. A normal-size element uses Playwright's own element
 * screenshot; an oversized one (a 23,240px-wide carousel track, a whole
 * listing) is clipped to its visible, bounded region instead, and the caller
 * is told so — a full-size capture would be useless or rejected by the API.
 */
export async function captureElement(locator: Locator, path: string, mask: Locator[] = []): Promise<{ clipped: boolean }> {
  await ensureDir(path);
  const page = locator.page();
  const box = await pageBoxOf(locator);
  const viewportWidth = page.viewportSize()?.width ?? 1440;
  const oversized = box.width > viewportWidth || box.height > MAX_EVIDENCE_HEIGHT_PX || box.x < 0;
  if (!oversized) {
    await locator.screenshot({ path, animations: 'disabled', caret: 'hide', scale: 'css', mask, maskColor: MASK_COLOR });
    return { clipped: false };
  }
  const clip = boundedClip(page, box, MAX_EVIDENCE_HEIGHT_PX);
  if (!clip) throw new Error('captureElement: element lies entirely outside the visible page area');
  await page.screenshot({ path, fullPage: true, clip, animations: 'disabled', caret: 'hide', scale: 'css', mask, maskColor: MASK_COLOR });
  return { clipped: true };
}

/** The element inside its surroundings (for alignment/overlap/hierarchy judgments), bounded like the crop. */
export async function captureContext(page: Page, locator: Locator, path: string, marginPx = 120, mask: Locator[] = []): Promise<void> {
  const box = await pageBoxOf(locator);
  const clip = boundedClip(page, { x: box.x - marginPx, y: box.y - marginPx, width: box.width + marginPx * 2, height: box.height + marginPx * 2 }, MAX_EVIDENCE_HEIGHT_PX);
  if (!clip) throw new Error('captureContext: element lies entirely outside the visible page area');
  await ensureDir(path);
  await page.screenshot({ path, fullPage: true, clip, animations: 'disabled', caret: 'hide', scale: 'css', mask, maskColor: MASK_COLOR });
}

/**
 * One section as B2's visual evidence: a single image when it fits, else
 * full-width strips of SECTION_SLICE_HEIGHT_PX top to bottom (up to
 * MAX_SECTION_SLICES). Measured on the target page: two sections were 9,516px
 * and 8,300px tall — one image would exceed the API's 8000px limit, and even
 * under it would be shrunk to an unreadable 390px-wide sliver.
 */
export async function captureSectionSlices(
  page: Page,
  rootRef: string,
  pathFor: (slice: number) => string,
): Promise<{ slices: Array<{ path: string; top: number; height: number }>; totalHeight: number; truncated: boolean }> {
  const locator = page.locator(`aria-ref=${rootRef}`);
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
  const box = await pageBoxOf(locator);
  const slices: Array<{ path: string; top: number; height: number }> = [];
  const count = Math.min(MAX_SECTION_SLICES, Math.max(1, Math.ceil(box.height / SECTION_SLICE_HEIGHT_PX)));
  for (let i = 0; i < count; i++) {
    const top = box.y + i * SECTION_SLICE_HEIGHT_PX;
    const clip = boundedClip(page, { x: box.x, y: top, width: box.width, height: Math.min(SECTION_SLICE_HEIGHT_PX, box.y + box.height - top) }, SECTION_SLICE_HEIGHT_PX);
    if (!clip) break;
    const path = pathFor(i);
    await ensureDir(path);
    await page.screenshot({ path, fullPage: true, clip, animations: 'disabled', caret: 'hide', scale: 'css' });
    slices.push({ path, top: Math.round(top), height: Math.round(clip.height) });
  }
  return { slices, totalHeight: Math.round(box.height), truncated: count * SECTION_SLICE_HEIGHT_PX < box.height };
}

/**
 * Viewport-height tiles top to bottom. Scrolling also drives lazy-loading
 * and in-view animations. `maxTiles` bounds very long listing pages — any
 * truncation is returned explicitly, never silent.
 */
export async function captureOverviewTiles(
  page: Page,
  pathFor: (index: number) => string,
  opts: { maxTiles?: number; mask?: Locator[]; settleMs?: number } = {},
): Promise<{ tiles: Tile[]; totalHeight: number; truncated: boolean }> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const maxTiles = opts.maxTiles ?? 20;
  const tiles: Tile[] = [];
  for (let i = 0, y = 0; y < totalHeight && i < maxTiles; i++, y += viewport.height) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 250));
    const path = pathFor(i);
    await ensureDir(path);
    await page.screenshot({ path, animations: 'disabled', caret: 'hide', scale: 'css', mask: opts.mask ?? [], maskColor: MASK_COLOR });
    tiles.push({ path, scrollY: y, height: Math.min(viewport.height, totalHeight - y) });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const covered = tiles.length * viewport.height;
  return { tiles, totalHeight, truncated: covered < totalHeight };
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(path);
  await writeFile(path, JSON.stringify(data, null, 2));
}
