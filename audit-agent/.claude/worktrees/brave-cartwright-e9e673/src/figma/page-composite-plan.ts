import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';

/**
 * Generalizes the manual fix proven on market-entry-real-1's Figma "Page Audit" frame
 * (Decision Log #32): B1's `captureOverviewTiles` (t-layer/screenshot.ts) takes independent
 * viewport screenshots while scrolling, so a `position: sticky`/`fixed` header re-appears at
 * the top of every tile after the first. Naively stacking raw tiles repeats that header down
 * the page. This module measures the repeated band automatically and produces the exact
 * crop/placement geometry to close the seam — no page-specific numbers, no manual pixel-diffing.
 */

export interface CompositeBlock {
  /** Index into the original tiles array (0-based, matching B1's page-tile-N.png naming). */
  tileIndex: number;
  /** Y within the SOURCE tile image to start cropping from. */
  sourceCropY: number;
  /** Height of the region taken from this tile. */
  sourceCropHeight: number;
  /** Y within the compacted composite output where this block should be placed. */
  destY: number;
}

export interface TileCompositePlan {
  tileWidthPx: number;
  tileHeightPx: number;
  headerHeightPx: number;
  blocks: CompositeBlock[];
  /** Total height of the compacted composite — shorter than tileCount * tileHeightPx by (tileCount-1) * headerHeightPx. */
  totalHeightPx: number;
}

interface DecodedPng {
  width: number;
  height: number;
  data: Buffer; // RGBA, 4 bytes/pixel
}

async function decodePng(path: string): Promise<DecodedPng> {
  const bytes = await readFile(path);
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * Crops one tile to exactly the region a `CompositeBlock` calls for and returns encoded PNG
 * bytes ready to upload — the runbook's actual image-preparation step (docs/FIGMA-PUBLISH-RUNBOOK.md),
 * so "crop by sourceCropY/sourceCropHeight" is one tested function call, not hand-rolled each time.
 */
export async function cropTileForBlock(tilePath: string, block: Pick<CompositeBlock, 'sourceCropY' | 'sourceCropHeight'>): Promise<Buffer> {
  const src = await decodePng(tilePath);
  if (block.sourceCropY < 0 || block.sourceCropY + block.sourceCropHeight > src.height) {
    throw new Error(`cropTileForBlock: crop region [${block.sourceCropY}, ${block.sourceCropY + block.sourceCropHeight}) is outside the source tile's height (${src.height})`);
  }
  const out = new PNG({ width: src.width, height: block.sourceCropHeight });
  src.data.copy(out.data, 0, block.sourceCropY * src.width * 4, (block.sourceCropY + block.sourceCropHeight) * src.width * 4);
  return PNG.sync.write(out);
}

export interface DetectRepeatedBandOptions {
  /** A per-channel byte difference above this counts as "genuinely different content", not anti-aliasing/shadow noise. Tuned against a real page with a shadowed sticky header (its shadow band peaked at ~96; real content differences measured 230+) — exposed so a page with lower-contrast content can override it. */
  highDiffThreshold?: number;
  /** How many CONSECUTIVE rows must all exceed the threshold before the band is considered over — guards against a transient shadow/highlight blip reading as the boundary. */
  consecutiveRowsRequired?: number;
}

/**
 * Compares two consecutive raw viewport tiles row by row. Rows that are visually identical
 * (within tolerance) between them are the repeated sticky header; the first row where
 * `consecutiveRowsRequired` rows in a row all exceed `highDiffThreshold` marks where each
 * tile's own new content begins. Returns 0 (no repeated band) if no such sustained
 * difference is ever found — e.g. the page has no sticky header at all.
 */
export async function detectRepeatedBandHeight(tileAPath: string, tileBPath: string, opts: DetectRepeatedBandOptions = {}): Promise<number> {
  const highDiffThreshold = opts.highDiffThreshold ?? 150;
  const consecutiveRowsRequired = opts.consecutiveRowsRequired ?? 5;

  const [a, b] = await Promise.all([decodePng(tileAPath), decodePng(tileBPath)]);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`detectRepeatedBandHeight: tile size mismatch (${a.width}x${a.height} vs ${b.width}x${b.height}) — tiles must come from the same capture`);
  }

  let consecutive = 0;
  for (let y = 0; y < a.height; y++) {
    let rowMaxDiff = 0;
    const rowStart = y * a.width * 4;
    for (let x = 0; x < a.width; x++) {
      const idx = rowStart + x * 4;
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(a.data[idx + c]! - b.data[idx + c]!);
        if (diff > rowMaxDiff) rowMaxDiff = diff;
      }
    }
    if (rowMaxDiff > highDiffThreshold) {
      consecutive++;
      if (consecutive >= consecutiveRowsRequired) return y - consecutiveRowsRequired + 1;
    } else {
      consecutive = 0;
    }
  }
  return 0; // no sustained difference found anywhere — no repeated band to crop
}

/**
 * Tile 0 is kept whole (it's genuinely the top of the page). Every subsequent tile has its
 * top `headerHeightPx` cropped off (the repeated header) and is placed directly after the
 * previous block — no gap, no duplicate header, and the composite is exactly
 * `tileHeightPx + (tileCount-1) * (tileHeightPx - headerHeightPx)` tall.
 */
export function buildTileCompositePlan(tileCount: number, tileWidthPx: number, tileHeightPx: number, headerHeightPx: number): TileCompositePlan {
  if (tileCount < 1) throw new Error('buildTileCompositePlan: tileCount must be at least 1');
  if (headerHeightPx < 0 || headerHeightPx >= tileHeightPx) throw new Error(`buildTileCompositePlan: headerHeightPx (${headerHeightPx}) must be within [0, tileHeightPx) — got tileHeightPx=${tileHeightPx}`);

  const blocks: CompositeBlock[] = [{ tileIndex: 0, sourceCropY: 0, sourceCropHeight: tileHeightPx, destY: 0 }];
  let destY = tileHeightPx;
  for (let i = 1; i < tileCount; i++) {
    const cropHeight = tileHeightPx - headerHeightPx;
    blocks.push({ tileIndex: i, sourceCropY: headerHeightPx, sourceCropHeight: cropHeight, destY });
    destY += cropHeight;
  }
  return { tileWidthPx, tileHeightPx, headerHeightPx, blocks, totalHeightPx: destY };
}

/**
 * Maps a real, page-scroll-space Y (from B2's measured element geometry — the SAME box that
 * drives markerGroups) into the compacted composite's Y space built by `buildTileCompositePlan`.
 * Returns null when the real Y falls inside a tile's cropped-off header band — that slice of the
 * page was never captured by ANY tile (occluded by the sticky header at every scroll position
 * that could have shown it) — or when it falls at or past `tileCount` tiles' worth of raw scroll
 * space, i.e. B1 never captured a tile that far down the page at all (the page's real scrollHeight
 * exceeded what B1 tiled). Both are "never captured by any tile"; without the `tileCount` bound,
 * a realY past the last tile extrapolates the tiling formula forever, producing a Y inside the
 * Figma frame's geometry that no uploaded tile image ever covers — the marker renders floating in
 * blank canvas past the visible content (bug: 4 markers on a real run landed 1000-5000px below a
 * 9700px-tall, 12-tile frame). Callers should fall back to the nearest capturable position or omit
 * the marker rather than mis-place it.
 */
export function remapMarkerY(realY: number, tileHeightPx: number, headerHeightPx: number, tileCount: number): number | null {
  if (realY < tileHeightPx) return realY; // tile 0, always unaffected
  const tileIndex = Math.floor(realY / tileHeightPx);
  if (tileIndex >= tileCount) return null; // past the last tile B1 ever captured — never captured by any tile
  const withinTile = realY - tileIndex * tileHeightPx;
  if (withinTile < headerHeightPx) return null; // occluded band — never captured
  return tileHeightPx + (tileIndex - 1) * (tileHeightPx - headerHeightPx) + (withinTile - headerHeightPx);
}

/** B1's page-tile-N.png files for one page, in tile order — [] if the page has none (e.g. a very short page needing only one capture, or an older run predating tiled capture). */
export async function findPageTiles(screenshotsDir: string, pageId: string): Promise<string[]> {
  const dir = join(screenshotsDir, pageId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => /^page-tile-\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((f) => join(dir, f));
}

/**
 * The one entry point a CLI run (or the Figma-publish runbook) needs: given a page's tile
 * files, measures the repeated band automatically and returns the ready-to-execute composite
 * plan — or null when there's nothing to composite (no tiles at all). A single tile needs no
 * cropping (there's no second tile to have repeated anything), so it composites as-is.
 */
export async function buildPageCompositePlan(tilePaths: string[]): Promise<TileCompositePlan | null> {
  if (tilePaths.length === 0) return null;
  const first = await decodePng(tilePaths[0]!);
  if (tilePaths.length === 1) {
    return { tileWidthPx: first.width, tileHeightPx: first.height, headerHeightPx: 0, blocks: [{ tileIndex: 0, sourceCropY: 0, sourceCropHeight: first.height, destY: 0 }], totalHeightPx: first.height };
  }
  const headerHeightPx = await detectRepeatedBandHeight(tilePaths[0]!, tilePaths[1]!);
  return buildTileCompositePlan(tilePaths.length, first.width, first.height, headerHeightPx);
}
