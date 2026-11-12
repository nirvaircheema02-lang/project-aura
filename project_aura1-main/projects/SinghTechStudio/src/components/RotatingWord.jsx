import { useEffect, useState } from "react";

/* One accent word at a time, cycling on a timer.

   Every word stays in the DOM, stacked into a single grid cell, so the box is
   always as wide and tall as the longest one and the headline cannot reflow
   mid-rotation. Only the active word is exposed to assistive tech, so the h1
   still reads as one sentence.

   prefers-reduced-motion stops the rotation here rather than in CSS: the global
   kill-switch removes the transition but not the timer, which would leave the
   words hard-cutting between each other — worse than not rotating at all. */
export default function RotatingWord({ words, hold = 2800, className = "" }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % words.length), hold);
    return () => clearInterval(id);
  }, [words.length, hold]);

  /* In a plain cycle the outgoing word is always the one before the active
     one, so it needs no state of its own. */
  const out = (idx - 1 + words.length) % words.length;

  return (
    <span className={`rot ${className}`.trim()}>
      {words.map((w, i) => (
        <span
          key={w}
          aria-hidden={i !== idx}
          className={`rot-w${i === idx ? " on" : i === out ? " out" : ""}`}
        >
          {w}
        </span>
      ))}
    </span>
  );
}
