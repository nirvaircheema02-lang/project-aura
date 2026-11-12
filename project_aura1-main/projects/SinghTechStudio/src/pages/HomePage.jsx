import Icon from "../components/Icon.jsx";
import SplitWords from "../components/SplitWords.jsx";
import Reveal from "../components/Reveal.jsx";
import FadeImg from "../components/FadeImg.jsx";
import CTASection from "../components/CTASection.jsx";
import Testimonials from "../components/Testimonials.jsx";
import ProjectCard from "../components/ProjectCard.jsx";
import HeroLaptop from "../sections/HeroLaptop.jsx";
import ProcessTimeline from "../sections/ProcessTimeline.jsx";
import FreeAudit from "../sections/FreeAudit.jsx";
import { PROJECTS } from "../data/portfolio.js";

/* Four high-level groups. The homepage answers "what do they do"; the six
   detailed services live on /services, so the two pages do not repeat each
   other. Keyword coverage is deliberate: website design, web development,
   UI/UX, branding, digital marketing, SEO, AEO, analytics and AI automation
   all still appear here. */
const SERVICE_GROUPS = [
  { key: "web", title: "Web & Digital Experiences",
    desc: "Sites and interfaces built around how people read and decide.",
    items: ["Website Design", "Web Development", "UI/UX Design", "Landing Pages", "E-commerce"] },
  { key: "brand", title: "Brand & Creative",
    desc: "One look and voice, applied everywhere your business shows up.",
    items: ["Branding", "Visual Identity", "Graphic Design", "Creative Direction", "Marketing Creatives"] },
  { key: "growth", title: "Digital Marketing & Growth",
    desc: "Getting found, and turning that attention into real enquiries.",
    items: ["SEO & AEO", "Analytics", "Performance Marketing", "Content & Social", "CRO / Lead Generation"] },
  { key: "ai", title: "AI & Automation",
    desc: "The repetitive follow-up handled, so enquiries never go cold.",
    items: ["AI Automation", "Lead Systems", "Workflow Automation", "Integrations", "Business Automation"] },
];


/* ⚑ Industry photography goes in /public/industries/<key>.webp — contextual to
   the sector, never a project screenshot: this section says "these are the
   businesses we help", not "this is our portfolio". A card whose image is
   missing falls back to a neutral tone and still reads, so the art can be
   swapped in later without touching the component. */
const INDUSTRIES = [
  { key: "real-estate", cat: "Property", label: "Real Estate",
    line: "Websites that present properties clearly and turn interest into qualified enquiries." },
  { key: "ecommerce", cat: "Retail", label: "E-commerce & Retail",
    line: "Product-focused experiences built around discovery, trust and conversion." },
  { key: "hospitality", cat: "Hospitality", label: "Restaurants & Hospitality",
    line: "Menus, bookings and locations made easier to find and easier to act on." },
  { key: "professional", cat: "Services", label: "Professional Services",
    line: "Clear, credible websites for businesses where expertise and enquiries matter." },
  { key: "healthcare", cat: "Healthcare", label: "Healthcare",
    line: "Clinic sites that make services, timings and appointments simple to follow." },
  { key: "wellness", cat: "Wellness", label: "Beauty & Wellness",
    line: "Salons and studios where the look of the brand is part of the service." },
  { key: "construction", cat: "Construction", label: "Construction & Interiors",
    line: "Project-led sites that let finished work speak before the first call." },
  { key: "technology", cat: "Technology", label: "Technology & Startups",
    line: "Products that need explaining clearly, and quickly." },
];


const PROCESS = [
  { n: "01", icon: "comp", title: "Discover",        desc: "We understand your business, audience, current website, competitors, goals, and inquiry flow." },
  { n: "02", icon: "lst",  title: "Structure",       desc: "We plan pages, content hierarchy, service flow, CTAs, sitemap, and user journey before design starts." },
  { n: "03", icon: "pen",  title: "Design",          desc: "We create clean, mobile-first UI screens, visual direction, design system, and key page layouts." },
  { n: "04", icon: "hmr",  title: "Build",           desc: "We develop the website, forms, WhatsApp CTAs, SEO-ready structure, analytics, and integrations." },
  { n: "05", icon: "rkt",  title: "Launch & Improve",desc: "We test responsiveness, fix issues, launch the site, and suggest improvements based on real usage." },
];


export default function HomePage({ onNav }) {
  return (
    <>
      {/* ── HERO (laptop → Services on desktop; HeroFrames everywhere else) ── */}
      <HeroLaptop onNav={onNav} />

      {/* ── SERVICES ── */}
      <section className="sec sec-surf">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Services</span>
            <h2 className="sec-title split-h"><SplitWords text="Services that help your business grow online" /></h2>
            <p className="sec-p">Websites, UI/UX, branding, SEO, analytics and automation — grouped so you can find what you need.</p>
          </Reveal>

          <div className="hsv-grid">
            {SERVICE_GROUPS.map((g, i) => (
              <Reveal key={g.key} delay={i * 70}>
                <article className="hsv-card" onClick={() => onNav("services")}>
                  <h3 className="hsv-t">{g.title}</h3>
                  <p className="hsv-d">{g.desc}</p>
                  <ul className="hsv-list">
                    {g.items.map(it => <li key={it} className="hsv-li">{it}</li>)}
                  </ul>
                  <span className="hsv-cta">Explore Services <Icon name="arr" size={14} /></span>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── WHO WE HELP ── */}
      <section className="sec">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Who we help</span>
            <h2 className="sec-title split-h"><SplitWords text="Built for businesses that need a stronger digital presence." /></h2>
            <p className="sec-p">We work with businesses that need a better website, a clearer digital experience, and a steadier way to bring in enquiries.</p>
          </Reveal>

          <div className="ind-grid">
            {INDUSTRIES.map((n, i) => (
              <Reveal key={n.key} className="ind-cell" delay={i * 90}>
                <div className="ind-card" onClick={() => onNav("services")}>
                  <FadeImg
                    className="ind-img"
                    src={`/industries/${n.key}.webp`}
                    alt={`${n.label} — a sector Singhtech builds for`}
                    loading="lazy"
                    decoding="async"
                    onError={(e) => { e.currentTarget.style.display = "none"; }}
                  />
                  <span className="ind-veil" />
                  <div className="ind-body">
                    <span className="ind-cat">{n.cat}</span>
                    <h3 className="ind-label">{n.label}</h3>
                    <p className="ind-line">{n.line}</p>
                    <span className="ind-cta">Explore Solution</span>
                  </div>
                  {/* Anchored to the card's own corner, not tucked beside the label. */}
                  <span className="ind-go" aria-hidden="true"><Icon name="arr" size={14} /></span>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal>
            <div className="ind-banner">
              <div>
                <p className="ind-ban-t">
                  <strong>Serving businesses across multiple industries:</strong>{" "}
                  Real Estate, Retail, Hospitality, Healthcare, Professional Services,
                  Construction, Technology, Beauty &amp; more.
                </p>
              </div>
              <button className="btn-ghost on-light" onClick={() => onNav("services")}>
                Explore All Industries <Icon name="arr" size={15} />
              </button>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── PROCESS ── */}
      <section className="sec">
        <div className="wrap">
          <div className="proc-layout">
            <Reveal className="sec-hd proc-head" head>
              <span className="eyebrow">Process</span>
              <h2 className="sec-title split-h"><SplitWords text="From idea to launch, without confusion" /></h2>
              <p className="sec-p">We keep every project structured, transparent, and focused on what helps your business look professional, explain services clearly, and generate better inquiries.</p>
            </Reveal>
            <ProcessTimeline steps={PROCESS} />
          </div>
        </div>
      </section>

      {/* ── REAL WORK ── */}
      <section className="sec sec-surf">
        <div className="wrap">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <Reveal className="sec-hd" head>
              <span className="eyebrow">Real work</span>
              <h2 className="sec-title split-h"><SplitWords text="Selected real projects and website work" /></h2>
              <p className="sec-p">A few real websites, UI/UX screens, and digital experiences created for businesses.</p>
            </Reveal>
            <Reveal>
              <span className="sec-link" style={{ marginTop: 34, whiteSpace: "nowrap" }} onClick={() => onNav("work")}>View Our Work <Icon name="arr" size={14} /></span>
            </Reveal>
          </div>
          <div className="gproj" style={{ marginTop: 48 }}>
            {PROJECTS.slice(0, 5).map((p, i) => (
              <Reveal key={p.slug} delay={i * 60}>
                <ProjectCard project={p} onNav={onNav} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ── */}
      <Testimonials />

      {/* ── FREE REVIEW (radar + audit) ── */}
      <FreeAudit />

      <CTASection onNav={onNav} />
    </>
  );
}
