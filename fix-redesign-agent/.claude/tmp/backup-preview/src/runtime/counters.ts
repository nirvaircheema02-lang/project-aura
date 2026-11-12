/**
 * Stat counters. A large numeral that is only digits (optionally grouped with commas, with a trailing "+" or "%") counts up from 0
 * to its value the first time it scrolls into view — the usual behaviour of a stats strip. The final text is exactly the
 * original text, the box width is held so nothing around it shifts, and `prefers-reduced-motion` shows the final value at once.
 */
const STAT = /^(\d[\d,]*)(\+|%)?$/;
const DURATION_MS = 1600;

export function attachCounters(shadow: ShadowRoot): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  // DS contract: every animation shows its final state under prefers-reduced-motion. `?motion=full` on the preview URL overrides that for review only.
  const forced = typeof location !== 'undefined' && /[?&]motion=full\b/.test(location.search);
  const reduce = !forced && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const targets = Array.from(shadow.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,span,div')).filter((el) => {
    if (el.children.length > 0) return false;
    const t = (el.textContent ?? '').trim();
    return STAT.test(t) && parseFloat(getComputedStyle(el).fontSize) >= 30;
  });
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
    el.textContent = '0' + (STAT.exec(finals.get(el)!)?.[2] ?? '');
    io.observe(el);
  }
  return () => { io.disconnect(); for (const [el, f] of frames) { cancelAnimationFrame(f); el.textContent = finals.get(el) ?? el.textContent; } for (const [el, t] of finals) el.textContent = t; };
}
