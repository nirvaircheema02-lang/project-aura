import { useEffect, useRef } from "react";
import Icon from "./Icon.jsx";

/* The footer does not sit in the page — it sits underneath it.

   It is fixed to the bottom of the viewport behind the main column, which is
   opaque and stacked above it. Scrolling slides the page up off the footer, so
   the footer is uncovered from the bottom edge rather than arriving as the next
   section. A spacer below the content reserves exactly enough scroll to
   uncover it.

   Reveal progress drives a restrained rise on the columns and, last, the
   wordmark. Every value is a pure function of scroll position, so the whole
   thing reverses on the way back up.

   A footer taller than the viewport cannot be fixed without losing its bottom
   edge, so on short screens it falls back to a normal static footer. */
export default function Footer({ onNav }) {
  const host = useRef(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
    let raf = 0, h = 0, under = false;

    const measure = () => {
      const vh = window.innerHeight;
      /* Measure unpinned, or the height would be read off the fixed box. */
      el.classList.remove("is-under");
      h = el.offsetHeight;
      under = !reduce.matches && h <= vh * 0.92;
      el.classList.toggle("is-under", under);
      document.documentElement.style.setProperty("--ft-h", under ? `${h}px` : "0px");
      paint();
    };

    const paint = () => {
      raf = 0;
      if (!under) {
        el.style.setProperty("--p", "1");
        for (let i = 1; i <= 4; i++) el.style.setProperty(`--pb${i}`, "1");
        el.style.setProperty("--ps", "1");
        return;
      }
      const vh = window.innerHeight;
      const docH = document.documentElement.scrollHeight;
      /* How much of the footer the page has slid off, 0 → 1. */
      const p = clamp((window.scrollY + vh - (docH - h)) / Math.max(1, h));
      el.style.setProperty("--p", p.toFixed(4));
      for (let i = 0; i < 4; i++) {
        const o = 0.10 + i * 0.08;
        el.style.setProperty(`--pb${i + 1}`, clamp((p - o) / 0.45).toFixed(4));
      }
      /* The wordmark is the last thing to settle. */
      el.style.setProperty("--ps", clamp((p - 0.55) / 0.4).toFixed(4));
    };

    const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    reduce.addEventListener("change", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      reduce.removeEventListener("change", measure);
      if (ro) ro.disconnect();
      document.documentElement.style.removeProperty("--ft-h");
    };
  }, []);

  return (
    <footer className="ft-wrap" ref={host}>
      <div className="ft-glow" />
      <div className="wrap">
        <div className="ft-lead" style={{ "--pb": "var(--pb1, 1)" }}>
          <span className="eyebrow-dk">Let's work together</span>
        </div>

        <div className="ft-grid">
          {/* Brand */}
          <div className="ft-col" style={{ "--pb": "var(--pb1, 1)" }}>
            <div className="logo" style={{ cursor: "default", flexWrap: "wrap" }}>
              <img src="/singhtech-white.webp" alt="singhtech" style={{ width: 240, maxWidth: "100%", height: "auto", display: "block" }} />
              <span>Singhtech</span>
            </div>
            <p className="ft-desc">A digital growth studio building modern websites, brand systems, marketing, and AI-powered lead workflows for growing businesses.</p>
          </div>

          {/* Services */}
          <div className="ft-col" style={{ "--pb": "var(--pb2, 1)" }}>
            <h4 className="eyebrow-dk">Services</h4>
            <ul className="ft-links">
              {["Website Design & Development", "UI/UX Design", "Branding & Graphic Design", "Digital Marketing", "SEO & Analytics", "AI Automation"].map(s => (
                <li key={s}><span className="ft-link" onClick={() => onNav("services")}>{s}</span></li>
              ))}
            </ul>
          </div>

          {/* Quick links */}
          <div className="ft-col" style={{ "--pb": "var(--pb3, 1)" }}>
            <h4 className="eyebrow-dk">Quick links</h4>
            <ul className="ft-links">
              {[["Home", "home"], ["Work", "work"], ["About", "about"], ["Contact", "contact"]].map(([l, p]) => (
                <li key={l}><span className="ft-link" onClick={() => onNav(p)}>{l}</span></li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div className="ft-col" style={{ "--pb": "var(--pb4, 1)" }}>
            <h4 className="eyebrow-dk">Contact</h4>
            <ul className="ft-links">
              <li className="ft-ci"><Icon name="mail" size={14} /> contact@singhtechstudio.com</li>
              <li className="ft-ci"><Icon name="pin"  size={14} /> Gurgaon, India</li>
              <li className="ft-ci"><Icon name="msg"  size={14} /> WhatsApp inquiries welcome</li>
              <li style={{ fontSize: 14, color: "rgba(255,255,255,.4)" }}>Response: within 24 hours</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="ft-btm">
        <div className="wrap">
          <div className="ft-bi">
            <span>© {new Date().getFullYear()} Singhtech. All rights reserved.</span>
            <span>A digital growth studio for growing businesses.</span>
          </div>
        </div>
      </div>

      {/* Closing signature. Decorative — the brand is already named above, so it
          is hidden from assistive tech rather than announced a third time. */}
      <div className="ft-sig" aria-hidden="true">
        <span className="ft-sig-word">SINGHTECH</span>
      </div>
    </footer>
  );
}
