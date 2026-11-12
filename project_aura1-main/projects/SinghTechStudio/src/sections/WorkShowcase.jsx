import { useEffect, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import Reveal from "../components/Reveal.jsx";

/* Pinned real-work showcase. LEFT = project number + supporting text + heading.
   RIGHT = the active project's image, rising/crossfading as you scroll. */
export default function WorkShowcase({ projects, onNav }) {
  const ref = useRef(null);
  const rafRef = useRef(0);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const n = projects.length;
    const update = () => {
      rafRef.current = 0;
      const total = el.offsetHeight - window.innerHeight;
      const p = total > 0 ? Math.min(1, Math.max(0, -el.getBoundingClientRect().top / total)) : 0;
      setActive(Math.min(n - 1, Math.floor(p * n + 0.00001)));
    };
    const onScroll = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [projects]);

  const cur = projects[active];

  return (
    <div className="rw" ref={ref} style={{ height: `${projects.length * 85}vh` }}>
      <div className="rw-sticky">
        <div className="wrap rw-inner">
          {/* Main heading — fixed at the top while projects transition */}
          <Reveal className="rw-head" head>
            <span className="eyebrow">Selected work</span>
            <h2 className="rw-mainh">Selected website and UI/UX projects</h2>
          </Reveal>

          <div className="rw-grid">
            {/* LEFT — project number + supporting text + heading */}
            <div className="rw-content">
              <div className="rw-num">
                <span key={active} className="rw-num-d">{String(active + 1).padStart(2, "0")}</span>
                <span className="rw-num-total"> / {String(projects.length).padStart(2, "0")}</span>
              </div>
              <div key={active} className="rw-text">
                <span className="rw-cat">{cur.category}</span>
                <h3 className="rw-title">{cur.title}</h3>
                <p className="rw-meta">{cur.industry} · {cur.timeline || cur.status}</p>
                <button className="btn-p sm" onClick={() => onNav("detail", cur.slug)}>
                  View project <Icon name="arrUR" size={14} />
                </button>
              </div>
              <div className="rw-dots">
                {projects.map((p, i) => (
                  <button key={p.slug} className={`rw-dot ${i === active ? "on" : ""}`} onClick={() => onNav("detail", p.slug)} aria-label={p.title} />
                ))}
              </div>
            </div>

            {/* RIGHT — project image, rises/crossfades to match */}
            <div className="rw-media">
              <div className="rw-stage">
                {projects.map((p, i) => (
                  <div
                    key={p.slug}
                    className={`rw-slide ${i === active ? "on" : i < active ? "past" : "upcoming"}`}
                    onClick={() => onNav("detail", p.slug)}
                  >
                    <img src={p.img} alt={p.title} loading={i < 2 ? "eager" : "lazy"} />
                    <div className="rw-slide-foot"><span className="wsp-panel-lbl">{p.label}</span></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
