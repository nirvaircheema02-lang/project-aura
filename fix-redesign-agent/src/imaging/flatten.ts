import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { buildPageCompositePlan, decodePng, type TileCompositePlan } from './tile-composite.ts';

/**
 * NEW code (not vendored) — ARCHITECTURE.md Q4 named this gap honestly: audit-agent never
 * needed to flatten cropped tile blocks into one merged raster, because Figma's node
 * placement did that step visually. R2 (before) and R4/R7 (after) need a real single PNG.
 *
 * One `PNG` sized `tileWidthPx × totalHeightPx`; every block's rows are copied from its
 * source tile at `sourceCropY` into the output at `destY`. Nothing is resampled.
 */
export async function flattenTilesToPng(tilePaths: string[], plan: TileCompositePlan): Promise<Buffer> {
  const out = new PNG({ width: plan.tileWidthPx, height: plan.totalHeightPx });
  const rowBytes = plan.tileWidthPx * 4;
  for (const block of plan.blocks) {
    const tilePath = tilePaths[block.tileIndex];
    if (!tilePath) throw new Error(`flattenTilesToPng: plan references tile ${block.tileIndex} but only ${tilePaths.length} tile paths were given`);
    const src = await decodePng(tilePath);
    if (src.width !== plan.tileWidthPx) {
      throw new Error(`flattenTilesToPng: tile ${block.tileIndex} is ${src.width}px wide, plan expects ${plan.tileWidthPx}px — tiles must come from the same capture`);
    }
    if (block.sourceCropY < 0 || block.sourceCropY + block.sourceCropHeight > src.height) {
      throw new Error(`flattenTilesToPng: block for tile ${block.tileIndex} crops [${block.sourceCropY}, ${block.sourceCropY + block.sourceCropHeight}) outside the tile's height (${src.height})`);
    }
    if (block.destY < 0 || block.destY + block.sourceCropHeight > plan.totalHeightPx) {
      throw new Error(`flattenTilesToPng: block for tile ${block.tileIndex} lands at [${block.destY}, ${block.destY + block.sourceCropHeight}) outside the composite height (${plan.totalHeightPx})`);
    }
    src.data.copy(out.data, block.destY * rowBytes, block.sourceCropY * rowBytes, (block.sourceCropY + block.sourceCropHeight) * rowBytes);
  }
  return PNG.sync.write(out);
}

export interface CompositeResult {
  plan: TileCompositePlan;
  outPath: string;
  bytes: number;
}

/**
 * The one call R2/R4/R7 make: plan (measure the repeated header band) + flatten + write.
 * Returns null when there are no tiles at all — never a blank image passed off as a page.
 */
export async function compositeTilesToFile(tilePaths: string[], outPath: string): Promise<CompositeResult | null> {
  const plan = await buildPageCompositePlan(tilePaths);
  if (!plan) return null;
  const png = await flattenTilesToPng(tilePaths, plan);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, png);
  return { plan, outPath, bytes: png.byteLength };
}
