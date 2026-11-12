/**
 * Stat counters. A large numeral that is only digits (optionally grouped with commas, with a trailing "+" or "%") counts up from 0
 * to its value the first time it scrolls into view — the usual behaviour of a stats strip. The final text is exactly the
 * original text, the box width is held so nothing around it shifts, and `prefers-reduced-motion` shows the final value at once.
 */
const STAT = /^(\d[\d,]*)(\+|%)?$/;
/** Any stat numeral, also a decimal or a multiplier ("1.5x", "4.8%"): it takes the stat ink (runtime/stats.ts) but does not count up. */
export const STAT_NUMERAL = /^\d[\d,]*(\.\d+)?(\+|%|x|X)?$/;
const DURATION_MS = 1600;

/** The stat numerals of a section: leaf elements whose text matches `pattern` (default: digits only, grouped with commas, optional trailing + or %) set at 30px or larger. Shared by the counters and runtime/stats.ts. */
export function findStatNumerals(shadow: ShadowRoot, pattern: RegExp = STAT): HTMLElement[] {
  return Array.from(shadow.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,span,div')).filter((el) => {
    if (el.children.length > 0) return false;
    const t = (el.textContent ?? '').trim();
    return pattern.test(t) && parseFloat(getComputedStyle(el).fontSize) >= 30;
  });
}

export function attachCounters(shadow: ShadowRoot): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  // DS contract: every animation shows its final state under prefers-reduced-motion. `?motion=full` on the preview URL overrides that for review only.
  const forced = typeof location !== 'undefined' && /[?&]motion=full\b/.test(location.search);
  const reduce = !forced && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const targets = findStatNumerals(shadow);
  if (targets.length === 0 || reduce) return () => {};
  const frames = new Map<HTMLElement, number>();
  const finals = new Map<HTMLElement, string>();
  const run = (el: HTMLElement) => {
    const original = finals.get(el) ?? '';
    const m = STAT.exec(original); if (!m) return;
    const end = Number(m[1]!.replace(/,/g, '')); const grouped = m[1]!.includes(','); const suffix = m[2] ?? '';
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION_MS); const v = Math.round(end * (1 - Math.pow(1 - p, 3)));
      el.textContent = (grouped ? v.toLocaleString('en-US') : String(v)) + suffix;
      if (p < 1) frames.set(el, requestAnimationFrame(tick)); else { el.textContent = original; frames.delete(el); }
    };
    frames.set(el, requestAnimationFrame(tick));
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); run(e.target as HTMLElement); }
  }, { threshold: 0.4 });
  for (const el of targets) {
    finals.set(el, (el.textContent ?? '').trim());
    const w = el.getBoundingClientRect().width; if (w > 0) el.style.minWidth = `${Math.ceil(w)}px`;
    // The text stays the original until the numeral scrolls into view; the first animation frame writes the 0. Writing "0+" up front made every
    // not-yet-visible stat read as the wrong number (to a reader without scrolling, a content check, copy/paste), so content verification failed.
    io.observe(el);
  }
  return () => { io.disconnect(); for (const [el, f] of frames) { cancelAnimationFrame(f); el.textContent = finals.get(el) ?? el.textContent; } for (const [el, t] of finals) el.textContent = t; };
}
