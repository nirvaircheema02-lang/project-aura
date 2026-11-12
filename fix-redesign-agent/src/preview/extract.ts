import type { BrowserContext, Page } from 'playwright';
import { applyEdit } from '../dom/apply-edit.ts';
import type { TargetedEdit } from '../llm/schemas/r-nodes.ts';
import { applyStateGuards } from '../fidelity/guard.ts';
import { visibleTextOf } from './visible-text.ts';
import { compactCarousels } from './carousel.ts';
import { normalizeForMatching, referencedAnimationNames, renderRuleItems, rewriteSelectorForShadow, splitSelectorList, type RuleItem } from './css.ts';
import type { AncestorStub, ElementLayout, ExtractedSection, ExtractionResult, InteractiveItem, PreviewNode, StructuralElement } from './types.ts';

/**
 * Extracts, from the run's own pre-edit stamped snapshot (`original.html`, already standalone —
 * every stylesheet inlined), everything the React Preview needs: the in-scope sections' markup,
 * exactly the CSS rules that apply to them, their fonts, and their interactive elements.
 *
 * Runs offline: all network from the stand-in page is aborted, so extraction never touches the
 * production site and is reproducible from the run folder alone.
 */

export interface ExtractOptions {
  /** Selected Sections: the section ids to render. Full Page: null (every content region). */
  sectionIds: string[] | null;
  fullPage: boolean;
  /** Display names keyed by section id (from the audit's section names). */
  names: Record<string, string>;
  /** Edits R4 applied and that are still in force — replayed so the preview carries the validated fixes. */
  edits: TargetedEdit[];
  /** `guardKey(findingId, property)`s whose style edit is emitted state-safe (so it never overrides the original's hover/focus rules). */
  stateGuards?: ReadonlySet<string>;
  /** DS-first: a design-system component replaces an element, so the slot it sits in is the ORIGINAL element's (measured before any CSS edit lands on it). */
  dsFirst?: boolean;
}

interface RawRegion {
  id: string;
  order: number;
  unlabelled: boolean;
  tree: PreviewNode;
  ancestors: AncestorStub[];
  text: string;
  visibleText: string;
  height: number;
  locator: { cssPath: string; textStart: string; textLength: number };
  links: string[];
  images: number;
  headings: string[];
  findingElements: Array<{ stamp: string; findingIds: string[]; tag: string; textAlign: string; layout: ElementLayout }>;
  structural: StructuralElement[];
  indicators: NonNullable<ExtractedSection['indicators']>;
  /** px, at the viewport the page is currently in */
  outerSpacing: { top: number; bottom: number };
  interactive: Array<Omit<InteractiveItem, 'sectionId'>>;
}

interface RawExtraction {
  regions: RawRegion[];
  rules: RuleItem[];
  keyframes: Array<{ name: string; text: string }>;
  fontFaces: Array<{ family: string; text: string }>;
  properties: Array<{ name: string; text: string }>;
  usedFamilies: string[];
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  orphans: Array<{ tag: string; text: string; between: string }>;
  outOfScopeText: Array<{ id: string; scope: string; snippet: string }>;
  remoteAssets: string[];
  stats: { rules: number; keptRules: number; elements: number };
}

/**
 * Runs inside the stand-in page. Self-contained on purpose: Playwright serializes only this
 * function's own source, so every helper it needs is declared inside it (same rule as
 * `serializeInPage` in src/html/serialize.ts).
 */
async function extractInPage(opts: { sectionIds: string[] | null; fullPage: boolean }, helpers: { normalize: (s: string) => string; split: (s: string) => string[]; visibleText: (root: Element) => string }): Promise<RawExtraction> {
  const { normalize, split, visibleText } = helpers;
  const doc = document as any;
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'BASE', 'TITLE']);
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  // ── regions ────────────────────────────────────────────────────────────────────────────
  const wrappers: Array<{ id: string; el: Element; scope: string }> = Array.from(doc.querySelectorAll('[data-fra-section]')).map((el: any) => ({ id: el.getAttribute('data-fra-section') as string, el, scope: (el.getAttribute('data-fra-scope') as string) || 'content' }));
  const wrapperOf = new Map<Element, { id: string; el: Element; scope: string }>();
  for (const w of wrappers) wrapperOf.set(w.el, w);

  const hasContent = (el: Element): boolean => {
    if (SKIP_TAGS.has(el.tagName)) return false;
    const r = (el as any).getBoundingClientRect();
    const text = norm(el.textContent);
    const media = el.querySelector('img,svg,video,canvas,picture,iframe,input,select,textarea,button,a');
    return (text.length > 0 || !!media) && (r.height > 0 || r.width > 0 || !!media);
  };

  type Region = { kind: 'wrapper'; id: string; el: Element } | { kind: 'gap'; el: Element };
  const regions: Region[] = [];
  const orphans: Array<{ tag: string; text: string; between: string }> = [];

  if (opts.fullPage) {
    const chains = wrappers.map((w) => { const c: Element[] = []; let n: Element | null = w.el; while (n) { c.push(n); n = n.parentElement; } return c; });
    let container: Element = doc.body;
    if (chains.length) {
      const first = chains[0]!;
      for (const cand of first) { if (chains.every((c) => c.includes(cand))) { container = cand; break; } }
      // an LCA that is itself a wrapper means a single wrapper holds everything — descend from its parent
      if (wrapperOf.has(container) && container.parentElement) container = container.parentElement;
    }
    const walk = (parent: Element) => {
      for (const child of Array.from(parent.children)) {
        if (SKIP_TAGS.has(child.tagName)) continue;
        const w = wrapperOf.get(child);
        if (w) { if (w.scope !== 'excluded') regions.push({ kind: 'wrapper', id: w.id, el: child }); continue; }
        const inside = wrappers.some((x) => child.contains(x.el));
        if (inside) { walk(child); continue; }
        if (hasContent(child)) regions.push({ kind: 'gap', el: child });
      }
    };
    walk(container);
  } else {
    const wanted = new Set(opts.sectionIds ?? []);
    for (const w of wrappers) if (w.scope !== 'excluded' && wanted.has(w.id)) regions.push({ kind: 'wrapper', id: w.id, el: w.el });
    // content directly beside a selected section that belongs to no section: reported, never silently dropped
    for (const r of regions) {
      for (const [dir, sib] of [['before', r.el.previousElementSibling], ['after', r.el.nextElementSibling]] as Array<[string, Element | null]>) {
        if (sib && !wrapperOf.has(sib) && !Array.from(wrappers).some((x) => sib.contains(x.el)) && hasContent(sib)) {
          // text that only exists as a fallback inside <video>/<audio>/<canvas> is not content: say what the block really is
          const shown = visibleText(sib);
          const media = sib.querySelector('video,audio,canvas,iframe,object,embed');
          orphans.push({ tag: sib.tagName.toLowerCase(), text: (shown || (media ? `(<${media.tagName.toLowerCase()}> media only, no readable text — not reproduced)` : norm(sib.textContent))).slice(0, 160), between: `${dir} ${(r as any).id}` });
        }
      }
    }
  }

  // what must NOT show up in the preview: the text of every section wrapper that is not rendered
  const renderedWrappers = new Set(regions.filter((r) => r.kind === 'wrapper').map((r) => r.el));
  const outOfScopeText = wrappers
    .filter((w) => !renderedWrappers.has(w.el))
    .map((w) => ({ id: w.id, scope: w.scope, snippet: norm(w.el.textContent).slice(0, 100) }))
    .filter((o) => o.snippet.length >= 15);

  const regionEls = regions.map((r) => r.el);
  const ancestorChains = regionEls.map((el) => { const chain: Element[] = []; let n = el.parentElement; while (n && n !== doc.body && n !== doc.documentElement) { chain.unshift(n); n = n.parentElement; } return chain; });
  const matchTargets = new Set<Element>([doc.documentElement, doc.body, ...ancestorChains.flat()]);

  // ── DOM → tree ─────────────────────────────────────────────────────────────────────────
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MATH_NS = 'http://www.w3.org/1998/Math/MathML';
  const remoteAssets = new Set<string>();
  let elementCount = 0;

  const serialize = (node: Node): PreviewNode | null => {
    if (node.nodeType === 3) {
      const v = node.nodeValue ?? '';
      if (!v) return null;
      return { t: 'text', v: /^\s+$/.test(v) ? ' ' : v };
    }
    if (node.nodeType !== 1) return null;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return null;
    const tag = (el as any).localName as string;
    if (tag === 'iframe') return { t: 'el', tag: 'div', attrs: { 'data-pv-iframe': el.getAttribute('src') ?? '', role: 'img', 'aria-label': 'Embedded content is not reproduced in the preview' }, children: [] };
    elementCount++;
    const attrs: Record<string, string> = {};
    let stamp: string | undefined;
    let findingIds: string[] | undefined;
    for (const a of Array.from(el.attributes)) {
      const name = a.name;
      if (name === 'data-fra-element') { stamp = a.value; attrs['data-fra-element'] = a.value; continue; }
      if (name === 'data-pvs-stamp') { stamp = a.value; continue; } // a structural element (see structural.ts): a stamp for the island planner, not an attribute of the page
      if (name === 'data-fra-findings') { findingIds = a.value.split(' ').filter(Boolean); continue; }
      if (name.startsWith('data-fra-')) continue;
      if (/^on[a-z]/i.test(name)) continue;
      if (name === 'style' || name === 'nonce' || name === 'integrity') continue;
      attrs[name] = a.value;
      if ((name === 'src' || name === 'poster' || name === 'data-src') && /^https?:/i.test(a.value)) remoteAssets.add(a.value);
      if (name === 'srcset') for (const part of a.value.split(',')) { const u = part.trim().split(/\s+/)[0]; if (u && /^https?:/i.test(u)) remoteAssets.add(u); }
    }
    const style: Record<string, string> = {};
    const st = (el as any).style;
    if (st && st.length) {
      for (let i = 0; i < st.length; i++) {
        const prop = st[i] as string;
        const pri = st.getPropertyPriority(prop);
        style[prop] = st.getPropertyValue(prop) + (pri ? ' !important' : '');
        // an inline background-image (or any inline url()) is an asset the preview must carry too
        for (const m of st.getPropertyValue(prop).matchAll(/url\(\s*["']?(https?:[^"')]+)["']?\s*\)/gi)) remoteAssets.add(m[1] as string);
      }
    }
    const ns = el.namespaceURI === SVG_NS ? 'svg' : el.namespaceURI === MATH_NS ? 'math' : undefined;
    const children: PreviewNode[] = [];
    if (tag === 'textarea') attrs['value'] = (el as any).value ?? el.textContent ?? '';
    else for (const c of Array.from(el.childNodes)) { const s = serialize(c); if (s) children.push(s); }
    if (tag === 'input' && (el as any).value !== undefined && !attrs['value'] && (el as any).value !== '') attrs['value'] = (el as any).value;
    const out: PreviewNode = { t: 'el', tag, attrs, children };
    if (ns) out.ns = ns;
    if (Object.keys(style).length) out.style = style;
    if (findingIds) out.findingIds = findingIds;
    if (stamp) out.elementStamp = stamp;
    return out;
  };

  const attrsOf = (el: Element): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) { if (a.name.startsWith('data-fra-') || /^on[a-z]/i.test(a.name) || a.name === 'style') continue; out[a.name] = a.value; }
    return out;
  };

  // ── interactive inventory ──────────────────────────────────────────────────────────────
  const labelOf = (el: Element): string => norm((el as any).getAttribute('aria-label') || el.textContent || (el as any).value || (el as any).getAttribute('title') || (el as any).getAttribute('placeholder') || '').slice(0, 80);
  const findingsOf = (el: Element): string[] => { const c = (el as any).closest('[data-fra-findings]'); return c ? (c.getAttribute('data-fra-findings') as string).split(' ').filter(Boolean) : []; };
  const inventory = (root: Element): Array<Omit<InteractiveItem, 'sectionId'>> => {
    const out: Array<Omit<InteractiveItem, 'sectionId'>> = [];
    const seen = new Set<Element>();
    const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=switch],[role=checkbox],[role=menuitem],[aria-expanded],[tabindex]:not([tabindex="-1"])';
    for (const el of Array.from(root.querySelectorAll(sel))) {
      if (seen.has(el)) continue;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      const type = (el as any).getAttribute('type');
      let kind: InteractiveItem['kind'] = 'pointer';
      if (tag === 'a') kind = 'link';
      else if (tag === 'select') kind = 'select';
      else if (tag === 'textarea') kind = 'textarea';
      else if (tag === 'summary') kind = 'summary';
      else if (tag === 'input') kind = type === 'range' ? 'range' : 'input';
      else if ((el as any).hasAttribute('aria-expanded')) kind = 'disclosure';
      else kind = 'button';
      out.push({ index: out.length, kind, tag, label: labelOf(el), href: tag === 'a' ? (el as any).getAttribute('href') : null, findingIds: findingsOf(el) });
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (seen.has(el) || SKIP_TAGS.has(el.tagName)) continue;
      if ((el as any).closest && Array.from(seen).some((s) => s.contains(el))) continue;
      const cs = getComputedStyle(el);
      if (cs.cursor === 'pointer' && norm(el.textContent).length > 0) { seen.add(el); out.push({ index: out.length, kind: 'pointer', tag: el.tagName.toLowerCase(), label: labelOf(el), href: null, findingIds: findingsOf(el) }); }
    }
    return out.map((o, i) => ({ ...o, index: i }));
  };

  const layoutOf = (el: Element, withAlign = false): ElementLayout => {
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    const pr = parent ? parent.getBoundingClientRect() : null;
    const pcs = parent ? getComputedStyle(parent) : null;
    const inner = pr && pcs ? pr.width - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight) : 0;
    const w = (el as HTMLElement).getBoundingClientRect().width;
    // full width matters when the parent is a flex/grid container (item sizing); a block parent fills its width by itself
    const widthRules: NonNullable<ElementLayout['widthRules']> = [];
    // responsive (inside an @media / @supports / @layer group) horizontal padding of the element: a design-system heading that replaces it keeps it at the same breakpoints (`max-sm:px-4`)
    const paddingRules: NonNullable<ElementLayout['paddingRules']> = [];
    const widths = ['width', 'min-width', 'max-width', 'inline-size', 'min-inline-size', 'max-inline-size'];
    const paddings = ['padding-left', 'padding-right', 'padding-inline', 'padding-inline-start', 'padding-inline-end'];
    const bodyOf = (style: CSSStyleDeclaration, props: string[] = widths) => props.filter((p) => style.getPropertyValue(p)).map((p) => `${p}: ${style.getPropertyValue(p)}${style.getPropertyPriority(p) ? ' !important' : ''};`).join(' ');
    const visit = (rules: CSSRuleList, groups: string[]) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          const body = bodyOf(rule.style);
          const padBody = groups.some((g) => g.startsWith('@media')) ? bodyOf(rule.style, paddings) : '';
          if (!body && !padBody) continue;
          for (const selector of split(rule.selectorText)) {
            try {
              if (!el.matches(selector)) continue;
              if (body) widthRules.push({ selector, groups, body });
              if (padBody) paddingRules.push({ selector, groups, body: padBody });
            } catch { /* unsupported selector */ }
          }
        } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || rule.constructor.name === 'CSSLayerBlockRule') {
          visit((rule as CSSGroupingRule).cssRules, [...groups, rule.cssText.slice(0, rule.cssText.indexOf('{')).trim()]);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { visit(sheet.cssRules, []); } catch { /* inaccessible stylesheet */ }
    }
    const inline = bodyOf((el as HTMLElement).style);
    if (inline) widthRules.push({ selector: '', groups: [], body: inline });
    return { display: cs.display, margin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft], alignSelf: cs.alignSelf, flexGrow: cs.flexGrow, ...(withAlign ? { justifyContent: cs.justifyContent, padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft] as [string, string, string, string] } : {}), fullWidth: inner > 0 && w >= inner * 0.97 && !!pcs && /^(flex|grid)$/.test(pcs.display), ...(widthRules.length ? { widthRules } : {}), ...(paddingRules.length ? { paddingRules } : {}) };
  };

  const cssPathOf = (el: Element): string => {
    const parts: string[] = [];
    let n: Element | null = el;
    while (n && n !== doc.documentElement) {
      const parent: Element | null = n.parentElement;
      const idx = parent ? Array.from(parent.children).indexOf(n) + 1 : 1;
      parts.unshift(`${n.localName}:nth-child(${idx})`);
      n = parent;
    }
    return 'html > ' + parts.join(' > ');
  };


  // ── structural elements: recognised by what they ARE (src/preview/structural.ts has the same rules, unit-tested) ──────────────
  const ARROW_LINK = /^(read|learn|view|explore|discover)\s+(more|all|details?)\b/i;
  const STEP_LABEL_TEXT = /^step\s*\d+$/i;
  // Is the element drawn on a DARK surface? A painted ancestor background says so when there is one; a hero over an image has none (the scrim is a sibling layer), so the
  // text drawn there is the other witness: when most text around the element is light, the surface behind it is dark.
  const lumOf = (rgb: string): number | null => {
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb);
    return m ? (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 : null;
  };
  const paintedLightInside = (e: Element, root: Element): boolean => {
    for (let n: Element | null = e; n; n = n.parentElement) {
      const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(getComputedStyle(n).backgroundColor);
      if (m && !(m[4] !== undefined && Number(m[4]) < 0.5)) return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 >= 0.4;
      if (n === root) break;
    }
    return false;
  };
  const isDarkSurface = (e: Element, root: Element): boolean => {
    // a painted background INSIDE the section decides (a white card in a dark section is a light surface, whatever its grey text says)
    for (let n: Element | null = e; n; n = n.parentElement) {
      const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(getComputedStyle(n).backgroundColor);
      if (m && !(m[4] !== undefined && Number(m[4]) < 0.5)) return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 < 0.4;
      if (n === root) break;
    }
    // nothing paints it (a hero over an image: the scrim is a sibling layer): the text drawn there says what the surface is
    for (let n: Element | null = e.parentElement; n && n !== doc.body; n = n.parentElement) {
      const lums: number[] = [];
      for (const t of Array.from(n.querySelectorAll('p,h1,h2,h3,h4,h5,h6,span,a,li,button')).slice(0, 60)) {
        if (t.children.length > 0 || norm(t.textContent).length < 2) continue;
        const l = lumOf(getComputedStyle(t).color);
        if (l !== null) lums.push(l);
      }
      if (lums.length >= 3) { lums.sort((a, b) => a - b); return lums[Math.floor(lums.length / 2)]! > 0.6; }
    }
    return false;
  };
  const stampOf = (e: Element, kind: 'arrow-link' | 'eyebrow' | 'badge' | 'cta-button', sectionIndex: number, out: StructuralElement[], root: Element) => {
    let s = e.getAttribute('data-pvs-stamp');
    if (!s) { s = `pvs-${sectionIndex}-${out.length + 1}`; e.setAttribute('data-pvs-stamp', s); }
    const own = lumOf(getComputedStyle(e).color);
    const onDark = isDarkSurface(e, root) || (own !== null && own > 0.75 && !paintedLightInside(e, root));
    out.push({ stamp: s, kind, tag: e.tagName.toLowerCase(), layout: layoutOf(e, true), ...(onDark ? { onDark } : {}) });
  };
  const markStructural = (root: Element, sectionIndex: number): StructuralElement[] => {
    const out: StructuralElement[] = [];
    for (const a of Array.from(root.querySelectorAll('a[href]'))) {
      if (a.hasAttribute('data-fra-findings')) continue; // a mapped element keeps its finding's route
      const label = norm(a.textContent);
      if (label.length > 30 || !ARROW_LINK.test(label) || !a.querySelector('svg')) continue;
      stampOf(a, 'arrow-link', sectionIndex, out, root);
    }
    // a CTA button the audit could not map: a link drawn as a brand-red filled (or red-bordered) box holding a short label — the design system's Button `brand`
    const brandRed = (c: string): boolean => { const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c); return !!m && Number(m[1]) >= 150 && Number(m[2]) <= 80 && Number(m[3]) <= 80; };
    for (const a of Array.from(root.querySelectorAll('a[href]'))) {
      if (a.hasAttribute('data-fra-findings')) continue; // a mapped element keeps its finding's route
      const label = norm(a.textContent);
      if (label.length < 3 || label.length > 60 || ARROW_LINK.test(label)) continue;
      const cs = getComputedStyle(a);
      const box = (a as HTMLElement).getBoundingClientRect();
      if (box.height < 30 || box.height > 72 || box.width < 80) continue;
      if (!(brandRed(cs.backgroundColor) || brandRed(cs.backgroundImage) || (parseFloat(cs.borderTopWidth) > 0 && brandRed(cs.borderTopColor)))) continue;
      stampOf(a, 'cta-button', sectionIndex, out, root);
    }
    for (const e of Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div'))) {
      if (e.children.length > 0 || e.closest('a,button')) continue;
      const t = norm(e.textContent);
      if (t.length < 3 || t.length > 40 || !/^[A-Z0-9][A-Z0-9 &·\-–/]*$/.test(t) || !/[A-Z].*[A-Z].*[A-Z]/.test(t) || STEP_LABEL_TEXT.test(t)) continue;
      if (parseFloat(getComputedStyle(e).fontSize) > 16) continue;
      const parent = e.parentElement;
      const prev = e.previousElementSibling;
      if (!parent || !prev || parent.children.length !== 2 || parent.firstElementChild !== prev) continue;
      const iconOnly = (prev.tagName.toLowerCase() === 'svg' || prev.querySelector('svg') !== null) && norm(prev.textContent) === '' && prev.querySelector('img') === null;
      if (!iconOnly || norm(parent.textContent) !== t) continue;
      stampOf(e, 'eyebrow', sectionIndex, out, root);
    }
    // a badge: a small translucent (or bordered) pill chip holding a short label — "Featured Post" over an image. Not a link, a button or a control.
    for (const e of Array.from(root.querySelectorAll('p,span,div'))) {
      if (e.children.length > 0 || e.closest('a,button') || e.hasAttribute('data-fra-findings')) continue; // a mapped element keeps its finding's route
      const t = norm(e.textContent);
      if (t.length < 3 || t.length > 30 || /^[\d\s.,%+\-–]+$/.test(t)) continue;
      const cs = getComputedStyle(e);
      const b = (e as HTMLElement).getBoundingClientRect();
      if (b.height < 14 || b.height > 40 || b.width > 220 || cs.cursor === 'pointer' || parseFloat(cs.fontSize) > 14) continue;
      const radius = parseFloat(cs.borderTopLeftRadius);
      if (!(radius >= b.height / 2 - 0.5)) continue;
      const m = /^rgba?\(\s*\d+[,\s]+\d+[,\s]+\d+(?:[,\s/]+([\d.]+))?/.exec(cs.backgroundColor);
      const alpha = m ? (m[1] === undefined ? 1 : Number(m[1])) : 0;
      const bordered = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
      if (!((alpha > 0 && alpha <= 0.6) || bordered)) continue;
      stampOf(e, 'badge', sectionIndex, out, root);
    }
    return out;
  };

  // carousel indicators: a row of three or more small EMPTY bars, one of which is drawn differently (the active one). What separates the active bar from the others is its class
  // tokens, so DS colours are applied by class and keep following the carousel script as it moves the active class around (structural.ts indicatorCss).
  const markIndicators = (root: Element): NonNullable<ExtractedSection['indicators']> => {
    const out: NonNullable<ExtractedSection['indicators']> = [];
    for (const parent of Array.from(root.querySelectorAll('*'))) {
      const kids = Array.from(parent.children);
      if (kids.length < 3 || kids.length > 12) continue;
      if (!kids.every((k) => k.tagName === kids[0]!.tagName && k.children.length === 0 && norm(k.textContent) === '')) continue;
      const boxes = kids.map((k) => (k as HTMLElement).getBoundingClientRect());
      if (!boxes.every((x) => x.height > 0 && x.height <= 8 && x.width > 0 && x.width <= 120 && Math.abs(x.width - boxes[0]!.width) < 1.5 && Math.abs(x.height - boxes[0]!.height) < 1.5)) continue;
      const colour = kids.map((k) => getComputedStyle(k).backgroundColor);
      const counts = new Map<string, number>();
      for (const c of colour) counts.set(c, (counts.get(c) ?? 0) + 1);
      if (counts.size !== 2) continue;
      const minority = [...counts].find(([, n]) => n === 1)?.[0];
      if (minority === undefined) continue;
      const activeEl = kids[colour.indexOf(minority)]!;
      const restEl = kids.find((k) => k !== activeEl)!;
      const toks = (e: Element) => (e.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      const a = new Set(toks(activeEl)), r = new Set(toks(restEl));
      const shared = [...a].filter((t) => r.has(t));
      const active = [...a].filter((t) => !r.has(t)), rest = [...r].filter((t) => !a.has(t));
      if (shared.length === 0 || (active.length === 0 && rest.length === 0)) continue;
      const dark = isDarkSurface(parent, root);
      out.push({ shared, active, rest, dark });
    }
    return out;
  };

  // ── regions → raw ──────────────────────────────────────────────────────────────────────
  const raw: RawRegion[] = regions.map((r, i) => {
    const el = r.el;
    const structural = markStructural(el, i);
    const tree = serialize(el)!;
    const findingElements: Array<{ stamp: string; findingIds: string[]; tag: string; textAlign: string; layout: ElementLayout }> = [];
    for (const f of [el, ...Array.from(el.querySelectorAll('[data-fra-findings]'))]) {
      if ((f as any).hasAttribute('data-fra-findings')) findingElements.push({ stamp: (f as any).getAttribute('data-fra-element') ?? '', findingIds: ((f as any).getAttribute('data-fra-findings') as string).split(' ').filter(Boolean), tag: f.tagName.toLowerCase(), textAlign: getComputedStyle(f).textAlign, layout: layoutOf(f) });
    }
    return {
      id: r.kind === 'wrapper' ? r.id : `region-${i + 1}`,
      order: i,
      unlabelled: r.kind === 'gap',
      tree,
      ancestors: ancestorChains[i]!.map((a) => ({ tag: a.tagName.toLowerCase(), attrs: attrsOf(a) })),
      text: norm(el.textContent),
      visibleText: visibleText(el),
      height: Math.round((el as any).getBoundingClientRect().height),
      locator: { cssPath: cssPathOf(el), textStart: norm(el.textContent).slice(0, 80), textLength: norm(el.textContent).length },
      links: Array.from(el.querySelectorAll('a[href]')).map((a: any) => a.getAttribute('href') as string),
      images: el.querySelectorAll('img').length,
      headings: Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')).map((h) => norm(h.textContent)),
      findingElements,
      structural,
      indicators: markIndicators(el),
      outerSpacing: (() => {
        // ancestors that hold no OTHER region belong to this section alone: their vertical padding and margin are the section's own breathing room
        let top = 0, bottom = 0;
        for (const a of ancestorChains[i]!) {
          if (regionEls.some((o) => o !== el && a.contains(o))) continue;
          const cs = getComputedStyle(a);
          top += parseFloat(cs.paddingTop) + parseFloat(cs.marginTop);
          bottom += parseFloat(cs.paddingBottom) + parseFloat(cs.marginBottom);
        }
        return { top: Math.round(top), bottom: Math.round(bottom) };
      })(),
      interactive: inventory(el),
    };
  });

  // ── fonts actually used ────────────────────────────────────────────────────────────────
  const usedFamilies = new Set<string>();
  for (const el of regionEls) {
    for (const e of [el, ...Array.from(el.querySelectorAll('*'))]) {
      for (const f of getComputedStyle(e).fontFamily.split(',')) usedFamilies.add(f.trim().replace(/^["']|["']$/g, ''));
    }
  }

  // ── CSS: only rules that apply to the in-scope sections (or the ancestors/html/body they sit in) ──
  const matchesAny = (selector: string): boolean => {
    let n: string;
    try { n = normalize(selector); } catch { return false; }
    try {
      for (const t of matchTargets) if (t.matches(n)) return true;
      for (const el of regionEls) { if (el.matches(n) || el.querySelector(n)) return true; }
    } catch { return false; }
    return false;
  };

  const rules: RuleItem[] = [];
  const keyframes: Array<{ name: string; text: string }> = [];
  const fontFaces: Array<{ family: string; text: string }> = [];
  const properties: Array<{ name: string; text: string }> = [];
  let ruleCount = 0;
  let kept = 0;

  const header = (rule: any): string => { const t = rule.cssText as string; return t.slice(0, t.indexOf('{')).trim(); };
  const walkRules = (list: CSSRuleList, groups: string[]) => {
    for (const rule of Array.from(list) as any[]) {
      const ctor = rule.constructor?.name as string;
      ruleCount++;
      if (ctor === 'CSSStyleRule') {
        const kept_ = split(rule.selectorText as string).filter(matchesAny);
        if (kept_.length) { kept++; rules.push({ kind: 'style', groups, selectors: kept_, body: rule.style.cssText as string }); }
      } else if (ctor === 'CSSLayerStatementRule') {
        rules.push({ kind: 'layer-statement', groups, text: rule.cssText as string });
      } else if (ctor === 'CSSKeyframesRule' || ctor === 'CSSKeyframeRule') {
        if (ctor === 'CSSKeyframesRule') keyframes.push({ name: rule.name as string, text: rule.cssText as string });
      } else if (ctor === 'CSSFontFaceRule') {
        fontFaces.push({ family: String(rule.style.getPropertyValue('font-family')).trim().replace(/^["']|["']$/g, ''), text: rule.cssText as string });
      } else if (ctor === 'CSSPropertyRule') {
        properties.push({ name: rule.name as string, text: rule.cssText as string });
      } else if (rule.cssRules && (ctor === 'CSSMediaRule' || ctor === 'CSSSupportsRule' || ctor === 'CSSContainerRule' || ctor === 'CSSLayerBlockRule' || ctor === 'CSSScopeRule' || ctor === 'CSSStartingStyleRule')) {
        walkRules(rule.cssRules as CSSRuleList, [...groups, header(rule)]);
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets) as any[]) {
    let list: CSSRuleList | null = null;
    try { list = sheet.cssRules; } catch { list = null; }
    if (list) walkRules(list, []);
  }
  // remote url(...) used by kept CSS (data: URIs are resolved Node-side)
  for (const r of rules) for (const m of String(r.body ?? '').matchAll(/url\(\s*["']?(https?:[^"')]+)["']?\s*\)/gi)) remoteAssets.add(m[1] as string);

  const attrsMap = (el: Element): Record<string, string> => { const o: Record<string, string> = {}; for (const a of Array.from(el.attributes)) if (!a.name.startsWith('data-fra-') && a.name !== 'style') o[a.name] = a.value; return o; };
  return { regions: raw, rules, keyframes, fontFaces, properties, usedFamilies: [...usedFamilies], htmlAttrs: attrsMap(doc.documentElement), bodyAttrs: attrsMap(doc.body), orphans, outOfScopeText, remoteAssets: [...remoteAssets], stats: { rules: ruleCount, keptRules: kept, elements: elementCount } };
}

/** Opens `html` (a standalone snapshot) in an offline stand-in page. */
/** Opens `html` (a standalone snapshot) in an offline stand-in page of a context that ignores the snapshot's own CSP. */
export async function openOfflineSnapshot(context: BrowserContext, html: string, viewport = { width: 1440, height: 900 }): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = context.browser();
  const ctx = browser ? await browser.newContext({ bypassCSP: true, viewport }) : context;
  const page = await ctx.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return { page, close: async () => { await page.close().catch(() => {}); if (ctx !== context) await ctx.close().catch(() => {}); } };
}

/** The page-side extraction, evaluated as an expression string so the snapshot's CSP cannot block it. */
export function extractionExpression(opts: { sectionIds: string[] | null; fullPage: boolean }): string {
  return `(async () => { const helpers = { normalize: ${normalizeForMatching.toString()}, split: ${splitSelectorList.toString()}, visibleText: ${visibleTextOf.toString()} }; return await (${extractInPage.toString()})(${JSON.stringify(opts)}, helpers); })()`;
}

export async function extractSections(context: BrowserContext, originalHtml: string, opts: ExtractOptions): Promise<ExtractionResult> {
  const { page, close } = await openOfflineSnapshot(context, originalHtml);
  try {
    await compactCarousels(page); // retain all original slides; remove only library duplicates
    // DS-first: the original element's place in its parent (display, margins, alignment) is read BEFORE edits: the audit's CSS targets (display
    // inline-flex, padding 0) would otherwise change how it sits (an auto-margin-centred button lost its centring), and a design-system
    // component that replaces the element has to take the original's slot, not the edited one.
    let preLayouts: Map<string, ElementLayout> | null = null;
    if (opts.dsFirst) {
      const pre = (await page.evaluate(extractionExpression({ sectionIds: opts.sectionIds, fullPage: opts.fullPage }))) as RawExtraction;
      preLayouts = new Map(pre.regions.flatMap((r) => [...r.findingElements.map((fe) => [fe.stamp, fe.layout] as const), ...r.structural.map((se) => [se.stamp, se.layout] as const)]));
    }
    for (const edit of applyStateGuards(opts.edits, opts.stateGuards)) {
      try { await applyEdit(page, edit, null); } catch { /* an edit that no longer applies is simply not in the preview; verification reports the finding */ }
    }
    const raw = (await page.evaluate(extractionExpression({ sectionIds: opts.sectionIds, fullPage: opts.fullPage }))) as RawExtraction;

    const keyframeNames = new Set(raw.keyframes.map((k) => k.name));
    const baseCss = renderRuleItems(raw.rules.filter((r) => r.kind === 'style' || r.kind === 'layer-statement'), rewriteSelectorForShadow);
    const usedNames = referencedAnimationNames(baseCss, keyframeNames);
    const keyframeCss = raw.keyframes.filter((k) => usedNames.has(k.name)).map((k) => k.text).join('\n');
    const fontCss = raw.fontFaces.filter((f) => raw.usedFamilies.includes(f.family)).map((f) => f.text).join('\n');
    const propertyCss = raw.properties.filter((p) => baseCss.includes(p.name) || keyframeCss.includes(p.name)).map((p) => p.text).join('\n');

    if (preLayouts) for (const r of raw.regions) for (const fe of [...r.findingElements, ...r.structural]) { const l = preLayouts.get(fe.stamp); if (l) fe.layout = l; }
    const sections: ExtractedSection[] = raw.regions.map((r) => ({
      id: r.id, name: opts.names[r.id] ?? (r.unlabelled ? `Unlabelled content ${r.order + 1}` : r.id), order: r.order, unlabelled: r.unlabelled,
      tree: r.tree, ancestors: r.ancestors, text: r.text, visibleText: r.visibleText, height: r.height, locator: r.locator, links: r.links, images: r.images, headings: r.headings, findingElements: r.findingElements, structural: r.structural, ...(r.indicators.length ? { indicators: r.indicators } : {}),
    }));
    // the same spacing at a phone width (the original's `md:py-40` is smaller there): read last, the viewport is put back
    let mobileSpacing: Array<{ top: number; bottom: number }> | null = null;
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const mob = (await page.evaluate(extractionExpression({ sectionIds: opts.sectionIds, fullPage: opts.fullPage }))) as RawExtraction;
      if (mob.regions.length === raw.regions.length) mobileSpacing = mob.regions.map((r) => r.outerSpacing);
    } catch { /* no mobile spacing: the desktop values apply at every width */ } finally { await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined); }
    sections.forEach((sec, i) => {
      const d = raw.regions[i]!.outerSpacing;
      if (d.top === 0 && d.bottom === 0 && !mobileSpacing?.[i]?.top && !mobileSpacing?.[i]?.bottom) return;
      sec.outerSpacing = { desktop: d, mobile: mobileSpacing?.[i] ?? d };
    });
    const interactive: InteractiveItem[] = raw.regions.flatMap((r) => r.interactive.map((i) => ({ ...i, sectionId: r.id })));
    return {
      sections,
      scopedCss: [baseCss, keyframeCss].filter(Boolean).join('\n'),
      globalCss: [fontCss, propertyCss].filter(Boolean).join('\n'),
      htmlAttrs: raw.htmlAttrs,
      bodyAttrs: raw.bodyAttrs,
      orphanContent: raw.orphans,
      outOfScopeText: raw.outOfScopeText,
      remoteAssets: raw.remoteAssets,
      interactive,
      stats: raw.stats,
    };
  } finally {
    await close();
  }
}


/** Region ids and production locators, read from a live, stamped page (used to find the same sections on the original site before any edit). */
export async function locateRegions(page: Page, opts: { sectionIds: string[] | null; fullPage: boolean }): Promise<Array<{ id: string; order: number; unlabelled: boolean; locator: { cssPath: string; textStart: string; textLength: number } }>> {
  const raw = (await page.evaluate(extractionExpression(opts))) as RawExtraction;
  return raw.regions.map((r) => ({ id: r.id, order: r.order, unlabelled: r.unlabelled, locator: r.locator }));
}
