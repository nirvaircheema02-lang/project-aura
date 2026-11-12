'use client';

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

// Curated subset of real client/partner logos. Samsung, BMW, Volkswagen,
// Shell, and Bosch were dropped: their marks are circular/badge designs whose
// detail comes from adjacent opaque colors (e.g. white letters cut into a
// solid blue ellipse), not real transparency — so the white-silhouette
// filter below collapses them into a solid blob. Only kept the ones whose
// detail survives that filter: flat wordmarks or letterforms defined by true
// alpha transparency.
const LOGOS = [
  { name: 'AWS', file: 'aws.webp' },
  { name: 'Google', file: 'google.webp' },
  { name: 'Microsoft', file: 'microsoft.webp' },
  { name: 'DHL', file: 'dhl.webp' },
  { name: 'Maersk', file: 'maersk.webp' },
  { name: 'BASF', file: 'basf.webp' },
  { name: 'Deloitte', file: 'deloitte.webp' },
  { name: 'KPMG', file: 'kpmg.webp' },
];

/**
 * "Trusted by" logo carousel — real client/partner logo assets (not invented
 * marks). Each source file is the brand's full-color transparent logo; a
 * `brightness(0) invert(1)` filter renders every one as a clean white
 * silhouette regardless of its original colors, so the whole row reads as one
 * consistent, grayscale-on-dark set (no per-brand color clashing). Muted
 * opacity by default, brightens on hover/focus only — no red, no underline.
 * Continuously auto-scrolls (slow, seamless loop via a duplicated list),
 * pauses on hover/touch, and is natively swipeable on mobile since the track
 * is a real scroll container — no manual arrows.
 */
export default function PublicationsCarousel() {
  const trackRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const el = trackRef.current;
    if (!el) return;
    let raf: number;
    const step = () => {
      if (!paused) {
        el.scrollLeft += 0.45;
        const half = el.scrollWidth / 2;
        if (el.scrollLeft >= half) el.scrollLeft -= half;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [paused, reduce]);

  return (
    <div className="pubcar">
      <div className="pubcar-in">
        <span className="pubcar-lbl">Trusted by</span>
        <div
          className="pubcar-track"
          ref={trackRef}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onTouchStart={() => setPaused(true)}
          onTouchEnd={() => setPaused(false)}
        >
          <div className="pubcar-marquee">
            {[...LOGOS, ...LOGOS].map((logo, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${logo.name}-${i}`}
                className="pubcar-logo"
                src={`/logos/${logo.file}`}
                alt={logo.name}
                tabIndex={0}
                loading="lazy"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
