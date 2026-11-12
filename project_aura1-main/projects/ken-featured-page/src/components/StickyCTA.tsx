'use client';

import { useEffect, useState, type RefObject } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const DISMISS_KEY = 'kfp-sticky-cta-dismissed';

/**
 * Global sticky conversion bar (all 3 variants). Rules:
 * - Hidden on load; appears once the user scrolls past the hero (~90% of one
 *   viewport height) or past 30% of the page, whichever comes first.
 * - Stays visible while browsing listings — no per-scroll-tick toggling.
 * - Handoff: the IntersectionObserver's `rootMargin` extends 120px past the
 *   real viewport bottom, so "near-final-CTA" flips true slightly BEFORE the
 *   banner is actually visible — the fade/slide-down finishes right around
 *   when the banner arrives, so it reads as handing off into it rather than
 *   vanishing then having the banner separately appear. Reverses smoothly if
 *   the reader scrolls back up away from the banner.
 * - Closable; once closed it stays dismissed for the rest of the browser
 *   session (sessionStorage), not just this render.
 */
export default function StickyCTA({ finalCtaRef }: { finalCtaRef: RefObject<HTMLElement | null> }) {
  const [dismissed, setDismissed] = useState(true); // default hidden until session check runs, avoids a flash
  const [pastThreshold, setPastThreshold] = useState(false);
  const [nearFinalCta, setNearFinalCta] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  useEffect(() => {
    let ticking = false;
    const update = () => {
      const y = window.scrollY;
      const docH = document.documentElement.scrollHeight - window.innerHeight;
      const pct = docH > 0 ? y / docH : 0;
      setPastThreshold(pct > 0.3 || y > window.innerHeight * 0.9);
      ticking = false;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = finalCtaRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => setNearFinalCta(entry.isIntersecting), {
      rootMargin: '0px 0px 120px 0px',
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [finalCtaRef]);

  const show = !dismissed && pastThreshold && !nearFinalCta;

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* sessionStorage unavailable — dismissal just won't persist */
    }
  };

  return (
    <div className="sticky-cta" aria-hidden={!show}>
      <motion.div
        className="sticky-cta-in"
        initial={false}
        animate={{ opacity: show ? 1 : 0, y: show ? 0 : 48 }}
        transition={reduce ? { duration: 0 } : { duration: 0.35, ease: 'easeOut' }}
        style={{
          pointerEvents: show ? 'auto' : 'none',
          // Set inline (not via the stylesheet) — Lightning CSS's autoprefixer
          // was silently dropping the unprefixed `backdropFilter` declaration
          // from the compiled CSS, leaving only `-webkit-` which Chrome/
          // Firefox don't honor, so the blur never actually rendered.
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
        }}
      >
        <div className="sticky-cta-wrap">
          <p className="sticky-cta-txt">Need market data journalists trust?</p>
          <div className="sticky-cta-btns">
            <a className="btn-primary sm" href="#">
              Talk to an Analyst
            </a>
            <a className="btn-outline sm sticky-cta-secondary" href="#">
              Request Sample Report
            </a>
          </div>
          <button className="sticky-cta-close" aria-label="Dismiss for this session" onClick={dismiss}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </motion.div>
    </div>
  );
}
