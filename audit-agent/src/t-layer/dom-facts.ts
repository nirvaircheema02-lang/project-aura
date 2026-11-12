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
  /** Context is measured from ancestry, never inferred from text colour. */
  context?: {
    breadcrumb: boolean;
    current: boolean;
    expanded: boolean;
    surface: 'dark' | 'light' | 'unknown';
    surfaceEvidence: string;
    imageSource: string | null;
    accessibleName: string;
    lucideMarker?: boolean;
    subtitleCandidate?: boolean;
  };
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
    /** Optional: only read from a live element; a fixture may omit it. A card's surface can be a shadow alone. */
    boxShadow?: string;
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
      let surface: 'dark' | 'light' | 'unknown' = 'unknown';
      let surfaceEvidence = 'no opaque ancestor surface';
      for (let ancestor: Element | null = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.backgroundImage !== 'none') {
          const image = style.backgroundImage;
          const stops = image.match(/rgba?\([^)]+\)/g)?.map(c => c.match(/[\d.]+/g)!.map(Number)) ?? [];
          const opaque = stops.length >= 2 && stops.every(c => c.length >= 3 && (c[3] ?? 1) >= 0.95);
          const luminances = stops.map(c => c[0]! * .2126 + c[1]! * .7152 + c[2]! * .0722);
          // Only a single RGB gradient with opaque stops all on the same side is decidable.
          const singleGradient = /^(?:linear|radial)-gradient\(/.test(image) && (image.match(/gradient\(/g) ?? []).length === 1 && !/url\(|color\(|lab\(|lch\(/.test(image);
          if (singleGradient && opaque && luminances.every(v => v < 128)) surface = 'dark';
          else if (singleGradient && opaque && luminances.every(v => v >= 128)) surface = 'light';
          surfaceEvidence = surface === 'unknown' ? 'image/mixed gradient surface requires visual review' : `${ancestor.tagName.toLowerCase()} opaque ${surface} gradient ${image}`;
          break;
        }
        const channels = style.backgroundColor.match(/[\d.]+/g)?.map(Number);
        if (channels && channels.length >= 3 && (channels[3] ?? 1) >= 0.95) {
          surface = (channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722) < 128 ? 'dark' : 'light';
          surfaceEvidence = `${ancestor.tagName.toLowerCase()} background ${style.backgroundColor}`;
          break;
        }
      }
      let breadcrumb = el.closest('[aria-label*="breadcrumb" i], [data-component="Breadcrumb"], [itemtype$="BreadcrumbList"]');
      const nav = el.closest('nav');
      if (!breadcrumb && nav && !nav.closest('footer, header')) {
        const links = Array.from(nav.querySelectorAll('a[href]'));
        const paths = links.map(a => { try { return new URL(a.getAttribute('href')!, location.href).pathname; } catch { return ''; } });
        const hierarchy = paths.length >= 2 && paths.every((path, i) => path && (i === 0 || path.startsWith(paths[i - 1]!.replace(/\/$/, '') + '/')));
        const separators = (nav.textContent?.match(/[›»❯]/g) ?? []).length;
        if (hierarchy && separators >= links.length - 1) breadcrumb = nav;
      }
      const image = el.tagName === 'IMG' ? el : el.querySelector('img');
      return {
        context: {
          breadcrumb: breadcrumb !== null,
          current: el.getAttribute('aria-current') === 'page' || Boolean(breadcrumb && el.tagName === 'BUTTON' && el.textContent?.trim() === document.querySelector('h1')?.textContent?.trim()),
          expanded: el.getAttribute('aria-expanded') === 'true',
          surface, surfaceEvidence,
          imageSource: image?.getAttribute('src') ?? null,
          accessibleName: (el.getAttribute('aria-label') || el.getAttribute('title') || image?.getAttribute('alt') || el.textContent || '').trim().slice(0, 120),
          lucideMarker: el.matches('svg.lucide') || el.querySelector('svg.lucide') !== null,
          subtitleCandidate: el.tagName === 'H2' && (el.textContent ?? '').trim().length > 120 && Boolean(el.closest('section')?.querySelector('h1')),
        },
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
          boxShadow: cs.boxShadow,
        },
        box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
      };
    },
    undefined,
    { timeout: timeoutMs },
  );
}
