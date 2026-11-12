import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import scopedCss from '../generated/scoped.css?inline';
import { bodyAttrs, htmlAttrs } from '../generated/page';
import { attachBehaviors } from './behaviors';
import { watchAncestorClip } from './clip';
import { attachAccordion } from './accordion';
import { attachCounters } from './counters';
import { attachStatNumerals } from './stats';
import { attachCarousels } from './carousels';

/**
 * Renders one captured section in a shadow root so the page's own CSS (copied verbatim, only the
 * rules that apply to this section) cannot collide with the design system's, and the design
 * system's cannot disturb the original. Design-system "islands" are light-DOM children assigned
 * to <slot>s at the positions of the elements they replace, so they keep the DS stylesheet.
 *
 * html/body/ancestor elements of the original are mirrored as `display: contents` wrappers so
 * selectors such as `.dark .x` or `body .y` still match.
 */

let sheet: CSSStyleSheet | null = null;
const getSheet = () => {
  if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(scopedCss); }
  return sheet;
};

export interface Ancestor { tag: string; attrs: Record<string, string> }

export function Slot({ name }: { name: string }) {
  return <slot name={name} />;
}

function make(tag: string, attrs: Record<string, string>, marker?: string): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { try { el.setAttribute(k, v); } catch { /* an attribute name the DOM refuses is simply not mirrored */ } }
  if (marker) el.setAttribute(marker, '');
  el.style.setProperty('display', 'contents', 'important');
  return el;
}

export interface Island { node: ReactNode; findingIds: string; component: string; /** the replaced element's place in its parent (display, margins, alignment) */ style: Record<string, string> }

export function OriginalSection({ id, name, ancestors, islands, children }: { id: string; name: string; ancestors: Ancestor[]; islands?: Record<string, Island>; children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current!;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    shadow.adoptedStyleSheets = [getSheet()];
    shadow.replaceChildren();
    const htmlEl = make('div', htmlAttrs, 'data-pv-html');
    const bodyEl = make('div', bodyAttrs, 'data-pv-body');
    htmlEl.appendChild(bodyEl);
    let inner: HTMLElement = bodyEl;
    const wrappers: HTMLElement[] = [];
    for (const a of ancestors) { const el = make(a.tag, a.attrs); inner.appendChild(el); wrappers.push(el); inner = el; }
    inner.setAttribute('data-pv-mount', '');
    shadow.appendChild(htmlEl);
    setMount(inner);
    // wrappers are display:contents (no box, no clip): hand their clipping to the host box instead
    const stopClip = watchAncestorClip(host, wrappers);
    const stopBehaviors = attachBehaviors(shadow, id);
    const stopAccordion = attachAccordion(shadow);
    const stopCarousels = attachCarousels(shadow, host);
    return () => { stopClip(); stopBehaviors?.(); stopAccordion(); stopCarousels(); };
  }, [id, ancestors]);

  // the section's content is portalled into the shadow root AFTER the mount point exists: stat numerals are found once it is there. Their colour is pinned before paint
  // (no flash of the original gradient); the count-up starts after it.
  useLayoutEffect(() => {
    const shadow = hostRef.current?.shadowRoot;
    return mount && shadow ? attachStatNumerals(shadow) : undefined;
  }, [mount]);
  useEffect(() => {
    const shadow = hostRef.current?.shadowRoot;
    return mount && shadow ? attachCounters(shadow) : undefined;
  }, [mount]);

  return (
    <div ref={hostRef} data-pv-section={id} data-pv-name={name} style={{ display: 'block' }}>
      {islands && Object.entries(islands).map(([slot, island]) => (
        <div key={slot} slot={slot} data-pv-island={island.component} data-finding-ids={island.findingIds} style={island.style}>{island.node}</div>
      ))}
      {mount && createPortal(children, mount)}
    </div>
  );
}
