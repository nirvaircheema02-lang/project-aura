'use client';

import { motion } from 'framer-motion';

/**
 * Design 2 hero: clean, single-column, no citation cards, no illustration —
 * just breadcrumb + headline + subtitle on a dark editorial background. Feels
 * like a newsroom/media-archive masthead, not a report-store hero.
 * Self-contained mount animation (see HeroCitationWall for why).
 */
export default function HeroCarouselClean() {
  return (
    <section className="hero hero--clean">
      <div className="hero-in">
        <motion.div
          className="hero-clean-col"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          <nav className="crumb" aria-label="Breadcrumb">
            <a href="#">Home</a>
            <span className="sep">›</span>
            <span className="cur">Media Citations</span>
          </nav>
          <h1 className="hero-h1">Where leading newsrooms cite Ken Research</h1>
          <p className="hero-sub">
            Explore how leading publications and business media use Ken Research data,
            forecasts, and market intelligence to shape credible market stories.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
