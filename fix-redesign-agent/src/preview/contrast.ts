import { PNG } from 'pngjs';

/**
 * Text contrast, MEASURED on the rendered preview. Backgrounds in these pages are gradients and
 * images, not flat colours, so the background behind each text run is taken from real pixels (the
 * section rendered with its text made transparent) rather than guessed from CSS; the foreground
 * is the run's computed colour with its alpha and its ancestors' opacity.
 *
 * Pure maths + pixel sampling live here (unit-tested). The in-page part (`textRunsInPage`) is
 * self-contained and stringified into the page, like the other in-page helpers of src/preview.
 */

export interface Rgba { r: number; g: number; b: number; a: number }

/** What the page reports for one text run (one text node's rendered box). */
export interface TextRun {
  /** Section host id (data-pv-section). */
  section: string;
  text: string;
  tag: string;
  /** Computed text colour as rgba(), alpha already multiplied by the ancestors' opacity. */
  color: string;
  fontPx: number;
  fontWeight: number;
  /** Boxes of the run relative to the section host's top-left (CSS px), from Range.getClientRects. */
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  /** Finding ids of the nearest ancestor that carries data-finding-ids, if any. */
  findingIds: string[];
  /** Name of the DS component that renders it (nearest data-pv-island), if any. */
  island: string | null;
  /** Reduced-alpha or neutral mid-grey text: the "muted label" population. */
  muted: boolean;
}

export type ContrastLevel = 'AA' | 'AAA';

/** WCAG 2.x: large text is >= 24px, or >= 18.66px (14pt) and bold. */
export function isLargeText(fontPx: number, fontWeight: number): boolean {
  return fontPx >= 24 || (fontPx >= 18.66 && fontWeight >= 700);
}

/** The ratio a text run must reach: AA 4.5 (3 for large text); AAA 7 (4.5 for large text). */
export function requiredRatio(fontPx: number, fontWeight: number, level: ContrastLevel): number {
  const large = isLargeText(fontPx, fontWeight);
  return level === 'AA' ? (large ? 3 : 4.5) : large ? 4.5 : 7;
}

export function parseCssColor(value: string): Rgba | null {
  const m = value.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Math.min(1, Math.max(0, a)) };
}

const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

/** WCAG relative luminance of an opaque sRGB colour. */
export function relativeLuminance(c: { r: number; g: number; b: number }): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Source-over: a (possibly translucent) foreground on an opaque background. */
export function compositeOver(fg: Rgba, bg: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
}

export interface RunMeasurement {
  run: TextRun;
  /** Worst-case ratio over the sampled pixels, and the 5th percentile (robust to a stray pixel). */
  worst: number;
  p5: number;
  /** Mean background colour under the run, for reporting. */
  background: string;
  samples: number;
  aaRequired: number;
  aaaRequired: number;
  passesAA: boolean;
  passesAAA: boolean;
}

const hex = (c: { r: number; g: number; b: number }) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/**
 * Measures one run against the background pixels of a screenshot of its section. The screenshot's
 * (0,0) is the section host's top-left, scale 1 CSS px per pixel. A run with no sampled pixels
 * (outside the image) is not measured: it returns null rather than a pass.
 */
export function measureRun(run: TextRun, png: Pick<PNG, 'width' | 'height' | 'data'>, level: { aa?: number; aaa?: number } = {}): RunMeasurement | null {
  const fg = parseCssColor(run.color);
  if (!fg) return null;
  const ratios: number[] = [];
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (const rect of run.rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(png.width, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(png.height, Math.ceil(rect.y + rect.h));
    const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 40));
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (png.width * y + x) * 4;
        const bg = { r: png.data[i]!, g: png.data[i + 1]!, b: png.data[i + 2]! };
        const solid = compositeOver(fg, bg);
        ratios.push(contrastRatio(solid, bg));
        sr += bg.r; sg += bg.g; sb += bg.b; n++;
      }
    }
  }
  if (n === 0) return null;
  ratios.sort((p, q) => p - q);
  const worst = ratios[0]!;
  const p5 = ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.05))]!;
  const aaRequired = level.aa ?? requiredRatio(run.fontPx, run.fontWeight, 'AA');
  const aaaRequired = level.aaa ?? requiredRatio(run.fontPx, run.fontWeight, 'AAA');
  // the 5th percentile decides: one anti-aliased edge pixel must not fail a run, a gradient that really dips below must
  return { run, worst, p5, background: hex({ r: sr / n, g: sg / n, b: sb / n }), samples: n, aaRequired, aaaRequired, passesAA: p5 >= aaRequired, passesAAA: p5 >= aaaRequired };
}

export function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

/**
 * Runs IN the page (`handle.evaluate(textRunsInPage, section)`), on a section's root: every text
 * node that is really rendered (real box, inside every clipping ancestor, not transparent), through
 * shadow roots and slots. Self-contained: Playwright serializes only this function's source.
 */
export function textRunsInPage(root: Element, args: { section: string; origin: { x: number; y: number } }): TextRun[] {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION']);
  const runs: TextRun[] = [];
  const opacityChain = (el: Element): number => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) o *= Number(getComputedStyle(n).opacity); return o; };
  const clipOf = (el: Element): { l: number; t: number; r: number; b: number } | null => {
    let box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      // a `display: contents` element (the generated app mirrors the page's html/body this way) has no box, so it clips nothing — its zero-size rect must not become a zero-size clip
      if (cs.display !== 'contents' && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) {
        const r = n.getBoundingClientRect();
        box = { l: Math.max(box.l, cs.overflowX !== 'visible' ? r.left : -Infinity), t: Math.max(box.t, cs.overflowY !== 'visible' ? r.top : -Infinity), r: Math.min(box.r, cs.overflowX !== 'visible' ? r.right : Infinity), b: Math.min(box.b, cs.overflowY !== 'visible' ? r.bottom : Infinity) };
      }
      if (n === root) break;
    }
    return box;
  };
  const colourOf = (el: Element): string => {
    const cs = getComputedStyle(el);
    const fill = cs.getPropertyValue('-webkit-text-fill-color');
    const base = fill && fill !== 'rgba(0, 0, 0, 0)' && fill !== 'transparent' ? fill : cs.color;
    const m = base.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/);
    if (!m) return base;
    const a = (m[4] === undefined ? 1 : Number(m[4])) * opacityChain(el);
    return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${Math.round(a * 1000) / 1000})`;
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      const parent = node.parentElement;
      if (!text || !parent || SKIP.has(parent.tagName)) return;
      const clip = clipOf(parent);
      if (!clip) return;
      if (opacityChain(parent) < 0.05) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects: TextRun['rects'] = [];
      for (const r of Array.from(range.getClientRects())) {
        const w = Math.min(r.right, clip.r) - Math.max(r.left, clip.l);
        const h = Math.min(r.bottom, clip.b) - Math.max(r.top, clip.t);
        if (w > 1 && h > 1) rects.push({ x: Math.max(r.left, clip.l) - args.origin.x, y: Math.max(r.top, clip.t) - args.origin.y, w, h });
      }
      if (rects.length === 0) return;
      const cs = getComputedStyle(parent);
      const color = colourOf(parent);
      const m = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/);
      const alpha = m && m[4] !== undefined ? Number(m[4]) : 1;
      const rgb = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
      const neutral = Math.max(...rgb) - Math.min(...rgb) < 24 && Math.max(...rgb) > 30 && Math.min(...rgb) < 225;
      const withIds = parent.closest('[data-finding-ids]');
      const island = parent.closest('[data-pv-island]');
      runs.push({
        section: args.section, text: text.slice(0, 80), tag: parent.localName, color, fontPx: parseFloat(cs.fontSize), fontWeight: Number(cs.fontWeight) || 400, rects,
        findingIds: (withIds?.getAttribute('data-finding-ids') ?? '').split(/\s+/).filter(Boolean), island: island?.getAttribute('data-pv-island') ?? null, muted: alpha < 0.95 || neutral,
      });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    if (el.tagName === 'SLOT') { for (const n of (el as HTMLSlotElement).assignedNodes({ flatten: true })) visit(n); return; }
    for (const c of Array.from(el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes)) visit(c);
  };
  visit(root);
  return runs;
}
