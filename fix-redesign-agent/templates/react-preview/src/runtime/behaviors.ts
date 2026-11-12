/**
 * The only behaviour the generator can add to captured markup without the site's own scripts:
 * what the browser already does natively (links, native form controls, <details>, CSS hover /
 * focus / animation) plus three generic adapters. Anything else the original page does with its
 * own JavaScript is NOT reproduced; the pipeline's interaction probes report it as unavailable.
 */

import { attachCardFocus } from './cardFocus';

export const SIMULATED_EVENT = 'pv:simulated';


export function attachBehaviors(root: ShadowRoot, sectionId: string): () => void {
  const onClick = (e: Event) => {
    const target = e.target as Element | null;
    if (!target || !target.closest) return;

    // same-page anchors: the target lives in this shadow tree or in the document
    const a = target.closest('a[href^="#"]') as HTMLAnchorElement | null;
    if (a && a.getAttribute('href') && a.getAttribute('href') !== '#') {
      const id = decodeURIComponent((a.getAttribute('href') as string).slice(1));
      const dest = (root.getElementById?.(id) ?? document.getElementById(id)) as HTMLElement | null;
      if (dest) { e.preventDefault(); dest.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }

    // generic disclosure: a control with aria-expanded + aria-controls toggles the controlled element
    const ctl = target.closest('[aria-expanded][aria-controls]') as HTMLElement | null;
    if (ctl) {
      const panel = root.getElementById?.(ctl.getAttribute('aria-controls') as string) as HTMLElement | null;
      if (panel) {
        const open = ctl.getAttribute('aria-expanded') === 'true';
        ctl.setAttribute('aria-expanded', String(!open));
        panel.hidden = open;
      }
    }
  };

  const onSubmit = (e: Event) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent(SIMULATED_EVENT, { detail: { kind: 'form-submit', section: sectionId } }));
  };

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  // the numbered cards ("What Makes Our Way Different" / "What Sets Us Apart") fade their neighbours on hover on every survey page (user, 2026-10-29); acts only on those cards
  const stopCardFocus = attachCardFocus(root);
  return () => { root.removeEventListener('click', onClick); root.removeEventListener('submit', onSubmit); stopCardFocus(); };
}
