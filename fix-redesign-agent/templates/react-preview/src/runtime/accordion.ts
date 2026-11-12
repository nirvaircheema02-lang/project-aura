/**
 * The original FAQ is a single-open accordion driven by the page's own JavaScript: clicking an item grows its answer from
 * `height: 0` to its content height and turns the chevron 180°; opening another item closes the first; clicking the open item
 * closes it. The preview is a static snapshot, so the same behaviour is replayed here — recorded read-only on the production page.
 *
 * An accordion item is any element that holds a collapsed panel (class `h-0` with an inline `height`) and is the click target
 * for it (`cursor-pointer`). Items that share a parent form one group. Nothing here changes the markup or the content.
 */

export function panelOf(item: Element): HTMLElement | null {
  for (const el of Array.from(item.querySelectorAll<HTMLElement>('[style]'))) {
    if (el.classList.contains('h-0') && /(^|;)\s*height\s*:/.test(el.getAttribute('style') ?? '')) return el;
  }
  return null;
}

function chevronOf(item: Element): SVGElement | null {
  return item.querySelector<SVGElement>(':scope > svg');
}

export function setOpen(item: HTMLElement, open: boolean): void {
  const panel = panelOf(item);
  if (!panel) return;
  panel.style.height = open ? `${panel.scrollHeight}px` : '0px';
  const chevron = chevronOf(item);
  if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
  item.setAttribute('data-pv-open', open ? 'true' : 'false');
}

export function isOpen(item: Element): boolean {
  return item.getAttribute('data-pv-open') === 'true';
}

/** The click on `target` toggles its accordion item and closes the others in its group. Returns the item it acted on, or null. */
export function handleAccordionClick(target: Element): HTMLElement | null {
  const item = target.closest<HTMLElement>('.cursor-pointer');
  if (!item || !panelOf(item)) return null;
  const willOpen = !isOpen(item);
  for (const sibling of Array.from(item.parentElement?.children ?? [])) {
    if (sibling !== item && sibling instanceof HTMLElement && panelOf(sibling) && isOpen(sibling)) setOpen(sibling, false);
  }
  setOpen(item, willOpen);
  return item;
}

export function attachAccordion(root: ShadowRoot | Document): () => void {
  const onClick = (e: Event) => {
    const target = e.target as Element | null;
    if (target?.closest) handleAccordionClick(target);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
