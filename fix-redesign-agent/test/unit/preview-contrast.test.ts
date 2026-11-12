import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compositeOver, contrastRatio, isLargeText, measureRun, parseCssColor, relativeLuminance, requiredRatio, type TextRun } from '../../src/preview/contrast.ts';

const solid = (w: number, h: number, rgb: [number, number, number]) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < w * h; i++) { p.data[i * 4] = rgb[0]; p.data[i * 4 + 1] = rgb[1]; p.data[i * 4 + 2] = rgb[2]; p.data[i * 4 + 3] = 255; } return p; };
const run = (over: Partial<TextRun> = {}): TextRun => ({ section: 's', text: 'Hello', tag: 'h1', color: 'rgb(10, 10, 10)', fontPx: 48, fontWeight: 300, rects: [{ x: 10, y: 10, w: 100, h: 40 }], findingIds: [], island: null, muted: false, ...over });

describe('WCAG maths', () => {
  it('black on white is 21:1, identical colours are 1:1, and the order does not matter', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
    expect(contrastRatio({ r: 9, g: 9, b: 9 }, { r: 9, g: 9, b: 9 })).toBe(1);
    expect(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 5);
  });
  it('matches the published reference values (#767676 on white ≈ 4.54, #777 ≈ 4.48)', () => {
    expect(contrastRatio({ r: 0x76, g: 0x76, b: 0x76 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(4.54, 1);
    expect(contrastRatio({ r: 0x77, g: 0x77, b: 0x77 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(4.48, 1);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
  it('composites a translucent colour over its background before measuring', () => {
    expect(compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 })).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
  });
  it('parses rgb()/rgba() including slash and percentage alpha, and refuses what it cannot read', () => {
    expect(parseCssColor('rgba(255, 255, 255, 0.4)')).toEqual({ r: 255, g: 255, b: 255, a: 0.4 });
    expect(parseCssColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor('color(display-p3 1 0 0)')).toBeNull();
  });
  it('large text needs 3:1 (AA) / 4.5:1 (AAA); normal text 4.5:1 / 7:1; bold 18.66px counts as large', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(19, 700)).toBe(true);
    expect(isLargeText(19, 400)).toBe(false);
    expect([requiredRatio(48, 300, 'AA'), requiredRatio(48, 300, 'AAA'), requiredRatio(14, 400, 'AA'), requiredRatio(14, 400, 'AAA')]).toEqual([3, 4.5, 4.5, 7]);
  });
});

describe('measureRun — pixels, not guesses', () => {
  it('the reported defect: near-black text on a near-black section is ~1:1 and fails AA and AAA', () => {
    const m = measureRun(run(), solid(200, 100, [12, 12, 14]))!;
    expect(m.p5).toBeLessThan(1.2);
    expect(m.passesAA).toBe(false);
    expect(m.passesAAA).toBe(false);
    expect(m.background).toBe('#0c0c0e');
  });
  it('the same text on a light background passes both levels', () => {
    const m = measureRun(run(), solid(200, 100, [255, 255, 255]))!;
    expect(m.p5).toBeGreaterThan(15);
    expect(m.passesAAA).toBe(true);
  });
  it('uses the text alpha: 40% white on #0a0a0a composites to grey 108 (3.77:1) — fails AA for 12px text, passes AA (not AAA) as large text', () => {
    const bg = solid(200, 100, [10, 10, 10]);
    const small = measureRun(run({ color: 'rgba(255, 255, 255, 0.4)', fontPx: 12, fontWeight: 400 }), bg)!;
    expect(small.p5).toBeCloseTo(3.77, 1);
    expect(small.passesAA).toBe(false);
    const large = measureRun(run({ color: 'rgba(255, 255, 255, 0.4)', fontPx: 30, fontWeight: 400 }), bg)!;
    expect(large.passesAA).toBe(true);
    expect(large.passesAAA).toBe(false);
  });
  it('judges a gradient by where it is worst, not by its average', () => {
    const p = new PNG({ width: 200, height: 100 });
    for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) { const i = (200 * y + x) * 4; const v = x < 100 ? 0 : 230; p.data[i] = v; p.data[i + 1] = v; p.data[i + 2] = v; p.data[i + 3] = 255; }
    // white text over a background that is black on the left half and near-white on the right half
    const m = measureRun(run({ color: 'rgb(255, 255, 255)', rects: [{ x: 0, y: 10, w: 200, h: 20 }] }), p)!;
    expect(m.worst).toBeLessThan(1.3);
    expect(m.passesAA).toBe(false);
  });
  it('does not call an unmeasurable run a pass', () => {
    expect(measureRun(run({ rects: [{ x: 500, y: 500, w: 10, h: 10 }] }), solid(100, 100, [0, 0, 0]))).toBeNull();
    expect(measureRun(run({ color: 'oklch(0.5 0 0)' }), solid(100, 100, [0, 0, 0]))).toBeNull();
  });
});
