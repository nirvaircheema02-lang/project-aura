import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPageCompositePlan, buildTileCompositePlan, cropTileForBlock, detectRepeatedBandHeight, findPageTiles, remapMarkerY } from '../../src/figma/page-composite-plan.ts';

/**
 * The generalized fix for the sticky-header/repeated-marker bug found on market-entry-real-1
 * (Decision Log #32): a future audit of ANY page must automatically detect a repeated capture
 * band and remap marker coordinates without anyone hand-diffing pixels again.
 */

const REAL_TILES_DIR = join(import.meta.dirname, '..', 'fixtures', 'real', 'market-entry-tiles');

function writeTestPng(path: string, width: number, height: number, paint: (x: number, y: number) => [number, number, number]): void {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const [r, g, b] = paint(x, y);
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

describe('detectRepeatedBandHeight — synthetic tiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-agent-composite-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a clean repeated header band of a known height', () => {
    const HEADER_H = 40;
    const W = 100;
    const H = 200;
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    // Both tiles: identical solid header for rows [0, HEADER_H); genuinely different content below.
    writeTestPng(a, W, H, (_x, y) => (y < HEADER_H ? [10, 10, 10] : [200, 40, 40]));
    writeTestPng(b, W, H, (_x, y) => (y < HEADER_H ? [10, 10, 10] : [40, 40, 200]));
    expect(detectRepeatedBandHeight(a, b)).resolves.toBe(HEADER_H);
  });

  it('is not fooled by a transient low-magnitude blip inside the identical header band', () => {
    const HEADER_H = 60;
    const W = 80;
    const H = 150;
    const a = join(dir, 'a2.png');
    const b = join(dir, 'b2.png');
    // Rows 30-40 differ slightly between tiles (a soft shadow/anti-aliasing artifact) — well
    // under the high-diff threshold — real content starts only at HEADER_H.
    writeTestPng(a, W, H, (_x, y) => (y < HEADER_H ? [20, 20, 20] : [220, 60, 60]));
    writeTestPng(b, W, H, (_x, y) => {
      if (y >= 30 && y < 40) return [30, 20, 20]; // +10 blip — below the default 150 threshold
      return y < HEADER_H ? [20, 20, 20] : [60, 60, 220];
    });
    expect(detectRepeatedBandHeight(a, b)).resolves.toBe(HEADER_H);
  });

  it('returns 0 when the tiles have no repeated band at all (no sticky header)', () => {
    const W = 60;
    const H = 120;
    const a = join(dir, 'a3.png');
    const b = join(dir, 'b3.png');
    writeTestPng(a, W, H, () => [200, 30, 30]);
    writeTestPng(b, W, H, () => [30, 30, 200]); // different from row 0
    expect(detectRepeatedBandHeight(a, b)).resolves.toBe(0);
  });

  it('throws on mismatched tile dimensions rather than silently comparing garbage', () => {
    const a = join(dir, 'a4.png');
    const b = join(dir, 'b4.png');
    writeTestPng(a, 50, 50, () => [0, 0, 0]);
    writeTestPng(b, 60, 60, () => [0, 0, 0]);
    expect(detectRepeatedBandHeight(a, b)).rejects.toThrow(/size mismatch/);
  });
});

describe('detectRepeatedBandHeight — real captured tiles (market-entry-real-1)', () => {
  it('measures the exact 100px header height verified on the real run', async () => {
    const height = await detectRepeatedBandHeight(join(REAL_TILES_DIR, 'page-tile-0.png'), join(REAL_TILES_DIR, 'page-tile-1.png'));
    expect(height).toBe(100);
  });
});

describe('findPageTiles + buildPageCompositePlan — the automatic, per-run entry point', () => {
  it('finds and orders tile files numerically, ignoring unrelated files in the same directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-agent-findtiles-'));
    try {
      const pageDir = join(dir, 'p1');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(pageDir, { recursive: true });
      for (const name of ['page-tile-10.png', 'page-tile-2.png', 'page-tile-1.png', 's0-3-element.png', 'not-a-tile.txt']) {
        writeFileSync(join(pageDir, name), Buffer.from([]));
      }
      const tiles = await findPageTiles(dir, 'p1');
      expect(tiles.map((t) => t.split('/').pop())).toEqual(['page-tile-1.png', 'page-tile-2.png', 'page-tile-10.png']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a page with no tile files (never throws)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-agent-findtiles-empty-'));
    try {
      expect(await findPageTiles(dir, 'no-such-page')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds the full composite plan directly from the real tile files, end to end', async () => {
    const tiles = [join(REAL_TILES_DIR, 'page-tile-0.png'), join(REAL_TILES_DIR, 'page-tile-1.png')];
    const plan = await buildPageCompositePlan(tiles);
    expect(plan).not.toBeNull();
    expect(plan!.headerHeightPx).toBe(100);
    expect(plan!.tileWidthPx).toBe(1440);
    expect(plan!.tileHeightPx).toBe(900);
    expect(plan!.blocks).toHaveLength(2);
  });

  it('cropTileForBlock produces a real PNG of exactly the requested crop height, with the header removed', async () => {
    const plan = await buildPageCompositePlan([join(REAL_TILES_DIR, 'page-tile-0.png'), join(REAL_TILES_DIR, 'page-tile-1.png')]);
    const secondBlock = plan!.blocks[1]!; // tileIndex 1, cropped by the detected header height
    const cropped = await cropTileForBlock(join(REAL_TILES_DIR, 'page-tile-1.png'), secondBlock);
    const decoded = PNG.sync.read(cropped);
    expect(decoded.width).toBe(plan!.tileWidthPx);
    expect(decoded.height).toBe(secondBlock.sourceCropHeight);
  });

  it('returns null for zero tiles, and a whole single block for exactly one tile', async () => {
    expect(await buildPageCompositePlan([])).toBeNull();
    const single = await buildPageCompositePlan([join(REAL_TILES_DIR, 'page-tile-0.png')]);
    expect(single!.headerHeightPx).toBe(0);
    expect(single!.totalHeightPx).toBe(900);
    expect(single!.blocks).toEqual([{ tileIndex: 0, sourceCropY: 0, sourceCropHeight: 900, destY: 0 }]);
  });
});

describe('buildTileCompositePlan — geometry', () => {
  it('keeps tile 0 whole and crops every subsequent tile by the header height, with no gaps or overlaps', () => {
    const plan = buildTileCompositePlan(11, 1440, 900, 100);
    expect(plan.blocks).toHaveLength(11);
    expect(plan.blocks[0]).toEqual({ tileIndex: 0, sourceCropY: 0, sourceCropHeight: 900, destY: 0 });
    expect(plan.blocks[1]).toEqual({ tileIndex: 1, sourceCropY: 100, sourceCropHeight: 800, destY: 900 });
    expect(plan.blocks[10]).toEqual({ tileIndex: 10, sourceCropY: 100, sourceCropHeight: 800, destY: 8100 });
    // Exactly matches the shipped market-entry-real-1 composite: 900 + 10*800 = 8900.
    expect(plan.totalHeightPx).toBe(8900);
    // Contiguous: each block's destY starts exactly where the previous one ends.
    for (let i = 1; i < plan.blocks.length; i++) {
      expect(plan.blocks[i]!.destY).toBe(plan.blocks[i - 1]!.destY + plan.blocks[i - 1]!.sourceCropHeight);
    }
  });

  it('rejects a header height that would crop an entire tile away', () => {
    expect(() => buildTileCompositePlan(3, 1440, 900, 900)).toThrow(/headerHeightPx/);
    expect(() => buildTileCompositePlan(3, 1440, 900, -1)).toThrow(/headerHeightPx/);
  });

  it('rejects fewer than 1 tile', () => {
    expect(() => buildTileCompositePlan(0, 1440, 900, 100)).toThrow(/tileCount/);
  });
});

describe('remapMarkerY — matches the real, already-shipped market-entry-real-1 positions', () => {
  const TILE_H = 900;
  const HEADER_H = 100;
  // market-entry-real-1 shipped with exactly 11 captured tiles (figma-composite-plan.json).
  const TILE_COUNT = 11;

  it('leaves tile-0 markers (realY < tileHeightPx) completely unchanged', () => {
    expect(remapMarkerY(4, TILE_H, HEADER_H, TILE_COUNT)).toBe(4);
    expect(remapMarkerY(816, TILE_H, HEADER_H, TILE_COUNT)).toBe(816);
  });

  it('remaps markers in later tiles to the compacted composite space — exact values verified against the shipped Figma file', () => {
    // Marker 6 (input, "How We Can Help" tile boundary): real Y 4116 -> shipped compact Y 3716.
    expect(remapMarkerY(4116, TILE_H, HEADER_H, TILE_COUNT)).toBe(3716);
    // Marker 9 (footer button): real Y 9268 -> shipped compact Y 8268 (box.y; instance.y = 8268-16 = 8252).
    expect(remapMarkerY(9268, TILE_H, HEADER_H, TILE_COUNT)).toBe(8268);
  });

  it('returns null when the real Y falls inside a cropped, unrecoverable header band — never mis-placed', () => {
    // Tile boundary at 900: the band [900, 1000) is occluded in every tile that could show it.
    expect(remapMarkerY(950, TILE_H, HEADER_H, TILE_COUNT)).toBeNull();
    expect(remapMarkerY(900, TILE_H, HEADER_H, TILE_COUNT)).toBeNull();
    expect(remapMarkerY(999, TILE_H, HEADER_H, TILE_COUNT)).toBeNull();
    // Just past the band, it resolves again.
    expect(remapMarkerY(1000, TILE_H, HEADER_H, TILE_COUNT)).toBe(900);
  });

  it('returns null when the real Y falls at or past the last tile B1 ever captured — never extrapolated (bug repro: survey-page-audit)', () => {
    // 12 tiles captured (indices 0-11) -> valid raw-scroll range is [0, 12*900) = [0, 10800).
    const tileCount = 12;
    // Exactly at the boundary of the 12th tile (tileIndex 12) — never captured.
    expect(remapMarkerY(10800, TILE_H, HEADER_H, tileCount)).toBeNull();
    // Real bug repro: marker #9 on survey-page-audit, real Y 12240 (tileIndex 13) — previously
    // extrapolated to compact Y 10940, floating ~1200px below the 9700px-tall shipped frame.
    expect(remapMarkerY(12240, TILE_H, HEADER_H, tileCount)).toBeNull();
    // marker #12: real Y 16368 (tileIndex 18) — previously extrapolated to compact Y 14568.
    expect(remapMarkerY(16368, TILE_H, HEADER_H, tileCount)).toBeNull();
    // One tile short of the bound (tileIndex 11, the last real tile) still resolves normally.
    expect(remapMarkerY(10799, TILE_H, HEADER_H, tileCount)).toBe(9699);
  });
});
