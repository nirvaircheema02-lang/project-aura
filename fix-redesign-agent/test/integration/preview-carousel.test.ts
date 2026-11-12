import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachCarousels } from '../../templates/react-preview/src/runtime/carousels.ts';
import { compactCarousels } from '../../src/preview/carousel.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/** Real Chromium: every real slide remains reachable; only library duplicates are removed. */
const slides = (n: number) =>
  Array.from({ length: n }, (_, i) => `<div class="swiper-slide" data-fra-element="e${i}" id="s${i}" style="width:300px;margin-right:24px">Testimonial ${i}</div>`).join('');
const HTML = `<!doctype html><html><body><div class="swiper"><div class="swiper-wrapper" style="display:flex;transform:translate3d(-324px,0,0)">
<div class="swiper-slide swiper-slide-duplicate" style="width:300px">Testimonial 19 (dup)</div>${slides(20)}</div></div>
<div class="swiper"><div class="swiper-wrapper" style="display:flex">${slides(2).replace(/data-fra-element="e/g, 'data-fra-element="x').replace(/id="s/g, 'id="t')}</div></div></body></html>`;

let pool: BrowserPool;
beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});

describe('compactCarousels', () => {
  it('keeps ALL real slides and their findings, removing only Swiper duplicates', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent(HTML);
      const out = await compactCarousels(page);
      expect(out).toEqual({ carousels: 2, kept: 22, dropped: 1 });
      const texts = await page.locator('.swiper').first().locator('.swiper-slide').allTextContents();
      expect(texts).toEqual([...Array.from({length: 20}, (_, i) => `Testimonial ${i}`), ...Array.from({length: 20}, (_, i) => `Testimonial ${i}`)]);
      expect(await page.locator('[data-fra-element="e19"]').count()).toBe(1);
    });
  });

  it('clones carry no stamps or ids, so findings and edits can only ever point at the originals', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent(HTML);
      await compactCarousels(page);
      expect(await page.locator('.fra-carousel-clone[data-fra-element]').count()).toBe(0);
      expect(await page.locator('.fra-carousel-clone[id]').count()).toBe(0);
      expect(await page.locator('.fra-carousel-clone:not([inert])').count()).toBe(0);
      expect(await page.locator('[data-fra-element="e0"]').count()).toBe(1);
      expect(await page.locator('#s0').count()).toBe(1);
    });
  });

  it('animates the track by exactly the original set (a -50% loop on a max-content track) and respects reduced motion', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent(HTML);
      await compactCarousels(page);
      const track = page.locator('.fra-carousel-track').first();
      const cs = await track.evaluate((el) => { const c = getComputedStyle(el); return { name: c.animationName, iter: c.animationIterationCount, dur: c.animationDuration, width: el.getBoundingClientRect().width }; });
      expect(cs).toMatchObject({ name: 'fra-carousel-loop', iter: 'infinite', dur: '140s' });
      expect(cs.width).toBe(40 * 324); // every original + inert clones
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await track.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    });
  });

  it('gives slides Swiper never sized (the phone-only carousel hidden at capture) the container width, not their one-line text width', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await page.setContent(`<!doctype html><html><body style="margin:0"><div style="padding:0 16px"><div class="swiper" style="overflow:hidden"><div class="swiper-wrapper" style="display:flex">
        <div class="swiper-slide" style="margin-right:10px"><p style="white-space:nowrap">${'long testimonial text '.repeat(40)}</p></div>
        <div class="swiper-slide" style="margin-right:10px">Second</div></div></div></div></body></html>`);
      await compactCarousels(page);
      const widths = await page.locator('.swiper-slide:not(.fra-carousel-clone)').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
      expect(widths).toEqual([343, 343]);
    });
  });

  it('is a no-op on a page without carousels', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent('<p>plain</p>');
      expect(await compactCarousels(page)).toEqual({ carousels: 0, kept: 0, dropped: 0 });
    });
  });
  it('connects slotted next/previous controls and keyboard pagination to the actual track', async () => {
    await pool.withIsolatedPage(async (page) => {
      await page.setContent(HTML);
      await compactCarousels(page);
      const html = await page.locator('.swiper').first().evaluate((el) => el.outerHTML);
      await page.setContent('<div id="host"><button slot="controls" data-pv-carousel-direction="prev">Previous</button><button slot="controls" data-pv-carousel-direction="next">Next</button></div>');
      await page.evaluate(({ html, attach }) => {
        const host = document.getElementById('host')!;
        const root = host.attachShadow({mode:'open'});
        root.innerHTML = '<style>.swiper{width:700px;overflow:hidden}.swiper-wrapper{display:flex;width:max-content}.swiper-slide{flex-shrink:0}</style><slot name="controls"></slot>' + html;
        const pager = document.createElement('div');pager.className = 'swiper-pagination';
        pager.innerHTML = Array.from({length:20}, () => '<span class="swiper-pagination-bullet">•</span>').join('');
        root.querySelector('.swiper')!.append(pager);
        (new Function('return ('+attach+')')())(root,host);
      }, {html,attach:attachCarousels.toString()});
      const track = page.locator('.fra-carousel-track');
      await page.getByRole('button', {name:'Next', exact:true}).click();
      expect(await track.evaluate(el => el.style.transform)).toBe('translate3d(-324px, 0px, 0px)');
      await page.getByRole('button', {name:'Previous', exact:true}).click();
      expect(await track.evaluate(el => el.style.transform)).toBe('translate3d(0px, 0px, 0px)');
      await page.getByRole('button', {name:'Go to slide 20', exact:true}).focus();
      await page.keyboard.press('Enter');
      expect(await track.evaluate(el => el.style.transform)).toBe('translate3d(-6156px, 0px, 0px)');
      expect(await page.getByRole('button', {name:'Go to slide 20', exact:true}).getAttribute('aria-current')).toBe('true');
    });
  });

});
