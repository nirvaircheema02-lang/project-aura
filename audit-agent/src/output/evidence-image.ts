import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { PNG } from 'pngjs';

/**
 * What a report needs to know about one evidence screenshot to show it honestly — read from the
 * pixels, never from the finding. An element crop is only as good as what it captured: an element
 * that is hidden until hover/interaction (a collapsed card action, an `opacity:0` reveal link, a
 * menu item inside a closed radial menu) is still in the DOM with a real box and real computed
 * styles, so it is audited — but its crop is one flat colour. And a wide, short crop of left-aligned
 * text has plenty of ink at the left and an empty centre, so a centre-cropped thumbnail of it looks
 * blank too. Both are "the screenshot exists but looks blank", and neither is visible to anything
 * that only looks at the finding.
 */
export interface EvidenceImageInfo {
  width: number;
  height: number;
  /** One flat colour: nothing visible to look at (a hidden element, or a solid shape with nothing drawn on it). */
  blank: boolean;
  /** Padded bounding box of everything that differs visibly from the dominant background colour; null when `blank`. */
  ink: { x: number; y: number; width: number; height: number } | null;
}

/** Reads the pixels of an evidence file by its absolute path; null when it cannot tell (not a PNG, unreadable, gone). */
export type EvidenceInspector = (absoluteRef: string) => EvidenceImageInfo | null;

/** A pixel counts as ink when its colour is this far (sum of |ΔR|+|ΔG|+|ΔB|, max 765) from the background. */
const INK_DISTANCE = 60;
/** Fewer than this share of ink pixels and an image has nothing a reviewer can see. */
const BLANK_INK_FRACTION = 0.001;
/** Padding around the ink box, so a thumbnail never clips the glyph edges or a 1px border. */
const INK_PAD = 3;
/** Past this many pixels the bounding box is skipped (blank detection still runs on a sample) — a bound on work. */
const MAX_BBOX_PIXELS = 4_000_000;

const cache = new Map<string, { key: string; info: EvidenceImageInfo | null }>();

/**
 * Pixel-inspects one evidence PNG. Alpha is composited over white — the surface the report draws
 * on — so white text on a transparent background counts as the blank it actually looks like.
 * Cached per path and invalidated by size/mtime, so the long-running dashboard pays once per file.
 */
export function inspectEvidenceImage(absoluteRef: string): EvidenceImageInfo | null {
  if (extname(absoluteRef).toLowerCase() !== '.png') return null;
  let key: string;
  try {
    const st = statSync(absoluteRef);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = cache.get(absoluteRef);
  if (hit && hit.key === key) return hit.info;

  let info: EvidenceImageInfo | null;
  try {
    info = analyze(PNG.sync.read(readFileSync(absoluteRef)));
  } catch {
    info = null; // a corrupt or unsupported PNG is "unknown", never a reason to hide or fail the report
  }
  cache.set(absoluteRef, { key, info });
  return info;
}

function analyze(png: PNG): EvidenceImageInfo {
  const { width, height, data } = png;
  const total = width * height;
  const channel = (o: number): [number, number, number] => {
    const a = (data[o + 3] ?? 255) / 255;
    return [(data[o] ?? 0) * a + 255 * (1 - a), (data[o + 1] ?? 0) * a + 255 * (1 - a), (data[o + 2] ?? 0) * a + 255 * (1 - a)];
  };

  // The dominant colour, from a bounded sample, is the "background" everything else is measured against.
  const step = Math.max(1, Math.floor(total / 150_000));
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < total; i += step) {
    const [r, g, b] = channel(i * 4);
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(k);
    if (bucket) {
      bucket.n++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else buckets.set(k, { n: 1, r, g, b });
  }
  let best = { n: 0, r: 255, g: 255, b: 255 };
  for (const bucket of buckets.values()) if (bucket.n > best.n) best = bucket;
  const bg = best.n > 0 ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];

  const isInk = (o: number): boolean => {
    const [r, g, b] = channel(o);
    return Math.abs(r - (bg[0] ?? 255)) + Math.abs(g - (bg[1] ?? 255)) + Math.abs(b - (bg[2] ?? 255)) > INK_DISTANCE;
  };

  if (total > MAX_BBOX_PIXELS) {
    let ink = 0;
    let seen = 0;
    for (let i = 0; i < total; i += step) {
      seen++;
      if (isInk(i * 4)) ink++;
    }
    return { width, height, blank: ink / Math.max(1, seen) < BLANK_INK_FRACTION, ink: null };
  }

  let ink = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isInk((y * width + x) * 4)) continue;
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (ink / Math.max(1, total) < BLANK_INK_FRACTION || maxX < 0) return { width, height, blank: true, ink: null };
  const x = Math.max(0, minX - INK_PAD);
  const y = Math.max(0, minY - INK_PAD);
  return { width, height, blank: false, ink: { x, y, width: Math.min(width, maxX + 1 + INK_PAD) - x, height: Math.min(height, maxY + 1 + INK_PAD) - y } };
}
