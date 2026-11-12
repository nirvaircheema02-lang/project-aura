'use client';

import { useEffect, useRef, useState } from 'react';

type Props = {
  /** Final display value, e.g. "2,000", "85%", "200", "10". */
  value: string;
  /** Animation length in ms. */
  duration?: number;
};

/**
 * Counts up from 0 to the numeric part of `value` when it scrolls into view.
 * Preserves any prefix, thousands grouping, and suffix (e.g. "%") from the
 * original string. Honours prefers-reduced-motion (renders the final value).
 */
export default function CountUp({ value, duration = 1600 }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const m = value.match(/^(\D*)([\d,]+)(.*)$/);
  const prefix = m?.[1] ?? '';
  const digits = m?.[2] ?? value;
  const suffix = m?.[3] ?? '';
  const target = parseInt(digits.replace(/,/g, ''), 10) || 0;
  const grouped = digits.includes(',');

  const fmt = (n: number) =>
    `${prefix}${grouped ? n.toLocaleString('en-US') : String(n)}${suffix}`;

  const [display, setDisplay] = useState(() => fmt(0));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(fmt(target));
      return;
    }

    let raf = 0;
    let started = false;
    const run = (start: number) => {
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        setDisplay(fmt(Math.round(eased * target)));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting && !started) {
            started = true;
            run(performance.now());
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.2 }
    );
    io.observe(el);

    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);

  return (
    <span ref={ref} className="tabular-nums">
      {display}
    </span>
  );
}
