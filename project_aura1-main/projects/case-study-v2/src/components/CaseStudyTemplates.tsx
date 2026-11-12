'use client';

import { useEffect, useRef, useState } from 'react';
import { animate, inView } from 'framer-motion';
import TemplateA from './TemplateA';
import TemplateB from './TemplateB';
import TemplateC from './TemplateC';
import TemplateD from './TemplateD';
import TemplateE from './TemplateE';

type TemplateKey = 'a' | 'b' | 'c' | 'd' | 'e';

const TABS: { key: TemplateKey; label: string }[] = [
  { key: 'a', label: 'A — Stat-led' },
  { key: 'b', label: 'B — Narrative' },
  { key: 'c', label: 'C — Visual' },
  { key: 'd', label: 'D — Quote' },
  { key: 'e', label: 'E — IPO' },
];

const TEMPLATES: Record<TemplateKey, React.ComponentType> = {
  a: TemplateA,
  b: TemplateB,
  c: TemplateC,
  d: TemplateD,
  e: TemplateE,
};

export default function CaseStudyTemplates() {
  const [active, setActive] = useState<TemplateKey>('a');
  const panelRef = useRef<HTMLDivElement>(null);

  // Reveal-on-scroll via Framer Motion. Every `.fu` element fades + rises (or
  // slides from the side for `.fu-l`/`.fu-r`) the moment it enters the viewport
  // — `inView` (IntersectionObserver under the hood) triggers `animate`, so it
  // fires as the element becomes visible rather than early/off-screen. Motion
  // drives the DOM element directly: no wrapper components, no layout shift.
  useEffect(() => {
    const root = panelRef.current;
    if (!root) return;
    const targets = Array.from(root.querySelectorAll<HTMLElement>('.fu'));
    if (!targets.length) return;

    // Reduced motion: show everything immediately, no animation.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      targets.forEach((el) => {
        el.style.opacity = '1';
        el.style.transform = 'none';
      });
      return;
    }

    const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
    const DURATION = 1.35;
    const STAGGER = 0.14;

    // Every group of `.fu` siblings cascades in order — the same one-by-one feel
    // as the Resources cards, applied everywhere (hero blocks, section text,
    // objective/impact/step cards, resources): each item waits `index * STAGGER`
    // before it fades in.
    const delayFor = (el: HTMLElement): number => {
      const p = el.parentElement;
      if (!p) return 0;
      const sibs = Array.from(p.children).filter((n) =>
        (n as HTMLElement).classList.contains('fu')
      );
      const idx = sibs.indexOf(el);
      return idx > 0 ? Math.min(idx, 5) * STAGGER : 0;
    };

    const keyframesFor = (el: HTMLElement) =>
      el.classList.contains('fu-l')
        ? { opacity: [0, 1], x: [-18, 0] }
        : el.classList.contains('fu-r')
          ? { opacity: [0, 1], x: [18, 0] }
          : { opacity: [0, 1], y: [24, 0] };

    const done = new WeakSet<HTMLElement>();
    const reveal = (el: HTMLElement) => {
      if (done.has(el)) return;
      done.add(el);
      animate(el, keyframesFor(el), {
        duration: DURATION,
        ease: EASE,
        delay: delayFor(el),
      });
    };

    // Reveal everything at or above the fold synchronously (top < viewport
    // height). This animates above-fold content on load, and — crucially —
    // guarantees content isn't left hidden if the effect runs while the page is
    // still scrolled (e.g. a tab switch from a scrolled-down template, where an
    // element could sit above the viewport and never re-enter). `inView`
    // handles everything below the fold as it scrolls in.
    const vh = window.innerHeight;
    targets.forEach((el) => {
      if (el.getBoundingClientRect().top < vh) reveal(el);
    });
    const stops = targets.map((el) =>
      inView(el, () => reveal(el), { margin: '0px' })
    );

    return () => stops.forEach((stop) => stop());
  }, [active]);

  const switchTo = (key: TemplateKey) => {
    // Instant (not smooth) so the reveal effect measures positions at the top.
    window.scrollTo(0, 0);
    setActive(key);
  };

  const ActiveTemplate = TEMPLATES[active];

  return (
    <>
      <div className="switcher" role="group" aria-label="Switch case study template">
        <span className="sw-label">Template</span>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`sw-btn${active === tab.key ? ' on' : ''}`}
            onClick={() => switchTo(tab.key)}
            aria-pressed={active === tab.key}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div ref={panelRef}>
        <ActiveTemplate />
      </div>
    </>
  );
}
