import type { Page } from 'playwright';
import type { CoverageItemKind } from '../../skills/s0-result-contract.ts';
import type { DomFacts } from '../../t-layer/dom-facts.ts';

/**
 * B7's COVERAGE MANIFEST — the list of every meaningful thing on the RENDERED page, built from the page
 * itself and never from B2's candidate list:
 *
 *  - the DOM (every text-bearing block, control, form field, badge, surfaced card — including open shadow
 *    roots, and content that only a disclosure, a tab, a carousel or a hover layer reveals),
 *  - the accessibility tree (items only the tree lists are added by `index.ts`),
 *  - the visible text of each item, its computed styles and its geometry,
 *  - interaction state: whether the item is visible now, off-canvas, in a faded (hover / scroll-in) layer,
 *    collapsed behind a disclosure, or visually hidden.
 *
 * What it records for each item is exactly what the reconciler needs to say WHERE the audit accounted for it:
 * the `data-audit-el` stamps B2/B5 left on the element, inside it, or on an enclosing control — the durable,
 * DOM-level trace of "this was audited" — never a lookup in a list B2 produced.
 *
 * An item is the smallest UNIT a reviewer would call a thing: a block of running text (a `<p>`, an `<h2>`, a
 * `<div>` of words — inline `<span>`/`<b>` belong to their block), a control (a link, a button, a tab, a
 * summary — its words belong to it), a form field, a bordered/filled text pill (badge) or a surfaced block
 * that repeats (card). A control's own words are never a separate item; a heading inside a control still is
 * (a card title is audited as a heading).
 */

export interface Box { x: number; y: number; width: number; height: number }

export type ItemVisibility = 'visible' | 'off-canvas' | 'faded' | 'collapsed' | 'sr-only';

export interface RawManifestItem {
  /** `b7-<n>`, document order — also written to the element as `data-audit-b7`. */
  id: string;
  kind: CoverageItemKind;
  /** The accessibility role this item would have (`heading`, `paragraph`, `link`, `button`, `textbox`, `generic`). */
  role: string;
  tag: string;
  /** Full visible text (≤ 400 chars). */
  text: string;
  box: Box;
  /** The element's own DOM facts (everything `classifyCandidate` reads), measured in the same round trip. */
  facts: DomFacts;
  visibility: ItemVisibility;
  /** listing / faq / carousel / tab-panel / list — context that matters for finding the item again. */
  where: string[];
  place: { inNavigation: boolean; inFooter: boolean; insideOwner: boolean; ownerText: string | null };
  /** The audit stamps (`data-audit-el`) on the element, inside it, and on enclosing text owners. */
  stamps: { self: string[]; inner: Array<{ id: string; textLength: number }>; owner: Array<{ id: string; ownerLike: boolean }> };
  /** `fadedHost`: the element whose opacity hides it (its parent is what a hover / scroll reveals). `revealedBy`: what discloses a collapsed item. */
  reveal: { kind: 'hover' | 'accordion' | 'tab-panel' | 'carousel' | null; hostSelector: string | null; controlSelector: string | null };
  source: 'dom' | 'a11y' | 'b2';
  /**
   * WHO OWNS the item, read from the DOM — never from where its box happens to sit. Absent for an item that did not come
   * from the DOM scan (an accessibility-tree-only item, an audited element the scan did not classify).
   */
  owner?: ItemOwner;
  /** The element's canonical DOM path — the very `structuralPath` the capture fingerprints it with, so "the same element" is one definition. */
  path?: string;
}

/** The ownership evidence of one manifest item (see `ownership.ts` for how it is resolved). */
export interface ItemOwner {
  /** `data-audit-section` of the nearest ancestor-or-self that is a B1 section root: the section whose DOM subtree holds the item. */
  sectionStamp: string | null;
  /** The same, for the control that REVEALS the item (a hover host, a disclosure / tab control, an `aria-controls` trigger) — for an overlay rendered outside its owner's subtree. */
  triggerSectionStamp: string | null;
  /** A header / footer / navigation landmark the item sits in. */
  region: 'header' | 'footer' | 'navigation' | null;
  /** Inside a fixed / sticky box, a dialog or a popup: its page-absolute box is the viewport position plus the scroll offset, which says nothing about who owns it. */
  floating: boolean;
  /** B1's section roots are stamped on this page, so DOM ownership is available for every item. */
  anchored: boolean;
  /** The page's own banner (a top-level `<header>` / `role=banner`) or contentinfo (`<footer>`) the item sits in — strict: a `<header>` of an article or section is NOT one. */
  landmark?: 'header' | 'footer' | null;
  /** The same, for the control that reveals the item: a menu opened from the banner is the banner's wherever its panel is rendered. */
  triggerLandmark?: 'header' | 'footer' | null;
  /** What the item is, as a header sub-group is named: the label of the control that opens it, and whether that (or the item itself) is search / account. */
  menu?: { trigger: string | null; kind: 'search' | 'account' | null };
}

export interface DomManifest {
  items: RawManifestItem[];
  /** Text blocks under `display: none` that no control reveals — not content a visitor can ever see. */
  notRevealable: number;
  iframes: number;
  truncated: boolean;
  viewportWidth: number;
  pageHeight: number;
}

/** A hard bound on the manifest — past it the gate FAILS (the page was not fully enumerated), never silently clips. */
export const MANIFEST_MAX_ITEMS = 8000;

/** What marks an element as part of a carousel / slider — one definition for the manifest's scan and for B7's state pass (which looks for the carousel's own "next" control). */
export const CAROUSEL_SELECTOR = '[aria-roledescription="carousel" i],[aria-roledescription="slide" i],.swiper,.swiper-slide,.slick-slider,.slick-slide,.splide,.splide__slide,.embla,.embla__slide,[data-carousel],[data-swiper],[class*="carousel" i],[class*="slider" i]';

/**
 * Scans the live page. One round trip, no model, no dependence on the aria snapshot's refs.
 * Idempotent: clears and re-stamps `data-audit-b7`.
 */
export async function collectDomManifest(page: Page, opts: { maxItems?: number } = {}): Promise<DomManifest> {
  return page.evaluate((o) => {
    const MAX = o.maxItems;
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'SVG', 'CANVAS', 'AUDIO', 'VIDEO', 'OBJECT', 'EMBED', 'IFRAME', 'MAP', 'OPTION', 'OPTGROUP', 'DATALIST', 'IMG', 'PICTURE', 'SOURCE', 'BR', 'HR', 'WBR']);
    const OWNER_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'checkbox', 'radio', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
    const FIELD_ROLES = new Set(['combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'checkbox', 'radio', 'switch']);
    const INLINE = new Set(['inline', 'contents']);
    const CAROUSEL = o.carousel;
    const CARD_MIN_AREA = 20000;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const vw = window.innerWidth;

    document.querySelectorAll('[data-audit-b7]').forEach((el) => el.removeAttribute('data-audit-b7'));
    document.querySelectorAll('[data-audit-b7-host]').forEach((el) => el.removeAttribute('data-audit-b7-host'));
    const styleCache = new Map<Element, CSSStyleDeclaration>();
    const css = (el: Element): CSSStyleDeclaration => {
      let c = styleCache.get(el);
      if (!c) {
        c = getComputedStyle(el);
        styleCache.set(el, c);
      }
      return c;
    };
    const tagOf = (el: Element) => el.tagName.toLowerCase();
    const roleAttrOf = (el: Element) => (el.getAttribute('role') ?? '').split(/\s+/)[0]?.toLowerCase() || null;
    const isHeadingEl = (el: Element) => /^h[1-6]$/.test(tagOf(el)) || roleAttrOf(el) === 'heading';
    const pageBox = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + sx, y: r.y + sy, width: r.width, height: r.height };
    };

    /** 'control' | 'form-field' when the element is something a visitor operates; null otherwise. */
    const ownerKindOf = (el: Element, cs: CSSStyleDeclaration, parent: Element | null, genericPointer = true): 'control' | 'form-field' | null => {
      const t = tagOf(el);
      const role = roleAttrOf(el);
      if (t === 'input') return (el as HTMLInputElement).type === 'hidden' ? null : (['button', 'submit', 'reset', 'image'].includes((el as HTMLInputElement).type) ? 'control' : 'form-field');
      if (t === 'select' || t === 'textarea') return 'form-field';
      if (t === 'button' || t === 'summary') return 'control';
      if (t === 'a' && el.hasAttribute('href')) return 'control';
      if (role && OWNER_ROLES.has(role)) return FIELD_ROLES.has(role) ? 'form-field' : 'control';
      if ((el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== null) return 'form-field';
      // A role-less element that is only clickable (cursor: pointer its parent does not already have) is a real control on this web.
      if (genericPointer && cs.cursor === 'pointer' && parent && css(parent).cursor !== 'pointer' && (el.childElementCount > 0 || norm(el.textContent) !== '')) return 'control';
      return null;
    };

    const accessibleText = (el: Element): string => {
      const label = norm(el.getAttribute('aria-label'));
      if (label) return label;
      const own = norm(el.textContent);
      if (own) return own;
      const img = el.querySelector('img[alt]');
      return norm(img?.getAttribute('alt')) || norm(el.getAttribute('title')) || norm((el as HTMLInputElement).value) || norm(el.getAttribute('placeholder'));
    };

    /** The words of a block: its own text and its INLINE descendants' — never a nested block's, never a control's. */
    const unitText = (el: Element): string => {
      let out = '';
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3) {
          out += n.nodeValue ?? '';
        } else if (n.nodeType === 1) {
          const c = n as Element;
          if (SKIP.has(c.tagName.toUpperCase())) {
            if (c.tagName === 'BR') out += ' ';
            continue;
          }
          const ccs = css(c);
          if (INLINE.has(ccs.display) && ownerKindOf(c, ccs, el) === null && !isHeadingEl(c)) out += ` ${unitText(c)} `;
        }
      }
      return norm(out);
    };

    const paintsOwnText = (el: Element): boolean => {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType !== 3 || !(child.textContent ?? '').trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        if (Array.from(range.getClientRects()).some((r) => r.width > 0 && r.height > 0)) return true;
      }
      return false;
    };

    const borderOrFill = (cs: CSSStyleDeclaration): boolean => {
      const border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
      const alpha = /^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\s*\)$/.exec(cs.backgroundColor);
      return border || (cs.backgroundColor !== 'transparent' && !(alpha && Number(alpha[1]) === 0));
    };

    const hasSurface = (cs: CSSStyleDeclaration): boolean => {
      const border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
      const alpha = /^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\s*\)$/.exec(cs.backgroundColor);
      const filled = cs.backgroundColor !== 'transparent' && !(alpha && Number(alpha[1]) === 0);
      return border || filled || (cs.backgroundImage !== 'none' && cs.backgroundImage !== '') || (cs.boxShadow !== 'none' && cs.boxShadow !== '');
    };

    /** What discloses a display:none subtree, or null when nothing does (then it is not content a visitor can ever see). */
    const revealerOf = (el: Element): { kind: 'accordion' | 'tab-panel' | 'carousel'; controlSelector: string | null } | null => {
      if (el.closest('details:not([open])')) return { kind: 'accordion', controlSelector: null };
      for (let a: Element | null = el; a; a = a.parentElement) {
        if (a.id) {
          const trigger = document.querySelector(`[aria-controls~="${CSS.escape(a.id)}"]`);
          if (trigger) return { kind: roleAttrOf(trigger) === 'tab' ? 'tab-panel' : 'accordion', controlSelector: `[aria-controls~="${CSS.escape(a.id)}"]` };
        }
        if (roleAttrOf(a) === 'tabpanel') return { kind: 'tab-panel', controlSelector: a.getAttribute('aria-labelledby') ? `#${CSS.escape(a.getAttribute('aria-labelledby') ?? '')}` : null };
      }
      if (el.closest(CAROUSEL)) return { kind: 'carousel', controlSelector: null };
      return null;
    };

    const accordionPanelOf = (el: Element): boolean => {
      if (el.closest('details')) return true;
      let n = 0;
      for (let a: Element | null = el; a && n < 8; a = a.parentElement, n++) {
        if (a.id && document.querySelector(`[aria-controls~="${CSS.escape(a.id)}"][aria-expanded]`)) return true;
      }
      return false;
    };

    // ── Ownership evidence ────────────────────────────────────────────────────────────────────────
    // Who owns an item is a question about the DOM (B1's section subtrees, the landmark it sits in, the control that
    // opens it) — never about the page-absolute box it has at the moment it is measured: a mega-menu revealed from a
    // sticky header lies over whatever section is scrolled under it.
    const anchored = document.querySelector('[data-audit-section]') !== null;
    const sectionStampOf = (el: Element | null | undefined): string | null => el?.closest('[data-audit-section]')?.getAttribute('data-audit-section') ?? null;
    const regionOf = (el: Element): 'header' | 'footer' | 'navigation' | null => {
      if (el.closest('header,[role="banner"]')) return 'header';
      if (el.closest('footer,[role="contentinfo"]')) return 'footer';
      if (el.closest('nav,[role="navigation"],[role="menu"],[role="menubar"]')) return 'navigation';
      return null;
    };
    const floatingOf = (el: Element): boolean => {
      if (el.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[popover]')) return true;
      for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
        const p = css(a).position;
        if (p === 'fixed' || p === 'sticky') return true;
      }
      return false;
    };
    /** The control that points at this item (or at an ancestor holding it) through aria-controls — the owner of an overlay rendered elsewhere in the DOM. */
    const controllerOf = (el: Element): Element | null => {
      let n = 0;
      for (let a: Element | null = el; a && n < 10; a = a.parentElement, n++) {
        if (a.id) {
          const c = document.querySelector(`[aria-controls~="${CSS.escape(a.id)}"]`);
          if (c) return c;
        }
      }
      return null;
    };
    // The page's own banner / contentinfo, strictly: a top-level <header>/<footer> (or role=banner/contentinfo) — never the
    // <header> of an article or section, which is not a page landmark.
    const SECTIONING = 'article,aside,main,nav,section,[role="main"],[role="article"],[role="complementary"],[role="region"],[role="navigation"]';
    const landmarkOf = (el: Element | null | undefined): 'header' | 'footer' | null => {
      for (let a: Element | null | undefined = el; a; a = a.parentElement) {
        const role = roleAttrOf(a);
        const t = tagOf(a);
        if (role === 'banner' || (t === 'header' && !role && !a.parentElement?.closest(SECTIONING))) return 'header';
        if (role === 'contentinfo' || (t === 'footer' && !role && !a.parentElement?.closest(SECTIONING))) return 'footer';
      }
      return null;
    };
    const CONTROL_SEL = 'button,a[href],[role="button"],[role="menuitem"],[role="tab"],summary,[aria-haspopup],[aria-expanded]';
    const labelOfControl = (c: Element | null | undefined): string | null => {
      if (!c) return null;
      const l = norm(c.getAttribute('aria-label')) || norm(c.textContent);
      return l ? l.slice(0, 60) : null;
    };
    const SEARCH_RE = /\bsearch/i;
    const ACCOUNT_RE = /\b(my account|account|profile|log ?in|sign ?in|sign ?up|register|user menu)\b/i;
    const kindOfLabel = (text: string): 'search' | 'account' | null => (SEARCH_RE.test(text) ? 'search' : ACCOUNT_RE.test(text) ? 'account' : null);
    // The canonical path: the SAME algorithm as the capture's `elementFingerprint` (src/t-layer/element-registry.ts),
    // so a manifest item and an audited component are "the same element" by one definition.
    const pathOf = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      const unique = (selector: string) => document.querySelectorAll(selector).length === 1;
      while (node && node !== document.documentElement) {
        if (node.id && unique(`#${CSS.escape(node.id)}`)) {
          parts.unshift(`#${node.id}`);
          break;
        }
        const testId = node.getAttribute('data-testid');
        if (testId && unique(`[data-testid="${CSS.escape(testId)}"]`)) {
          parts.unshift(`[data-testid="${testId}"]`);
          break;
        }
        const tag = node.tagName.toLowerCase();
        const parentEl: Element | null = node.parentElement;
        const siblings = parentEl ? Array.from(parentEl.children).filter((c) => c.tagName === node!.tagName) : [];
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
        node = parentEl;
      }
      return parts.join(' > ');
    };

    const items: unknown[] = [];
    let notRevealable = 0;
    let truncated = false;
    let nextIdx = 0;
    const surfaceBlocks: Array<{ el: Element; box: { x: number; y: number; width: number; height: number }; parent: Element | null; owner: boolean }> = [];

    const stampsOf = (el: Element) => {
      const self = el.getAttribute('data-audit-el') ? [el.getAttribute('data-audit-el') as string] : [];
      const inner = Array.from(el.querySelectorAll('[data-audit-el]')).slice(0, 12).map((e) => ({ id: e.getAttribute('data-audit-el') as string, textLength: norm(e.textContent).length }));
      const owner: Array<{ id: string; ownerLike: boolean }> = [];
      let n = 0;
      for (let a = el.parentElement; a && n < 6; a = a.parentElement, n++) {
        const id = a.getAttribute('data-audit-el');
        if (id) owner.push({ id, ownerLike: isHeadingEl(a) || ownerKindOf(a, css(a), a.parentElement) !== null || tagOf(a) === 'label' });
      }
      return { self, inner, owner };
    };

    /** The control that opens an item, named: the revealer itself when it is a control, else the control inside the wrapper it heads (never one inside the layer). */
    const menuOf = (el: Element, revealer: Element | null, layer: Element | null, kind: string): { trigger: string | null; kind: 'search' | 'account' | null } => {
      const controller = revealer ?? controllerOf(el);
      let trigger: string | null = null;
      if (controller) {
        const isControl = ownerKindOf(controller, css(controller), controller.parentElement) !== null;
        const inner = isControl ? controller : Array.from(controller.querySelectorAll(CONTROL_SEL)).find((c) => !c.contains(el) && !el.contains(c) && !(layer && layer.contains(c)));
        trigger = labelOfControl(inner ?? null);
      }
      if (trigger) return { trigger, kind: kindOfLabel(trigger) };
      // Not inside a revealed layer: the item is a base-level header element — it names itself (a "Search" box, a "Log in" link).
      const own = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('title') ?? ''} ${kind === 'control' || kind === 'form-field' ? norm(el.textContent) : ''}`;
      const searchy = el.closest('[role="search"]') !== null || (el as HTMLInputElement).type === 'search' || SEARCH_RE.test(own);
      return { trigger: null, kind: searchy ? 'search' : kindOfLabel(own) };
    };

    const emit = (el: Element, kind: string, text: string, ctx: Ctx, extra: { role: string; ownerText?: string | null } ) => {
      if (items.length >= MAX) {
        truncated = true;
        return;
      }
      const cs = css(el);
      const box = pageBox(el);
      const idx = nextIdx++;
      const id = `b7-${idx}`;
      el.setAttribute('data-audit-b7', id);
      const vis = cs.visibility;
      const faded = ctx.opacity < 0.05 || vis === 'hidden' || vis === 'collapse';
      const sizeless = box.width <= 2 || box.height <= 2;
      let visibility: ItemVisibility = 'visible';
      if (ctx.hidden) visibility = 'collapsed';
      else if (faded) visibility = 'faded';
      else if (sizeless) visibility = 'sr-only';
      else if (box.x + box.width <= 0 || box.x >= vw) visibility = 'off-canvas';

      const where: string[] = [];
      if (el.closest('li,[role="listitem"]')) where.push('list');
      if (accordionPanelOf(el)) where.push('faq');
      if (el.closest(CAROUSEL)) where.push('carousel');
      if (el.closest('[role="tabpanel"]')) where.push('tab-panel');

      let reveal: { kind: string | null; hostSelector: string | null; controlSelector: string | null } = { kind: null, hostSelector: null, controlSelector: null };
      let revealer: Element | null = null; // the element whose interaction reveals this item — its owner is the owner of what it reveals
      let fadedHost: Element | null = null; // the layer (opacity 0) the item sits in, when it is a hover layer
      if (ctx.hidden) {
        reveal = { kind: ctx.hidden.kind, hostSelector: null, controlSelector: ctx.hidden.controlSelector };
        if (ctx.hidden.controlSelector) {
          try {
            revealer = document.querySelector(ctx.hidden.controlSelector);
          } catch {
            revealer = null;
          }
        }
      } else if (faded) {
        // the element whose opacity hides it: its (visible) parent — the TRIGGER — is what a hover / scroll-in reveals
        let host: Element | null = el;
        while (host && css(host).opacity !== '0' && host.parentElement) host = host.parentElement;
        const trigger = host?.parentElement ?? el.parentElement;
        revealer = trigger;
        fadedHost = host;
        if (trigger) {
          // ONE marker per trigger, shared by every item the layer behind it holds. (Re-numbering it per item left only the
          // LAST item of a menu with a valid selector — every other member's reveal then waited out its timeouts and failed.)
          const triggerItem = trigger.getAttribute('data-audit-b7');
          let hostId = trigger.getAttribute('data-audit-b7-host');
          if (!hostId && !triggerItem) {
            hostId = `h-${idx}`;
            trigger.setAttribute('data-audit-b7-host', hostId);
          }
          reveal = { kind: 'hover', hostSelector: triggerItem ? `[data-audit-b7="${triggerItem}"]` : `[data-audit-b7-host="${hostId}"]`, controlSelector: null };
        }
      }
      const ownText = paintsOwnText(el) || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? Boolean(norm((el as HTMLInputElement).value) || norm(el.getAttribute('placeholder'))) : false);
      const sectionStamp = sectionStampOf(el);
      // An overlay rendered OUTSIDE its owner's subtree (a portal): the control that opens it — or that aria-controls an
      // ancestor of it — is what ties it to its section.
      const triggerSectionStamp = sectionStamp ? null : sectionStampOf(revealer) ?? sectionStampOf(controllerOf(el));
      items.push({
        id, kind, role: extra.role, tag: tagOf(el), text: text.slice(0, 400), box,
        facts: {
          tag: tagOf(el),
          classes: (typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : (el.getAttribute('class') ?? '')).split(/\s+/).filter(Boolean),
          roleAttr: el.getAttribute('role'),
          cursor: cs.cursor,
          text: norm(el.textContent).slice(0, 120),
          hasSvg: el.querySelector('svg') !== null || tagOf(el) === 'svg',
          hasImg: el.querySelector('img, picture') !== null || tagOf(el) === 'img',
          imgAlt: norm(el.querySelector('img[alt]')?.getAttribute('alt')) || null,
          ownText,
          childElementCount: el.childElementCount,
          style: {
            backgroundColor: cs.backgroundColor, backgroundImage: cs.backgroundImage, borderTopWidth: cs.borderTopWidth, borderTopStyle: cs.borderTopStyle,
            paddingLeft: cs.paddingLeft, paddingTop: cs.paddingTop, color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, display: cs.display,
            opacity: String(ctx.opacity), visibility: cs.visibility, textTransform: cs.textTransform, letterSpacing: cs.letterSpacing, boxShadow: cs.boxShadow,
          },
          box,
        },
        visibility, where, reveal,
        place: { inNavigation: ctx.inNav, inFooter: ctx.inFooter, insideOwner: ctx.owner !== null, ownerText: extra.ownerText ?? null },
        stamps: stampsOf(el),
        source: 'dom',
        owner: { sectionStamp, triggerSectionStamp, region: regionOf(el), floating: floatingOf(el), anchored, landmark: landmarkOf(el), triggerLandmark: landmarkOf(revealer) ?? landmarkOf(controllerOf(el)), menu: menuOf(el, revealer, fadedHost, kind) },
        path: pathOf(el),
      });
    };

    interface Ctx {
      owner: Element | null;
      /** Inside a heading: its words are the heading's own (no separate text item); a control inside it still is one. */
      inHeading?: boolean;
      opacity: number;
      hidden: { kind: 'accordion' | 'tab-panel' | 'carousel'; controlSelector: string | null } | null;
      inNav: boolean;
      inFooter: boolean;
    }
    type ItemVisibility = 'visible' | 'off-canvas' | 'faded' | 'collapsed' | 'sr-only';

    const visit = (el: Element, ctx: Ctx): void => {
      if (truncated) return;
      if (SKIP.has(el.tagName.toUpperCase())) return;
      const cs = css(el);
      let hidden = ctx.hidden;
      if (cs.display === 'none') {
        const why = revealerOf(el);
        if (!why) {
          if (norm(el.textContent) !== '') notRevealable++;
          return;
        }
        hidden = why;
      }
      const opacity = ctx.opacity * (Number.isNaN(parseFloat(cs.opacity)) ? 1 : parseFloat(cs.opacity));
      const t = tagOf(el);
      const role = roleAttrOf(el);
      const inNav = ctx.inNav || t === 'nav' || role === 'navigation';
      const inFooter = ctx.inFooter || t === 'footer' || role === 'contentinfo';
      const next: Ctx = { owner: ctx.owner, inHeading: ctx.inHeading ?? false, opacity, hidden, inNav, inFooter };

      // Open shadow roots are part of the rendered page.
      const children: Element[] = [...Array.from(el.children), ...Array.from(el.shadowRoot?.children ?? [])];

      const ownerKind = ownerKindOf(el, cs, el.parentElement, !ctx.owner);
      const display = cs.display;
      const blockish = !INLINE.has(display);

      if (ownerKind) {
        const box = pageBox(el);
        const text = accessibleText(el);
        const area = box.width * box.height;
        const cardLike = ownerKind === 'control' && box.height > 80 && area >= CARD_MIN_AREA;
        if (text !== '' || ownerKind === 'form-field' || el.querySelector('svg, img')) {
          const kind = cardLike ? 'card' : ownerKind;
          const roleName = ownerKind === 'form-field' ? (role ?? (t === 'select' ? 'combobox' : 'textbox')) : (role ?? (t === 'a' ? 'link' : 'button'));
          emit(el, kind, text, next, { role: roleName });
        }
        const inside: Ctx = { ...next, owner: el, inHeading: false };
        for (const c of children) visit(c, inside);
        return;
      }

      if (isHeadingEl(el)) {
        const text = norm(el.textContent);
        if (text !== '') emit(el, 'heading', text, next, { role: 'heading', ownerText: ctx.owner ? accessibleText(ctx.owner) : null });
        // A heading's words are its own: nothing inside it is a separate text item (controls still are).
        for (const c of children) visit(c, { ...next, inHeading: true });
        return;
      }

      if (blockish && !ctx.owner && !ctx.inHeading) {
        const text = unitText(el);
        if (text !== '') {
          const box = pageBox(el);
          const leaf = el.childElementCount === 0;
          const small = box.height > 0 && box.height <= 40 && box.width > 0 && box.width <= 320;
          const kind = leaf && small && borderOrFill(cs) ? 'badge' : 'text';
          emit(el, kind, text, next, { role: t === 'p' ? 'paragraph' : 'generic' });
        } else if (hasSurface(cs) && el.childElementCount > 0) {
          const box = pageBox(el);
          if (box.width * box.height >= CARD_MIN_AREA) surfaceBlocks.push({ el, box, parent: el.parentElement, owner: false });
        }
      }
      for (const c of children) visit(c, next);
    };

    const body = document.body;
    if (body) visit(body, { owner: null, opacity: 1, hidden: null, inNav: false, inFooter: false });

    // Surfaced blocks that repeat (same size, same parent) are cards; a lone surfaced container is just layout.
    const groups = new Map<Element | null, typeof surfaceBlocks>();
    for (const b of surfaceBlocks) groups.set(b.parent, [...(groups.get(b.parent) ?? []), b]);
    for (const list of groups.values()) {
      for (const b of list) {
        const twins = list.filter((o) => o !== b && Math.abs(o.box.width - b.box.width) <= 1 && Math.abs(o.box.height - b.box.height) <= 1);
        if (twins.length === 0 || b.box.width * b.box.height > 1_200_000) continue;
        emit(b.el, 'card', accessibleText(b.el).slice(0, 80), { owner: null, opacity: 1, hidden: null, inNav: false, inFooter: false }, { role: 'generic' });
      }
    }

    return {
      items: items as never,
      notRevealable,
      iframes: document.querySelectorAll('iframe').length,
      truncated,
      viewportWidth: vw,
      pageHeight: document.documentElement.scrollHeight,
    };
  }, { maxItems: opts.maxItems ?? MANIFEST_MAX_ITEMS, carousel: CAROUSEL_SELECTOR }) as Promise<DomManifest>;
}
