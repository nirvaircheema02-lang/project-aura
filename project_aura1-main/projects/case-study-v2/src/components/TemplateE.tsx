'use client';

import { useEffect, useRef, useState } from 'react';
import SiteHeader from './SiteHeader';
import FinalCTA from './FinalCTA';
import InsightsResources from './InsightsResources';
import Testimonial from './Testimonial';

/* ── Content (verbatim from Figma · Template E) ─────────────────── */

const PILLS = [
  { label: 'VOC Survey', kind: 'bright' as const },
  { label: 'Agri-Input', kind: 'dim' as const },
  { label: '2024', kind: 'dim' as const },
];

const META = [
  { k: 'Study type', v: 'Primary research' },
  { k: 'Respondents', v: 'Principals & HoDs' },
  { k: 'Delivery', v: '8 weeks' },
  { k: 'Geography', v: '6 metro clusters' },
  { k: 'Segments', v: 'Private · Gov · CBSE · State' },
];

const OBJECTIVES = [
  {
    tag: 'Objective 1',
    title: 'Assess Farmer Perception and Loyalty',
    body: 'Evaluate farmer satisfaction, product experience, and loyalty toward the client’s seed products across key crops and regional markets.',
  },
  {
    tag: 'Objective 2',
    title: 'Identify Product and Service Experience Gaps',
    body: 'Capture unmet needs, usage challenges, and improvement opportunities at the ground level to support product and service enhancement.',
  },
  {
    tag: 'Objective 3',
    title: 'Evaluate Channel Partner Perception',
    body: 'Assess distributor and retailer perceptions of the client’s brand, service quality, support ecosystem, and engagement effectiveness.',
  },
];

const STEPS = [
  {
    n: '01',
    title: 'A. Farmer Voice-of-Customer Research',
    body: 'Conducted face-to-face interviews with 2,000 farmers across 10 states to capture product usage, satisfaction levels, brand perception, and loyalty drivers.',
  },
  {
    n: '02',
    title: 'B. Channel Partner CATI Assessment',
    body: 'Executed CATI interviews with 200 distributors and retailers to evaluate brand perception, service experience, loyalty, and engagement with the client.',
  },
  {
    n: '03',
    title: 'C. Customer and Channel Experience Mapping',
    body: 'Built an end-to-end view of farmer and channel partner experience to identify actionable improvements across product performance, service delivery, and partner engagement.',
  },
];

const IMPACT = [
  {
    num: '85%',
    label: 'Satisfaction Score',
    title: '85% Satisfaction Score Identified:',
    body: 'Assessed satisfaction across farmer and channel partner groups, revealing strong engagement and support from distributors and retailers.',
  },
  {
    num: '200',
    label: 'Channel Partners',
    title: '200 Channel Partners Assessed:',
    body: 'Conducted CATI-based assessment with 200 distributors and retailers, capturing brand perception, loyalty, and service experience.',
  },
  {
    num: '45%',
    label: 'Customer Behaviour',
    title: '45% Customer Behaviour Insight Captured:',
    body: 'Identified key insights on customer behaviour and channel dynamics, supporting sharper product, service, and engagement strategies.',
  },
];

/* Compact method summary shown on the right of the dark banner. Numbers reuse
   existing case-study metrics — no new stats. */
const METHOD_SUMMARY = [
  { num: '2,000', unit: 'Farmers', label: 'F2F Interviews' },
  { num: '200', unit: 'Channel Partners', label: 'CATI Assessment' },
  { num: '10', unit: 'States', label: 'Experience Mapping' },
];

export default function TemplateE() {
  const stepsRef = useRef<HTMLOListElement>(null);
  const railRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(0);

  /* Scroll-linked 01→03 progress (Framer "how we work" feel). The red rail
     fills CONTINUOUSLY as the section scrolls through the viewport; each step
     lights up smoothly the moment the fill reaches it. A rAF lerp trails the
     scroll target for a buttery, non-jumpy motion, and `active` only updates on
     an actual index change, so it never flickers. Respects reduced motion. */
  useEffect(() => {
    const root = stepsRef.current;
    const rail = railRef.current;
    const fill = fillRef.current;
    if (!root || !rail || !fill) return;
    const circles = Array.from(
      root.querySelectorAll<HTMLElement>('.te-step-circle')
    );
    if (!circles.length) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let railTop = 0;
    let railH = 1;
    let centers: number[] = [];
    const measure = () => {
      const rr = root.getBoundingClientRect();
      const ys = circles.map((c) => {
        const b = c.getBoundingClientRect();
        return b.top - rr.top + b.height / 2;
      });
      railTop = ys[0];
      railH = Math.max(1, ys[ys.length - 1] - ys[0]);
      centers = ys.map((y) => (y - railTop) / railH);
      rail.style.top = `${railTop}px`;
      rail.style.height = `${railH}px`;
      fill.style.top = `${railTop}px`;
    };

    let target = 0;
    let current = 0;
    let raf = 0;
    let running = false;
    const computeTarget = () => {
      const rr = root.getBoundingClientRect();
      const anchor = window.innerHeight * 0.52;
      return Math.max(0, Math.min(1, (anchor - rr.top) / rr.height));
    };
    const applyActive = (p: number) => {
      let idx = 0;
      centers.forEach((cf, i) => {
        if (p >= cf - 0.02) idx = i;
      });
      setActive((prev) => (prev === idx ? prev : idx));
    };
    const render = () => {
      current += (target - current) * 0.16;
      if (Math.abs(target - current) < 0.0015) current = target;
      fill.style.height = `${current * railH}px`;
      applyActive(current);
      if (current !== target) {
        raf = requestAnimationFrame(render);
      } else {
        running = false;
      }
    };
    const onScroll = () => {
      target = computeTarget();
      if (reduce) {
        current = target;
        fill.style.height = `${current * railH}px`;
        applyActive(current);
        return;
      }
      if (!running) {
        running = true;
        raf = requestAnimationFrame(render);
      }
    };
    const onResize = () => {
      measure();
      onScroll();
    };

    measure();
    onScroll();
    const settle = window.setTimeout(onResize, 300); // re-measure after fonts
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="te-root">
      <SiteHeader variant="d" />

      {/* ── HERO (image-led agri field · pills + meta row) ── */}
      <header className="te-hero" role="banner">
        <div className="te-hero-photo" aria-hidden />
        <div className="te-hero-veil" aria-hidden />
        <div className="te-hero-in">
          <div className="te-pills fu">
            {PILLS.map((p) => (
              <span key={p.label} className={`te-pill te-pill--${p.kind}`}>
                {p.label}
              </span>
            ))}
          </div>
          <h1 className="te-hero-h1 fu">
            Voice of Customer and Channel Partner Assessment for a Leading
            Agri-Input Company in India
          </h1>
          <p className="te-hero-sub fu">
            India’s first independent cross-school benchmarking study on teacher
            professional development preferences — across 6 metro clusters, 500
            institutions, and 1,400 respondents.
          </p>
          <dl className="te-meta fu">
            {META.map((m) => (
              <div className="te-meta-item" key={m.k}>
                <dt>{m.k}</dt>
                <dd>{m.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <div className="te-wrap">
        {/* ── Client Context (2-col) ─────────────────────── */}
        <section className="te-sec te-sec--warm">
          <div className="te-ctx">
            <div className="te-ctx-head fu">
              <p className="te-eyebrow-red">About the Client</p>
              <h2 className="te-h2">Confidential</h2>
            </div>
            <div className="te-ctx-body fu">
              <p>
                The client is a leading agri-input company with a strong presence
                across India’s seed market. To strengthen brand positioning,
                improve customer satisfaction, and enhance channel effectiveness,
                the client engaged Ken Research to conduct a large-scale Voice of
                Customer (VOC) study supported by a CATI-based channel partner
                assessment.
              </p>
              <p>
                The engagement covered farmers, distributors, and retailers
                across key agricultural states to understand product usage, brand
                perception, satisfaction levels, loyalty drivers, and service
                expectations.
              </p>
            </div>
          </div>
        </section>

        {/* ── Engagement Objectives ──────────────────────── */}
        <section className="te-sec">
          <p className="te-eyebrow-red fu">Engagement Value Pillars</p>
          <h2 className="te-h2 fu">Engagement Objectives</h2>
          <p className="te-intro fu">
            Strategy consulting objectives designed to provide actionable
            insights and sustainable competitive advantages
          </p>
          <div className="te-obj-grid">
            {OBJECTIVES.map((o) => (
              <article className="te-obj-card fu" key={o.tag}>
                <div className="te-obj-tag">{o.tag}</div>
                <h3 className="te-obj-ttl">{o.title}</h3>
                <p className="te-obj-body">{o.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── Consulting Approach (dark card + steps) ────── */}
        <section className="te-sec">
          <p className="te-eyebrow-red fu">Our Methodology</p>
          <h2 className="te-h2 fu">Consulting Approach &amp; Initiatives</h2>

          <div className="te-meth-card fu">
            <div className="te-meth-head">
              <span className="te-meth-kicker">Research-driven approach</span>
              <p className="te-meth-title">
                A systematic, research-driven approach designed to deliver
                actionable insights and sustainable outcomes
              </p>
            </div>
            <div className="te-meth-summary" aria-hidden>
              {METHOD_SUMMARY.map((m) => (
                <div className="te-meth-stat" key={m.num}>
                  <span className="te-meth-stat-tick" />
                  <div className="te-meth-stat-num">{m.num}</div>
                  <div className="te-meth-stat-unit">{m.unit}</div>
                  <div className="te-meth-stat-lbl">{m.label}</div>
                </div>
              ))}
            </div>
          </div>

          <ol className="te-steps" ref={stepsRef}>
            <span className="te-steps-rail" aria-hidden ref={railRef} />
            <span className="te-steps-fill" aria-hidden ref={fillRef} />
            {STEPS.map((s, i) => (
              <li
                className={`te-step ${i === active ? 'is-active' : ''}`}
                key={s.n}
              >
                <div className="te-step-circle" aria-hidden>
                  {s.n}
                </div>
                <div className="te-step-body">
                  <h3 className="te-step-ttl">{s.title}</h3>
                  <p className="te-step-desc">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Impact (horizontal metric rows) ────────────── */}
        <section className="te-sec te-sec--warm">
          <div className="te-warm-in">
            <p className="te-eyebrow-red fu">Impact</p>
            <h2 className="te-h2 fu">
              Market intelligence delivered for IPO-ready positioning
            </h2>
            <p className="te-intro fu">
              Ken Research delivered the findings through a structured
              presentation to Yash Highvoltage Insulators’ leadership team —
              covering market sizing, competitive benchmarking, supply chain
              risks, and a fully developed investor narrative aligned with SEBI
              disclosure requirements.
            </p>
            <div className="te-impact">
              {IMPACT.map((m) => (
                <article className="te-metric fu" key={m.label}>
                  <div className="te-metric-fig">
                    <div className="te-metric-num">{m.num}</div>
                    <div className="te-metric-label">{m.label}</div>
                  </div>
                  <div className="te-metric-text">
                    <h3 className="te-metric-ttl">{m.title}</h3>
                    <p className="te-metric-body">{m.body}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── Client Endorsement ─────────────────────────── */}
        <section className="te-sec">
          <Testimonial
            quote="“Ken Research helped us quantify our addressable opportunity, build a sharper product strategy, and clearly articulate our competitive strengths. Their analysis played a key role in our next-stage discussions with investors.”"
            cite="Director, Yash Highvoltage Insulators"
            rating={4.97}
          />
        </section>
      </div>

      <FinalCTA variant="prominent" tone="warm" />
      <InsightsResources />
    </div>
  );
}
