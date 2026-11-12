/** Connect captured pagination and the DS arrow buttons, including light-DOM controls assigned through slots. */
export function attachCarousels(root: ShadowRoot, host: HTMLElement): () => void {
  const indices = new WeakMap<HTMLElement, number>();
  const go = (track: HTMLElement, index: number) => {
    const slides = Array.from(track.children).filter((e): e is HTMLElement => e instanceof HTMLElement && e.classList.contains('swiper-slide') && !e.classList.contains('fra-carousel-clone'));
    if (!slides.length) return;
    const next = (index + slides.length) % slides.length;
    indices.set(track, next);
    const offset = slides[next]!.getBoundingClientRect().left - slides[0]!.getBoundingClientRect().left;
    track.style.animation = 'none';
    track.style.transform = `translate3d(${-offset}px, 0, 0)`;
    slides.forEach((slide, i) => slide.classList.toggle('swiper-slide-active', i === next));
    const pagination = track.parentElement?.querySelector('.swiper-pagination');
    pagination?.querySelectorAll<HTMLElement>('.swiper-pagination-bullet').forEach((bullet, i) => {
      bullet.classList.toggle('swiper-pagination-bullet-active', i === next);
      bullet.setAttribute('aria-current', String(i === next));
    });
  };
  const control = (event: Event) => {
    const target = event.composedPath().find((e): e is Element => e instanceof Element && e.matches('[data-pv-carousel-direction], .swiper-pagination-bullet'));
    if (!target) return;
    if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return;
    // Native buttons generate their own click on keyboard activation.
    if (event instanceof KeyboardEvent && target instanceof HTMLButtonElement) return;
    const bullet = target.classList.contains('swiper-pagination-bullet');
    const track = bullet
      ? target.closest('.swiper')?.querySelector<HTMLElement>('.fra-carousel-track')
      : Array.from(root.querySelectorAll<HTMLElement>('.fra-carousel-track')).find((e) => e.getBoundingClientRect().width > 0 && e.parentElement!.getBoundingClientRect().width > 0);
    if (!track) return;
    event.preventDefault();
    const index = bullet ? Array.from(target.parentElement!.children).indexOf(target) : (indices.get(track) ?? 0) + (target.getAttribute('data-pv-carousel-direction') === 'prev' ? -1 : 1);
    go(track, index);
  };
  const labelPagination = () => root.querySelectorAll<HTMLElement>('.swiper-pagination-bullet').forEach((el) => {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-label', `Go to slide ${Array.from(el.parentElement!.children).indexOf(el) + 1}`);
  });
  const observer = new MutationObserver(labelPagination);
  observer.observe(root, { childList: true, subtree: true });
  labelPagination();
  // Listen once on the host: composed events from its shadow tree and its light-DOM islands both reach it.
  host.addEventListener('click', control);
  host.addEventListener('keydown', control);
  return () => { observer.disconnect(); host.removeEventListener('click', control); host.removeEventListener('keydown', control); };
}
