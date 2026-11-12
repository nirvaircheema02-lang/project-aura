'use client';

import { useEffect, useRef, useState } from 'react';

const STEPS: [string, string, string][] = [
  ['01', 'Function-Level Integration Mapping', 'Conducted comprehensive mapping across Finance, HR, Supply Chain, Sales, Quality, and Regulatory Affairs. Identified cultural, process, and compliance gaps between entities. Developed harmonization pathways aligned with governance standards.'],
  ['02', 'SOP & Risk Practice Benchmarking', 'Benchmarked existing SOPs, audit findings, risk controls, and compliance mechanisms against governance standards. Highlighted high-priority remediation areas and designed a unified compliance framework.'],
  ['03', 'SEBI Compliance Support', 'Developed a comprehensive IPO readiness report aligned with SEBI disclosure requirements. Built investor inputs across market potential, business strengths, risk factors, and long-term opportunity mapping.'],
  ['04', 'Primary Research & Stakeholder Interviews', 'Conducted structured interviews with utility procurement heads, transformer OEM engineers, and EPC project managers to validate demand signals and gather real-time competitive pricing intelligence across voltage segments.'],
  ['05', 'Strategic Narrative & IPO Readiness Report', 'Synthesised all findings into an investor-ready market narrative — covering TAM–SAM–SOM sizing, competitive moats, supply chain resilience, and capacity expansion pathways aligned with SEBI disclosure standards.'],
];

const D = 36; // circle diameter

/**
 * Research Methodology steps — scroll interaction matching the Figma site:
 * the active step is whichever step's row center is nearest the viewport's
 * vertical center; the red connector line fills from the first circle to the
 * active circle (animated). Steps are also clickable.
 */
export default function MethodologySteps() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const circleRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [lineH, setLineH] = useState(0);

  // Active = step whose row center is closest to the middle of the viewport.
  useEffect(() => {
    const onScroll = () => {
      const mid = window.innerHeight * 0.5;
      let best = 0;
      let bestDist = Infinity;
      rowRefs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dist = Math.abs(r.top + r.height / 2 - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      setActive(best);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  // Red line height = distance from the first circle center to the active circle center.
  useEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current;
      const first = circleRefs.current[0];
      const act = circleRefs.current[active];
      if (!wrap || !first || !act) return;
      const wb = wrap.getBoundingClientRect();
      const m = first.getBoundingClientRect().top + D / 2 - wb.top;
      const n = act.getBoundingClientRect().top + D / 2 - wb.top;
      setLineH(Math.max(0, n - m));
    };
    const id = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', measure);
    };
  }, [active]);

  return (
    <div className="msteps" ref={wrapRef}>
      <div className="msteps-track" />
      <div className="msteps-prog" style={{ height: `${lineH}px` }} />
      {STEPS.map(([num, title, desc], i) => (
        <div
          className={`mstep${i === active ? ' on' : ''}`}
          key={num}
          ref={(el) => {
            rowRefs.current[i] = el;
          }}
          onClick={() => setActive(i)}
        >
          <div
            className="mstep-num"
            ref={(el) => {
              circleRefs.current[i] = el;
            }}
          >
            {num}
          </div>
          <div className="mstep-body">
            <div className="mstep-ttl">{title}</div>
            <div className="mstep-desc">{desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
