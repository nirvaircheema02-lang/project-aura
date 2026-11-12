import Icon from "../components/Icon.jsx";
import SplitWords from "../components/SplitWords.jsx";
import Reveal from "../components/Reveal.jsx";
import FadeImg from "../components/FadeImg.jsx";
import { PROJECTS } from "../data/portfolio.js";
import { WA_URL } from "../data/constants.js";

const GALL_ICONS = { desktop: "mon", mobile: "phone", figma: "fig", brand: "spark" };

export default function ProjectDetailPage({ slug, onNav }) {
  const proj = PROJECTS.find(p => p.slug === slug);

  if (!proj) {
    return (
      <div className="wrap" style={{ padding: "128px 0", textAlign: "center" }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.03em" }}>Project not found</h1>
        <p style={{ marginTop: 12, color: "var(--muted)" }}>The project you're looking for doesn't exist.</p>
        <button className="btn-p" style={{ marginTop: 32 }} onClick={() => onNav("work")}>
          <Icon name="arrL" size={14} /> Back to Work
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Hero */}
      <section style={{ background: "var(--grad-hero)", paddingTop: 64, paddingBottom: 64 }}>
        <div className="wrap">
          <button
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "rgba(255,255,255,.6)", background: "none", border: "none", cursor: "pointer" }}
            onClick={() => onNav("work")}
          >
            <Icon name="arrL" size={13} /> Back to Work
          </button>

          <div style={{ marginTop: 28 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span className="badge badge-dk badge-strong">{proj.label}</span>
              <span className="badge badge-dk">{proj.category}</span>
              <span className="badge badge-dk">{proj.industry}</span>
            </div>
            <h1 style={{ marginTop: 20, fontSize: "clamp(28px,4vw,56px)", fontWeight: 700, letterSpacing: "-0.035em", color: "#fff", lineHeight: 0.98 }}>{proj.title}</h1>
            <p style={{ marginTop: 16, maxWidth: 600, fontSize: "clamp(14px,1.6vw,17px)", color: "rgba(255,255,255,.65)", lineHeight: 1.75 }}>{proj.summary}</p>
            <div style={{ marginTop: 28, display: "flex", flexWrap: "wrap", gap: 12 }}>
              {proj.liveUrl && (
                <a href={proj.liveUrl} target="_blank" rel="noreferrer" className="btn-p">
                  Visit live website <Icon name="extL" size={14} />
                </a>
              )}
              <button className="btn-ghost" onClick={() => onNav("contact")}>
                Discuss similar project <Icon name="arr" size={14} />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Meta grid */}
      <section style={{ padding: "48px 0 0" }}>
        <div className="wrap">
          <Reveal>
            <div className="meta-g">
              {[{ k: "Project type", v: proj.label }, { k: "Industry", v: proj.industry }, { k: "Timeline", v: proj.timeline }, { k: "Status", v: proj.status }].map(r => (
                <div key={r.k} className="meta-c">
                  <span className="eyebrow">{r.k}</span>
                  <div className="meta-v">{r.v}</div>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal>
            <div style={{ marginTop: 32 }}>
              <span className="eyebrow-m">Services delivered</span>
              <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                {proj.services.map(s => (
                  <span key={s} className="badge">{s}</span>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Challenge + Delivered */}
      <section className="sec sec-surf" style={{ paddingTop: 56 }}>
        <div className="wrap">
          <div style={{ display: "grid", gap: 40 }}>
            <Reveal>
              <div style={{ maxWidth: 500 }}>
                <span className="eyebrow">The challenge</span>
                <h2 style={{ marginTop: 16, fontSize: "clamp(22px,3vw,36px)", fontWeight: 600, letterSpacing: "-0.03em" }}>What needed solving</h2>
                <p style={{ marginTop: 16, fontSize: 15, color: "var(--muted)", lineHeight: 1.75 }}>{proj.challenge}</p>
              </div>
            </Reveal>
            <Reveal>
              <div>
                <span className="eyebrow">What we delivered</span>
                <h2 style={{ marginTop: 16, fontSize: "clamp(22px,3vw,36px)", fontWeight: 600, letterSpacing: "-0.03em" }}>Scope of work</h2>
                <div style={{ marginTop: 24, display: "grid", gap: 12 }}>
                  {proj.delivered.map(d => (
                    <div key={d} className="del-item">
                      <Icon name="chkC" size={16} style={{ color: "var(--brand)", marginTop: 2, flexShrink: 0 }} />
                      <span>{d}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Gallery */}
      <section className="sec">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Screens & visuals</span>
            <h2 className="sec-title split-h"><SplitWords text="Project visuals" /></h2>
          </Reveal>
          <div className="gall-g">
            {proj.gallery.map((g, i) => (
              <Reveal key={i} delay={i * 80}>
                <div className="gall-item" style={{ aspectRatio: g.kind === "mobile" ? "4/3" : "16/10" }}>
                  <FadeImg src={g.img} alt={`${proj.title} — ${g.kind}`} loading="lazy" />
                  <div className="gall-ph">
                    <div className="gall-tag">
                      <Icon name={GALL_ICONS[g.kind]} size={14} />
                      {g.label || g.kind}
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Design decisions */}
      <section className="sec sec-surf">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Design decisions</span>
            <h2 className="sec-title split-h"><SplitWords text="How we approached it" /></h2>
          </Reveal>
          <div className="g3" style={{ marginTop: 48 }}>
            {proj.decisions.map((d, i) => (
              <Reveal key={d.title} delay={i * 70}>
                <div className="dec-card">
                  <span className="why-n">0{i + 1}</span>
                  <h3 className="dec-h">{d.title}</h3>
                  <p className="dec-p">{d.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Results */}
      <section className="sec">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Result</span>
            <h2 className="sec-title split-h"><SplitWords text="What was delivered" /></h2>
            <p className="sec-p">No invented metrics — only what was actually shipped on this project.</p>
          </Reveal>
          <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 12 }}>
            {proj.results.map((r, i) => (
              <Reveal key={r} delay={i * 50}>
                <div className="del-item">
                  <Icon name="chkC" size={16} style={{ color: "var(--brand)", marginTop: 2, flexShrink: 0 }} />
                  <span>{r}</span>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <div className="cta-out">
        <div className="wrap">
          <Reveal scale>
            <div className="cta-box" style={{ textAlign: "center" }}>
              <div className="cta-gb" /><div className="cta-gc" />
              <div className="cta-cnt" style={{ margin: "0 auto" }}>
                <h2 className="cta-title">Want a similar website or digital system?</h2>
                <p className="cta-desc">Tell us what you want to build and we'll suggest the best starting point.</p>
                <div className="cta-btns" style={{ justifyContent: "center" }}>
                  <button className="btn-p" onClick={() => onNav("contact")}>
                    Book Free Consultation <Icon name="arr" size={15} />
                  </button>
                  <a href={WA_URL} target="_blank" rel="noreferrer" className="btn-ghost">
                    <Icon name="msg" size={15} /> Chat on WhatsApp
                  </a>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </>
  );
}
