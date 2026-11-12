'use client';

import SiteHeader from './SiteHeader';
import FinalCTA from './FinalCTA';
import InsightsResources from './InsightsResources';

/* ── Content (verbatim from Figma · Template D) ─────────────────── */

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
    kicker: 'Satisfaction Score',
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
  {
    kicker: 'Partners',
    title: '200 Channel Partners Assessed:',
    body: 'Conducted CATI-based assessment with 200 distributors and retailers, capturing brand perception, loyalty, and service experience.',
  },
];

/* Two-column section shell: 200px sticky red label + body. */
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
    <section className={`td-sec ${tone === 'grey' ? 'td-sec--grey' : ''}`}>
      <div className="td-grid">
        <p className="td-label fu">{label}</p>
        <div className="td-body">{children}</div>
      </div>
    </section>
  );
}

export default function TemplateD() {
  return (
    <div className="td-root">
      <SiteHeader />

      {/* ── HERO ─────────────────────────────────────────── */}
      <header className="td-hero" role="banner">
        <div className="td-hero-in">
          <div className="td-pills fu">
            {PILLS.map((p) => (
              <span key={p.label} className={`td-pill td-pill--${p.kind}`}>
                {p.label}
              </span>
            ))}
          </div>
          <h1 className="td-hero-h1 fu">
            Voice of Customer and Channel Partner Assessment for a Leading
            Agri-Input Company in India
          </h1>
          <p className="td-hero-sub fu">
            India’s first independent cross-school benchmarking study on teacher
            professional development preferences — across 6 metro clusters, 500
            institutions, and 1,400 respondents.
          </p>
          <dl className="td-meta fu">
            {META.map((m) => (
              <div className="td-meta-item" key={m.k}>
                <dt>{m.k}</dt>
                <dd>{m.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      {/* ── About the Client ─────────────────────────────── */}
      <Section label="About the Client">
        <h2 className="td-h2 fu">Confidential</h2>
        <div className="td-prose fu">
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
        <blockquote className="td-quote fu">
          <p>
            “Ken Research’s structured VOC and channel partner assessment gave us
            deep, actionable insights into farmer needs and channel expectations
            across markets. The findings helped us sharpen our product and
            engagement strategies.”
          </p>
          <cite>Business Head, Agri-Input Company</cite>
        </blockquote>
      </Section>

      {/* ── Engagement Objectives ────────────────────────── */}
      <Section label="Engagement Value Pillars">
        <h2 className="td-h2 fu">Engagement Objectives</h2>
        <p className="td-intro fu">
          Strategy consulting objectives designed to provide actionable insights
          and sustainable competitive advantages
        </p>
        <div className="td-obj-grid">
          {OBJECTIVES.map((o) => (
            <article className="td-obj-card fu" key={o.tag}>
              <div className="td-obj-tag">{o.tag}</div>
              <h3 className="td-obj-ttl">{o.title}</h3>
              <p className="td-obj-body">{o.body}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* ── Consulting Approach ──────────────────────────── */}
      <Section label="Our Methodology" tone="grey">
        <h2 className="td-h2 fu">Consulting Approach &amp; Initiatives</h2>
        <p className="td-intro fu">
          A systematic, research-driven approach designed to deliver actionable
          insights and sustainable outcomes
        </p>
        <ol className="td-steps">
          {STEPS.map((s) => (
            <li className="td-step fu" key={s.step}>
              <div className="td-step-rail" aria-hidden>
                <span className="td-step-dot" />
              </div>
              <div>
                <div className="td-step-num">{s.step}</div>
                <h3 className="td-step-ttl">{s.title}</h3>
                <p className="td-step-desc">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* ── Impact Delivered (2×2 grid) ──────────────────── */}
      <Section label="Measurable Business Outcomes" tone="grey">
        <h2 className="td-h2 fu">Impact Delivered</h2>
        <p className="td-intro fu">
          The synthesis workshop produced a single prioritised action agenda. All
          three workstream recommendations were adopted into the client’s FY25
          commercial plan within two weeks of delivery.
        </p>
        <div className="td-impact-grid">
          {IMPACT.map((m, i) => (
            <article className="td-impact-card fu" key={i}>
              <div className="td-impact-kicker">{m.kicker}</div>
              <h3 className="td-impact-ttl">{m.title}</h3>
              <p className="td-impact-body">{m.body}</p>
            </article>
          ))}
        </div>
      </Section>

      <FinalCTA variant="card" eyebrow band />
      <InsightsResources />
    </div>
  );
}
