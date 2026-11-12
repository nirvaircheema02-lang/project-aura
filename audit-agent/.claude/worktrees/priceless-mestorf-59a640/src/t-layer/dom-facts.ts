import type { Locator } from 'playwright';

/**
 * The element's own DOM facts — tag, classes, cursor and the handful of
 * computed styles that tell a button from a link from a card — read in one
 * round trip while the element is resolvable. The deterministic (no-api)
 * strategies classify from these instead of a model looking at a picture,
 * and B3 matches the class list against the Design System's own sources.
 */
export interface DomFacts {
  tag: string;
  classes: string[];
  roleAttr: string | null;
  cursor: string;
  text: string;
  hasSvg: boolean;
  hasImg: boolean;
  /** Alt text of the first descendant image — the only name a logo link or image button may have. */
  imgAlt?: string | null | undefined;
  /**
   * True only when the element PAINTS text in its own font — a direct
   * non-whitespace text node with a non-empty layout rect, a non-empty
   * ::before/::after `content`, or (for a form field) a non-empty
   * value/placeholder. An aria-label or accessible name is NOT text: an
   * icon-only button labelled "Close menu" renders no glyphs in any
   * typeface, so a typeface rule (R1.4) must never judge it (third-pass
   * review F1 — `component.label`, which carries the aria name, was being
   * read as "has text" and fired R1.4 on icons and containers).
   */
  ownText: boolean;
  childElementCount: number;
  style: {
    backgroundColor: string;
    backgroundImage: string;
    borderTopWidth: string;
    borderTopStyle: string;
    paddingLeft: string;
    paddingTop: string;
    color: string;
    fontSize: string;
    fontWeight: string;
    display: string;
    opacity: string;
    visibility: string;
    textTransform: string;
    letterSpacing: string;
  };
  box: { x: number; y: number; width: number; height: number };
}

export async function readDomFacts(locator: Locator, timeoutMs = 2_000): Promise<DomFacts> {
  return locator.evaluate(
    (el) => {
      if (!el.isConnected) throw new Error('element detached');
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '');
      return {
        tag: el.tagName.toLowerCase(),
        classes: cls.split(/\s+/).filter(Boolean),
        roleAttr: el.getAttribute('role'),
        cursor: cs.cursor,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
        hasSvg: el.querySelector('svg') !== null || el.tagName.toLowerCase() === 'svg',
        hasImg: el.querySelector('img, picture') !== null || el.tagName.toLowerCase() === 'img',
        imgAlt: (el.tagName.toLowerCase() === 'img' ? el.getAttribute('alt') : el.querySelector('img[alt]')?.getAttribute('alt'))?.trim() || null,
        ownText: (() => {
          for (const child of Array.from(el.childNodes)) {
            if (child.nodeType !== Node.TEXT_NODE || !(child.textContent ?? '').trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(child);
            if (Array.from(range.getClientRects()).some((r) => r.width > 0 && r.height > 0)) return true;
          }
          const paints = (content: string) => content && content !== 'none' && content !== '""' && content !== "''";
          if (paints(getComputedStyle(el, '::before').content) || paints(getComputedStyle(el, '::after').content)) return true;
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const field = el as HTMLInputElement | HTMLTextAreaElement;
            if ((field.value || field.getAttribute('placeholder') || '').trim()) return true;
          }
          return false;
        })(),
        childElementCount: el.childElementCount,
        style: {
          backgroundColor: cs.backgroundColor,
          backgroundImage: cs.backgroundImage,
          borderTopWidth: cs.borderTopWidth,
          borderTopStyle: cs.borderTopStyle,
          paddingLeft: cs.paddingLeft,
          paddingTop: cs.paddingTop,
          color: cs.color,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          display: cs.display,
          opacity: cs.opacity,
          visibility: cs.visibility,
          textTransform: cs.textTransform,
          letterSpacing: cs.letterSpacing,
        },
        box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
      };
    },
    undefined,
    { timeout: timeoutMs },
  );
}
