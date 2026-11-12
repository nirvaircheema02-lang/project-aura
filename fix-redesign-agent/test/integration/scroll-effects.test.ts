import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureScrollEffects, isFirstVisitScrollDriven, isScrollDriven, translateYOf } from '../../src/preview/scroll-effects.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Real Chromium. A page with (a) an element whose translateY follows the scroll offset (the hero card stack),
 * (b) an autoplay carousel whose translateX changes with TIME, and (c) a static element. Only (a) is a scroll effect.
 */
const FIXTURE = `<!doctype html><html><head><title>fx</title><style>body{margin:0;height:4000px}#hero{position:fixed;top:50px;left:0;width:100px;height:100px}</style></head><body>
<div id="hero" class="z-30 hero-stack" style="transform: translateY(20px);">cards</div>
<div id="car" class="car-track" style="transform: translateX(0px);">slides</div>
<div id="still" class="still" style="transform: none;">x</div>
<div id="stack" class="path-stack" style="transform: translateY(20px);">cards</div>
<script>
  const hero = document.getElementById('hero');
  const f = (y) => Math.max(-350, 20 - y * 0.55);
  addEventListener('scroll', () => { hero.style.transform = 'translateY(' + f(scrollY) + 'px)'; });
  // path-dependent: follows the offset on the way down, never moves back up (the page's handler reads its own moved position)
  const stack = document.getElementById('stack'); let lastY = 0;
  addEventListener('scroll', () => { if (scrollY > lastY) stack.style.transform = 'translateY(' + f(scrollY) + 'px)'; lastY = scrollY; });
  let x = 0; setInterval(() => { x -= 37; document.getElementById('car').style.transform = 'translateX(' + x + 'px)'; }, 120);
</script></body></html>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
beforeAll(async () => {
  server = await startLocalServer({ '/fx': { body: FIXTURE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
  await server?.close();
});

describe('translateYOf', () => {
  it('parses the plain vertical transforms and rejects the rest', () => {
    expect(translateYOf('translateY(-4.38px)')).toBe(-4.38);
    expect(translateYOf('translate3d(0px, 12px, 0px)')).toBe(12);
    expect(translateYOf('matrix(1, 0, 0, 1, 0, -350)')).toBe(-350);
    expect(translateYOf('none')).toBe(0);
    expect(translateYOf('translateX(5px)')).toBeNull();
    expect(translateYOf('matrix(1, 0, 0, 1, -37, 0)')).toBeNull();
  });
});

describe('isScrollDriven', () => {
  const ys = [0, 100, 200, 300, 400, 500];
  it('accepts a smoothed scroll effect: different values going up than going down, same shape and same ends (the hero card stack)', () => {
    const down = [20, -11, -60, -112, -170, -230];
    const up = [20, -30, -90, -150, -200, -230];
    expect(isScrollDriven(down, up)).toBe(true);
    void ys;
  });
  it('accepts an effect that increases with the offset', () => {
    expect(isScrollDriven([0, 10, 25, 40], [0, 8, 22, 40])).toBe(true);
  });
  it('REGRESSION: rejects a time-driven vertical mover (it keeps moving the same way over TIME, so against the offset the sweeps run opposite ways)', () => {
    const marquee = [0, -37, -74, -111, -148, -185, -222, -259]; // down sweep, then the same drift continues during the up sweep
    const down = marquee.slice(0, 4);
    const up = marquee.slice(4);
    expect(isScrollDriven(down, up)).toBe(false);
  });
  it('rejects non-moving, non-monotonic and too-short series', () => {
    expect(isScrollDriven([5, 5, 5, 5], [5, 5, 5, 5])).toBe(false);
    expect(isScrollDriven([0, 10, 0, 10], [0, 10, 0, 10])).toBe(false);
    expect(isScrollDriven([0, 1], [0, 1])).toBe(false);
  });
});

describe('isFirstVisitScrollDriven', () => {
  it('accepts an effect that follows the offset going down but does not return to its first-load value going up (the cndp hero cards)', () => {
    const down = [20, -33, -92, -152, -214, -313];
    const up = [-122, -150, -170, -200, -260, -313];
    expect(isScrollDriven(down, up)).toBe(false);
    expect(isFirstVisitScrollDriven(down, up)).toBe(true);
  });
  it('REGRESSION: still rejects a time-driven mover (the two sweeps end in different places) and non-moving series', () => {
    const marquee = [0, -37, -74, -111, -148, -185, -222, -259];
    expect(isFirstVisitScrollDriven(marquee.slice(0, 4), marquee.slice(4))).toBe(false);
    expect(isFirstVisitScrollDriven([5, 5, 5, 5], [5, 5, 5, 5])).toBe(false);
    expect(isFirstVisitScrollDriven([0, 10, 0, 10], [0, 10, 0, 10])).toBe(false);
  });
});

describe('captureScrollEffects', () => {
  it('records the scroll-driven translateY (and the first-visit path of a path-dependent one) and ignores the time-driven carousel and the static element', async () => {
    const context = await pool.newIsolatedContext();
    try {
      const out = await captureScrollEffects(context, `${server.origin}/fx`);
      expect(out.effects.map((e) => e.className).sort()).toEqual(['path-stack', 'z-30 hero-stack']);
      const s = out.effects[0]!.samples;
      expect(s[0]).toEqual([0, 20]);
      const at = (y: number) => s.find(([yy]) => yy === y)![1];
      expect(at(200)).toBeCloseTo(20 - 200 * 0.55, 0);
      expect(at(700)).toBe(-350); // clamped, like the original
      expect(out.effects.some((e) => e.className === 'car-track')).toBe(false);
      // the path-dependent element is replayed along its first-visit path from its first-load value, and disclosed as approximate
      const stack = out.effects.find((e) => e.className === 'path-stack');
      expect(stack?.samples[0]).toEqual([0, 20]);
      expect(stack!.samples.find(([yy]) => yy === 200)![1]).toBeCloseTo(20 - 200 * 0.55, 0);
      expect(out.approximated?.map((a) => a.className)).toEqual(['path-stack']);
    } finally {
      await context.close();
    }
  }, 120_000);
});
