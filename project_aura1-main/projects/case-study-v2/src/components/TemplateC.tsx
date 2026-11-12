'use client';

import SiteHeader from './SiteHeader';
import FinalCTA from './FinalCTA';
import InsightsResources from './InsightsResources';
import CountUp from './CountUp';

/* ── Content (verbatim from Figma · Template C) ─────────────────── */

const PILLS = [
  { label: 'VOC Survey', kind: 'bright' as const },
  { label: 'Agri-Input', kind: 'dim' as const },
  { label: '2024', kind: 'dim' as const },
];

const HERO_STATS = [
  { num: '2,000', lbl: 'Farmers interviewed across 10 states' },
  { num: '200', lbl: 'Channel partners assessed' },
  { num: '85%', lbl: 'Satisfaction score identified' },
  { num: '10', lbl: 'States covered' },
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
    kicker: 'Satisfaction Score',
    title: '85% Satisfaction Score Identified:',
    body: 'Assessed satisfaction across farmer and channel partner groups, revealing strong engagement and support from distributors and retailers.',
  },
  {
    num: '200',
    kicker: 'Channel Partners',
    title: '200 Channel Partners Assessed:',
    body: 'Conducted CATI-based assessment with 200 distributors and retailers, capturing brand perception, loyalty, and service experience.',
  },
  {
    num: '45%',
    kicker: 'Customer Behaviour',
    title: '45% Customer Behaviour Insight Captured:',
    body: 'Identified key insights on customer behaviour and channel dynamics, supporting sharper product, service, and engagement strategies.',
  },
];

export default function TemplateC() {
  return (
    <div className="tc-root">
      <SiteHeader />

      {/* ── HERO (photographic) ──────────────────────────── */}
      <header className="tc-hero" role="banner">
        <div className="tc-hero-photo" aria-hidden />
        <div className="tc-hero-veil" aria-hidden />
        <div className="tc-hero-in">
          <div className="tc-pills fu">
            {PILLS.map((p) => (
              <span key={p.label} className={`tc-pill tc-pill--${p.kind}`}>
                {p.label}
              </span>
            ))}
          </div>
          <h1 className="tc-hero-h1 fu">
            Voice of Customer and Channel Partner Assessment for a Leading
            Agri-Input Company in India
          </h1>
          <p className="tc-hero-sub fu">
            A large-scale customer and channel assessment helped the client
            understand farmer satisfaction, distributor perception, and service
            improvement opportunities across key agricultural markets.
          </p>
          <div className="tc-hero-rule" />
          <dl className="tc-hero-stats fu">
            {HERO_STATS.map((s) => (
              <div className="tc-hero-stat" key={s.num}>
                <dt className="tc-hero-stat-num">
                  <CountUp value={s.num} />
                </dt>
                <dd className="tc-hero-stat-lbl">{s.lbl}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <div className="tc-body">
        {/* ── Client Context ─────────────────────────────── */}
        <section className="tc-sec">
          <p className="tc-sec-eyebrow fu">About the Client</p>
          <h2 className="tc-h2 fu">Confidential</h2>
          <div className="tc-prose fu">
            <p>
              The client is a leading agri-input company with a strong presence
              across India’s seed market. To strengthen brand positioning,
              improve customer satisfaction, and enhance channel effectiveness,
              the client engaged Ken Research to conduct a large-scale Voice of
              Customer (VOC) study supported by a CATI-based channel partner
              assessment.
            </p>
            <p>
              The engagement covered farmers, distributors, and retailers across
              key agricultural states to understand product usage, brand
              perception, satisfaction levels, loyalty drivers, and service
              expectations.
            </p>
          </div>
          <blockquote className="tc-quote fu">
            <p>
              “Ken Research’s structured VOC and channel partner assessment gave
              us deep, actionable insights into farmer needs and channel
              expectations across markets. The findings helped us sharpen our
              product and engagement strategies.”
            </p>
            <cite>Business Head, Agri-Input Company</cite>
          </blockquote>
        </section>

        {/* ── Engagement Objectives ──────────────────────── */}
        <section className="tc-sec">
          <p className="tc-sec-eyebrow fu">Engagement Value Pillars</p>
          <h2 className="tc-h2 fu">Engagement Objectives</h2>
          <p className="tc-intro fu">
            Strategy consulting objectives designed to provide actionable
            insights and sustainable competitive advantages
          </p>
          <div className="tc-obj-grid">
            {OBJECTIVES.map((o) => (
              <article className="tc-obj-card fu" key={o.tag}>
                <div className="tc-obj-tag">{o.tag}</div>
                <h3 className="tc-obj-ttl">{o.title}</h3>
                <p className="tc-obj-body">{o.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── Consulting Approach (steps + image) ────────── */}
        <section className="tc-sec tc-sec--grey">
          <div className="tc-grey-in">
            <p className="tc-sec-eyebrow fu">Our Methodology</p>
            <h2 className="tc-h2 fu">Consulting Approach &amp; Initiatives</h2>
            <p className="tc-intro fu">
              A systematic, research-driven approach designed to deliver
              actionable insights and sustainable outcomes
            </p>
            <div className="tc-appr">
              <ol className="tc-steps">
                {STEPS.map((s) => (
                  <li className="tc-step fu" key={s.step}>
                    <div className="tc-step-rail" aria-hidden>
                      <span className="tc-step-dot" />
                    </div>
                    <div>
                      <div className="tc-step-num">{s.step}</div>
                      <h3 className="tc-step-ttl">{s.title}</h3>
                      <p className="tc-step-desc">{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <figure className="tc-figure fu">
                <div className="tc-figure-img" aria-hidden />
                <figcaption>Ken Research primary intelligence synthesis.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        {/* ── Impact Delivered ───────────────────────────── */}
        <section className="tc-sec">
          <p className="tc-sec-eyebrow fu">Measurable Business Outcomes</p>
          <h2 className="tc-h2 fu">Impact Delivered</h2>
          <p className="tc-intro fu">
            The synthesis workshop produced a single prioritised action agenda.
            All three workstream recommendations were adopted into the client’s
            FY25 commercial plan within two weeks of delivery.
          </p>
          <div className="tc-impact-grid">
            {IMPACT.map((m) => (
              <article className="tc-impact-card fu" key={m.kicker}>
                <div className="tc-impact-num">{m.num}</div>
                <div className="tc-impact-kicker">{m.kicker}</div>
                <h3 className="tc-impact-ttl">{m.title}</h3>
                <p className="tc-impact-body">{m.body}</p>
              </article>
            ))}
          </div>
        </section>
      </div>

      <FinalCTA variant="card" />
      <InsightsResources />
    </div>
  );
}
