import { useEffect, useLayoutEffect, useRef, useState } from "react";
import HeroFrames from "./HeroFrames.jsx";
import Icon from "../components/Icon.jsx";
import RotatingWord from "../components/RotatingWord.jsx";
/* The Build stage shows this very file. Vite hands back its real source at
   build time, so what is on screen cannot drift from what ships. */
import rotatingWordSource from "../components/RotatingWord.jsx?raw";

/* Hero → Services. A real laptop plays on the right of the hero; the glass builds,
   shows work, then escapes the laptop and becomes the real Services section.

     IDLE       nobody scrolling: the code types itself, then the component it
                renders takes the glass, and it loops. Nothing else advances.
     BUILD      scrolling starts: that output rewinds, and scroll types the code
     RESULT     the code gives way to the component it renders
     REAL WORK  Arjun Realty → Amrit Studio → 25Colleges, each edge-to-edge
     SERVICES   the live section, rendered, arrives in the glass
     BREAKOUT   environment, hand, body, bezel dissolve; the glass flattens and
                expands onto the live section, which takes over

   Desktop only. Narrow, touch and reduced-motion visitors get HeroFrames
   untouched, and because the choice is made before either mounts, neither hero's
   assets are fetched by the other's audience.

   Smoothness. Scroll position is the only input to the story, but it is not
   applied raw: a wheel notch or a flick would otherwise move the whole story in
   one step. The playhead eases toward the scroll position (the same
   rAF + lerp as ProcessTimeline) and tightens as the end nears so the takeover
   still lands on the real scroll. The projects' scrolling parts are stitched
   into one tall image and slid, not played back as frames — frames of a scrolling
   page are either steppy or, when blended, double-exposed. */

const DESKTOP = "(min-width: 1024px) and (min-height: 560px) and (hover: hover) and (pointer: fine)";
const REDUCED = "(prefers-reduced-motion: reduce)";

/* ── the laptop ── */
const BASE = { w: 950, h: 700 };
/* The clip was stabilised at build time against its slow dolly, so these hold
   for every frame. Glass corners TL, TR, BR, BL in the cropped video's pixels. */
const GLASS = [[244, 137], [707, 136], [745, 446], [268, 481]];

/* The hand strays into the lower-right corner of the glass in 85% of the clip's frames (measured: union of every
   overlap pixel is x 699-834, y 376-469). The plane is stacked above the video, so it would cover the fingers.
   This is the region, with margin, where the hand is keyed back on top of the plane. */
const OVER = { x: 684, y: 360, w: 166, h: 124 };
/* The current clip keeps the hand on the trackpad, below the glass, so the hand layer is off. Kept for a clip where
   fingers rise in front of the screen. */
const HAND_OVER = false;

/* ── the screen plane: where every piece of content lives, flat, at 1440 wide ── */
const PW = 1440, PH = 916;
const PLANE_RADIUS = 17;

/* ── runtime media ── */
const REC = { w: 1152, h: 716 };                                  // the project recordings, as exported
const CS = Math.max(PW / REC.w, PH / REC.h);                      // plane px per recording px (cover-fit)
const OFFX = (REC.w * CS - PW) / 2;                               // the cover crop, split left/right
/* Each project = a short frame sequence for the part where the page is not simply
   scrolling (hero imagery, parallax), then one stitched strip slid by scroll.
   `keys` are [u, y] stops on the project's own 0..1; equal y's are holds. */
const PROJ = {
  arjun: { dir: "/hero-story/arjun", hero: 8, hdr: 66, heroEnd: 0.14,
           keys: [[0.14, 0], [0.34, 620], [0.45, 620], [0.68, 1393], [1, 1393]] },
  amrit: { dir: "/hero-story/amrit", hero: 24, hdr: 58, heroEnd: 0.30,
           keys: [[0.30, 0], [0.54, 420], [0.64, 420], [0.84, 1663], [1, 1663]] },
};
const COLLEGES_SRC = "/hero-story/25colleges.webp";
const COLLEGES_H = 1430;                                          // CSS px of the design at the plane's 1440 width
const SERVICES_SRC = "/hero-story/services-state.webp";

/* ── the story on the 0..1 pin ── */
const T = {
  copy:     [0.04, 0.18],
  settle:   [0.08, 0.27],
  build:    [0.00, 0.15],
  result:   [0.15, 0.235],
  wipeArjun:  [0.200, 0.255],     // a page slides up over the one before it — no frame ever holds two blended pages
  arjun:      [0.245, 0.400],
  wipeAmrit:  [0.370, 0.425],
  amrit:      [0.425, 0.545],
  wipeColl:   [0.515, 0.570],
  colleges:   [0.570, 0.650],
  wipeSvc:    [0.640, 0.700],
  env:      [0.77, 0.81],
  hand:     [0.79, 0.835],
  body:     [0.815, 0.86],
  lid:      [0.86, 0.90],
  notch:    [0.815, 0.862],
  flatten:  [0.84, 0.95],
  radius:   [0.88, 0.95],
  ground:   [0.925, 0.955],
  handoff:  [0.955, 0.99],
};
const FREEZE_AT = 0.69, UNFREEZE_AT = 0.665;
const HEADER_LIGHT_AT = 0.88;

/* ── the idle loop, in seconds: code types, the output takes the glass, holds, and resets ── */
const IDLE = { type: 5.4, result: 0.7, out: 10.4, reset: 10.95, loop: 12.0 };
const IDLE_RESUME_MS = 650;                 // stillness at the top before the loop resumes
const FOLLOW = 0.16;                        // seconds: how fast build values chase their target (the rewind)

const clamp = (v) => Math.min(1, Math.max(0, v));
const seg = (p, [a, b]) => clamp((p - a) / (b - a));
const sm = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
/* a crossfade that spends less of its time as a double exposure */
const crisp = (a) => (a < 0.3 ? 0 : a > 0.7 ? 1 : sm((a - 0.3) / 0.4));

/* y on a strip for a project's progress u, easing in and out of every stop */
function stripY(keys, u) {
  if (u <= keys[0][0]) return 0;
  for (let i = 1; i < keys.length; i++) {
    const [u0, y0] = keys[i - 1], [u1, y1] = keys[i];
    if (u <= u1) return lerp(y0, y1, sm((u - u0) / (u1 - u0)));
  }
  return keys[keys.length - 1][1];
}

/* ── homography: unit square → quad, then as a CSS matrix3d ── */
function homography(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return { a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0, d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0, g, h };
}
function matrixFor(q, w, h) {
  const H = homography(q);
  return `matrix3d(${H.a / w},${H.d / w},0,${H.g / w},${H.b / h},${H.e / h},0,${H.h / h},0,0,1,0,${H.c},${H.f},0,1)`;
}

/* ── the code shown in the glass ── */
const CODE = rotatingWordSource.slice(rotatingWordSource.indexOf("export default function")).trimEnd();
const TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|export|default|function|const|let|return|if|else|new|true|false|null|typeof)\b|(\b\d+(?:\.\d+)?\b)|(<\/?[A-Za-z][\w.]*)|(\b[A-Za-z_]\w*(?=\())/g;
const TOKEN_CLASS = [null, "c", "s", "k", "n", "t", "f"];
const TOKENS = (() => {
  const out = []; let last = 0;
  for (const m of CODE.matchAll(TOKEN)) {
    if (m.index > last) out.push([null, CODE.slice(last, m.index)]);
    out.push([TOKEN_CLASS[m.findIndex((v, i) => i > 0 && v !== undefined)], m[0]]);
    last = m.index + m[0].length;
  }
  if (last < CODE.length) out.push([null, CODE.slice(last)]);
  return out;
})();
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function codeHtml(upto) {
  let left = upto, html = "";
  for (const [cls, text] of TOKENS) {
    if (left <= 0) break;
    const part = left >= text.length ? text : text.slice(0, left);
    left -= part.length;
    html += cls ? `<span class="hl-t-${cls}">${esc(part)}</span>` : esc(part);
  }
  return html;
}

/* ── frame sequences, loaded coarse-to-fine and only when their stage is near ── */
function coarseOrder(n) {
  const seen = new Set(), out = [];
  const add = (i) => { if (i >= 0 && i < n && !seen.has(i)) { seen.add(i); out.push(i); } };
  add(0); add(n - 1);
  for (let s = 16; s >= 1; s >>= 1) for (let i = 0; i < n; i += s) add(i);
  return out;
}
function makeSeq(name) {
  const n = PROJ[name].hero;
  return { name, n, path: (i) => `${PROJ[name].dir}/hero_${String(i + 1).padStart(2, "0")}.webp`,
           imgs: new Array(n), ok: new Array(n).fill(false), order: coarseOrder(n), next: 0, active: 0, started: false, key: "" };
}

function useLaptopMode() {
  const get = () => window.matchMedia(DESKTOP).matches && !window.matchMedia(REDUCED).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    const a = window.matchMedia(DESKTOP), b = window.matchMedia(REDUCED);
    const f = () => setOn(get());
    a.addEventListener("change", f); b.addEventListener("change", f);
    return () => { a.removeEventListener("change", f); b.removeEventListener("change", f); };
  }, []);
  return on;
}

export default function HeroLaptop({ onNav }) {
  return useLaptopMode() ? <LaptopHero onNav={onNav} /> : <HeroFrames onNav={onNav} />;
}

function LaptopHero({ onNav }) {
  const R = useRef({});          // every element the loop writes to
  const ref = (k) => (el) => { R.current[k] = el; };

  useLayoutEffect(() => {
    const E = R.current;
    const { root, sticky, copy, scrim, guard, base, view, video, env, body, lid, hand, vgL, vgT, vgB, vgR,
            screen, over, overCv, notch, glare, lBuild, lArjun, lAmrit, lColleges, lServices, code, pre, prev, prevStage, prevLbl,
            cArjun, cAmrit, sArjun, sAmrit, hArjun, hAmrit, colleges, services } = E;
    const snaps = [env, body, lid, hand];
    const seqs = { arjun: makeSeq("arjun"), amrit: makeSeq("amrit") };
    const cv = { arjun: cArjun, amrit: cAmrit };
    const ctxs = { arjun: cArjun.getContext("2d", { alpha: false }), amrit: cAmrit.getContext("2d", { alpha: false }) };
    const strip = { arjun: { img: sArjun, hdr: hArjun, y: -1, op: -1 }, amrit: { img: sAmrit, hdr: hAmrit, y: -1, op: -1 } };
    const stills = { arjun: [sArjun, hArjun], amrit: [sAmrit, hAmrit], colleges: [colleges], services: [services] };
    const started = {};

    let L = null, raf = 0, last = 0, frozen = false, dead = false;
    let pT = 0, pM = 0, pS = 0, lastScrollTs = -1e9, idleOn = true, idleT0 = performance.now();
    let bD = 0, rD = 0, fadeD = 1, lastChars = -1, lastTy = 0, lastR = -1;

    /* ── loading: a stage's media is requested as its scroll nears, and decoded before it is needed ── */
    const pump = (s) => {
      while (!dead && s.active < 3 && s.next < s.order.length) {
        const i = s.order[s.next++]; s.active++;
        const im = new Image(); im.decoding = "async";
        im.onload = () => { s.imgs[i] = im; s.ok[i] = true; s.active--; s.key = ""; kick(); pump(s); };
        im.onerror = () => { s.active--; pump(s); };
        im.src = s.path(i);
      }
    };
    const start = (name) => {
      if (started[name]) return; started[name] = true;
      if (seqs[name]) pump(seqs[name]);
      for (const el of stills[name]) {
        el.src = el.dataset.src;
        if (el.decode) el.decode().catch(() => {});          // raster cost is paid now, not on the frame it first appears
      }
    };

    /* ── a hero-frame sequence into its canvas, with a short, crisp crossfade between neighbours ── */
    const drawSeq = (name, f) => {
      const s = seqs[name]; let lo = -1, hi = -1;
      for (let i = Math.floor(f); i >= 0; i--) if (s.ok[i]) { lo = i; break; }
      for (let i = Math.ceil(f); i < s.n; i++) if (s.ok[i]) { hi = i; break; }
      if (lo < 0 && hi < 0) return;
      if (lo < 0) lo = hi; if (hi < 0) hi = lo;
      const a = hi === lo ? 0 : crisp((f - lo) / (hi - lo));
      const key = `${lo}:${hi}:${Math.round(a * 16)}`;
      if (key === s.key) return; s.key = key;
      const ctx = ctxs[name], w = cv[name].width, h = cv[name].height;
      ctx.globalAlpha = 1; ctx.drawImage(s.imgs[lo], 0, 0, w, h);
      if (a > 0.03) { ctx.globalAlpha = a; ctx.drawImage(s.imgs[hi], 0, 0, w, h); ctx.globalAlpha = 1; }
    };

    /* ── geometry ── */
    const measure = () => {
      const vw = sticky.clientWidth, vh = sticky.clientHeight;
      const el = copy.querySelector(".hero-copy");
      let x = 0, n = el;
      while (n && n !== sticky) { x += n.offsetLeft; n = n.offsetParent; }
      const copyRight = x + Math.min(640, el.offsetWidth);

      const xs = GLASS.map((p) => p[0]), gl = Math.min(...xs);
      const left = Math.max(vw * 0.5, copyRight + 20), right = vw * 1.03;
      const s = (right - left) / (BASE.w - gl);
      const ox = left - gl * s;
      const cyImg = GLASS.reduce((a, p) => a + p[1], 0) / 4;
      const oy = vh * 0.5 - cyImg * s;
      const q0 = GLASS.map(([px, py]) => [ox + px * s, oy + py * s]);
      const c0 = [q0.reduce((a, p) => a + p[0], 0) / 4, q0.reduce((a, p) => a + p[1], 0) / 4];

      /* The live Services is a fixed 1200px wrap centred at any width, and its
         rendered state is 1440 wide, so the plane lands where the cards are by
         centring it — no scaling to the viewport. */
      const tx = vw / 2 - PW / 2;
      const target = [[tx, 0], [tx + PW, 0], [tx + PW, PH], [tx, PH]];
      L = { vw, vh, s, ox, oy, q0, c0, tc: [vw * 0.5, vh * 0.5], target, baseRight: ox + BASE.w * s, run: root.offsetHeight - sticky.offsetHeight };
      guard.style.height = `${HEADER_LIGHT_AT * L.run + 90}px`;
    };

    /* ── the hand, back on top of the screen ──
       Key the skin out of the playing video inside a small region and draw it above the plane, so fingers that
       rise into the glass pass in FRONT of the screen instead of disappearing behind it. Only the part that is
       over the glass matters: outside it the video already shows the hand. */
    const N = OVER.w * OVER.h;
    const octx = overCv.getContext("2d");
    const mat = document.createElement("canvas"); mat.width = OVER.w; mat.height = OVER.h;     // the finished matte, before the vignettes
    const mctx = mat.getContext("2d");
    const ovT = { x: 0, y: 0, s: 1, vw: 0, vh: 0, vg: 1, ready: false, key: "" };
    const inkRgb = (getComputedStyle(root).getPropertyValue("--ink").trim() || "#0A0A12");
    const scratch = document.createElement("canvas"); scratch.width = OVER.w; scratch.height = OVER.h;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });
    const makeMask = (lw, blurPx) => {                           // the glass quad, dilated by lw/2, edge softened, as 0..1 per pixel of the region
      const c = document.createElement("canvas"); c.width = OVER.w; c.height = OVER.h;
      const x = c.getContext("2d", { willReadFrequently: true });
      if ("filter" in x) x.filter = `blur(${blurPx}px)`;
      x.fillStyle = x.strokeStyle = "#fff"; x.lineWidth = lw; x.lineJoin = "round";
      x.beginPath(); GLASS.forEach(([gx, gy], i) => (i ? x.lineTo(gx - OVER.x, gy - OVER.y) : x.moveTo(gx - OVER.x, gy - OVER.y)));
      x.closePath(); x.fill(); x.stroke();
      const d = x.getImageData(0, 0, OVER.w, OVER.h).data, m = new Float32Array(N);
      for (let i = 0; i < N; i++) m[i] = d[i * 4 + 3] / 255;
      return m;
    };
    const glassMask = makeMask(5, 1.2);                          // tight: the shadow and rim light belong on the glass only
    /* Where the hand layer meets the video's own hand (outside the glass) the two differ by a hair in tone, so a hard
       edge shows as a faint line through the hand. Fade the layer out over ~8px past the glass instead — underneath
       it is the same hand, so the fade only ever cross-fades one hand into itself. */
    const softMask = makeMask(16, 4);
    const skin = new Float32Array(N), cov = new Float32Array(N), tmp = new Float32Array(N), shA = new Float32Array(N), shB = new Float32Array(N), tmp2 = new Float32Array(N);
    let overActive = true;
    /* The blank glass, as it looks with no hand on it (the per-pixel median of the whole clip). Anything on the glass
       that differs from this IS the hand — whatever its colour or shadow — which a skin-colour key alone misses:
       shadowed fingers came out half-transparent, and where the hand crossed the glass edge that left a visible step. */
    let glassRef = null;
    { const im = new Image(); im.decoding = "async";
      im.onload = () => { const c = document.createElement("canvas"); c.width = OVER.w; c.height = OVER.h;
        const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0); glassRef = x.getImageData(0, 0, OVER.w, OVER.h).data; };
      if (HAND_OVER) im.src = "/hero-story/glass-ref.webp"; }
    /* 3x3 max / min over a Float32 field, for closing the matte's holes */
    const morph = (src, dst, pick) => {
      for (let y = 0; y < OVER.h; y++) for (let x = 0; x < OVER.w; x++) {
        let v = src[y * OVER.w + x];
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= OVER.h) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= OVER.w) continue; v = pick(v, src[yy * OVER.w + xx]); } }
        dst[y * OVER.w + x] = v;
      }
    };
    /* separable box blur of a Float32 field, radius r, edges clamped */
    const blur = (src, dst, tmpf, r) => {
      const W = OVER.w, H = OVER.h, k = 1 / (2 * r + 1);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let a = 0; for (let t = -r; t <= r; t++) a += src[y * W + Math.min(W - 1, Math.max(0, x + t))];
        tmpf[y * W + x] = a * k; }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let a = 0; for (let t = -r; t <= r; t++) a += tmpf[Math.min(H - 1, Math.max(0, y + t)) * W + x];
        dst[y * W + x] = a * k; }
    };
    /* The studio vignettes darken the video's own hand but sit under the plane, so the hand layer on top would come out
       brighter than the hand beside it — a visible patch at the glass edge. Paint the same four gradients onto the
       hand layer (source-atop: only where it has pixels), in viewport space through the laptop's current transform. */
    const paintOver = () => {
      if (!ovT.ready) return;
      const key = `${ovT.x.toFixed(1)}|${ovT.y.toFixed(1)}|${ovT.s.toFixed(4)}|${ovT.vg.toFixed(2)}|${ovT.vw}|${ovT.vh}`;
      if (key === ovT.key && !ovT.dirty) return; ovT.key = key; ovT.dirty = false;
      octx.globalCompositeOperation = "copy"; octx.globalAlpha = 1; octx.drawImage(mat, 0, 0);
      if (ovT.vg > 0.002) {
        const k = 1 / ovT.s;
        octx.save();
        octx.globalCompositeOperation = "source-atop"; octx.globalAlpha = ovT.vg;
        octx.setTransform(k, 0, 0, k, -ovT.x * k - OVER.x, -ovT.y * k - OVER.y);
        const { vw, vh } = ovT;
        const grad = (x0, y0, x1, y1, stop, x, y, w, h) => {
          const g = octx.createLinearGradient(x0, y0, x1, y1);
          g.addColorStop(stop, inkRgb); g.addColorStop(1, "rgba(0,0,0,0)");
          octx.fillStyle = g; octx.fillRect(x, y, w, h);
        };
        grad(0, 0, vw * 0.4, 0, 0.06, 0, 0, vw * 0.4, vh);                     // .hl-vg-l
        grad(0, 0, 0, vh * 0.2, 0.08, 0, 0, vw, vh * 0.2);                     // .hl-vg-t
        grad(0, vh, 0, vh * 0.78, 0.08, 0, vh * 0.78, vw, vh * 0.22);          // .hl-vg-b
        grad(vw, 0, vw * 0.93, 0, 0, vw * 0.93, 0, vw * 0.07, vh);             // .hl-vg-r
        octx.restore();
      }
    };
    const drawOver = () => {
      if (!overActive || video.readyState < 2) return;
      sctx.drawImage(video, OVER.x, OVER.y, OVER.w, OVER.h, 0, 0, OVER.w, OVER.h);
      const img = sctx.getImageData(0, 0, OVER.w, OVER.h), d = img.data;
      for (let i = 0, j = 0; i < N; i++, j += 4) {
        const r = d[j], g = d[j + 1], b = d[j + 2];
        let a = 0, sk = 0;
        if (glassRef) {                                            // what differs from blank glass
          const dv = Math.max(Math.abs(r - glassRef[j]), Math.abs(g - glassRef[j + 1]), Math.abs(b - glassRef[j + 2]));
          a = clamp((dv - 12) / 16);
        }
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
        if (c >= 12 && r - b >= 18) {                              // and what is skin-coloured, for the dim fingertips
          const hue = (mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60;
          const hd = Math.min(Math.abs(hue - 16), 360 - Math.abs(hue - 16));
          const k = clamp(1 - hd / 40) * clamp((r - b - 18) / 30) * clamp((c / mx * 255 - 28) / 40) * clamp((mx - 55) / 50);
          sk = clamp((k - 0.15) / 0.6);
        }
        skin[i] = sk; shA[i] = a * Math.max(0, Math.min(1, (r - b - 3) / 8));   // glass is neutral or cool; even a shadowed finger is warm
      }
      /* The reference is a median over the clip and the hand sits in this corner most of the time, so with the hand
         away the glass here differs from it — a grey patch that is not a hand. A difference only counts as hand when
         it is also warm (shadowed finger sides are; the grey glass is not). */
      for (let i = 0; i < N; i++) skin[i] = Math.max(skin[i], shA[i]);
      /* close the holes (max then min), then feather the edge: a solid hand with a soft outline, not a translucent one */
      morph(skin, tmp, Math.max); morph(tmp, cov, Math.min);
      for (let y = 0; y < OVER.h; y++) for (let x = 0; x < OVER.w; x++) {
        const i = y * OVER.w + x; let a = 0, wsum = 0;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= OVER.h) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= OVER.w) continue;
            const w = (2 - Math.abs(dx)) * (2 - Math.abs(dy)); a += cov[yy * OVER.w + xx] * w; wsum += w; } }
        tmp[i] = a / wsum;
      }
      /* seat the hand in the light of the screen: a soft occlusion shadow around it on the glass, and a little of the
         screen's white wrapping its edge — without both it reads as a cut-out laid on top */
      blur(cov, shA, shB, 3); blur(shA, shB, tmp2, 5);                                  // shB: wide soft field; shA: tight one
      for (let y = 0, i = 0; y < OVER.h; y++) for (let x = 0; x < OVER.w; x++, i++) {
        const j = i * 4, gm = glassMask[i];
        const a = clamp((tmp[i] - 0.3) / 0.4) * softMask[i];
        const sy = Math.min(OVER.h - 1, y + 3), occ = clamp(shB[sy * OVER.w + x] * 1.25) * 0.12 * gm * (1 - a);
        const wrap = clamp((0.9 - shA[i]) / 0.55) * 0.4 * a;                            // only the rim of the hand
        const r = d[j] + (246 - d[j]) * wrap, g = d[j + 1] + (243 - d[j + 1]) * wrap, b = d[j + 2] + (238 - d[j + 2]) * wrap;
        const oa = a + occ;
        if (oa <= 0.002) { d[j + 3] = 0; continue; }
        d[j] = (r * a) / oa; d[j + 1] = (g * a) / oa; d[j + 2] = (b * a) / oa; d[j + 3] = Math.round(oa * 255);
      }
      mctx.putImageData(img, 0, 0);
      ovT.ready = true; ovT.dirty = true; paintOver();
    };

    /* ── freeze: snapshot the playing frame into the dissolve layers ── */
    const freeze = () => {
      if (frozen || video.readyState < 2) return;
      video.pause();
      drawOver();                                                  // the hand layer must hold the same frozen frame
      for (const c of snaps) c.getContext("2d").drawImage(video, 0, 0, BASE.w, BASE.h);
      frozen = true; view.dataset.frozen = "1"; video.style.visibility = "hidden";
    };
    const unfreeze = () => {
      if (!frozen) return;
      frozen = false; view.dataset.frozen = "0"; video.style.visibility = "visible";
      for (const c of snaps) c.style.visibility = "hidden";
      video.play().catch(() => {});
    };

    const show = (el, o) => { el.style.opacity = String(o); el.style.visibility = o > 0.002 ? "visible" : "hidden"; };

    /* one project: hero frames while the page is not simply scrolling, then the strip slides */
    const project = (name, u) => {
      const d = PROJ[name], st = strip[name];
      drawSeq(name, seg(u, [0, d.heroEnd]) * (d.hero - 1));
      const op = sm(seg(u, [d.heroEnd - 0.012, d.heroEnd + 0.02]));
      const y = stripY(d.keys, u);
      if (y !== st.y) { st.y = y; st.img.style.transform = `translate3d(${-OFFX}px,${(d.hdr - y) * CS}px,0)`; }
      if (op !== st.op) { st.op = op; st.img.style.opacity = st.hdr.style.opacity = String(op); }
    };

    /* ── what the glass shows while building: real code typed to `b`, the component it renders taking over at `r` ── */
    const paintBuild = (b, r) => {
      const chars = Math.round(CODE.length * b);
      if (chars !== lastChars) {
        lastChars = chars;
        pre.innerHTML = codeHtml(chars) + '<span class="hl-caret"></span>';
        /* keep the caret in view: the pre grows as it types, so slide it up once it outgrows the panel */
        const ty = -Math.max(0, pre.offsetHeight - (PH - 64) + 28);
        if (ty !== lastTy) { lastTy = ty; pre.style.transform = `translate3d(0,${ty}px,0)`; }
      }
      if (r !== lastR) {
        lastR = r;
        prev.style.width = `${lerp(0.36, 1, r) * 100}%`;
        code.style.opacity = String(clamp(1 - r * 1.35));
        code.style.transform = `translate3d(${-r * 6}%,0,0)`;
        prevStage.style.fontSize = `${lerp(78, 168, r)}px`;
        prevLbl.style.opacity = String(1 - r);
      }
    };

    /* ── the frame: read scroll, ease the playhead, run idle or scroll build, paint ── */
    const tick = (now) => {
      raf = 0;
      if (!L || dead) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now;

      pT = clamp(-root.getBoundingClientRect().top / Math.max(1, L.run));
      /* The playhead eases toward the scroll position in two stages (two chained low-pass filters), which gives the
         motion an eased start as well as an eased stop — a single stage jumps to full speed the instant a wheel
         notch lands. It tightens near the end, so the takeover still meets the real scroll; at the very end it is exact. */
      if (pT >= 0.999 || (pT <= 0.0005 && pS < 0.004)) pM = pS = pT;
      else {
        const tau = lerp(0.085, 0.02, sm(seg(pT, [0.9, 1])));
        pM += (pT - pM) * (1 - Math.exp(-dt / tau));
        pS += (pM - pS) * (1 - Math.exp(-dt / tau));
        if (Math.abs(pT - pS) < 0.0003 && Math.abs(pT - pM) < 0.0003) pM = pS = pT;
      }
      const p = pS;

      /* load each stage before its scroll arrives */
      if (pT > 0.01) start("arjun");
      if (pT > 0.14) start("amrit");
      if (pT > 0.28) start("colleges");
      if (pT > 0.42) start("services");

      if (p >= FREEZE_AT) freeze(); else if (p < UNFREEZE_AT) unfreeze();

      /* ── idle vs scroll: what Build should be showing ── */
      const idle = pT <= 0.0015 && now - lastScrollTs > IDLE_RESUME_MS && p < 0.004;
      if (idle && !idleOn) { idleOn = true; idleT0 = now; }
      if (!idle) idleOn = false;
      let tB, tR, tF = 1;
      if (idleOn) {
        const t = ((now - idleT0) / 1000) % IDLE.loop;
        const reset = t >= IDLE.reset;
        tB = reset ? 0 : clamp(t / IDLE.type);
        tR = reset ? 0 : sm(seg(t, [IDLE.type, IDLE.type + IDLE.result]));
        tF = t < IDLE.out ? 1 : reset ? sm(seg(t, [IDLE.reset, IDLE.reset + 0.5])) : 1 - sm(seg(t, [IDLE.out, IDLE.reset]));
      } else { tB = sm(seg(p, T.build)); tR = sm(seg(p, T.result)); }
      /* chase the target: this is what rewinds the idle output when scrolling begins */
      const k = 1 - Math.exp(-dt / FOLLOW);
      bD += (tB - bD) * k; rD += (tR - rD) * k; fadeD += (tF - fadeD) * (1 - Math.exp(-dt / 0.12));
      if (idleOn && fadeD < 0.05) { bD = tB; rD = tR; }                      // reset happens while it is invisible
      if (Math.abs(bD - tB) < 0.0008) bD = tB;
      if (Math.abs(rD - tR) < 0.0008) rD = tR;
      if (Math.abs(fadeD - tF) < 0.003) fadeD = tF;

      /* ── hero copy ── */
      const c = sm(seg(p, T.copy));
      copy.style.opacity = String(1 - c);
      copy.style.transform = `translate3d(${-36 * c}px,0,0)`;
      copy.style.pointerEvents = c > 0.85 ? "none" : "auto";
      scrim.style.opacity = String(1 - c);

      /* ── laptop settles toward the centre and grows; held once settled ── */
      const e = sm(seg(p, T.settle));
      const sg = 1 + 0.5 * e;
      const dxF = L.tc[0] - L.c0[0], dyF = L.tc[1] - L.c0[1];
      let tx = e * dxF; const ty = e * dyF;
      tx = Math.max(tx, L.vw + 2 - (L.c0[0] + sg * (L.baseRight - L.c0[0])));
      const bt = `translate3d(${L.c0[0] + sg * (L.ox - L.c0[0]) + tx}px,${L.c0[1] + sg * (L.oy - L.c0[1]) + ty}px,0) scale(${L.s * sg})`;
      base.style.transform = over.style.transform = bt;               // the hand layer rides exactly with the laptop
      ovT.x = L.c0[0] + sg * (L.ox - L.c0[0]) + tx; ovT.y = L.c0[1] + sg * (L.oy - L.c0[1]) + ty; ovT.s = L.s * sg;
      ovT.vw = L.vw; ovT.vh = L.vh;

      /* ── dissolve: environment, then hand, body, and last the bezel ── */
      const oEnv = 1 - sm(seg(p, T.env)), oHand = 1 - sm(seg(p, T.hand)), oBody = 1 - sm(seg(p, T.body)), oLid = 1 - sm(seg(p, T.lid));
      if (frozen) { show(env, oEnv); show(hand, oHand); show(body, oBody); show(lid, oLid); }
      show(over, HAND_OVER ? oHand : 0); overActive = HAND_OVER && oHand > 0.002;                    // fades with the hand, and stops costing anything once gone
      for (const v of [vgL, vgT, vgB, vgR]) show(v, oEnv);
      ovT.vg = oEnv; if (overActive) paintOver();
      view.style.visibility = oEnv + oHand + oBody + oLid > 0.002 ? "visible" : "hidden";

      /* ── the glass ── */
      const qg = L.q0.map(([x, y]) => [L.c0[0] + sg * (x - L.c0[0]) + tx, L.c0[1] + sg * (y - L.c0[1]) + ty]);
      const b = sm(seg(p, T.flatten));
      const q = qg.map((pt, i) => [lerp(pt[0], L.target[i][0], b), lerp(pt[1], L.target[i][1], b)]);
      screen.style.transform = matrixFor(q, PW, PH);
      screen.style.borderRadius = `${PLANE_RADIUS * (1 - sm(seg(p, T.radius)))}px`;
      show(notch, 1 - sm(seg(p, T.notch)));
      show(glare, oLid * 0.9);

      /* ── what the glass shows: each page wipes up over the last (layers are stacked in story order) ── */
      const wA = sm(seg(p, T.wipeArjun)), wB = sm(seg(p, T.wipeAmrit)), wC = sm(seg(p, T.wipeColl)), wD = sm(seg(p, T.wipeSvc));
      const wipe = (el, w, hidden) => {
        el.style.visibility = w > 0 && !hidden ? "visible" : "hidden";
        el.style.transform = w >= 1 ? "none" : `translate3d(0,${(1 - w) * 100}%,0)`;
      };
      const oBuild = (wA < 1 ? 1 : 0) * fadeD;                                  // Build is covered, not faded
      const oArjun = wA > 0 && wB < 1 ? 1 : 0, oAmrit = wB > 0 && wC < 1 ? 1 : 0, oCol = wC > 0 && wD < 1 ? 1 : 0;
      show(lBuild, oBuild);
      wipe(lArjun, wA, wB >= 1); wipe(lAmrit, wB, wC >= 1); wipe(lColleges, wC, wD >= 1); wipe(lServices, wD, false);
      lArjun.style.opacity = lAmrit.style.opacity = lColleges.style.opacity = lServices.style.opacity = "1";

      if (oBuild > 0.002) paintBuild(bD, rD);
      if (oArjun > 0.002) project("arjun", seg(p, T.arjun));
      if (oAmrit > 0.002) project("amrit", seg(p, T.amrit));
      if (oCol > 0.002) {
        const kk = sm(seg(p, T.colleges));
        colleges.style.transform = `translate3d(0,${-(COLLEGES_H - PH) * kk}px,0) scale(${1 + 0.04 * kk})`;
      }

      /* ── ground and handoff ── */
      const g = sm(seg(p, T.ground)), mix = (a, z) => Math.round(lerp(a, z, g));
      sticky.style.backgroundColor = `rgb(${mix(10, 244)},${mix(10, 244)},${mix(18, 241)})`;
      sticky.style.opacity = String(1 - sm(seg(p, T.handoff)));
      sticky.style.visibility = p >= 0.992 ? "hidden" : "visible";
      root.dataset.p = p.toFixed(3);

      /* keep going while anything is still moving; otherwise rest until the next scroll */
      const busy = idleOn || pT !== pS || bD !== tB || rD !== tR || fadeD !== tF;
      if (busy && !document.hidden) raf = requestAnimationFrame(tick);
    };

    function kick() { if (!raf && !dead) { last = performance.now(); raf = requestAnimationFrame(tick); } }
    const onScroll = () => { lastScrollTs = performance.now(); kick(); };
    const onResize = () => { measure(); kick(); };
    const onVisible = () => { if (!document.hidden) { idleT0 = performance.now(); kick(); } };

    video.muted = true; video.defaultMuted = true;
    video.play().catch(() => {});
    /* the matte follows the video frame by frame, independent of the scroll loop (which rests when nothing moves) */
    let overTimer = 0;
    if (video.requestVideoFrameCallback) {
      const onVideoFrame = () => { if (dead) return; drawOver(); video.requestVideoFrameCallback(onVideoFrame); };
      video.requestVideoFrameCallback(onVideoFrame);
    } else overTimer = setInterval(() => { if (!video.paused) drawOver(); }, 42);

    measure();
    last = performance.now();
    raf = requestAnimationFrame(tick);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      dead = true;
      clearInterval(overTimer);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <div className="hl-scrub" ref={ref("root")}>
      {/* Stands in for the hero in the header's light/dark check. Sized in JS. */}
      <div className="hero-section hl-guard" ref={ref("guard")} aria-hidden="true" />
      <div className="hl-sticky" ref={ref("sticky")}>

        {/* the laptop: a real video, with the same frame snapshotted into masked layers for the dissolve */}
        <div className="hl-base" ref={ref("base")} aria-hidden="true">
          <div className="hl-view" ref={ref("view")} data-frozen="0">
            <video className="hl-video" ref={ref("video")} src="/hero-story/laptop-trackpad.mp4"
                   poster="/hero-story/laptop-trackpad-poster.webp" autoPlay muted loop playsInline preload="auto" />
            <canvas className="hl-snap hl-snap-env" ref={ref("env")} width={BASE.w} height={BASE.h} />
            <canvas className="hl-snap hl-snap-body" ref={ref("body")} width={BASE.w} height={BASE.h} />
            <canvas className="hl-snap hl-snap-lid" ref={ref("lid")} width={BASE.w} height={BASE.h} />
            <canvas className="hl-snap hl-snap-hand" ref={ref("hand")} width={BASE.w} height={BASE.h} />
          </div>
          <i className="hl-vg hl-vg-l" ref={ref("vgL")} />
          <i className="hl-vg hl-vg-t" ref={ref("vgT")} />
          <i className="hl-vg hl-vg-b" ref={ref("vgB")} />
          <i className="hl-vg hl-vg-r" ref={ref("vgR")} />
        </div>

        {/* the glass — one flat plane, mapped onto the laptop and later onto the page */}
        <div className="hl-screen" ref={ref("screen")} aria-hidden="true">
          <div className="hl-layer hl-build" ref={ref("lBuild")}>
            <div className="hl-code" ref={ref("code")}>
              <div className="hl-code-bar"><i /><i /><i /><span>RotatingWord.jsx</span></div>
              <pre className="hl-pre" ref={ref("pre")} />
            </div>
            <div className="hl-prev" ref={ref("prev")}>
              <span className="hl-prev-lbl" ref={ref("prevLbl")}>Preview</span>
              <div className="hl-prev-stage" ref={ref("prevStage")}>
                <RotatingWord words={["grow.", "convert.", "automate."]} />
              </div>
            </div>
          </div>
          <div className="hl-layer" ref={ref("lArjun")}>
            <canvas className="hl-fill" ref={ref("cArjun")} width={REC.w} height={REC.h} />
            <img className="hl-strip" ref={ref("sArjun")} data-src="/hero-story/arjun/strip.webp" alt="" decoding="async" />
            <img className="hl-hdr" ref={ref("hArjun")} data-src="/hero-story/arjun/header.webp" alt="" decoding="async" />
          </div>
          <div className="hl-layer" ref={ref("lAmrit")}>
            <canvas className="hl-fill" ref={ref("cAmrit")} width={REC.w} height={REC.h} />
            <img className="hl-strip" ref={ref("sAmrit")} data-src="/hero-story/amrit/strip.webp" alt="" decoding="async" />
            <img className="hl-hdr" ref={ref("hAmrit")} data-src="/hero-story/amrit/header.webp" alt="" decoding="async" />
          </div>
          <div className="hl-layer hl-colleges-wrap" ref={ref("lColleges")}>
            <img className="hl-colleges" ref={ref("colleges")} data-src={COLLEGES_SRC} alt="" decoding="async" />
          </div>
          <div className="hl-layer" ref={ref("lServices")}>
            <img className="hl-fill" ref={ref("services")} data-src={SERVICES_SRC} alt="" decoding="async" />
          </div>
          <i className="hl-notch" ref={ref("notch")} />
          <i className="hl-glare" ref={ref("glare")} />
        </div>

        {/* the hand, keyed back on top of the glass; rides with the laptop */}
        <div className="hl-over" ref={ref("over")} aria-hidden="true">
          <canvas ref={ref("overCv")} width={OVER.w} height={OVER.h} style={{ left: OVER.x, top: OVER.y }} />
        </div>

        <div className="hl-scrim" ref={ref("scrim")} />

        <div className="hl-copy" ref={ref("copy")}>
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
