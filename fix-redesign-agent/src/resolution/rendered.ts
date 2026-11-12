import type { ElementHandle, Page } from 'playwright';
import { colorDeltaEWithAlpha } from '../t-layer/computed-style.ts';
import { compositeOver, deltaE2000, evaluateColourVisible, parseBackdrop, parseCssColour, suppliesProperty } from './ds-colours.ts';
import type { ResolvedTarget, StateName } from './schema.ts';

/**
 * Rendered evidence for the Resolver and the verifiers: facts read from the page as it is actually
 * laid out. Used where the audit's own comparison could not decide (a keyword like `normal`/`auto`, an
 * inherited value, a theme surface) — the answer comes from a measurement, never from a guess.
 */

export interface RenderedFacts {
  found: boolean;
  display: string | null;
  /** Computed value of `property` on the element, and on its parent. */
  value: string | null;
  parentValue: string | null;
  /** The element's computed value equals its parent's (the value is inherited/cascaded, not set at this element). */
  inheritedFromParent: boolean | null;
  /** Light or dark by the element's own paint chain; independent of the property asked about. The backdrop a colour lands on IS property-dependent: see `measureBackdrop`. */
  surface: 'light' | 'dark' | 'unknown';
}

/**
 * Reads ANY computed CSS colour to sRGB + alpha, in the page: `rgb()`/`rgba()` directly, everything else (`oklch()`, `color(srgb ...)` - what `color-mix()` computes to -,
 * `color(display-p3 ...)`, `lab()` ...) through the browser's own canvas (painted over black and over white, which gives colour and alpha back in sRGB). A colour the
 * browser cannot resolve is null: the caller must treat that as UNKNOWN, never as transparent.
 */
const READ_COLOUR_SRC = String.raw`(() => {
  let g = null;
  try { const c = document.createElement('canvas'); c.width = 1; c.height = 1; g = c.getContext('2d', { willReadFrequently: true }); } catch (e) { g = null; }
  const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  const accepts = (s) => { g.fillStyle = '#010203'; g.fillStyle = s; const a = g.fillStyle; g.fillStyle = '#040506'; g.fillStyle = s; return a === g.fillStyle; };
  return (text) => {
    const s = String(text).trim();
    const m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean);
      if ((p.length === 3 || p.length === 4) && p.every((x) => NUM.test(x))) { const n = p.map(Number); return { r: n[0], g: n[1], b: n[2], a: p.length > 3 ? n[3] : 1 }; }
    }
    if (!g || !accepts(s)) return null;
    const paint = (under) => { g.clearRect(0, 0, 1, 1); g.fillStyle = under; g.fillRect(0, 0, 1, 1); g.fillStyle = s; g.fillRect(0, 0, 1, 1); return g.getImageData(0, 0, 1, 1).data; };
    const k = paint('#000'); const w = paint('#fff');
    const a = Math.min(1, Math.max(0, 1 - ((w[0] - k[0]) + (w[1] - k[1]) + (w[2] - k[2])) / 765));
    return a < 0.004 ? { r: 0, g: 0, b: 0, a: 0 } : { r: Math.min(255, k[0] / a), g: Math.min(255, k[1] / a), b: Math.min(255, k[2] / a), a };
  };
})()`;

/**
 * The parent in the FLAT tree: the slot an element is assigned to, else its parent element, else - across a shadow-root boundary - the shadow host. The PREVIEW renders
 * each section inside a shadow root, so a walk by `parentElement` alone stops at the root and never sees the host's (or anything above it) paint.
 */
const FLAT_PARENT_SRC = String.raw`(n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null`;

/**
 * The colour a property is drawn over: the element's own background (a border and text sit on it; a background does not) and its ancestors', composited
 * from the nearest opaque one down to the canvas, walking the flat tree and skipping `display: contents` layers (they paint nothing). A gradient or image, partial
 * opacity, a blend mode, a filter / backdrop filter / mask / clip-path on an ANCESTOR (or the element), a ::before / ::after fill on an ancestor (or on the element,
 * for what sits on its own background), an inset box-shadow or a covering outline on it or an ancestor, or a sibling layer - out of flow, stacked by a grid, pulled over by a negative
 * margin, z-index: -1 - that overlaps the box and paints a fill or a replaced element (img, svg, video, canvas ...)
 * makes it UNMEASURABLE (null + why): the result is then `unverified`, never a guess. So does a background
 * colour the browser cannot resolve: an unreadable layer is never transparent. The element's OWN opacity is not read: this is what lies behind it, and a card that
 * fades in must not change what is recorded about it. The page canvas is white.
 */
const BACKDROP_SRC = String.raw`(([el, includeSelf]) => {
  if (!el) return { rgb: null, why: 'the element was not found' };
  const read = ${READ_COLOUR_SRC};
  const flatParent = ${FLAT_PARENT_SRC};
  const name = (n) => '<' + n.tagName.toLowerCase() + '>';
  const painted = (cs) => {
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return 'image';
    const c = read(cs.backgroundColor);
    return c === null ? 'unreadable' : c.a > 0 ? 'colour' : null;
  };
  // a ::before / ::after that generates a box and paints a background
  const pseudoFill = (n) => {
    for (const which of ['::before', '::after']) {
      const p = getComputedStyle(n, which);
      if (!p || p.content === 'none' || p.content === 'normal' || p.display === 'none') continue;
      if (painted(p) !== null) return which;
    }
    return null;
  };
  const box = el.getBoundingClientRect();
  // a replaced element (or one holding one) paints pixels no colour read can see: the hero-image / background-svg pattern
  const REPLACED = 'img, svg, picture, video, canvas, iframe, object, embed';
  const paintsPixels = (s, cs) => painted(cs) !== null || s.matches(REPLACED) || !!s.querySelector(REPLACED) || pseudoFill(s) !== null;
  // a sibling that paints a fill or a replaced element and overlaps the box lies behind (or over) the element and is not on the ancestor chain - WHATEVER its
  // position: out of flow, stacked by a CSS grid (grid-area: 1 / 1), pulled over by a negative margin, a z-index: -1 layer. Siblings that merely follow each other in flow
  // do not overlap (their edges touch), so overlap by more than a rounding error is the signal.
  // Siblings are the children of the node's real parent: for a direct child of a shadow root that is the root, not the host (whose children are the light DOM).
  const overlap = (r) => Math.min(r.right, box.right) - Math.max(r.left, box.left) > 0.5 && Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top) > 0.5;
  const layerName = (s) => { const p = getComputedStyle(s).position; return (p === 'absolute' || p === 'fixed' ? 'an out-of-flow layer ' : 'a stacked layer ') + name(s); };
  const layerOver = (n) => {
    const parent = n.parentNode || flatParent(n);
    if (!parent) return null;
    const siblings = n.assignedSlot ? [] : Array.from(parent.children || []).slice(0, 80);
    for (const s of siblings) {
      if (s === n || s === el) continue;
      const cs = getComputedStyle(s);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (!paintsPixels(s, cs)) continue;
      const r = s.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && overlap(r)) return s;
    }
    return null;
  };
  // an inset box-shadow is painted over the node's background and under what sits in it; an outline is painted over the content at the node's border edge, so a negative offset
  // (or a wide outline) can lie over the box. Neither is in the background colour.
  const insetShadow = (cs) => cs.boxShadow && cs.boxShadow !== 'none' && /\binset\b/.test(cs.boxShadow);
  const outlineOver = (n, cs) => {
    const w = parseFloat(cs.outlineWidth) || 0;
    if (cs.outlineStyle === 'none' || cs.outlineStyle === 'hidden' || w <= 0) return false;
    const o = parseFloat(cs.outlineOffset) || 0;
    const r = n.getBoundingClientRect();
    const grow = (d) => ({ left: r.left - d, right: r.right + d, top: r.top - d, bottom: r.bottom + d });
    const outer = grow(o + w); const inner = grow(o);
    const inside = box.left >= inner.left && box.right <= inner.right && box.top >= inner.top && box.bottom <= inner.bottom;
    return overlap(outer) && !inside;
  };
  const layers = [];
  const start = includeSelf ? el : flatParent(el);
  const over = layerOver(el);
  if (over) return { rgb: null, why: layerName(over) + ' with its own paint overlaps ' + name(el) };
  for (let n = start; n; n = flatParent(n)) {
    const cs = getComputedStyle(n);
    if (cs.display === 'contents') continue;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return { rgb: null, why: 'a background image or gradient on ' + name(n) };
    if (n !== el && parseFloat(cs.opacity) < 1) return { rgb: null, why: 'partial opacity on ' + name(n) };
    if (insetShadow(cs)) return { rgb: null, why: 'an inset box-shadow on ' + name(n) };
    if (outlineOver(n, cs)) return { rgb: null, why: 'an outline on ' + name(n) + ' that can lie over ' + name(el) };
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return { rgb: null, why: 'a blend mode on ' + name(n) };
    // a filter, a backdrop filter, a mask or a clip changes the colours (or the pixels) that land behind or inside the box: the text of the background says nothing
    const effect = cs.filter !== 'none' ? 'a filter' : cs.backdropFilter && cs.backdropFilter !== 'none' ? 'a backdrop filter' : (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') ? 'a mask' : cs.clipPath && cs.clipPath !== 'none' ? 'a clip-path' : null;
    if (effect) return { rgb: null, why: effect + ' on ' + name(n) };
    const fill = pseudoFill(n);
    if (fill) return { rgb: null, why: 'a ' + fill + ' fill on ' + name(n) };
    const c = read(cs.backgroundColor);
    if (c === null) return { rgb: null, why: 'an unreadable background colour ' + cs.backgroundColor + ' on ' + name(n) };
    if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    if (n !== el) { const other = layerOver(n); if (other) return { rgb: null, why: layerName(other) + ' with its own paint overlaps ' + name(n) }; }
  }
  let base = { r: 255, g: 255, b: 255 };
  for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
  return { rgb: 'rgb(' + Math.round(base.r) + ', ' + Math.round(base.g) + ', ' + Math.round(base.b) + ')', why: null };
})`;

const FACTS = String.raw`(([el, prop]) => {
  if (!el) return { found: false, display: null, value: null, parentValue: null, inheritedFromParent: null, surface: 'unknown' };
  const flatParent = ${FLAT_PARENT_SRC};
  const cs = getComputedStyle(el); const parent = flatParent(el); const pcs = parent ? getComputedStyle(parent) : null;
  const value = cs.getPropertyValue(prop); const parentValue = pcs ? pcs.getPropertyValue(prop) : null;
  const read = ${READ_COLOUR_SRC};
  // surface: the first layer of the flat tree (self, ancestors, across shadow roots; display:contents layers paint nothing) with a non-transparent background decides light vs dark by relative luminance; a background that cannot be read decides nothing
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  let surface = 'unknown';
  for (let n = el; n; n = flatParent(n)) {
    const ncs = getComputedStyle(n);
    if (ncs.display === 'contents') continue;
    const c = read(ncs.backgroundColor);
    if (c === null) break;
    if (c.a >= 0.5) { surface = lum(c) < 0.35 ? 'dark' : 'light'; break; }
  }
  return { found: true, display: cs.display, value, parentValue, inheritedFromParent: parentValue !== null ? value === parentValue : null, surface };
})`;

export async function renderedFacts(page: Page, selector: string, property: string): Promise<RenderedFacts> {
  const h = await page.$(selector); // an element handle: Playwright's selector engine pierces open shadow roots, document.querySelector does not
  try {
    return (await page.evaluate(asPageFunction(FACTS), [h, property])) as RenderedFacts;
  } finally {
    await h?.dispose();
  }
}

export interface UsedGap {
  /** `none`: the element is not a flex/grid container, so `gap` has no effect. */
  applicable: boolean;
  /** Used spacing between adjacent in-flow children along the axis, in px; null when it cannot be measured (fewer than two children). */
  px: number | null;
  display: string | null;
  children: number;
}

const USED_GAP_SRC = String.raw`([el, ax]) => {
  if (!el) return { applicable: false, px: null, display: null, children: 0 };
  const cs = getComputedStyle(el);
  const display = cs.display;
  if (!/(^|-)(flex|grid)$/.test(display)) return { applicable: false, px: null, display, children: 0 };
  const kids = Array.from(el.children).filter((c) => { const s = getComputedStyle(c); const r = c.getBoundingClientRect(); return s.display !== 'none' && s.position !== 'absolute' && s.position !== 'fixed' && r.width > 0 && r.height > 0; });
  if (kids.length < 2) return { applicable: true, px: null, display, children: kids.length };
  const rects = kids.map((c) => c.getBoundingClientRect());
  const key = ax === 'row' ? { start: 'top', end: 'bottom' } : { start: 'left', end: 'right' };
  const sorted = rects.slice().sort((a, b) => a[key.start] - b[key.start]);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    const d = cur[key.start] - prev[key.end];
    // neighbours that overlap along the axis sit in the same row/column: they do not measure this axis
    if (d >= -0.5 && cur[key.start] > prev[key.start] + 0.5) gaps.push(Math.max(0, d));
  }
  if (gaps.length === 0) return { applicable: true, px: null, display, children: kids.length };
  gaps.sort((a, b) => a - b);
  return { applicable: true, px: Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10, display, children: kids.length };
}`;

/**
 * Playwright never CALLS a string handed to `page.evaluate` (it evaluates it as an expression and returns the function itself, which
 * serializes to `undefined`). A real function built from the source is called with the argument — and carries no transpiler helpers.
 */
export const asPageFunction = (src: string) => new Function('arg', `return (${src})(arg);`) as (arg: unknown) => unknown;

/** The USED row/column gap of a flex or grid container, measured from its children's boxes (the computed value stays the keyword `normal`). */
export async function measureUsedGap(page: Page, selector: string, axis: 'row' | 'column'): Promise<UsedGap> {
  const h = await page.$(selector);
  if (!h) return { applicable: false, px: null, display: null, children: 0 };
  return (await page.evaluate(asPageFunction(USED_GAP_SRC), [h, axis])) as UsedGap;
}

/** The same measurement for an element handle (the preview's sections live in shadow roots, which a selector cannot reach). */
export async function measureUsedGapOf(page: Page, handle: ElementHandle<Element>, axis: 'row' | 'column'): Promise<UsedGap> {
  return (await page.evaluate(asPageFunction(USED_GAP_SRC), [handle, axis])) as UsedGap;
}

type StateLocator = ReturnType<Page['locator']>;

/** How long a state may take to settle (a transition or animation on the element or an ancestor) before it is reported as not settled. */
export const SETTLE_CAP_MS = 2400;

export interface Settled {
  settled: boolean;
  /** Why not, in words that do not depend on the moment of the sample (the record is hashed). */
  why: string | null;
}

/**
 * Waits until the element - and its ancestors, an inherited colour animates with an ancestor's transition - has stopped changing: every finite transition /
 * animation (`getAnimations()`) of the element, its ancestors and their ::before / ::after, and of the sibling layers that overlap it, is finished, and the values a verifier reads (colours, backgrounds, shadows, opacity, the measured property) AGREE on consecutive
 * reads; an endless animation that animates one of those values is never settled (its phase is the moment of the read), while another endless animation (a
 * spinner) runs on and three irregularly spaced reads must agree (two can coincide at the turning point of an alternating one). A state change
 * starts its transition at the next style recalculation, so two frames are waited first. Not settled by the cap: the caller reports UNVERIFIED, never the sample.
 */
const SETTLE_SRC = String.raw`(async ([el, property, cap]) => {
  const flatParent = ${FLAT_PARENT_SRC};
  const chain = [];
  for (let n = el; n; n = flatParent(n)) chain.push(n);
  // what else can decide the element's colours or backdrop: a SIBLING (of the element or of an ancestor) whose box overlaps the element - an out-of-flow layer, a stacked one - with
  // everything inside it. Anywhere else on the page cannot reach this box.
  const box = el.getBoundingClientRect();
  const layers = new Set();
  for (const n of chain) {
    const parent = n.parentNode || flatParent(n);
    for (const s of Array.from((parent && parent.children) || []).slice(0, 80)) {
      if (s === n || chain.includes(s)) continue;
      const r = s.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && Math.min(r.right, box.right) - Math.max(r.left, box.left) > 0.5 && Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top) > 0.5) layers.add(s);
    }
  }
  // an animation counts when it targets the element chain itself (not a descendant of the element) or an overlapping layer / anything in it. Pseudo-element animations
  // (::before / ::after) are not in element.getAnimations(): they are read from the root, where their target is the element that owns the pseudo-element.
  const owns = (t) => { for (let n = t; n; n = flatParent(n)) { if (chain.includes(n)) return n === t; if (layers.has(n)) return true; } return false; };
  const roots = Array.from(new Set(chain.map((n) => n.getRootNode()).filter((r) => r && r.getAnimations)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => requestAnimationFrame(fin)); setTimeout(fin, 120); });
  const running = () => roots.flatMap((r) => r.getAnimations()).filter((a) => (a.playState === 'running' || a.playState === 'pending') && a.effect && a.effect.target && owns(a.effect.target));
  const endless = (a) => { try { return !Number.isFinite(a.effect.getComputedTiming().endTime); } catch (e) { return false; } };
  // an endless animation of something the verifiers read: whichever phase a sample catches is a fact about the moment, not about the element (a hold-style one passes three equal reads)
  const SAMPLED = /color|background|border|outline|opacity|shadow|decoration|fill|stroke|filter/i;
  const sampled = (a) => { try { return a.effect.getKeyframes().some((k) => Object.keys(k).some((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p) && (SAMPLED.test(p) || (!!property && p.toLowerCase() === property.replace(/-/g, '').toLowerCase())))); } catch (e) { return true; } };
  const sig = () => chain.map((n) => { const cs = getComputedStyle(n); return [cs.color, cs.backgroundColor, cs.backgroundImage, cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor, cs.outlineColor, cs.boxShadow, cs.opacity, cs.textDecorationColor, property ? cs.getPropertyValue(property) : ''].join('|'); }).join('||');
  const t0 = performance.now();
  await frames();
  const gaps = [60, 97, 71];
  let last = null; let agree = 0; let finiteLeft = 0; let reads = 0;
  while (performance.now() - t0 < cap) {
    const live = running();
    if (live.some((a) => endless(a) && sampled(a))) return { settled: false, why: 'an endless animation on the element, an ancestor (or its pseudo-element) or a layer over it changes a colour, background, border, shadow or opacity, so no single read of it is stable' };
    const finite = live.filter((a) => !endless(a));
    finiteLeft = finite.length;
    if (finite.length > 0) { last = null; agree = 0; await Promise.race([Promise.allSettled(finite.map((a) => a.finished)), sleep(60)]); continue; }
    const now = sig();
    reads++;
    if (last !== null && now === last) agree++; else agree = 0;
    last = now;
    if (agree >= (live.length > 0 ? 2 : 1)) return { settled: true, why: null };
    await sleep(gaps[reads % gaps.length]);
  }
  return { settled: false, why: finiteLeft > 0 ? finiteLeft + ' transition(s)/animation(s) on the element, an ancestor or a layer over it were still running when the settle limit was reached' : 'the element\'s colours were still changing when the settle limit was reached (an endless animation?)' };
})`;

/** Waits for the state the element is in to settle (see `SETTLE_SRC`); `property` is the one that will be read. */
export async function settleState(page: Page, handle: ElementHandle<Element>, property: string | null, capMs = SETTLE_CAP_MS): Promise<Settled> {
  try {
    return (await page.evaluate(asPageFunction(SETTLE_SRC), [handle, property, capMs])) as Settled;
  } catch (err) {
    return { settled: false, why: `the state could not be observed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
}

/** `settleState` for the element a selector addresses; nothing to wait for when no element matches. */
export async function settleSelector(page: Page, selector: string): Promise<Settled> {
  const handle = await page.$(selector).catch(() => null);
  if (!handle) return { settled: true, why: null };
  try {
    return await settleState(page, handle, null);
  } finally {
    await handle.dispose();
  }
}

/**
 * Scroll-triggered reveals (an IntersectionObserver adding a class, a scroll-linked fade) change what is behind an element, and they stay changed once run: the
 * same page is read differently before and after it was scrolled. The page is swept top to bottom once so they have run, then put back at scroll 0 - fresh or
 * scrolled before, the reader then starts from the same state. A reveal that un-reveals when it leaves the viewport is back to hidden at scroll 0 either way
 * (read as unmeasurable: partial opacity). Reveals driven by a timer or by the page's own script are not scroll-triggered and stay the page's business.
 */
const SWEEP_SRC = String.raw`(async () => {
  const frames = () => new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => requestAnimationFrame(fin)); setTimeout(fin, 120); });
  const to = (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  const doc = document.scrollingElement || document.documentElement;
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  const max = Math.min(doc.scrollHeight - window.innerHeight, step * 60);
  to(0); await frames();
  for (let y = step; y < max; y += step) { to(y); await frames(); }
  if (max > 0) { to(max); await frames(); }
  to(0); await frames();
})`;

export async function sweepScrollReveals(page: Page): Promise<void> {
  await page.evaluate(asPageFunction(SWEEP_SRC), null);
}

/** Puts the element in `state` the way a visitor does (hover, or keyboard focus after a key press) and waits for it to settle. Never clicks or submits. */
async function enterState(page: Page, loc: StateLocator, state: StateName, property: string | null): Promise<Settled> {
  if (state === 'hover') {
    await loc.scrollIntoViewIfNeeded({ timeout: 1500 });
    await loc.hover({ timeout: 2000 });
  } else if (state === 'focus' || state === 'focus-visible') {
    await page.keyboard.press('Shift');
    await loc.focus();
  }
  const handle = await loc.elementHandle();
  if (!handle) return { settled: false, why: 'the element is gone' };
  try {
    return await settleState(page, handle, property);
  } finally {
    await handle.dispose();
  }
}

/** Leaves the state and lets the way back settle: the next measurement of this element (its DEFAULT colour included) must not start mid-transition. */
async function leaveState(page: Page, loc: StateLocator, state: StateName): Promise<void> {
  if (state === 'default') return;
  if (state === 'hover') await page.mouse.move(0, 0).catch(() => undefined);
  else if (state === 'focus' || state === 'focus-visible') await loc.evaluate((el) => (el as HTMLElement).blur()).catch(() => undefined);
  const handle = await loc.elementHandle().catch(() => null);
  if (!handle) return;
  try {
    await settleState(page, handle, null);
  } finally {
    await handle.dispose();
  }
}

/** The computed value of `property` on `selector`, optionally while the element is hovered or keyboard-focused and SETTLED; null when it cannot be measured or does not settle. Never clicks or submits. */
export async function measureComputed(page: Page, selector: string, property: string, state: StateName = 'default'): Promise<string | null> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return null;
  try {
    const settled = await enterState(page, loc, state, property);
    if (!settled.settled) return null;
    return await loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
  } catch {
    return null;
  } finally {
    await leaveState(page, loc, state);
  }
}

const READ_STATE_SRC = String.raw`([el, property, includeSelf]) => ({ value: getComputedStyle(el).getPropertyValue(property), backdrop: includeSelf === null ? null : (${BACKDROP_SRC})([el, includeSelf]) })`;

/**
 * The computed value of `property` AND the backdrop it is drawn over, read in ONE evaluation of the same settled state (null backdrop: not asked for): a hover can
 * change the element's own background (a card that is white at rest and black when hovered), so a backdrop read at rest says nothing about the hovered colour.
 */
export async function readInState(page: Page, handle: ElementHandle<Element>, property: string, withBackdrop: boolean): Promise<{ value: string; backdrop: MeasuredBackdrop | null }> {
  return (await page.evaluate(asPageFunction(READ_STATE_SRC), [handle, property, withBackdrop ? paintsOverOwnBackground(property) : null])) as { value: string; backdrop: MeasuredBackdrop | null };
}

/**
 * The computed value of `property` AND the backdrop it is drawn over, both read while the element is in `state` and after it has SETTLED. A state that does not
 * settle (`settled: false`) carries no backdrop and must be reported unverified by the caller - never judged on whatever frame the sample happened to catch.
 */
export async function measureInState(page: Page, selector: string, property: string, state: StateName): Promise<{ value: string; backdrop: MeasuredBackdrop; settled: boolean; why: string | null } | null> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return null;
  try {
    const settled = await enterState(page, loc, state, property);
    const handle = await loc.elementHandle();
    if (!handle) return null;
    const read = await readInState(page, handle, property, true);
    await handle.dispose();
    return { value: read.value, backdrop: settled.settled ? read.backdrop! : { rgb: null, why: settled.why }, settled: settled.settled, why: settled.why };
  } catch {
    return null;
  } finally {
    await leaveState(page, loc, state);
  }
}

/** Resolves a CSS value (e.g. `0.5rem`, `var(--x)` is NOT supported here) to the browser's computed form for `property` on `selector`. */
export async function resolveForProperty(page: Page, selector: string, property: string, value: string): Promise<string> {
  return page.evaluate(
    ([sel, prop, val]) => {
      const el = document.querySelector(sel as string);
      if (!el) return val as string;
      const probe = document.createElement('span');
      probe.style.setProperty(prop as string, val as string);
      (el.parentElement ?? el).appendChild(probe);
      const resolved = probe.style.getPropertyValue(prop as string) ? getComputedStyle(probe).getPropertyValue(prop as string) : (val as string);
      probe.remove();
      return resolved;
    },
    [selector, property, value] as const,
  );
}

// ── colour visibility ───────────────────────────────────────────────────────────────────────────

export interface MeasuredBackdrop {
  /** `rgb(r, g, b)`, opaque; null when it cannot be measured. */
  rgb: string | null;
  why: string | null;
}

/**
 * Does the property paint over the element's OWN background (a border, text) or over what is behind the element? A background replaces its own; an outline and
 * an outer box-shadow are painted outside the border box, so they land on the parent's backdrop.
 */
export const paintsOverOwnBackground = (property: string): boolean => !/^(?:background|outline|box-shadow)/.test(property);

/** The backdrop of `property` on the element behind `selector` (see `BACKDROP_SRC`). */
export async function measureBackdrop(page: Page, selector: string, property: string): Promise<MeasuredBackdrop> {
  const h = await page.$(selector);
  if (!h) return { rgb: null, why: 'the element was not found' };
  return (await page.evaluate(asPageFunction(BACKDROP_SRC), [h, paintsOverOwnBackground(property)])) as MeasuredBackdrop;
}

/** The same for an element handle (the preview's sections live in shadow roots, which a selector cannot reach). */
export async function measureBackdropOf(page: Page, handle: ElementHandle<Element>, property: string): Promise<MeasuredBackdrop> {
  return (await page.evaluate(asPageFunction(BACKDROP_SRC), [handle, paintsOverOwnBackground(property)])) as MeasuredBackdrop;
}

export interface RenderedColourJudgement {
  /** `not-required`: the target carries no colour-visible / state-distinct check. */
  status: 'passed' | 'failed' | 'unverified' | 'not-required';
  note: string;
}

/**
 * The `colour-visible` and `state-distinct` acceptance checks of a target, judged on what the page rendered: the colour in the target's own state, the colour
 * of the default state, and the backdrop. The outcome is written into the target's reference provenance (`colours[].verification.rendered`) so R5 and R8
 * report the same thing, and a failed or unverified check keeps the target from being called verified even when its VALUE matches.
 */
export function judgeRenderedColour(t: ResolvedTarget, m: { by: 'R5' | 'R8'; colour: string; defaultColour: string | null; backdrop: MeasuredBackdrop }): RenderedColourJudgement {
  const visible = t.acceptance.find((a) => a.kind === 'colour-visible' && a.property === t.property && a.state === t.state);
  const distinct = t.acceptance.find((a) => a.kind === 'state-distinct' && a.property === t.property && a.state === t.state);
  if (!visible && !distinct) return { status: 'not-required', note: '' };
  const notes: string[] = [];
  let failed = false;
  let unverified = false;
  let strength: number | null = null;
  if (visible) {
    const v = evaluateColourVisible(visible.expected ?? '', m.colour, m.backdrop.rgb);
    strength = v.strength;
    notes.push(v.status === 'unverified' && m.backdrop.why ? `unverified: the backdrop could not be measured (${m.backdrop.why})` : v.detail);
    if (v.status === 'failed') failed = true;
    else if (v.status === 'unverified') unverified = true;
  }
  if (distinct) {
    const now = parseCssColour(m.colour);
    const before = m.defaultColour === null ? null : parseCssColour(m.defaultColour);
    const backdrop = m.backdrop.rgb === null ? null : parseBackdrop(m.backdrop.rgb);
    if (!now || !before) {
      unverified = true;
      notes.push('the default-state colour could not be measured, so the state change could not be checked');
    } else {
      const delta = backdrop ? deltaE2000(compositeOver(now, backdrop), compositeOver(before, backdrop)) : (colorDeltaEWithAlpha(m.colour, m.defaultColour ?? '') ?? 0);
      const required = Number(distinct.expected ?? '2');
      if (delta + 1e-9 >= required) notes.push(`the ${t.state} colour differs from the default by ΔE ${Math.round(delta * 100) / 100} (>= ${required})`);
      else {
        failed = true;
        notes.push(`the ${t.state} colour is not distinguishable from the default state: ΔE ${Math.round(delta * 100) / 100} < ${required}`);
      }
    }
  }
  const status = failed ? 'failed' : unverified ? 'unverified' : 'passed';
  const note = notes.join('; ');
  // only the mappings of the property and state that were measured; a rounded strength: this file is hashed into the G2 fingerprint
  const stored = strength === null ? null : Math.round(strength * 100) / 100;
  for (const c of t.provenance.reference?.colours ?? []) {
    if (c.state === t.state && suppliesProperty(c.property, t.property)) c.verification.rendered = { status, measuredBy: m.by, backdrop: m.backdrop.rgb, strength: stored, detail: note };
  }
  return { status, note };
}

