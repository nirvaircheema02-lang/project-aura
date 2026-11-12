import Icon from "./Icon.jsx";
import Reveal from "./Reveal.jsx";
import ParticleCanvas from "../sections/ParticleCanvas.jsx";
import { WA_URL } from "../data/constants.js";

export default function CTASection({ onNav, centered = false }) {
  return (
    <div className="cta-out">
      <div className="wrap">
        <Reveal scale>
          <div className="cta-box" style={centered ? { textAlign: "center" } : {}}>
            {!centered && <div className="cta-web"><ParticleCanvas /></div>}
            <div className="cta-gb" /><div className="cta-gc" />
            <div className="cta-cnt" style={centered ? { margin: "0 auto" } : {}}>
              <div className="eyebrow-dk" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--cyan)", animation: "pdot 2s ease-in-out infinite", display: "inline-block" }} />
                Let's build
              </div>
              <h2 className="cta-title">Ready to build a stronger digital presence?</h2>
              <p className="cta-desc">
                Let's create a clean website, better design system, and practical digital setup that helps
                your business look professional and get more inquiries.
              </p>
              <div className="cta-btns" style={centered ? { justifyContent: "center" } : {}}>
                <button className="btn-p ftr-btn" onClick={() => onNav("contact")}>
                  Start a Project <Icon name="arr" size={15} />
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
  );
}
