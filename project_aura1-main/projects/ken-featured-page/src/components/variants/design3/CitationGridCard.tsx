'use client';

import { motion } from 'framer-motion';
import type { Citation } from '@/lib/mock-citations';
import Thumb from '../../Thumb';

/**
 * Variant 2 grid card: magazine/editorial-article treatment — image on top,
 * publisher+date, title, excerpt, then a thin divider and a stacked
 * "Featured Report" label + title (secondary, not a boxed block), View Report
 * CTA. Self-contained `whileInView` fade-in.
 */
export default function CitationGridCard({ c, index = 0 }: { c: Citation; index?: number }) {
  return (
    <motion.article
      className="egrid-card"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: Math.min(index, 6) * 0.05 }}
    >
      <div className="egrid-thumb-wrap">
        <Thumb industry={c.industry} id={c.id} className="egrid-thumb" />
        <span className="egrid-badge">{c.contentType}</span>
      </div>
      <div className="egrid-body">
        <div className="ccard-top">
          <span className="ccard-pub">{c.publisher}</span>
          <span className="dot" />
          <span>{c.date}</span>
        </div>
        <h3 className="egrid-ttl">{c.title}</h3>
        <p className="egrid-exc">{c.excerpt}</p>
        <div className="egrid-source-wrap">
          <hr className="egrid-divider" />
          <div className="egrid-source">
            <p className="egrid-source-lbl">Featured Report</p>
            <a className="egrid-source-rel" href={c.relatedHref}>
              {c.relatedReport}
            </a>
          </div>
          <a className="ccard-cta" href={c.href}>
            View Report
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="7" y1="17" x2="17" y2="7" />
              <polyline points="7 7 17 7 17 17" />
            </svg>
          </a>
        </div>
      </div>
    </motion.article>
  );
}
