import type { Page } from 'playwright';
import type { StructureFacts } from '../reference/element-kind.ts';
import { asPageFunction } from './rendered.ts';

/** How long the probe waits for finite animations of the element and its ancestors to end. */
const SETTLE_CAP_MS = 1500;

/**
 * Reads the facts that tell a card from a wrapper from the RENDERED element: does it paint a box (a visible border, shadow, tinted or gradient fill),
 * does it hold a heading with text/media/actions, is it one of several look-alikes, is it a link, does it fill its section, is it just a layout wrapper
 * around one child. It decides nothing — `inferElementKinds` (reference/element-kind.ts) does, from these facts plus the audit's and the mapping's evidence.
 *
 * Deterministic by construction: it reads the LAYOUT box (no transforms) and never opacity, so a card that is fading or sliding in is the same card at
 * any moment; animations of visibility, height and width (which DO change what is visible and how big it is) are waited out first, and the facts that reach the
 * hashed resolved-targets record are booleans and enums. Animations that outlast the cap leave `settled: false`: the classifier then gives the structure no say.
 */

const PROBE_SRC = String.raw`async ([el]) => {
  const flat = (n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null;
  // Wait out the FINITE animations of the element's subtree and of its ancestors (a reveal that animates visibility, height or width changes what is visible and how
  // big it is; an ancestor's does the same to inherited visibility): the facts are those of the settled element. Endless ones (a spinner) cannot be waited for and
  // are not an input; a finite one still running at the cap leaves the facts unsettled, which the classifier does not read.
  const live = () => {
    const out = el.getAnimations({ subtree: true });
    for (let n = flat(el); n; n = flat(n)) if (n.getAnimations) out.push(...n.getAnimations());
    return out.filter((a) => (a.playState === 'running' || a.playState === 'pending') && a.effect && Number.isFinite(a.effect.getComputedTiming().endTime));
  };
  const t0 = performance.now();
  for (let l = live(); l.length > 0 && performance.now() - t0 < ${SETTLE_CAP_MS}; l = live()) await Promise.race([Promise.allSettled(l.map((a) => a.finished)), new Promise((r) => setTimeout(r, 80))]);
  const settled = live().length === 0;
  // the landmark the element sits in (nearest first), across shadow roots
  let landmark = null;
  for (let n = el; n && !landmark; n = flat(n)) {
    const t = n.tagName ? n.tagName.toLowerCase() : '';
    const role = (n.getAttribute && n.getAttribute('role') || '').trim().toLowerCase();
    landmark = t === 'nav' || role === 'navigation' ? 'navigation' : t === 'footer' || role === 'contentinfo' ? 'footer' : t === 'header' ? 'header' : null;
  }
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth || 1;
  // Only facts that do not move while the page animates: the LAYOUT box (a scale() or translate() animation never changes it), no opacity, no transform.
  const html = el instanceof HTMLElement;
  const width = html ? el.offsetWidth : r.width;
  const height = html ? el.offsetHeight : r.height;
  const alpha = (c) => {
    if (!c || c === 'transparent') return 0;
    const slash = c.match(/\/\s*([\d.]+)(%?)\s*\)\s*$/);
    if (slash) return parseFloat(slash[1]) / (slash[2] ? 100 : 1);
    const m = c.match(/^(?:rgba?|hsla?)\(([^)]*)\)$/);
    if (!m) return 1;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean);
    return p.length > 3 ? parseFloat(p[3]) : 1;
  };
  const COLOUR = /(?:rgba?|hsla?|color|oklch|oklab|lab|lch|hwb)\([^)]*\)|transparent/g;
  const splitTop = (v) => {
    const out = []; let depth = 0, cur = '';
    for (const ch of v) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  // a box-shadow paints only if some layer has a visible colour AND an offset, blur or spread: Tailwind resets compute to "rgba(0, 0, 0, 0) 0px 0px 0px 0px"
  const shadowed = cs.boxShadow !== 'none' && splitTop(cs.boxShadow).some((layer) => {
    const colours = layer.match(COLOUR) || [];
    const lengths = (layer.replace(COLOUR, ' ').match(/-?[\d.]+/g) || []).map(parseFloat);
    return (colours.length === 0 || colours.some((c) => alpha(c) > 0)) && lengths.some((n) => n !== 0);
  });
  // a gradient paints only if some stop is visible
  const stops = /gradient\(/.test(cs.backgroundImage) ? (cs.backgroundImage.match(COLOUR) || []) : null;
  const gradient = stops !== null && (stops.length === 0 || stops.some((c) => alpha(c) > 0));
  const side = (s) => parseFloat(cs.getPropertyValue('border-' + s + '-width')) >= 1 && !/^(none|hidden)$/.test(cs.getPropertyValue('border-' + s + '-style')) && alpha(cs.getPropertyValue('border-' + s + '-color')) > 0;
  let behind = '';
  for (let n = el.parentElement; n; n = n.parentElement) { const b = getComputedStyle(n).backgroundColor; if (alpha(b) > 0) { behind = b; break; } }
  const own = cs.backgroundColor;

  // what the element holds, three levels deep: a heading, text, media, links/buttons and form controls make a composed block
  let headings = 0, textBlocks = 0, media = 0, actions = 0, controls = 0, seen = 0;
  const walk = (node, depth) => {
    for (const c of node.children) {
      if (++seen > 300) return;
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
      const t = c.tagName.toLowerCase(), role = c.getAttribute('role');
      if (/^h[1-6]$/.test(t) || role === 'heading') headings++;
      else if ((t === 'a' && c.hasAttribute('href')) || t === 'button' || role === 'button') actions++;
      else if (/^(img|svg|picture|video|canvas)$/.test(t)) media++;
      else if (/^(input|select|textarea)$/.test(t)) { if (c.getAttribute('type') !== 'hidden') controls++; }
      else {
        let text = '';
        for (const n of c.childNodes) if (n.nodeType === 3) text += n.textContent;
        if (text.replace(/\s+/g, ' ').trim().length >= 12) textBlocks++;
      }
      if (depth < 3 && t !== 'svg') walk(c, depth + 1);
    }
  };
  walk(el, 1);

  // look-alike siblings: same tag, at least 80% of the same classes
  let similar = 0;
  if (el.parentElement) {
    const mine = new Set((el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
    for (const sib of el.parentElement.children) {
      if (sib === el || sib.tagName !== el.tagName) continue;
      const theirs = new Set((sib.getAttribute('class') || '').split(/\s+/).filter(Boolean));
      let common = 0;
      for (const k of mine) if (theirs.has(k)) common++;
      const union = mine.size + theirs.size - common;
      if (union === 0 || common / union >= 0.8) similar++;
    }
  }

  const kids = Array.from(el.children).filter((c) => getComputedStyle(c).display !== 'none');
  let onlyChildSameBox = false;
  if (kids.length === 1) {
    const k = kids[0];
    const kb = k.getBoundingClientRect();
    const kw = k instanceof HTMLElement ? k.offsetWidth : kb.width;
    const kh = k instanceof HTMLElement ? k.offsetHeight : kb.height;
    onlyChildSameBox = Math.abs(kw - width) <= 1 && Math.abs(kh - height) <= 1;
  }

  const selfAnchor = el.matches('a[href]');
  const round = (x, d) => Math.round(x * d) / d;
  const contents = cs.display === 'contents';
  return {
    tag: el.tagName.toLowerCase(),
    role: (el.getAttribute('role') || '').trim().toLowerCase() || null,
    displayContents: contents,
    visible: cs.display !== 'none' && cs.visibility !== 'hidden' && (contents || (width > 0 && height > 0)),
    viewport: vw >= 768 ? 'desktop' : 'mobile',
    width: round(width, 10), height: round(height, 10), widthRatio: round(width / vw, 1000),
    bordered: ['top', 'right', 'bottom', 'left'].some(side),
    shadowed,
    tinted: alpha(own) > 0 && own !== (behind || 'rgb(255, 255, 255)'),
    gradient,
    headings, textBlocks, media, actions, controls,
    interactive: selfAnchor || !!el.closest('a[href], button, [role="button"]') || cs.cursor === 'pointer',
    selfAnchor,
    similarSiblings: similar,
    onlyChildSameBox,
    landmark,
    settled,
  };
}`;

/** The structure facts of the element `selector` matches on `page`, or null when nothing matches. */
export async function probeStructure(page: Page, selector: string): Promise<StructureFacts | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  try {
    return (await page.evaluate(asPageFunction(PROBE_SRC), [handle])) as StructureFacts;
  } finally {
    await handle.dispose();
  }
}
