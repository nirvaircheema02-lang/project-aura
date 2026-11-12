import type { Page } from 'playwright';

/**
 * Preserve every real slide, including its finding stamps. Only Swiper's duplicate slides are dropped; the kept
 * ones are cloned once, and the track slides left by exactly the original set, repeating forever
 * (`translate -50%` of a `max-content` track). Clones carry no stamps or ids, so mapping,
 * findings and edits still point only at the originals. Reduced-motion users get a still track.
 */
const SECONDS_PER_SLIDE = 7;

export interface CarouselSummary {
  carousels: number;
  kept: number;
  dropped: number;
}

export async function compactCarousels(page: Page): Promise<CarouselSummary> {
  return page.evaluate(
    ({ seconds }) => {
      let carousels = 0;
      let kept = 0;
      let dropped = 0;
      for (const wrapper of Array.from(document.querySelectorAll<HTMLElement>('.swiper-wrapper'))) {
        const children = Array.from(wrapper.children) as HTMLElement[];
        const real = children.filter((c) => c.classList.contains('swiper-slide') && !c.classList.contains('swiper-slide-duplicate') && !c.classList.contains('fra-carousel-clone'));
        if (real.length === 0) continue;
        const keepers = real;
        // a carousel that was hidden at the capture width (the phone-only one) was never sized by Swiper, so its slides carry no width and a `max-content` track
        // would stretch each to its one-line text; the original's phone carousel shows one slide per view, i.e. the container width
        for (const slide of keepers) if (!slide.style.width) slide.classList.add('fra-carousel-slide-fill');
        for (const c of children) {
          if (!keepers.includes(c)) {
            c.remove();
            dropped++;
          }
        }
        for (const slide of keepers) {
          const clone = slide.cloneNode(true) as HTMLElement;
          for (const el of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))]) {
            for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-fra-') || a.name === 'id') el.removeAttribute(a.name);
          }
          clone.setAttribute('aria-hidden', 'true');
          clone.setAttribute('inert', '');
          clone.classList.add('fra-carousel-clone');
          wrapper.appendChild(clone);
        }
        wrapper.classList.add('fra-carousel-track');
        wrapper.style.animationDuration = `${keepers.length * seconds}s`;
        carousels++;
        kept += keepers.length;
      }
      if (carousels > 0 && !document.getElementById('fra-carousel-style')) {
        const style = document.createElement('style');
        style.id = 'fra-carousel-style';
        style.textContent =
          '@keyframes fra-carousel-loop { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(-50%, 0, 0); } }' +
          '.fra-carousel-track { width: max-content; animation-name: fra-carousel-loop; animation-timing-function: linear; animation-iteration-count: infinite; }' +
          '.swiper:has(> .fra-carousel-track > .fra-carousel-slide-fill) { container-type: inline-size; }' +
          '.fra-carousel-slide-fill { width: 100cqw; flex-shrink: 0; }' +
          '@media (prefers-reduced-motion: reduce) { .fra-carousel-track { animation: none; } }';
        document.head.appendChild(style);
      }
      return { carousels, kept, dropped };
    },
    { seconds: SECONDS_PER_SLIDE },
  );
}
