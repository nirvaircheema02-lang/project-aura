'use client';

import SiteHeader from './SiteHeader';
import FinalCTA from './FinalCTA';
import InsightsResources from './InsightsResources';
import CountUp from './CountUp';

/* ── Content (verbatim from Figma · Template B) ─────────────────── */

const PILLS = [
  { label: 'VOC Survey', kind: 'bright' as const },
  { label: 'Agri-Input', kind: 'bright' as const },
  { label: 'India · 18 States', kind: 'dim' as const },
  { label: '2024', kind: 'dim' as const },
];

const HERO_STATS = [
  {
    num: '1,200+',
    title: 'Respondents surveyed',
    desc: 'Distributors, dealers & retailers across all tiers',
  },
  {
    num: '18',
    title: 'States covered',
    desc: 'From Punjab to Tamil Nadu — all key agri-belts',
  },
  {
    num: '92%',
    title: 'Distributor NPS baseline',
    desc: 'First-ever benchmarked score for the category',
  },
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
    kicker: 'Score',
    title: '85% Satisfaction Score Identified:',
    body: 'Assessed satisfaction across farmer and channel partner groups, revealing strong engagement and support from distributors and retailers.',
  },
  {
    kicker: 'Channel Partners',
    title: '200 Channel Partners Assessed:',
    body: 'Conducted CATI-based assessment with 200 distributors and retailers, capturing brand perception, loyalty, and service experience.',
  },
  {
    kicker: 'Customer Behaviour',
    title: '45% Customer Behaviour Insight Captured:',
    body: 'Identified key insights on customer behaviour and channel dynamics, supporting sharper product, service, and engagement strategies.',
  },
];

/* Two-column section shell: 200px red eyebrow label + body. */
function Section({
  label,
  tone = 'white',
  children,
}: {
  label: string;
  tone?: 'white' | 'grey';
  children: React.ReactNode;
}) {
  return (
    <section className={`tb-sec ${tone === 'grey' ? 'tb-sec--grey' : ''}`}>
      <div className="tb-grid">
        <p className="tb-label fu">{label}</p>
        <div className="tb-body">{children}</div>
      </div>
    </section>
  );
}

export default function TemplateB() {
  return (
    <div className="tb-root">
      <SiteHeader />

      {/* ── HERO ─────────────────────────────────────────── */}
      <header className="tb-hero" role="banner">
        <div className="tb-hero-in">
          <div className="tb-pills fu">
            {PILLS.map((p) => (
              <span key={p.label} className={`tb-pill tb-pill--${p.kind}`}>
                {p.label}
              </span>
            ))}
          </div>
          <h1 className="tb-hero-h1 fu">
            Voice of Customer and Channel Partner Assessment for a Leading
            Agri-Input Company in India
          </h1>
          <p className="tb-hero-sub fu">
            How Ken Research mapped distributor sentiment, NPS scores, and
            product positioning gaps across 1,200+ channel partners — delivering
            redistricting and packaging recommendations that moved directly into
            the client’s commercial roadmap.
          </p>
          <dl className="tb-hero-stats fu">
            {HERO_STATS.map((s) => (
              <div className="tb-hero-stat" key={s.num}>
                <dt className="tb-hero-stat-num">
                  <CountUp value={s.num} />
                </dt>
                <dd>
                  <div className="tb-hero-stat-title">{s.title}</div>
                  <div className="tb-hero-stat-desc">{s.desc}</div>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      {/* ── About the Client ─────────────────────────────── */}
      <Section label="About the Client">
        <h2 className="tb-h2 fu">Confidential</h2>
        <div className="tb-prose fu">
          <p>
            The client is a leading agri-input company with a strong presence
            across India’s seed market. To strengthen brand positioning, improve
            customer satisfaction, and enhance channel effectiveness, the client
            engaged Ken Research to conduct a large-scale Voice of Customer (VOC)
            study supported by a CATI-based channel partner assessment.
          </p>
          <p>
            The engagement covered farmers, distributors, and retailers across
            key agricultural states to understand product usage, brand
            perception, satisfaction levels, loyalty drivers, and service
            expectations.
          </p>
        </div>
      </Section>

      {/* ── Engagement Objectives ────────────────────────── */}
      <Section label="Engagement Value Pillars">
        <h2 className="tb-h2 fu">Engagement Objectives</h2>
        <p className="tb-intro fu">
          Strategy consulting objectives designed to provide actionable insights
          and sustainable competitive advantages
        </p>
        <div className="tb-obj-grid">
          {OBJECTIVES.map((o) => (
            <article className="tb-obj-card fu" key={o.tag}>
              <div className="tb-obj-tag">{o.tag}</div>
              <h3 className="tb-obj-ttl">{o.title}</h3>
              <p className="tb-obj-body">{o.body}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* ── Consulting Approach ──────────────────────────── */}
      <Section label="Our Methodology" tone="grey">
        <h2 className="tb-h2 fu">Consulting Approach &amp; Initiatives</h2>
        <p className="tb-intro fu">
          A systematic, research-driven approach designed to deliver actionable
          insights and sustainable outcomes
        </p>
        <ol className="tb-steps">
          {STEPS.map((s) => (
            <li className="tb-step fu" key={s.step}>
              <div className="tb-step-rail" aria-hidden>
                <span className="tb-step-dot" />
              </div>
              <div>
                <div className="tb-step-num">{s.step}</div>
                <h3 className="tb-step-ttl">{s.title}</h3>
                <p className="tb-step-desc">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* ── Impact Delivered ─────────────────────────────── */}
      <Section label="Measurable Business Outcomes">
        <h2 className="tb-h2 fu">Impact Delivered</h2>
        <p className="tb-intro fu">
          The synthesis workshop produced a single prioritised action agenda. All
          three workstream recommendations were adopted into the client’s FY25
          commercial plan within two weeks of delivery.
        </p>
        <div className="tb-impact">
          {IMPACT.map((m) => (
            <div className="tb-impact-card fu" key={m.kicker}>
              <div className="tb-impact-kicker">{m.kicker}</div>
              <h3 className="tb-impact-ttl">{m.title}</h3>
              <p className="tb-impact-body">{m.body}</p>
            </div>
          ))}
        </div>

        {/* ── Client Endorsement (pull-quote) ─────────────── */}
        <blockquote className="tb-quote fu">
          <p>
            “Ken Research’s structured VOC and channel partner assessment gave us
            deep, actionable insights into farmer needs and channel expectations
            across markets. The findings helped us sharpen our product and
            engagement strategies.”
          </p>
          <cite>Business Head, Agri-Input Company</cite>
        </blockquote>
      </Section>

      <FinalCTA variant="prominent" tone="grey" />
      <InsightsResources />
    </div>
  );
}
