import { useEffect, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import RotatingWord from "../components/RotatingWord.jsx";

/* Scroll-scrubbed hero. The source clip is pre-decoded to WebP stills in
   public/frames and scroll position paints the exact frame onto a <canvas> —
   frame-perfect, no auto-play, nothing to buffer.

   The current sequence runs UI assembling → design grid → growth chart →
   automation nodes → finished dashboard, and its left third is empty in every
   frame, which is what keeps the headline legible over it.

   Export is OpenCV + Pillow (no ffmpeg on this machine); it starts 20 frames
   into the source because the opening frames are near-black and the hero has
   to rest on something with substance. Keep FRAME_COUNT in sync with the file
   count in /frames. */
const FRAME_COUNT = 220;
const framePath = (i) => `/frames/frame_${String(i).padStart(4, "0")}.webp`;

/* Sampled from the sequence's own left and top edges, so the area beside a
   height-fitted frame is the colour the frame already ends on. */
const GROUND = "#12161C";

/* Cleared at the top so the composition starts below the floating header. */
const TOP_SAFE = 44;

/* The picture keeps to this band inside a full-viewport canvas, so the hero
   reads the same size it did when the box itself was this tall. */
const BAND_MIN = 560;
const BAND_MAX = 640;

export default function HeroFrames({ onNav }) {
  const scrubRef  = useRef(null);
  const stickyRef = useRef(null);
  const canvasRef = useRef(null);
  const imagesRef = useRef([]);
  const curFrame  = useRef(-1);
  const rafRef    = useRef(0);
  const [loaded, setLoaded] = useState(0);

  const draw = (frame) => {
    const canvas = canvasRef.current;
    const img = imagesRef.current[frame];
    if (!canvas || !img || !img.complete || !img.naturalWidth) return;
    const ctx = canvas.getContext("2d");
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const ir = img.naturalWidth / img.naturalHeight;

    /* Always fit the height, never crop it. On a wide container that used to
       mean cover, which cut the top and bottom — exactly where the UI panels
       and the graph peaks live. Fitting the height leaves side gaps instead,
       and the frame's own ground fills them. On a phone the same rule
       overflows sideways, which costs nothing vertically. */
    /* The canvas fills the viewport, but the picture does not: it keeps to a
       band the size the hero used to be, centred, with the ground filling
       above and below it. That is what balances the composition — pinning a
       short box at top:0 only pushed the leftover height to the bottom.

       The header floats transparently over all of this, and the frame's own
       top margin is only ~6% of its height, so on a screen short enough that
       the band nearly fills it, dy falls back to TOP_SAFE and the composition
       clears the bar instead of centring exactly. */
    const band = Math.min(Math.max(ch * 0.70, BAND_MIN), BAND_MAX);
    const dh = Math.min(band, ch - TOP_SAFE);
    const dw = dh * ir;
    const dy = Math.max(TOP_SAFE, (ch - dh) / 2);
    const gap = cw - dw;
    /* Positive gap: sit right with a little air. Negative: show the
       centre-right of the frame, which is where the composition is. */
    const dx = gap >= 0 ? gap * 0.88 : gap * 0.72;

    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, dx, dy, dw, dh);
    curFrame.current = frame;
  };

  const resize = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(curFrame.current < 0 ? 0 : curFrame.current);
  };

  /* Preload all frames */
  useEffect(() => {
    let count = 0;
    const imgs = new Array(FRAME_COUNT);
    for (let i = 0; i < FRAME_COUNT; i++) {
      const img = new Image();
      img.src = framePath(i + 1);
      const done = () => { count++; setLoaded(count); if (i === 0) draw(0); };
      img.onload = done; img.onerror = done;
      imgs[i] = img;
    }
    imagesRef.current = imgs;
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  /* Scroll → frame (imperative draw, no per-frame re-render) */
  useEffect(() => {
    const el = scrubRef.current;
    if (!el) return;
    const update = () => {
      rafRef.current = 0;
      /* The pinned phase lasts the runway minus the pinned box, which is no
         longer the viewport height now that the hero is shorter than one. */
      const pinned = stickyRef.current ? stickyRef.current.offsetHeight : window.innerHeight;
      const total = el.offsetHeight - pinned;
      const p = total > 0 ? Math.min(1, Math.max(0, -el.getBoundingClientRect().top / total)) : 0;
      const frame = Math.min(FRAME_COUNT - 1, Math.round(p * (FRAME_COUNT - 1)));
      if (frame !== curFrame.current) draw(frame);
    };
    const onScroll = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const pctLoaded = Math.round((loaded / FRAME_COUNT) * 100);

  return (
    <div className="hero-scrub" ref={scrubRef}>
      <div className="hero-sticky" ref={stickyRef}>
        <canvas ref={canvasRef} className="hero-video" />
        <div className="hero-scrim" />
        {/* Idle life. Scroll still owns which frame is painted; this only drifts
            above it, so pausing the scroll never freezes the hero. */}
        <div className="hero-aura" aria-hidden="true" />
        {loaded < FRAME_COUNT && (
          <div className="hero-load"><span style={{ width: `${pctLoaded}%` }} /></div>
        )}

        <div className="hero-content">
          <div className="wrap" style={{ width: "100%" }}>
            <div className="hero-copy">
              <span className="hero-tag">
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--cyan)", animation: "pdot 2s infinite" }} />
                Design · Technology · Growth
              </span>
              <h1 style={{ marginTop: 22, fontSize: "clamp(30px,4.4vw,58px)", lineHeight: 1.0, fontWeight: 800, letterSpacing: "-0.04em", color: "#fff", maxWidth: 640 }}>
                We design websites, brands and systems that{" "}
                <RotatingWord words={["grow.", "convert.", "automate."]} />
              </h1>
              <p style={{ marginTop: 18, fontSize: "clamp(14px,1.6vw,18px)", color: "rgba(255,255,255,.74)", lineHeight: 1.7, maxWidth: 520 }}>
                Singhtech builds the website, shapes the brand, sets up the SEO and marketing, and automates the follow-up &mdash; so inquiries actually reach you.
              </p>
              <div style={{ marginTop: 26, display: "flex", flexWrap: "wrap", gap: 12 }}>
                <button className="btn-p hro-cta" onClick={() => onNav("contact")}>
                  Start a Project <Icon name="arr" size={15} />
                </button>
                <button className="btn-ghost" onClick={() => onNav("work")}>
                  View Our Work <Icon name="arr" size={15} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
