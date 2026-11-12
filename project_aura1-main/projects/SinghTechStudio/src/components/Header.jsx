import { useState, useEffect } from "react";
import Icon from "./Icon.jsx";
import { NAV_ITEMS, PAGE_MAP, NAV_MAP } from "../data/constants.js";

export default function Header({ page, onNav, transparent = false }) {
  const [open,     setOpen]     = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [overHero, setOverHero] = useState(transparent);

  useEffect(() => {
    const fn = () => {
      setScrolled(window.scrollY > 40);
      // Stay in dark mode while a dark hero still covers the top of the screen
      const hero = document.querySelector(".hero-scrub, .hero-section");
      setOverHero(!!hero && hero.getBoundingClientRect().bottom > 90);
    };
    fn();
    window.addEventListener("scroll", fn, { passive: true });
    return () => window.removeEventListener("scroll", fn);
  }, [transparent]);

  // Dark/transparent header while over a dark hero; solid light header otherwise
  const isDark      = transparent && overHero;
  const active   = PAGE_MAP[page] || "";
  const go = (label) => { onNav(NAV_MAP[label]); setOpen(false); };

  return (
    <header className={`hdr-wrap ${isDark ? "hdr-transparent" : "hdr-scrolled"}`}>
      <div className="wrap">
        <div className="hdr-inner">
          {/* Logo */}
          <div className="logo" onClick={() => go("Home")} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
            <img
              src="/singhtech-logo.webp"
              alt=""
              style={{
                height: 32,
                width: "auto",
                display: "block",
                filter: isDark ? "brightness(0) invert(1)" : "none",
                transition: "filter .2s ease",
              }}
            />
            <span style={{ color: isDark ? "#fff" : "var(--fg)" }}></span>
          </div>

          {/* Desktop nav */}
          <nav className="nav-desktop">
            {NAV_ITEMS.map(n => (
              <button
                key={n}
                className={`nav-a ${isDark ? "nav-a-dark" : ""} ${active === n ? "active" : ""}`}
                onClick={() => go(n)}
              >
                {n}
              </button>
            ))}
          </nav>

          {/* CTA */}
          <button className="btn-p sm hdr-cta" onClick={() => go("Contact")}>
            Start a Project <Icon name="arr" size={14} />
          </button>

          {/* Mobile toggle */}
          <button
            className="mob-toggle"
            onClick={() => setOpen(v => !v)}
            aria-label="Toggle menu"
            style={{ color: isDark ? "#fff" : "var(--fg)" }}
          >
            <Icon name={open ? "x" : "menu"} size={20} />
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <div className={`mob-menu${open ? " open" : ""}`}>
        <div className="wrap">
          <nav className="mob-nav">
            {NAV_ITEMS.map(n => (
              <div key={n} className={`mob-a ${active === n ? "active" : ""}`} onClick={() => go(n)}>{n}</div>
            ))}
            <button className="btn-p" style={{ marginTop: 12, width: "100%" }} onClick={() => go("Contact")}>
              Start a Project
            </button>
          </nav>
        </div>
      </div>
    </header>
  );
}