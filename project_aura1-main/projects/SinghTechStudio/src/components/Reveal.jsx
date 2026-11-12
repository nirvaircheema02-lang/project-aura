import { useEffect, useRef, useState } from "react";

/* Scroll-reveal based on scroll/resize position checks (more robust across
   environments than IntersectionObserver, which can silently no-op).
   Variants: scale, clip, and `head` (staggered soft blur-rise for section
   headers — eyebrow → title → text arrive in sequence). */
/* Blocks that come into view on the same scroll tick are revealed as one wave, ordered top-to-bottom then
   left-to-right: a heading first, then the cards in reading order. Each wave starts from zero, so a card on the
   fifth row waits no longer than one on the first — the stagger used to follow the card's index in the whole grid. */
const wave = [];
let waveQueued = false;
const flushWave = () => {
  waveQueued = false;
  const items = wave.splice(0).filter((it) => it.alive.current);
  if (!items.length) return;
  const rects = new Map(items.map((it) => [it, it.el.getBoundingClientRect()]));
  items.sort((a, b) => {
    const ra = rects.get(a), rb = rects.get(b);
    return Math.abs(ra.top - rb.top) > 24 ? ra.top - rb.top : ra.left - rb.left;
  });
  const solo = items.length === 1;
  let n = 0;
  const lead = items.some((it) => it.head) ? 140 : 0;        // the heading lands before what it introduces
  for (const it of items) {
    if (it.head) { it.set(true); continue; }
    it.el.style.transitionDelay = solo ? `${it.delay}ms` : `${lead + Math.min(n, 7) * 75}ms`;
    n++;
    it.set(true);
  }
};

export default function Reveal({ children, className = "", delay = 0, scale = false, clip = false, head = false }) {
  const ref = useRef(null);
  const [vis, setVis] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    alive.current = true;            // a remount (StrictMode) must undo the unmount flag
    let done = false;

    const cleanup = () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
    const reveal = () => {
      if (done) return;
      done = true; cleanup();
      wave.push({ el, head, delay, alive, set: setVis });
      if (!waveQueued) { waveQueued = true; requestAnimationFrame(flushWave); }
    };
    function check() {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.9 && r.bottom > -50) reveal();
    }

    check(); // already-in-view on load
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    const t = setTimeout(check, 250); // safety re-check after layout settles

    return () => { alive.current = false; cleanup(); clearTimeout(t); };
  }, []);

  const base = head ? "reveal-head" : clip ? "reveal-clip" : scale ? "reveal-scale" : "reveal";

  return (
    <div
      ref={ref}
      className={`${base}${vis ? " show" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}
