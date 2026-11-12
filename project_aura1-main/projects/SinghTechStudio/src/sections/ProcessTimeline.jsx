import { useEffect, useRef, useState } from "react";

/* Scroll-drawn process timeline.

   Progress is traced onto the geometry that is already there: the active arc
   sits exactly on the node's own 2px border, and the active connector exactly
   on the rail between two nodes. Nothing is drawn outside them, so each step
   stays a single circle.

   The visible strokes are split across two layers — connectors beneath the
   nodes, arcs above them — so the accent paints over the neutral border
   without a connector ever crossing a numeral. A third, invisible guide path
   carries the continuous journey (arc, then down to the next arc) and is used
   only to position the travelling head, which is what keeps the motion
   reading as one movement rather than a set of separate fades.

   Progress logic (lerp smoothing, velocity → energy for the head) is ported
   from ElectricTimeline/useTimelineProgress in the portfolio project; that one
   is framer-motion + TS and draws a straight wire. */

/* The node is 48px across with a 2px border, so its border centreline — and
   therefore the active arc — is at exactly 23. Anything larger would read as
   a second ring outside the circle. */
const R = 23;
const CX = 24;

export default function ProcessTimeline({ steps }) {
  const hostRef  = useRef(null);
  const railRef  = useRef(null);
  const guideRef = useRef(null);
  const headRef  = useRef(null);
  const linesRef = useRef(null);
  const ringsRef = useRef(null);
  const connRefs = useRef([]);
  const ringRefs = useRef([]);
  const [active, setActive] = useState(-1);
  const [current, setCurrent] = useState(-1);

  useEffect(() => {
    const host = hostRef.current, guide = guideRef.current, head = headRef.current;
    const rail = railRef.current;
    if (!host || !guide) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

    let target = 0, cur = 0, raf = 0, running = false, energy = 0;
    let C = 0, arrivals = [], gaps = [], total = 0, L = 0, k = 1;

    const measure = () => {
      const hostTop = host.getBoundingClientRect().top;
      const nodes = [...host.querySelectorAll(".ptl-node")];
      if (!nodes.length) return;
      const ys = nodes.map(n => {
        const r = n.getBoundingClientRect();
        return r.top + r.height / 2 - hostTop;
      });

      C = 2 * Math.PI * R;
      gaps = ys.slice(1).map((y, i) => y - ys[i]);

      arrivals = [];
      let acc = 0;
      ys.forEach((_, i) => { if (i > 0) acc += C + gaps[i - 1]; arrivals.push(acc); });
      total = acc + C;

      /* Guide: arc, then straight down to the next arc. Never drawn. */
      let d = `M ${CX} ${ys[0] - R}`;
      ys.forEach((y, i) => {
        d += ` A ${R} ${R} 0 0 1 ${CX} ${y + R} A ${R} ${R} 0 0 1 ${CX} ${y - R}`;
        if (i < ys.length - 1) d += ` L ${CX} ${ys[i + 1] - R}`;
      });
      guide.setAttribute("d", d);
      L = guide.getTotalLength();
      k = total > 0 ? L / total : 1;   /* browser length ÷ analytic length */

      /* Active arc: same centre, same radius as the node border. Rotated so
         the dash begins at the top rather than at 3 o'clock. */
      ringRefs.current.forEach((c, i) => {
        if (!c) return;
        c.setAttribute("cx", CX); c.setAttribute("cy", ys[i]); c.setAttribute("r", R);
        c.setAttribute("transform", `rotate(-90 ${CX} ${ys[i]})`);
        c.style.strokeDasharray = `${C}`;
      });
      /* Active connector: only the rail between two circles. */
      connRefs.current.forEach((ln, i) => {
        if (!ln) return;
        ln.setAttribute("x1", CX); ln.setAttribute("x2", CX);
        ln.setAttribute("y1", ys[i] + R); ln.setAttribute("y2", ys[i + 1] - R);
        ln.style.strokeDasharray = `${Math.max(0, gaps[i] - 2 * R)}`;
      });

      /* The rail spans the milestones themselves. The container runs on past
         the last node to cover its description, and letting the rail follow it
         left a stub hanging below the final circle. */
      if (rail) {
        rail.style.top = `${ys[0]}px`;
        rail.style.bottom = "auto";
        rail.style.height = `${ys[ys.length - 1] - ys[0]}px`;
      }

      const h = `${host.offsetHeight}px`;
      if (linesRef.current) linesRef.current.style.height = h;
      if (ringsRef.current) ringsRef.current.style.height = h;
      paint(cur);
    };

    const computeTarget = () => {
      const r = host.getBoundingClientRect();
      const vh = window.innerHeight;
      target = clamp((vh * 0.82 - r.top) / Math.max(1, r.height + vh * 0.05));
    };

    const paint = (v) => {
      const drawn = v * total;          /* in analytic units */

      ringRefs.current.forEach((c, i) => {
        if (!c) return;
        const p = clamp((drawn - arrivals[i]) / C);
        c.style.strokeDashoffset = `${C * (1 - p)}`;
      });

      connRefs.current.forEach((ln, i) => {
        if (!ln) return;
        const local = drawn - (arrivals[i] + C);   /* distance into this leg */
        const span = Math.max(1, gaps[i] - 2 * R);
        const p = clamp((local - R) / span);       /* the first R is behind the node */
        ln.style.strokeDashoffset = `${span * (1 - p)}`;
      });

      if (head && L > 0) {
        const pt = guide.getPointAtLength(clamp(drawn * k, 0, L));
        head.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0)`;
        head.style.opacity = v > 0.002 && v < 0.999 ? "1" : "0";
        host.style.setProperty("--e", energy.toFixed(3));
      }

      let done = -1, cr = -1;
      for (let i = 0; i < arrivals.length; i++) {
        if (drawn >= arrivals[i] + C) done = i;
        if (drawn >= arrivals[i] - 1) cr = i;
      }
      setActive(p => (p === done ? p : done));
      setCurrent(p => (p === cr ? p : cr));
    };

    const tick = () => {
      const prev = cur;
      cur += (target - cur) * 0.14;
      if (Math.abs(target - cur) < 0.0004) { cur = target; running = false; }
      energy += (clamp(Math.abs(cur - prev) * 26) - energy) * 0.18;
      paint(cur);
      if (running) raf = requestAnimationFrame(tick);
    };

    const kick = () => {
      computeTarget();
      if (reduce.matches) { cur = target; energy = 0; paint(cur); return; }
      if (!running) { running = true; raf = requestAnimationFrame(tick); }
    };

    const onResize = () => { measure(); kick(); };

    measure();
    computeTarget();
    cur = target;
    paint(cur);

    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", onResize);
    const settle = setTimeout(onResize, 250);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", kick);
      window.removeEventListener("resize", onResize);
      clearTimeout(settle);
      if (ro) ro.disconnect();
    };
  }, [steps]);

  return (
    <div className="ptl" ref={hostRef}>
      <div className="ptl-line" ref={railRef} />

      {/* Connectors sit beneath the nodes, so the leg behind a circle never
          shows across its numeral. The guide lives here, unstroked. */}
      <svg className="ptl-svg ptl-svg-lines" ref={linesRef} aria-hidden="true" focusable="false">
        <path className="ptl-guide" ref={guideRef} />
        {steps.slice(1).map((s, i) => (
          <line key={s.title} className="ptl-conn" ref={el => (connRefs.current[i] = el)} />
        ))}
      </svg>

      {steps.map((s, i) => (
        <div key={s.title} className={`ptl-step ${i <= active ? "on" : ""} ${i === current ? "cur" : ""}`}>
          <div className="ptl-node">{String(i + 1).padStart(2, "0")}</div>
          <div className="ptl-body">
            <h3 className="ptl-h">{s.title}</h3>
            <p className="ptl-p">{s.desc}</p>
          </div>
        </div>
      ))}

      {/* Arcs sit above the nodes so the accent paints onto the border itself. */}
      <svg className="ptl-svg ptl-svg-rings" ref={ringsRef} aria-hidden="true" focusable="false">
        {steps.map((s, i) => (
          <circle key={s.title} className="ptl-ring" ref={el => (ringRefs.current[i] = el)} />
        ))}
      </svg>

      <span className="ptl-head" ref={headRef} aria-hidden="true">
        <span className="ptl-head-glow" />
        <span className="ptl-head-core" />
      </span>
    </div>
  );
}
