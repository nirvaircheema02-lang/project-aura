'use client';

import { useRef } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';

/**
 * Bottom conversion CTA — a normal in-flow section near the end of the page
 * (not sticky/fixed, so it never blocks content). Fades/slides up once as it
 * enters the viewport; reduced-motion shows it statically. Stacks on mobile.
 */
export default function BottomCTA() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { amount: 0.3, once: true });
  const show = reduce ? true : inView;

  return (
    <section className="fcta">
      <motion.div
        ref={ref}
        className="fcta-in"
        initial={false}
        animate={{ opacity: show ? 1 : 0, y: show ? 0 : 24 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="fcta-wrap">
          <div className="fcta-l">
            <div className="fcta-text">
              <h2 className="fcta-h2">Need market data journalists trust?</h2>
              <p className="fcta-sub">
                Talk to our analysts or request a sample report tailored to your story.
              </p>
            </div>
          </div>
          <div className="fcta-btns">
            <a className="btn-primary" href="#">
              Talk to an Analyst
            </a>
            <a className="btn-outline" href="#">
              Explore Report Store
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="17" x2="17" y2="7" />
                <polyline points="7 7 17 7 17 17" />
              </svg>
            </a>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
