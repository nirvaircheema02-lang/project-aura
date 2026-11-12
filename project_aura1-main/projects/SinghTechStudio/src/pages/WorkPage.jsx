import { useState } from "react";
import SplitWords from "../components/SplitWords.jsx";
import Reveal from "../components/Reveal.jsx";
import CTASection from "../components/CTASection.jsx";
import Testimonials from "../components/Testimonials.jsx";
import ProjectCard from "../components/ProjectCard.jsx";
import { PROJECTS, WORK_FILTERS } from "../data/portfolio.js";

export default function WorkPage({ onNav }) {
  const [active, setActive] = useState("All");

  const filtered = (() => {
    switch (active) {
      case "Live Websites": return PROJECTS.filter(p => p.label === "Live Website");
      case "UI/UX":         return PROJECTS.filter(p => p.category === "UI/UX Design");
      default:              return PROJECTS;
    }
  })();

  return (
    <>
      {/* Hero */}
      <section style={{ background: "var(--grad-hero)", paddingTop: 112, paddingBottom: 80 }}>
        <div className="wrap">
          <div style={{ maxWidth: 760, animation: "hIn .65s ease-out both" }}>
            <div className="badge badge-dk badge-strong">
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--cyan)", animation: "pdot 2s infinite" }} />
              Work
            </div>
            <h1 style={{ marginTop: 20, fontSize: "clamp(28px,4vw,56px)", fontWeight: 700, letterSpacing: "-0.035em", color: "#fff", lineHeight: 0.98 }}>
              Real websites and UI/UX work, built to convert
            </h1>
            <p style={{ marginTop: 20, fontSize: "clamp(14px,1.6vw,17px)", color: "rgba(255,255,255,.65)", lineHeight: 1.75, maxWidth: 580 }}>
              A focused selection of live websites and UI/UX projects. Every project is real work delivered for a business — open any one to see the goal, decisions, and outcome.
            </p>
          </div>
        </div>
      </section>

      {/* All projects with filters */}
      <section className="sec sec-surf">
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">All projects</span>
            <h2 className="sec-title split-h"><SplitWords text="Browse all work" /></h2>
            <p style={{ marginTop: 16, fontSize: 14, color: "var(--muted)", lineHeight: 1.65 }}>
              Filter by live websites or UI/UX projects.
            </p>
          </Reveal>

          <div className="filters">
            {WORK_FILTERS.map(f => (
              <button key={f} className={`fbtn${active === f ? " on" : ""}`} onClick={() => setActive(f)}>{f}</button>
            ))}
          </div>

          <div className="gproj" style={{ marginTop: 40 }}>
            {filtered.map((p, i) => (
              <Reveal key={p.slug} delay={i * 50}>
                <ProjectCard project={p} onNav={onNav} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <Testimonials variant="surface" />
      <CTASection onNav={onNav} />
    </>
  );
}
