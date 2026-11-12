import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { inspectEvidenceImage } from '../../src/output/evidence-image.ts';

/**
 * The report decides what to SHOW from the pixels of an evidence screenshot — a crop of an element
 * that is hidden at rest is one flat colour (blank), and a wide strip of left-aligned text has an
 * empty centre. These pin what "blank" means and where the visible content sits, on synthetic PNGs
 * with known geometry (no browser, no real run).
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-evimg-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Rgba = [number, number, number, number];
function png(name: string, width: number, height: number, fill: Rgba, paint?: (set: (x: number, y: number, c: Rgba) => void) => void): string {
  const img = new PNG({ width, height });
  const set = (x: number, y: number, c: Rgba) => {
    const o = (y * width + x) * 4;
    img.data[o] = c[0];
    img.data[o + 1] = c[1];
    img.data[o + 2] = c[2];
    img.data[o + 3] = c[3];
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, fill);
  paint?.(set);
  const path = join(dir, name);
  writeFileSync(path, PNG.sync.write(img));
  return path;
}
const block = (set: (x: number, y: number, c: Rgba) => void, x0: number, y0: number, w: number, h: number, c: Rgba) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c);
};

describe('inspectEvidenceImage — blank means one flat colour, whatever the colour', () => {
  it('a flat near-black sliver (the collapsed "Get in Touch" button shape) is blank', () => {
    const info = inspectEvidenceImage(png('sliver.png', 10, 51, [16, 16, 16, 255]));
    expect(info).toMatchObject({ width: 10, height: 51, blank: true, ink: null });
  });

  it('a flat light-gray rectangle (an invisible link in a closed menu) is blank', () => {
    expect(inspectEvidenceImage(png('gray.png', 240, 47, [232, 232, 240, 255]))?.blank).toBe(true);
  });

  it('a fully transparent image is blank', () => {
    expect(inspectEvidenceImage(png('clear.png', 80, 20, [0, 0, 0, 0]))?.blank).toBe(true);
  });

  it('white ink on a transparent background is blank — composited over the white the report draws on', () => {
    const info = inspectEvidenceImage(png('white-on-clear.png', 120, 30, [0, 0, 0, 0], (set) => block(set, 10, 8, 80, 12, [255, 255, 255, 255])));
    expect(info?.blank).toBe(true);
  });
});

describe('inspectEvidenceImage — visible content and where it is', () => {
  it('finds the ink box of left-aligned text on a wide, short crop — the part a centre-cropped thumbnail misses', () => {
    // A 1040x20 FAQ-question-shaped strip: ink only in x 0..199. The centre (x≈520) is empty.
    const path = png('strip.png', 1040, 20, [255, 255, 255, 255], (set) => block(set, 0, 4, 200, 12, [30, 30, 30, 255]));
    const info = inspectEvidenceImage(path)!;
    expect(info.blank).toBe(false);
    expect(info.ink).toEqual({ x: 0, y: 1, width: 203, height: 18 }); // ink 0..199 × 4..15, padded by 3 and clamped to the image
  });

  it('pads the ink box so glyph edges are not clipped, and clamps it to the image', () => {
    const path = png('padded.png', 200, 100, [255, 255, 255, 255], (set) => block(set, 50, 40, 20, 10, [0, 0, 0, 255]));
    expect(inspectEvidenceImage(path)!.ink).toEqual({ x: 47, y: 37, width: 26, height: 16 });
  });

  it('a one-pixel border is real, visible content — an outlined empty box is not blank', () => {
    const path = png('outline.png', 240, 47, [255, 255, 255, 255], (set) => {
      for (let x = 0; x < 240; x++) {
        set(x, 0, [20, 20, 20, 255]);
        set(x, 46, [20, 20, 20, 255]);
      }
      for (let y = 0; y < 47; y++) {
        set(0, y, [20, 20, 20, 255]);
        set(239, y, [20, 20, 20, 255]);
      }
    });
    const info = inspectEvidenceImage(path)!;
    expect(info.blank).toBe(false);
    expect(info.ink).toEqual({ x: 0, y: 0, width: 240, height: 47 });
  });

  it('measures ink against the dominant colour, not against white — light text on a dark crop is visible', () => {
    const path = png('light-on-dark.png', 200, 30, [16, 16, 16, 255], (set) => block(set, 20, 10, 60, 10, [240, 240, 240, 255]));
    expect(inspectEvidenceImage(path)).toMatchObject({ blank: false, ink: { x: 17, y: 7, width: 66, height: 16 } });
  });
});

describe('inspectEvidenceImage — never guesses, never throws', () => {
  it('returns null for a file that is not a PNG by extension', () => {
    const path = join(dir, 'shot.jpg');
    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff]));
    expect(inspectEvidenceImage(path)).toBeNull();
  });

  it('returns null for a missing file and for corrupt PNG bytes — the report keeps its existing behaviour', () => {
    expect(inspectEvidenceImage(join(dir, 'nope.png'))).toBeNull();
    const corrupt = join(dir, 'corrupt.png');
    writeFileSync(corrupt, Buffer.from('not a png at all'));
    expect(inspectEvidenceImage(corrupt)).toBeNull();
  });

  it('caches per file and re-reads it when the file changes', () => {
    const path = png('cache.png', 50, 20, [255, 255, 255, 255]);
    const first = inspectEvidenceImage(path);
    expect(inspectEvidenceImage(path)).toBe(first); // same object: not re-decoded
    png('cache.png', 50, 20, [255, 255, 255, 255], (set) => block(set, 5, 5, 20, 8, [0, 0, 0, 255]));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000)); // a distinct mtime, so the change is seen even within one clock tick
    expect(inspectEvidenceImage(path)).toMatchObject({ blank: false });
  });
});
