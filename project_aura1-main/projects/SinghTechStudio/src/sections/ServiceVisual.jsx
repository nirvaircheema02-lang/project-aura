/* Small coded scenes, one per service.

   Deliberately not photography: Who We Help carries the real-world imagery and
   Work carries the actual projects, so Services needs its own language. These
   are inline SVG on a tinted panel — a few hundred bytes each, they scale with
   the card, they recolour with the brand token, and they are editable without
   going near an image pipeline.

   `b` is the brand accent, `n` a neutral line, `f` a soft fill. */
const b = "var(--brand)";
const n = "var(--border-str, #D8D8D2)";
const f = "var(--brand-soft)";

function Frame({ children }) {
  return (
    <svg viewBox="0 0 220 128" className="svc-svg" role="img" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/* 01 — a desktop and a phone showing the same page: design and build. */
const Website = () => (
  <Frame>
    <rect x="18" y="20" width="140" height="92" rx="7" fill="#fff" stroke={n} />
    <rect x="18" y="20" width="140" height="15" rx="7" fill={f} />
    <circle cx="28" cy="27" r="2.4" fill={b} opacity=".55" />
    <circle cx="36" cy="27" r="2.4" fill={n} />
    <rect x="28" y="45" width="56" height="7" rx="3.5" fill={b} opacity=".85" />
    <rect x="28" y="58" width="90" height="4" rx="2" fill={n} />
    <rect x="28" y="66" width="72" height="4" rx="2" fill={n} />
    <rect x="28" y="80" width="34" height="11" rx="5.5" fill={b} />
    <rect x="96" y="45" width="50" height="46" rx="5" fill={f} />
    <rect x="150" y="52" width="52" height="76" rx="9" fill="#fff" stroke={n} />
    <rect x="157" y="62" width="30" height="5" rx="2.5" fill={b} opacity=".85" />
    <rect x="157" y="73" width="38" height="3.5" rx="1.75" fill={n} />
    <rect x="157" y="81" width="30" height="3.5" rx="1.75" fill={n} />
    <rect x="157" y="93" width="38" height="24" rx="4" fill={f} />
  </Frame>
);

/* 02 — wireframe on the left resolving into a finished screen on the right. */
const UIUX = () => (
  <Frame>
    <rect x="16" y="24" width="80" height="84" rx="6" fill="#fff" stroke={n} strokeDasharray="4 3" />
    <rect x="26" y="34" width="40" height="6" rx="3" fill={n} />
    <rect x="26" y="46" width="60" height="4" rx="2" fill={n} opacity=".7" />
    <rect x="26" y="56" width="60" height="4" rx="2" fill={n} opacity=".7" />
    <rect x="26" y="68" width="27" height="27" rx="4" fill={n} opacity=".35" />
    <rect x="59" y="68" width="27" height="27" rx="4" fill={n} opacity=".35" />
    <path d="M100 66h20" stroke={b} strokeWidth="1.6" strokeLinecap="round" strokeDasharray="3 3" />
    <path d="M116 62l5 4-5 4" stroke={b} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <rect x="126" y="24" width="80" height="84" rx="6" fill="#fff" stroke={n} />
    <rect x="136" y="34" width="44" height="6" rx="3" fill={b} />
    <rect x="136" y="46" width="60" height="4" rx="2" fill={n} />
    <rect x="136" y="56" width="48" height="4" rx="2" fill={n} />
    <rect x="136" y="68" width="27" height="27" rx="4" fill={f} />
    <rect x="169" y="68" width="27" height="27" rx="4" fill={b} opacity=".9" />
  </Frame>
);

/* 03 — the parts of an identity: mark, type, palette. */
const Brand = () => (
  <Frame>
    <rect x="22" y="26" width="76" height="76" rx="10" fill={f} />
    <path d="M48 76l12-28 12 28M53 66h14" stroke={b} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <rect x="110" y="26" width="88" height="42" rx="7" fill="#fff" stroke={n} />
    <text x="122" y="56" fontFamily="Manrope, sans-serif" fontSize="24" fontWeight="800" fill={b}>Aa</text>
    <rect x="158" y="38" width="30" height="3.5" rx="1.75" fill={n} />
    <rect x="158" y="46" width="22" height="3.5" rx="1.75" fill={n} />
    <circle cx="122" cy="88" r="11" fill={b} />
    <circle cx="146" cy="88" r="11" fill={b} opacity=".5" />
    <circle cx="170" cy="88" r="11" fill="#14141F" />
    <circle cx="194" cy="88" r="11" fill="#fff" stroke={n} />
  </Frame>
);

/* 04 — a campaign card beside a climbing trend. No numbers invented. */
const Growth = () => (
  <Frame>
    <rect x="18" y="26" width="78" height="76" rx="7" fill="#fff" stroke={n} />
    <rect x="28" y="36" width="42" height="5" rx="2.5" fill={b} />
    <rect x="28" y="47" width="58" height="3.5" rx="1.75" fill={n} />
    <rect x="28" y="55" width="46" height="3.5" rx="1.75" fill={n} />
    <rect x="28" y="68" width="58" height="24" rx="5" fill={f} />
    <rect x="110" y="26" width="92" height="76" rx="7" fill="#fff" stroke={n} />
    <path d="M122 88l18-16 16 10 24-28" stroke={b} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <circle cx="180" cy="54" r="4" fill={b} />
    <rect x="122" y="94" width="14" height="4" rx="2" fill={n} />
    <rect x="142" y="94" width="14" height="4" rx="2" fill={n} />
    <rect x="162" y="94" width="14" height="4" rx="2" fill={n} />
  </Frame>
);

/* 05 — a search result and a visibility trend. No ranking claims. */
const Search = () => (
  <Frame>
    <rect x="18" y="24" width="184" height="26" rx="13" fill="#fff" stroke={n} />
    <circle cx="36" cy="37" r="6" fill="none" stroke={b} strokeWidth="2" />
    <path d="M40.5 41.5l5 5" stroke={b} strokeWidth="2" strokeLinecap="round" />
    <rect x="52" y="34" width="86" height="5" rx="2.5" fill={n} />
    <rect x="18" y="60" width="110" height="42" rx="7" fill="#fff" stroke={n} />
    <rect x="28" y="70" width="60" height="5" rx="2.5" fill={b} />
    <rect x="28" y="81" width="86" height="3.5" rx="1.75" fill={n} />
    <rect x="28" y="89" width="66" height="3.5" rx="1.75" fill={n} />
    <rect x="140" y="60" width="62" height="42" rx="7" fill={f} />
    <path d="M150 92l12-10 10 6 20-18" stroke={b} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </Frame>
);

/* 06 — the path a lead actually takes. Nodes, not robots. */
const Automation = () => (
  <Frame>
    {[
      { x: 20, label: "Lead" },
      { x: 72, label: "AI" },
      { x: 124, label: "CRM" },
      { x: 176, label: "Reply" },
    ].map((s, i) => (
      <g key={s.label}>
        {i < 3 && <path d={`M${s.x + 27} 64h18`} stroke={n} strokeWidth="1.6" strokeLinecap="round" strokeDasharray="3 3" />}
        <rect x={s.x} y="46" width="26" height="36" rx="7" fill={i === 1 ? b : "#fff"} stroke={i === 1 ? b : n} />
        {i === 1 && <path d="M80 60l3 6 3-6M80 70h6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none" />}
        {i !== 1 && <circle cx={s.x + 13} cy="64" r="4" fill={b} opacity={i === 0 ? ".9" : ".55"} />}
        <text x={s.x + 13} y="98" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="9" fontWeight="600" fill="var(--muted)">{s.label}</text>
      </g>
    ))}
  </Frame>
);

const MAP = { website: Website, uiux: UIUX, brand: Brand, mktg: Growth, seo: Search, ai: Automation };

/* `media` is the swap-in point for later assets — pass
   { type: "video", src, poster } or { type: "image", src, alt } and the drawn
   scene steps aside. The container, its ratio and its styling stay the same
   either way, so replacing a visual is a data change, not a layout change. */
export default function ServiceVisual({ kind, media }) {
  const V = MAP[kind];
  return (
    <div className="svc-vis">
      {media?.type === "video" ? (
        <video className="svc-media" src={media.src} poster={media.poster}
               autoPlay muted loop playsInline preload="metadata" />
      ) : media?.type === "image" ? (
        <img className="svc-media" src={media.src} alt={media.alt || ""} loading="lazy" decoding="async" />
      ) : V ? (
        <V />
      ) : null}
    </div>
  );
}
