import { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import Reveal from "./Reveal.jsx";
import SplitWords from "./SplitWords.jsx";

/* ⚑ Real client quotes, supplied by the client and used verbatim. Do not
   paraphrase, and do not add ratings, metrics or logos that were not given.
   `role` is optional — the attribution line drops it cleanly when absent.
   No ratings: these clients did not give one. */
const TESTIMONIALS = [
  {
    quote: "Working with Singhtech was a really smooth experience. They understood the kind of website we wanted and translated it into something that feels clean, modern and true to our brand. The whole process was easy to follow, communication was clear, and we\u2019re very happy with how the final website turned out.",
    name: "Manorath Singh",
    role: "",
    company: "Amrit Studio",
  },
  {
    quote: "I had a clear idea of how I wanted the Arjun Realty website to look and feel, and Singhtech was able to bring that vision to life. The interface feels modern, well structured and easy to use, while still matching the visual direction I had in mind. I\u2019m really happy with the final result and the overall experience of working with the team.",
    name: "Arjun Sharma",
    role: "CEO & Founder",
    company: "Arjun Realty",
  },
];

/* Outcomes moved into the Why / What's included list on the homepage — it was
   repeating that section, and this one reads better as quotes alone. */

export default function Testimonials({ variant }) {
  const meta = (t) => [t.role, t.company].filter(Boolean).join(" · ");
  const initials = (n) => n.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();

  const count = TESTIMONIALS.length;
  const [i, setI] = useState(0);
  const paused = useRef(false);
  const [still, setStill] = useState(false);

  /* Reduced motion gets every quote stacked instead of a moving track --
     auto-advancing carousel content is exactly what that setting asks us not
     to do. */
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (still || count < 2) return;
    const id = setInterval(() => {
      if (!paused.current) setI(p => (p + 1) % count);
    }, 6500);
    return () => clearInterval(id);
  }, [still, count]);

  const card = (t) => (
    <figure className="tq">
      <span className="tq-mark" aria-hidden="true"><Icon name="qt" size={36} /></span>
      <blockquote className="tq-quote">{t.quote}</blockquote>
      <figcaption className="tq-author">
        <span className="tq-avatar" aria-hidden="true">{initials(t.name)}</span>
        <span className="tq-who">
          <span className="tq-name">{t.name}</span>
          <span className="tq-role">{meta(t)}</span>
        </span>
      </figcaption>
    </figure>
  );

  return (
    <section className={`sec${variant === "surface" ? " sec-surf" : ""}`}>
      <div className="wrap">
        <div className="tq-layout">
          <Reveal className="sec-hd tq-head" head>
            <span className="eyebrow">Working together</span>
            <h2 className="sec-title split-h"><SplitWords text="What it's like to work with us" /></h2>
          </Reveal>

          {count > 0 && (still ? (
          <div className="tq-stack">
            {TESTIMONIALS.map(t => <Reveal key={t.name}>{card(t)}</Reveal>)}
          </div>
        ) : (
          <Reveal>
            <div
              className="tq-slider"
              onMouseEnter={() => { paused.current = true; }}
              onMouseLeave={() => { paused.current = false; }}
              onFocusCapture={() => { paused.current = true; }}
              onBlurCapture={() => { paused.current = false; }}
            >
              <div className="tq-vp" aria-live="polite">
                <div className="tq-track" style={{ transform: `translate3d(-${i * 100}%, 0, 0)` }}>
                  {TESTIMONIALS.map((t, n) => (
                    <div className="tq-slide" key={t.name} aria-hidden={n !== i}>{card(t)}</div>
                  ))}
                </div>
              </div>

              {count > 1 && (
                <div className="tq-bar" role="tablist" aria-label="Choose a testimonial">
                  <span className="tq-bar-fill" style={{ width: `${((i + 1) / count) * 100}%` }} />
                  {TESTIMONIALS.map((t, n) => (
                    <button
                      key={t.name}
                      className="tq-bar-hit"
                      role="tab"
                      aria-selected={n === i}
                      aria-label={`Show the quote from ${t.name}`}
                      onClick={() => setI(n)}
                    />
                  ))}
                </div>
              )}
            </div>
          </Reveal>
          ))}
        </div>

      </div>
    </section>
  );
}
