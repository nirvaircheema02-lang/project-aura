import Icon from "../components/Icon.jsx";
import SplitWords from "../components/SplitWords.jsx";
import Reveal from "../components/Reveal.jsx";
import CTASection from "../components/CTASection.jsx";
import { Helmet } from "react-helmet-async";
const HOW_WE_WORK = [
  { icon: "comp",  title: "Strategy before screens",   desc: "We first understand your business, audience, services, and inquiry journey before designing." },
  { icon: "phone", title: "Mobile-first experience",   desc: "Every website and flow is planned for real users on mobile first." },
  { icon: "grid",  title: "Design system thinking",    desc: "We use consistent colors, typography, spacing, cards, buttons, and reusable UI patterns." },
  { icon: "flow",  title: "Practical growth setup",    desc: "We connect the website with CTAs, forms, WhatsApp, SEO basics, and automation where useful." },
];

/* Trimmed to 4 tighter values */
const VALUES = [
  { title: "Clarity over complexity",             desc: "Simple structures, clean layouts, easy-to-understand work." },
  { title: "Design that supports business goals", desc: "We design for inquiries, conversions, and trust — not just looks." },
  { title: "Mobile-first thinking",               desc: "Most of your audience is on a phone. We design for that first." },
  { title: "Long-term support mindset",           desc: "We help you launch, iterate, and grow over time." },
];

/* ⚑ EDIT ME — your real stack / tools */
const STACK = [
  { icon: "fig",   name: "Figma",            cat: "UI/UX Design"  },
  { icon: "code",  name: "React + Vite",     cat: "Development"   },
  { icon: "mon",   name: "Responsive Web",   cat: "Front-end"     },
  { icon: "spark", name: "Brand & Graphics", cat: "Identity"      },
  { icon: "msg",   name: "WhatsApp API",     cat: "Automation"    },
  { icon: "bot",   name: "AI & Chatbots",    cat: "Lead Systems"  },
  { icon: "srch",  name: "SEO / AEO",        cat: "Search"        },
  { icon: "bar",   name: "GA4 / Analytics",  cat: "Tracking"      },
];

export default function AboutPage({ onNav }) {
  return (
    
    <>
  <Helmet>
    <title>About SinghTech Studio | UI/UX & Website Design</title>

    <meta
      name="description"
      content="Learn about SinghTech Studio — a digital growth studio helping businesses with UI/UX design, React websites, branding and AI automation."
    />

    <link
      rel="canonical"
      href="https://singhtechstudio.com/about"
    />

    <meta property="og:title" content="About SinghTech Studio" />
    <meta
      property="og:description"
      content="Modern websites, branding, UI/UX and digital growth solutions."
    />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://singhtechstudio.com/about" />
  </Helmet>

  {/* Existing About page starts here */}
  

      <section style={{ padding: "104px 0 72px" }}>
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">About Singhtech</span>
            <h1 style={{ marginTop: 14, lineHeight: 0.98, fontSize: "clamp(28px,4vw,60px)", fontWeight: 700, letterSpacing: "-0.03em" }}>
              We build practical digital systems for <span className="grad-text">growing businesses</span>.
            </h1>
            <p style={{ marginTop: 24, fontSize: "clamp(14px,1.6vw,17px)", color: "var(--muted)", lineHeight: 1.75 }}>
              Singhtech helps businesses create a clearer, more credible digital presence through websites, UI/UX design,
              branding, digital marketing support, ecommerce setup, and practical AI/WhatsApp automation.
            </p>
          </Reveal>
        </div>
      </section>

      {/* Founder / studio intro */}
      <section className="sec sec-surf">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Who we are</span>
            <h2 className="sec-title split-h"><SplitWords text="A small studio, focused on real outcomes" /></h2>
          </Reveal>
          <Reveal>
            <div className="founder-card" style={{ marginTop: 48 }}>
              <div className="founder-glow" />
              {/* ⚑ Swap initials for a real photo: replace this div with <img className="founder-avatar" ... /> */}
              <div className="founder-avatar">singhtech</div>
              <div style={{ position: "relative" }}>
                <div className="founder-name">Singhtech Team</div>
                <div className="founder-role">Website, UI/UX &amp; Digital Growth Studio</div>
                <p className="founder-bio">
                  We help growing businesses build clean websites, practical design systems, service pages, inquiry
                  flows, and simple automations. Every project is focused on clarity, speed, trust, and measurable
                  business outcomes.
                </p>
                <div style={{ marginTop: 20, display: "flex", flexWrap: "wrap", gap: 10 }}>
                  <button className="btn-p sm" onClick={() => onNav("contact")}>
                    Work with us <Icon name="arr" size={14} />
                  </button>
                  <button className="btn-ghost" style={{ height: 44, fontSize: 13 }} onClick={() => onNav("work")}>
                    See our work
                  </button>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* How we work */}
      <section className="sec">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">How we work</span>
            <h2 className="sec-title split-h"><SplitWords text="Design, development, and growth systems built with clarity" /></h2>
          </Reveal>
          <div className="g2" style={{ marginTop: 48 }}>
            {HOW_WE_WORK.map((c, i) => (
              <Reveal key={c.title} delay={i * 70}>
                <div className="how-card">
                  <div className="how-ico"><Icon name={c.icon} size={18} /></div>
                  <h3 className="how-h">{c.title}</h3>
                  <p className="how-p">{c.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Tools & tech stack */}
      <section className="sec sec-surf">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Tools &amp; stack</span>
            <h2 className="sec-title split-h"><SplitWords text="The tools we design, build, and grow with" /></h2>
            <p className="sec-p">A practical, modern toolkit — from design and development to automation, search, and analytics.</p>
          </Reveal>
          <div className="stack-grid">
            {STACK.map((t, i) => (
              <Reveal key={t.name} delay={i * 40}>
                <div className="stack-item">
                  <div className="stack-ico"><Icon name={t.icon} size={18} /></div>
                  <div>
                    <div className="stack-name">{t.name}</div>
                    <div className="stack-cat">{t.cat}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="sec">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Our values</span>
            <h2 className="sec-title split-h"><SplitWords text="What we care about" /></h2>
          </Reveal>
          <div className="g4" style={{ marginTop: 48 }}>
            {VALUES.map((v, i) => (
              <Reveal key={v.title} delay={i * 60}>
                <div className="val-card">
                  <div className="val-ico"><Icon name="chk" size={16} /></div>
                  <h3 className="val-h">{v.title}</h3>
                  <p className="val-p">{v.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <CTASection onNav={onNav} />
    </>
  );
}
