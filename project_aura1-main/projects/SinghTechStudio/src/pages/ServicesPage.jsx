import Icon from "../components/Icon.jsx";
import Reveal from "../components/Reveal.jsx";
import CTASection from "../components/CTASection.jsx";
import ServiceVisual from "../sections/ServiceVisual.jsx";
import { SERVICES } from "../data/services.js";

/* Same six-card system as the homepage, using the same visuals.

   This page is where the service keywords need to live, so nothing from
   services.js is dropped: four capabilities show, the rest sit behind a
   native <details> along with "best for". Collapsed content is still in the
   DOM and still crawlable — it just is not all competing at once, which was
   the actual problem with the stacked version. */
export default function ServicesPage({ onNav }) {
  return (
    <>
      <section style={{ padding: "104px 0 0" }}>
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Services</span>
            <h1 style={{ marginTop: 14, lineHeight: 0.98, fontSize: "clamp(28px,4vw,60px)", fontWeight: 600, letterSpacing: "-0.03em" }}>
              Practical digital services for growing businesses
            </h1>
            <p className="sec-p">Everything you need to build, design, market, and automate your online presence — delivered with clean design and clear communication.</p>
          </Reveal>
        </div>
      </section>

      <section style={{ padding: "40px 0 80px" }}>
        <div className="wrap">
          <div className="svc-grid">
            {SERVICES.map((s, i) => {
              const shown = s.includes.slice(0, 4);
              const rest  = s.includes.slice(4);
              return (
                <Reveal key={s.slug} delay={(i % 3) * 70 + Math.floor(i / 3) * 90}>
                  <article className="svc-card">
                    <span className="svc-n">{String(i + 1).padStart(2, "0")}</span>
                    <h2 className="svc-t">{s.title}</h2>
                    <p className="svc-d">{s.description}</p>

                    <ServiceVisual kind={s.slug} media={s.media} />

                    <ul className="svc-list">
                      {shown.map(it => <li key={it} className="svc-li">{it}</li>)}
                    </ul>

                    <details className="svc-more">
                      <summary>
                        {rest.length > 0 ? `${rest.length} more, and who it suits` : "Who it suits"}
                        <Icon name="arr" size={13} />
                      </summary>
                      {rest.length > 0 && (
                        <ul className="svc-list svc-list-more">
                          {rest.map(it => <li key={it} className="svc-li">{it}</li>)}
                        </ul>
                      )}
                      <p className="svc-best"><span>Best for</span> {s.bestFor.join(" · ")}</p>
                    </details>

                    <button className="svc-cta" onClick={() => onNav("contact")}>
                      Discuss this service <Icon name="arr" size={14} />
                    </button>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <CTASection onNav={onNav} />
    </>
  );
}
