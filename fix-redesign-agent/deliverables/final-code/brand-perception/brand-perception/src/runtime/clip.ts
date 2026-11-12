/**
 * The original page's wrappers clip what sticks out of them (e.g. `max-sm:overflow-hidden` on the page root hides a 700px
 * decorative gradient on a phone). The preview mirrors those wrappers as `display: contents` elements, which have no box and so
 * clip nothing: the decoration stretched the page to 661px on a 390px screen. The wrappers' COMPUTED overflow is still the
 * original's (media queries included), so it is read from them and applied to the section's host box, which has the page's width.
 * html and body are not wrappers in this sense — their overflow is the page's own scrolling, not a clip.
 */

export function clipsHorizontally(overflowX: string): boolean {
  return ['hidden', 'clip', 'scroll', 'auto'].includes(overflowX.trim());
}

export function syncAncestorClip(host: HTMLElement, wrappers: readonly HTMLElement[]): boolean {
  const clip = wrappers.some((w) => clipsHorizontally(getComputedStyle(w).overflowX));
  host.style.overflowX = clip ? 'clip' : '';
  return clip;
}

/** Applies the clip now and again whenever the viewport changes (the original's rules depend on it). Returns a stop function. */
export function watchAncestorClip(host: HTMLElement, wrappers: readonly HTMLElement[], win: Window = window): () => void {
  const run = () => { syncAncestorClip(host, wrappers); };
  run();
  win.addEventListener('resize', run);
  return () => win.removeEventListener('resize', run);
}
