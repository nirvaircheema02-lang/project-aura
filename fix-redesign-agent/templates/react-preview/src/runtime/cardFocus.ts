/**
 * "What Makes Our Way Different": on the live page the numbered cards are one hover group — while the pointer is on a card, every OTHER card fades to
 * 20% (the site's own React state swaps `opacity-100` for `opacity-20`) and the hovered card, with its description overlay, stays fully visible.
 * The captured markup has no script, so the fade is restored here: the same opacity, the same trigger (a mouse pointer over a card), reset when the
 * pointer is no longer over a card. Touch devices have no hover, as on the live page.
 *
 * Delegated on the shadow root: the section's content is mounted into it AFTER the behaviours are attached, so the cards cannot be looked up here.
 * Cards are the grid's direct children that carry the original card classes (`border-[#EDECFB]` + `h-[140px]`); nothing else is touched.
 */
export const FADED_OPACITY = '0.2';
export const CARD_SELECTOR = 'div[class*="border-[#EDECFB]"][class*="h-[140px]"]';

export function attachCardFocus(root: ShadowRoot): () => void {
  let active: HTMLElement | null = null; // the grid whose cards are currently faded
  const cardsOf = (grid: HTMLElement) => Array.from(grid.children).filter((c): c is HTMLElement => (c as HTMLElement).matches?.(CARD_SELECTOR));
  const reset = () => { if (active) for (const c of cardsOf(active)) c.style.removeProperty('opacity'); active = null; };

  const onOver = (e: Event) => {
    const pe = e as PointerEvent;
    if (pe.pointerType && pe.pointerType !== 'mouse') return;
    const hovered = (e.target as Element | null)?.closest?.(CARD_SELECTOR) as HTMLElement | null;
    const grid = hovered?.parentElement ?? null;
    if (!hovered || !grid) { reset(); return; }
    if (active && active !== grid) reset();
    active = grid;
    for (const c of cardsOf(grid)) c.style.setProperty('opacity', c === hovered ? '1' : FADED_OPACITY);
  };
  // the pointer left every card: into the gap, out of the section (the target is then retargeted to the host) or out of the page
  const onOut = (e: Event) => {
    const to = (e as PointerEvent).relatedTarget as Element | null;
    if (!to || !to.closest?.(CARD_SELECTOR)) reset();
  };

  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  return () => { root.removeEventListener('pointerover', onOver); root.removeEventListener('pointerout', onOut); reset(); };
}
