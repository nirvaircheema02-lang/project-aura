'use client';

import { useEffect, useRef } from 'react';
import SiteHeader from './SiteHeader';
import FinalCTA from './FinalCTA';
import InsightsResources from './InsightsResources';
import Testimonial from './Testimonial';
import CountUp from './CountUp';

/* ── Content (verbatim from Figma · Template A) ─────────────────── */

const HERO_STATS = [
  { num: '2,000', lbl: 'Farmers interviewed across 10 states' },
  { num: '200', lbl: 'Channel partners assessed' },
  { num: '85%', lbl: 'Satisfaction score identified' },
  { num: '10', lbl: 'States covered' },
];

const DETAILS = [
  { k: 'Client', v: 'Confidential' },
  { k: 'Industry', v: 'Agriculture & Animal Care' },
  { k: 'Geography', v: 'India' },
  { k: 'Methodology', v: 'Primary Research · C-SAT' },
];

const TOC = [
  { id: 'objectives', label: 'Objective' },
  { id: 'context', label: 'The challenge' },
  { id: 'approach', label: 'Our approach' },
  { id: 'impact', label: 'Key findings' },
  { id: 'impact', label: 'Detailed insights' },
  { id: 'impact', label: 'Impact' },
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
    step: 'Step 1',
    title: 'A. Farmer Voice-of-Customer Research',
    body: 'Conducted face-to-face interviews with 2,000 farmers across 10 states to capture product usage, satisfaction levels, brand perception, and loyalty drivers.',
  },
  {
    step: 'Step 2',
    title: 'B. Channel Partner CATI Assessment',
    body: 'Executed CATI interviews with 200 distributors and retailers to evaluate brand perception, service experience, loyalty, and engagement with the client.',
  },
  {
    step: 'Step 3',
    title: 'C. Customer and Channel Experience Mapping',
    body: 'Built an end-to-end view of farmer and channel partner experience to identify actionable improvements across product performance, service delivery, and partner engagement.',
  },
];

const IMPACT = [
  {
    num: '85%',
    kicker: 'Score',
    title: '85% Satisfaction Score Identified',
    body: 'Assessed satisfaction across farmer and channel partner groups, revealing strong engagement and support from distributors and retailers.',
  },
  {
    num: '200',
    kicker: 'Partners',
    title: '200 Channel Partners Assessed',
    body: 'Conducted CATI-based assessment with 200 distributors and retailers, capturing brand perception, loyalty, and service experience.',
  },
  {
    num: '45%',
    kicker: 'Customer Behaviour',
    title: '45% Customer Behaviour Insight Captured',
    body: 'Identified key insights on customer behaviour and channel dynamics, supporting sharper product, service, and engagement strategies.',
  },
];

export default function TemplateA() {
  const progressRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);

  /* Scrollspy (active TOC link) + reading-progress bar. */
  useEffect(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('.ta-toc-link')
    );
    const sections = TOC.map((t) => document.getElementById(t.id)).filter(
      (el): el is HTMLElement => !!el
    );

    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            let matched = false;
            links.forEach((l) => {
              const on = !matched && l.dataset.target === e.target.id;
              l.classList.toggle('on', on);
              if (on) matched = true;
            });
          }
        });
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
    );
    sections.forEach((s) => spy.observe(s));

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const art = articleRef.current;
        const bar = progressRef.current;
        if (!art || !bar) return;
        const top = art.offsetTop;
        const total = art.offsetHeight - window.innerHeight;
        const p = Math.min(1, Math.max(0, (window.scrollY - top) / total));
        bar.style.transform = `scaleX(${p})`;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => {
      spy.disconnect();
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const jump = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="ta-root">
      <div className="ta-progress" aria-hidden>
        <div className="ta-progress-fill" ref={progressRef} />
      </div>

      <SiteHeader />

      {/* ── HERO ─────────────────────────────────────────── */}
      <header className="ta-hero" role="banner">
        <div className="ta-hero-photo" aria-hidden />
        <div className="ta-hero-veil" aria-hidden />
        <div className="ta-hero-in">
          <p className="ta-eyebrow fu">
            Case Study #001
            <span className="ta-eyebrow-bar" />
          </p>
          <h1 className="ta-hero-h1 fu">
            Voice of Customer and Channel Partner Assessment for a Leading
            Agri-Input Company in India
          </h1>
          <p className="ta-hero-sub fu">
            A large-scale customer and channel assessment helped the client
            understand farmer satisfaction, distributor perception, and service
            improvement opportunities across key agricultural markets.
          </p>
          <div className="ta-hero-rule" />
          <dl className="ta-hero-stats fu">
            {HERO_STATS.map((s) => (
              <div className="ta-hero-stat" key={s.num}>
                <dt className="ta-hero-stat-num">
                  <CountUp value={s.num} />
                </dt>
                <dd className="ta-hero-stat-lbl">{s.lbl}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      {/* ── BODY (sticky sidebar + content) ──────────────── */}
      <div className="ta-body" ref={articleRef}>
        <div className="ta-body-in">
          <aside className="ta-side">
            <div className="ta-side-sticky">
              <div className="ta-details-card fu fu-l">
                <p className="ta-side-label">Details</p>
                <dl className="ta-details">
                  {DETAILS.map((d) => (
                    <div className="ta-detail" key={d.k}>
                      <dt>{d.k}</dt>
                      <dd>{d.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <hr className="ta-side-rule" />
              <nav className="ta-toc fu fu-l" aria-label="On this page" style={{ transitionDelay: '.1s' }}>
                <p className="ta-toc-label">Contents</p>
                <div className="ta-toc-list">
                  {TOC.map((t) => (
                    <a
                      key={t.label}
                      href={`#${t.id}`}
                      className="ta-toc-link"
                      data-target={t.id}
                      onClick={(e) => jump(e, t.id)}
                    >
                      {t.label}
                    </a>
                  ))}
                </div>
              </nav>
            </div>
          </aside>

          <main className="ta-main">
            {/* Client Context */}
            <section id="context" className="ta-sec">
              <p className="ta-sec-eyebrow fu">About the Client</p>
              <h2 className="ta-sec-h2 fu">Confidential</h2>
              <div className="ta-prose fu">
                <p>
                  The client is a leading agri-input company with a strong
                  presence across India’s seed market. To strengthen brand
                  positioning, improve customer satisfaction, and enhance channel
                  effectiveness, the client engaged Ken Research to conduct a
                  large-scale Voice of Customer (VOC) study supported by a
                  CATI-based channel partner assessment.
                </p>
                <p>
                  The engagement covered farmers, distributors, and retailers
                  across key agricultural states to understand product usage,
                  brand perception, satisfaction levels, loyalty drivers, and
                  service expectations.
                </p>
              </div>
            </section>

            {/* Engagement Objectives */}
            <section id="objectives" className="ta-sec">
              <p className="ta-sec-eyebrow fu">Engagement Value Pillars</p>
              <h2 className="ta-sec-h2 fu">Engagement Objectives</h2>
              <p className="ta-sec-intro fu">
                Strategy consulting objectives designed to provide actionable
                insights and sustainable competitive advantages
              </p>
              <div className="ta-obj-grid">
                {OBJECTIVES.map((o) => (
                  <article className="ta-obj-card fu" key={o.tag}>
                    <div className="ta-obj-tag">{o.tag}</div>
                    <h3 className="ta-obj-ttl">{o.title}</h3>
                    <p className="ta-obj-body">{o.body}</p>
                  </article>
                ))}
              </div>
            </section>

            {/* Consulting Approach */}
            <section id="approach" className="ta-sec">
              <p className="ta-sec-eyebrow fu">Our Methodology</p>
              <h2 className="ta-sec-h2 fu">Consulting Approach &amp; Initiatives</h2>
              <p className="ta-sec-intro fu">
                A systematic, research-driven approach designed to deliver
                actionable insights and sustainable outcomes
              </p>
              <ol className="ta-steps">
                {STEPS.map((s) => (
                  <li className="ta-step fu" key={s.step}>
                    <div className="ta-step-rail" aria-hidden>
                      <span className="ta-step-dot" />
                    </div>
                    <div className="ta-step-body">
                      <div className="ta-step-num">{s.step}</div>
                      <h3 className="ta-step-ttl">{s.title}</h3>
                      <p className="ta-step-desc">{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            {/* Impact Delivered */}
            <section id="impact" className="ta-sec">
              <p className="ta-sec-eyebrow fu">Measurable Business Outcomes</p>
              <h2 className="ta-sec-h2 fu">Impact Delivered</h2>
              <p className="ta-sec-intro fu">
                The synthesis workshop produced a single prioritised action
                agenda. All three workstream recommendations were adopted into
                the client’s FY25 commercial plan within two weeks of delivery.
              </p>
              <div className="ta-impact-grid">
                {IMPACT.map((m) => (
                  <article className="ta-impact-card fu" key={m.kicker}>
                    <div className="ta-impact-num">{m.num}</div>
                    <div className="ta-impact-kicker">{m.kicker}</div>
                    <h3 className="ta-impact-ttl">{m.title}</h3>
                    <p className="ta-impact-body">{m.body}</p>
                  </article>
                ))}
              </div>
            </section>

            {/* Client Endorsement */}
            <Testimonial
              quote="“Ken Research helped us quantify our addressable opportunity, build a sharper product strategy, and clearly articulate our competitive strengths. Their analysis played a key role in our next-stage discussions with investors.”"
              cite="Director, Yash Highvoltage Insulators"
              rating={4.97}
            />

            <FinalCTA variant="card" inline />
          </main>
        </div>
      </div>

      <InsightsResources />
    </div>
  );
}
