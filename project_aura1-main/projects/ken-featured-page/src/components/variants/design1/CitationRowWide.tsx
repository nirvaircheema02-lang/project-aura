'use client';

import { motion } from 'framer-motion';
import type { Citation } from '@/lib/mock-citations';
import Thumb from '../../Thumb';

/**
 * Variant 1 listing row: small thumbnail left, citation content middle, related
 * report block on the right — citation-first hierarchy, related report kept
 * visually secondary (small, muted) rather than a big product-card block.
 * Always renders the design-system bordered white card treatment.
 * `whileInView` drives its own fade-in — self-contained, no page-level
 * IntersectionObserver pass required.
 */
export default function CitationRowWide({ c, index = 0 }: { c: Citation; index?: number }) {
  return (
    <motion.article
      className="crow-wide crow-wide--card"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: Math.min(index, 6) * 0.05 }}
    >
      <Thumb industry={c.industry} id={c.id} className="crow-wide-thumb" />
      <div className="crow-wide-body">
        <div className="ccard-top">
          <span className="ccard-pub">{c.publisher}</span>
          <span className="dot" />
          <span>{c.date}</span>
          <span className="dot" />
          <span className="ccard-ctype">{c.contentType}</span>
        </div>
        <h3 className="ccard-ttl">{c.title}</h3>
        <p className="ccard-exc">{c.excerpt}</p>
      </div>
      <div className="crow-wide-side">
        <div className="crow-side-block">
          <p className="crow-side-lbl">Featured Report</p>
          <a className="crow-side-rel" href={c.relatedHref}>
            {c.relatedReport}
          </a>
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
