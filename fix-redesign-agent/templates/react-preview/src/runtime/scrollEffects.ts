/**
 * Scroll-linked effects of the original page, replayed in the preview.
 *
 * Some elements move as the page scrolls (e.g. the hero card stack slides from +20px to -350px of translateY
 * over the first 700px of scroll). The original does it with a scroll handler; the preview is static HTML, so
 * the pipeline records the element's translateY at several scroll offsets on the production page (read-only)
 * and this module replays it: piecewise-linear between the recorded samples, clamped at both ends.
 */

export interface ScrollEffect {
  /** exact `class` attribute of the element in the original */
  className: string;
  tag: string;
  /** which of the elements with that tag+class (document order) */
  index: number;
  /** [scrollY, translateY px] sorted by scrollY */
  samples: Array<[number, number]>;
}

export function interpolate(samples: ReadonlyArray<readonly [number, number]>, y: number): number {
  if (samples.length === 0) return 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (y <= first[0]) return first[1];
  if (y >= last[0]) return last[1];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (y <= b[0]) {
      const span = b[0] - a[0];
      return span === 0 ? b[1] : a[1] + ((b[1] - a[1]) * (y - a[0])) / span;
    }
  }
  return last[1];
}

function* allElements(root: ParentNode): Generator<Element> {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    yield el;
    if (el.shadowRoot) yield* allElements(el.shadowRoot);
  }
}

/** Finds the element an effect describes — through the preview's shadow roots. */
export function findEffectTarget(root: ParentNode, effect: ScrollEffect): HTMLElement | null {
  let n = 0;
  for (const el of allElements(root)) {
    if (el.tagName.toLowerCase() === effect.tag && el.getAttribute('class') === effect.className) {
      if (n === effect.index) return el as HTMLElement;
      n++;
    }
  }
  return null;
}

/** Applies every effect for the current scroll offset. Returns how many elements were found and set. */
export function applyScrollEffects(root: ParentNode, effects: readonly ScrollEffect[], y: number): number {
  let applied = 0;
  for (const effect of effects) {
    const el = findEffectTarget(root, effect);
    if (!el) continue;
    el.style.transform = `translateY(${Math.round(interpolate(effect.samples, y) * 100) / 100}px)`;
    applied++;
  }
  return applied;
}

/** Starts the replay on scroll/resize; returns a stop function. A user who prefers reduced motion gets the original's starting position, still. */
export function startScrollEffects(effects: readonly ScrollEffect[], win: Window = window): () => void {
  if (effects.length === 0) return () => {};
  // `?scrollfx=live` (the Figma export) replays the effects at the real scroll position even under reduced motion; without it nothing changes
  const live = /[?&]scrollfx=live\b/.test(win.location?.search ?? '');
  const reduce = !live && (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  let frame = 0;
  const run = () => {
    frame = 0;
    applyScrollEffects(win.document, effects, reduce ? 0 : win.scrollY);
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(run);
  };
  run();
  // sections mount asynchronously: re-apply once they are in the DOM
  const retry = win.setTimeout(run, 300);
  if (!reduce) win.addEventListener('scroll', schedule, { passive: true });
  win.addEventListener('resize', schedule);
  return () => {
    win.clearTimeout(retry);
    win.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    if (frame) win.cancelAnimationFrame(frame);
  };
}
