import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPageCompositePlan, buildTileCompositePlan, compositeTilesToFile, cropTileForBlock, detectRepeatedBandHeight, findPageTiles, flattenTilesToPng } from '../../src/imaging/index.ts';

/**
 * The crop-planning half mirrors audit-agent's own test intent (synthetic tiles — behavior
 * unchanged post-copy); the flatten half is NEW and is what R2/R7 actually need.
 */

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

function pixel(png: PNG, x: number, y: number): [number, number, number] {
  const idx = (png.width * y + x) << 2;
  return [png.data[idx]!, png.data[idx + 1]!, png.data[idx + 2]!];
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fra-imaging-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('detectRepeatedBandHeight (vendored)', () => {
  it('detects a clean repeated header band of a known height', async () => {
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    writeTestPng(a, 100, 200, (_x, y) => (y < 40 ? [10, 10, 10] : [200, 40, 40]));
    writeTestPng(b, 100, 200, (_x, y) => (y < 40 ? [10, 10, 10] : [40, 40, 200]));
    await expect(detectRepeatedBandHeight(a, b)).resolves.toBe(40);
  });

  it('is not fooled by a low-magnitude blip inside the identical band', async () => {
    const a = join(dir, 'a2.png');
    const b = join(dir, 'b2.png');
    writeTestPng(a, 80, 150, (_x, y) => (y < 60 ? [20, 20, 20] : [220, 60, 60]));
    writeTestPng(b, 80, 150, (_x, y) => (y >= 30 && y < 40 ? [30, 20, 20] : y < 60 ? [20, 20, 20] : [60, 60, 220]));
    await expect(detectRepeatedBandHeight(a, b)).resolves.toBe(60);
  });

  it('returns 0 with no repeated band, and throws on mismatched sizes', async () => {
    const a = join(dir, 'a3.png');
    const b = join(dir, 'b3.png');
    writeTestPng(a, 60, 120, () => [200, 30, 30]);
    writeTestPng(b, 60, 120, () => [30, 30, 200]);
    await expect(detectRepeatedBandHeight(a, b)).resolves.toBe(0);
    const c = join(dir, 'c.png');
    writeTestPng(c, 50, 50, () => [0, 0, 0]);
    await expect(detectRepeatedBandHeight(a, c)).rejects.toThrow(/size mismatch/);
  });
});

describe('buildTileCompositePlan / findPageTiles / buildPageCompositePlan (vendored)', () => {
  it('keeps tile 0 whole and crops every later tile by the header height, contiguously', () => {
    const plan = buildTileCompositePlan(11, 1440, 900, 100);
    expect(plan.blocks[0]).toEqual({ tileIndex: 0, sourceCropY: 0, sourceCropHeight: 900, destY: 0 });
    expect(plan.blocks[1]).toEqual({ tileIndex: 1, sourceCropY: 100, sourceCropHeight: 800, destY: 900 });
    expect(plan.totalHeightPx).toBe(8900);
    for (let i = 1; i < plan.blocks.length; i++) expect(plan.blocks[i]!.destY).toBe(plan.blocks[i - 1]!.destY + plan.blocks[i - 1]!.sourceCropHeight);
    expect(() => buildTileCompositePlan(3, 1440, 900, 900)).toThrow(/headerHeightPx/);
    expect(() => buildTileCompositePlan(0, 1440, 900, 100)).toThrow(/tileCount/);
  });

  it('orders tile files numerically and ignores unrelated files; [] for a missing dir', async () => {
    const pageDir = join(dir, 'tiles');
    mkdirSync(pageDir);
    for (const name of ['page-tile-10.png', 'page-tile-2.png', 'page-tile-1.png', 'element.png', 'x.txt']) writeFileSync(join(pageDir, name), '');
    expect((await findPageTiles(pageDir)).map((p) => p.split('/').pop())).toEqual(['page-tile-1.png', 'page-tile-2.png', 'page-tile-10.png']);
    expect(await findPageTiles(join(dir, 'nope'))).toEqual([]);
  });

  it('plans null for zero tiles, a single whole block for one tile, and measures the band for two+', async () => {
    expect(await buildPageCompositePlan([])).toBeNull();
    const t0 = join(dir, 't0.png');
    const t1 = join(dir, 't1.png');
    writeTestPng(t0, 40, 100, (_x, y) => (y < 20 ? [5, 5, 5] : [250, 0, 0]));
    writeTestPng(t1, 40, 100, (_x, y) => (y < 20 ? [5, 5, 5] : [0, 0, 250]));
    const single = await buildPageCompositePlan([t0]);
    expect(single).toEqual({ tileWidthPx: 40, tileHeightPx: 100, headerHeightPx: 0, blocks: [{ tileIndex: 0, sourceCropY: 0, sourceCropHeight: 100, destY: 0 }], totalHeightPx: 100 });
    const two = await buildPageCompositePlan([t0, t1]);
    expect(two!.headerHeightPx).toBe(20);
    const cropped = PNG.sync.read(await cropTileForBlock(t1, two!.blocks[1]!));
    expect(cropped.height).toBe(80);
    expect(pixel(cropped, 0, 0)).toEqual([0, 0, 250]); // header row gone, content starts at row 0
  });
});

describe('flattenTilesToPng / compositeTilesToFile (new)', () => {
  it('flattens three tiles into one PNG of the planned height with the repeated header removed', async () => {
    const paths = [0, 1, 2].map((i) => join(dir, `page-tile-${i}.png`));
    const colors: Array<[number, number, number]> = [
      [250, 0, 0],
      [0, 250, 0],
      [0, 0, 250],
    ];
    paths.forEach((p, i) => writeTestPng(p, 30, 100, (_x, y) => (y < 25 ? [9, 9, 9] : colors[i]!)));
    const plan = (await buildPageCompositePlan(paths))!;
    expect(plan.headerHeightPx).toBe(25);
    const png = PNG.sync.read(await flattenTilesToPng(paths, plan));
    expect(png.width).toBe(30);
    expect(png.height).toBe(plan.totalHeightPx); // 100 + 75 + 75
    expect(png.height).toBe(250);
    expect(pixel(png, 5, 0)).toEqual([9, 9, 9]); // tile 0's header kept — it is genuinely the top of the page
    expect(pixel(png, 5, 99)).toEqual([250, 0, 0]); // end of tile 0
    expect(pixel(png, 5, 100)).toEqual([0, 250, 0]); // tile 1 content starts immediately — no second header
    expect(pixel(png, 5, 175)).toEqual([0, 0, 250]); // tile 2 content
    expect(pixel(png, 5, 249)).toEqual([0, 0, 250]);
  });

  it('a single tile flattens byte-for-byte to itself', async () => {
    const p = join(dir, 'only.png');
    writeTestPng(p, 20, 50, (x, y) => [x * 10, y * 5, 7]);
    const plan = (await buildPageCompositePlan([p]))!;
    const out = PNG.sync.read(await flattenTilesToPng([p], plan));
    expect(Buffer.compare(out.data, PNG.sync.read(readFileSync(p)).data)).toBe(0);
  });

  it('refuses a tile whose width differs from the plan, and a plan referencing a tile it was not given', async () => {
    const a = join(dir, 'w1.png');
    const b = join(dir, 'w2.png');
    writeTestPng(a, 30, 40, () => [1, 1, 1]);
    writeTestPng(b, 31, 40, () => [1, 1, 1]);
    const plan = buildTileCompositePlan(2, 30, 40, 0);
    await expect(flattenTilesToPng([a, b], plan)).rejects.toThrow(/31px wide/);
    await expect(flattenTilesToPng([a], plan)).rejects.toThrow(/only 1 tile paths/);
  });

  it('compositeTilesToFile writes the file and returns the plan; null (no file) for zero tiles', async () => {
    const paths = [0, 1].map((i) => join(dir, `c-${i}.png`));
    paths.forEach((p, i) => writeTestPng(p, 16, 32, (_x, y) => (y < 8 ? [0, 0, 0] : i === 0 ? [200, 0, 0] : [0, 200, 0])));
    const out = join(dir, 'out', 'before.png');
    const result = await compositeTilesToFile(paths, out);
    expect(result!.plan.totalHeightPx).toBe(56);
    expect(existsSync(out)).toBe(true);
    expect(PNG.sync.read(readFileSync(out)).height).toBe(56);
    expect(await compositeTilesToFile([], join(dir, 'never.png'))).toBeNull();
    expect(existsSync(join(dir, 'never.png'))).toBe(false);
  });
});
