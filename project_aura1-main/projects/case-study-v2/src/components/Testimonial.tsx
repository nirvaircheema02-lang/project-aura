'use client';

import { useEffect, useRef } from 'react';

type Props = {
  eyebrow?: string;
  quote: string;
  cite: string;
  rating?: number; // out of 5
  id?: string;
};

/**
 * Client Endorsement / testimonial card (Figma "Case Study 2026 N").
 * White card, radius 12, hairline border. Eyebrow + short rule sit inside the
 * card; the serif quote (25px) is followed by a footer row: bold cite on the
 * left, five black stars + "x.xx / 5" on the right.
 *
 * Scroll-reveal mirrors the live Ken Research case-study page: the card fades
 * in scaling 0.95→1 and rising, then the quote and footer stagger in.
 */
export default function Testimonial({
  eyebrow = 'Client Endorsement',
  quote,
  cite,
  rating = 5,
  id = 'endorsement',
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            el.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.15 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const full = Math.round(rating);

  return (
    <section id={id} className="tm-sec ta-sec">
      <div className="tm-card" ref={cardRef}>
        <p className="tm-eyebrow">{eyebrow}</p>
        <span className="tm-rule" aria-hidden />
        <blockquote className="tm-quote">{quote}</blockquote>
        <div className="tm-foot">
          <div className="tm-cite">{cite}</div>
          <div className="tm-meta">
            <div className="tm-stars" aria-hidden>
              {'★★★★★'.split('').map((s, i) => (
                <span key={i} className={i < full ? 'on' : ''}>
                  ★
                </span>
              ))}
            </div>
            <div className="tm-rating">
              <strong>{rating.toFixed(2)}</strong>
              <span> / 5</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
