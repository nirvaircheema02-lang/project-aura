import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ElementHandle, JSHandle, Page } from 'playwright';
import { PROBE_LIB } from '../preview/probe-lib.ts';
import { fingerprintOf, sha256Hex } from '../session/fingerprint.ts';
import { FIDELITY_LIB } from './lib.ts';
import { FIDELITY_SCHEMA_VERSION, type CapturedElement, type DesignBaseline, type DesignCapture, type FidelityViewport, type PseudoRef, type SectionDesign, type StateAttempt, type StickyTrace } from './types.ts';

export const DEFAULT_VIEWPORTS: FidelityViewport[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

export interface CaptureLimits {
  maxElements: number;
  maxHoverTargets: number;
  maxFocusTargets: number;
  maxDescendants: number;
}
export const DEFAULT_LIMITS: CaptureLimits = { maxElements: 160, maxHoverTargets: 20, maxFocusTargets: 16, maxDescendants: 24 };

/** Disclosed in every report: what this verifier does not look at. */
export const STATES_NOT_CAPTURED = [
  ':active (pressed) styling',
  'expanded / selected states that only a page script can reach — script-driven behaviour is probed on the live production page by B1 (effects, not styles)',
  'validation/error states that need a real submission (forms are never submitted)',
  'hover and focus on the mobile viewport (touch devices have no hover; desktop captures them)',
  'sibling / non-descendant hover effects (:hover + .x, :hover ~ .x): only the hovered element and its own descendants (with their ::before / ::after) are measured',
  'pseudo-elements other than ::before / ::after (::marker, ::placeholder, ::selection, ::first-line, ...) and the pseudo-elements of elements outside the captured set',
];

export interface CaptureTarget {
  sectionId: string;
  /** Resolves the section's root element on the current page, or null. */
  getRoot: (page: Page) => Promise<ElementHandle<Element> | null>;
}

/** Roots of `[data-fra-section]` wrappers in the pre-edit stamped snapshot. */
export const snapshotTargets = (sectionIds: string[]): CaptureTarget[] =>
  sectionIds.map((id) => ({ sectionId: id, getRoot: async (p) => (await p.$(`[data-fra-section="${id}"]`)) as ElementHandle<Element> | null }));

/** Roots of the generated preview's sections (each lives in a shadow root under a `[data-pv-section]` host). */
export const previewTargets = (sectionIds: string[]): CaptureTarget[] =>
  sectionIds.map((id) => ({
    sectionId: id,
    getRoot: async (p) => {
      const h = (await p.evaluateHandle((sid) => {
        const host = document.querySelector(`[data-pv-section="${sid}"]`);
        if (!host) return null;
        const mount = host.shadowRoot ? host.shadowRoot.querySelector('[data-pv-mount]') : null;
        return host.shadowRoot ? (mount ? mount.firstElementChild : null) : host;
      }, id)) as JSHandle<Element | null>;
      return h.asElement() as ElementHandle<Element> | null;
    },
  }));

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Parks the pointer OUTSIDE the viewport. A pointer left at (0, 0) hovers whatever sits in the corner: a fixed header on the original, a card link at the top of the section on a preview that has no
 * header, a later section's first element once the page is scrolled. Neither side may read a hover the other cannot have, so every default-state and keyboard-focus read starts from here.
 */
const parkPointer = (page: Page) => page.mouse.move(-1, -1);

type Subtree = Record<string, Record<string, string>>;
/** What the lib's `subtree` returns: the styles, how many qualifying descendants lay beyond the cap, and the box each pseudo-element's size resolves against. */
interface SubtreeRead { s: Subtree; dropped: number; r: Record<string, PseudoRef> }
const SETTLE_CAP_MS = 2400;
const RETRY_HOVER_MS = 5000;
const COVERED = 'covered by another element';

/**
 * A state is captured only once it has stopped changing. Running transitions and animations (on the target, its subtree AND its
 * ancestors — an inherited value animates with the ancestor's transition) are waited out; the subtree is then sampled until the samples
 * agree: once when nothing is running, three times at irregular gaps while an endless animation runs (a fixed gap could alias with its
 * period). An element that never stops changing within the cap is reported as not compared, never captured at an arbitrary frame.
 */
async function settledSubtree(page: Page, take: () => Promise<SubtreeRead | null>, animation: () => Promise<{ running: number; infinite: boolean; remaining: number }>): Promise<SubtreeRead | 'unsettled' | null> {
  const started = Date.now();
  while (Date.now() - started < SETTLE_CAP_MS) {
    let a = await animation();
    while (a.remaining > 0 && Date.now() - started < SETTLE_CAP_MS) { await page.waitForTimeout(clamp(a.remaining + 30, 40, 500)); a = await animation(); }
    const gaps = a.infinite ? [60, 130, 90] : [100];
    let prev = await take();
    if (!prev) return null;
    let agreed = true;
    for (const gap of gaps) {
      await page.waitForTimeout(gap);
      const cur = await take();
      if (!cur) return null;
      if (JSON.stringify(cur) !== JSON.stringify(prev)) { agreed = false; prev = cur; break; }
      prev = cur;
    }
    if (agreed) return prev;
  }
  return 'unsettled';
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.waitForTimeout(300);
}

async function handleByKey(page: Page, root: ElementHandle<Element>, key: string): Promise<ElementHandle<Element> | null> {
  const h = (await page.evaluateHandle(([r, k]) => (window as any).__pvFidelity.elementByKey(r, k), [root, key] as const)) as JSHandle<Element | null>;
  return h.asElement() as ElementHandle<Element> | null;
}

/** Did the state change any recorded style of the target or a captured descendant? */
function subtreeDiffers(rest: Record<string, Record<string, string>> | null, state: Record<string, Record<string, string>>): boolean {
  if (!rest) return true; // no resting reference: assume the state matters rather than hide a possible loss
  for (const [rel, st] of Object.entries(state)) {
    const r = rest[rel];
    if (!r) return true; // a member (or a pseudo-element) that only exists in the state is itself an effect of it
    for (const p of Object.keys(st)) if (st[p] !== r[p]) return true;
  }
  return false;
}

/**
 * Pin/release is traced at five positions RELATIVE TO THE SECTION (before it, pinning, mid, releasing, after). Whether such a position can be
 * scrolled to depends on how much page surrounds the section — and a Selected-Sections preview is far shorter than the original page — so the
 * document is padded by one viewport height above and below for the duration of the trace, identically on both sides, and restored afterwards.
 * A position that is STILL unreachable (the window does not scroll) is reported unreachable, never compared at a clamped offset.
 */
async function stickyTraces(page: Page, root: ElementHandle<Element>, candidates: Array<{ key: string; top: string }>): Promise<StickyTrace[]> {
  const out: StickyTrace[] = [];
  if (candidates.length === 0) return out;
  await page.evaluate(() => {
    const d = document.documentElement;
    (window as any).__fraPad = { top: d.style.paddingTop, bottom: d.style.paddingBottom };
    d.style.paddingTop = `${innerHeight}px`;
    d.style.paddingBottom = `${innerHeight}px`;
  });
  try {
    const info = await root.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top + scrollY, h: r.height, vh: innerHeight }; });
    const positions = Array.from({ length: 5 }, (_v, i) => Math.round(info.top - info.vh * 0.9 + ((info.h + info.vh * 0.8) * i) / 4));
    for (const c of candidates) {
      const trace: StickyTrace = { key: c.key, top: c.top, padded: true, positions: [] };
      for (const y of positions) {
        await page.evaluate((v) => window.scrollTo(0, Math.max(0, v)), y);
        await page.waitForTimeout(140);
        const actual = await page.evaluate(() => Math.round(scrollY));
        const rectTop = await page.evaluate(([r, k]) => (window as any).__pvFidelity.rectTop(r, k), [root, c.key] as const);
        trace.positions.push({ requestedScroll: y, actualScroll: actual, reachable: y >= 0 && Math.abs(actual - y) <= 2, rectTop });
      }
      out.push(trace);
    }
  } finally {
    await page.evaluate(() => {
      const d = document.documentElement;
      const saved = (window as any).__fraPad as { top: string; bottom: string } | undefined;
      d.style.paddingTop = saved?.top ?? '';
      d.style.paddingBottom = saved?.bottom ?? '';
      window.scrollTo(0, 0);
    });
  }
  return out;
}

/**
 * Sampling order under the cap: interactive finding elements, then interactive controls, then plain finding elements, then card-group items — each in document order. A page
 * with many finding-bearing paragraphs therefore cannot starve its real controls (links, buttons), where hover and focus reveals live.
 */
function prioritised(xs: CapturedElement[]): CapturedElement[] {
  const tier = (x: CapturedElement) => { const interactive = x.roles.includes('interactive'), finding = x.findingIds.length > 0; return interactive && finding ? 0 : interactive ? 1 : finding ? 2 : 3; };
  return xs.map((x, i) => ({ x, i })).sort((a, b) => tier(a.x) - tier(b.x) || a.i - b.i).map((o) => o.x);
}
const markAttempt = (t: CapturedElement, state: 'hover' | 'focus-visible', v: StateAttempt): void => { t.stateAttempt = { ...(t.stateAttempt ?? {}), [state]: v }; };

/**
 * What the ORIGINAL sampled, by `${sectionId}|${viewport}`: the preview mirrors it, so both sides measure the same elements instead of each
 * picking its own first N (keys are logical paths, identical on both sides).
 */
export interface CaptureHints {
  hover?: Record<string, string[]>;
  focus?: Record<string, string[]>;
  /** Parent keys of the composition groups the original detected. */
  groups?: Record<string, string[]>;
  /** The hover-subtree members the original recorded, by `${sectionId}|${viewport}` then element key (relative keys): the preview measures those even if its own state no longer makes them qualify. */
  hoverSubtree?: Record<string, Record<string, string[]>>;
}

/** The hints a baseline gives the preview that is compared with it. */
export function hintsFromBaseline(b: DesignCapture): CaptureHints {
  const hover: Record<string, string[]> = {}, focus: Record<string, string[]> = {}, groups: Record<string, string[]> = {}, hoverSubtree: Record<string, Record<string, string[]>> = {};
  for (const s of b.sections) {
    if (!s.located) continue;
    const k = `${s.sectionId}|${s.viewport}`;
    groups[k] = s.groups.map((g) => g.parentKey);
    if (s.viewport !== 'desktop') continue;
    hover[k] = s.elements.filter((e) => e.states.hover).map((e) => e.key);
    focus[k] = s.elements.filter((e) => e.states['focus-visible']).map((e) => e.key);
    hoverSubtree[k] = Object.fromEntries(s.elements.filter((e) => e.states.hover).map((e) => [e.key, Object.keys(e.states.hover!.subtree).filter((r) => r !== '')]));
  }
  return { hover, focus, groups, hoverSubtree };
}

export interface CaptureArgs {
  page: Page;
  targets: CaptureTarget[];
  viewports?: FidelityViewport[];
  source: DesignCapture['source'];
  limits?: Partial<CaptureLimits>;
  /** Called between sections/viewports so a caller can stop a long capture (the overall budget). */
  shouldStop?: () => boolean;
  /** Mirror what the original sampled (see `hintsFromBaseline`). Without it the capture picks its own targets. */
  hints?: CaptureHints;
  log?: (line: string) => void;
}

/**
 * One measuring routine for BOTH sides. For each viewport and section: scroll the section to the same
 * position, enumerate the elements that carry the design (finding elements, interactive controls, card
 * groups, text, boxes), record default styles, geometry and composition; on the desktop viewport hover and
 * keyboard-focus each interactive target (settling for the longest transition in its subtree) and record
 * the resulting styles; trace every sticky element across the section's scroll range.
 */
export async function captureDesign(args: CaptureArgs): Promise<DesignCapture> {
  const { page } = args;
  const log = args.log ?? (() => {});
  const viewports = args.viewports ?? DEFAULT_VIEWPORTS;
  const limits: CaptureLimits = { ...DEFAULT_LIMITS, ...(args.limits ?? {}) };
  const sections: SectionDesign[] = [];

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settle(page);
    await page.evaluate(PROBE_LIB);
    await page.evaluate(FIDELITY_LIB);
    for (const target of args.targets) {
      const hintKey = `${target.sectionId}|${vp.name}`;
      if (args.shouldStop?.()) {
        sections.push({ sectionId: target.sectionId, viewport: vp.name, located: false, elements: [], groups: [], sticky: [], capped: null, coverage: { hover: { attempted: 0, captured: 0 }, focusVisible: { attempted: 0, captured: 0 } }, notes: ['capture stopped: the overall verification budget was exhausted'], stopped: 'budget' });
        continue;
      }
      const root = await target.getRoot(page);
      const sec: SectionDesign = { sectionId: target.sectionId, viewport: vp.name, located: !!root, elements: [], groups: [], sticky: [], capped: null, coverage: { hover: { attempted: 0, captured: 0 }, focusVisible: { attempted: 0, captured: 0 } }, notes: [] };
      sections.push(sec);
      if (!root) { sec.notes.push('section root not found on this page'); continue; }
      await root.evaluate((el) => window.scrollTo(0, Math.max(0, Math.round(el.getBoundingClientRect().top + scrollY))));
      await parkPointer(page);
      await page.waitForTimeout(150);
      // Running animations are frozen at a fixed frame (on both sides) for the default state AND for the hover / focus captures that follow: an endless one (a pulsing ring on a ::after) would
      // otherwise make every state of its element "unsettled" for good. What a hover STARTS is a new animation, which is not frozen and is waited out (or reported as unsettled). Thawed below.
      const thaw = () => page.evaluate(() => (window as any).__pvFidelity.thawAnimations());
      const animated = (await page.evaluate((r) => (window as any).__pvFidelity.freezeAnimations(r), root)) as number;
      let e: { elements: CapturedElement[]; groups: SectionDesign['groups']; stickyCandidates: Array<{ key: string; top: string }>; dropped: number; nodeCount: number; walkCut: number; walkHidden: NonNullable<SectionDesign['walkHidden']> | null; groupsDropped: number; stickyDropped: number; stickyInert: number };
      try {
        e = (await page.evaluate(([r, o]) => (window as any).__pvFidelity.enumerate(r, o), [root, { maxElements: limits.maxElements, forceGroups: args.hints?.groups?.[hintKey] ?? [] }] as const));
      } catch (err) { await thaw().catch(() => undefined); throw err; }
      if (animated > 0) { sec.animationsFrozen = animated; sec.notes.push(`${animated} animated element(s) were frozen at a fixed frame for the default-state capture (running animations make a style read time-dependent)`); }
      sec.pseudoCaptured = true;
      sec.capLossRecorded = true;
      if (e.walkCut > 0) {
        sec.walkCut = e.walkCut;
        if (e.walkHidden) sec.walkHidden = e.walkHidden;
        const hid = e.walkHidden ? e.walkHidden.controls + e.walkHidden.groups + e.walkHidden.sticky : 0;
        sec.notes.push(`${e.walkCut} node(s) beyond the walk limit (depth 16 / 4000 nodes) were not entered, so what lies below them was not captured (elements a finding names are always captured)${hid ? `; the cut hid ${e.walkHidden!.controls} control(s), ${e.walkHidden!.groups} possible group(s) and ${e.walkHidden!.sticky} sticky element(s)` : ''}`);
      }
      sec.elements = e.elements;
      sec.groups = e.groups;
      if (e.groupsDropped > 0) sec.groupsDropped = e.groupsDropped;
      if (e.stickyDropped > 0) sec.stickyDropped = e.stickyDropped;
      if (e.stickyInert > 0) sec.stickyInert = e.stickyInert;
      if (e.dropped > 0) { sec.capped = { dropped: e.dropped }; sec.notes.push(`${e.dropped} lower-priority element(s) beyond the ${limits.maxElements}-element cap were not captured`); }
      log(`fidelity · ${vp.name} · ${target.sectionId}: ${e.elements.length} element(s), ${e.groups.length} group(s)`);

      if (vp.name === 'desktop') {
        sec.focusTrial = true;
        // keyboard focus is decided by a real focus trial (a href-less <a> does not take focus, a contenteditable does), never by a tag list or a tabindex test
        const trialKeys = sec.elements.filter((x) => x.roles.includes('interactive') || x.roles.includes('finding')).map((x) => x.key);
        if (trialKeys.length) {
          const took = new Set((await page.evaluate(([r, ks]) => (window as any).__pvFidelity.focusTrial(r, ks), [root, trialKeys] as const)) as string[]);
          for (const x of sec.elements) if (took.has(x.key)) x.focusable = true;
          // the trial's focus / blur may start transitions: let them finish before any resting style is read
          const trialMs = (await page.evaluate(([r, ks]) => (window as any).__pvFidelity.transitionMs(r, ks), [root, trialKeys] as const)) as number;
          if (trialMs > 0) await page.waitForTimeout(clamp(trialMs + 80, 120, 1500));
        }
        // every element a finding names can be hovered (a plain card has a hover design too); keyboard focus follows real focusability
        const hoverEligible = sec.elements.filter((x) => x.roles.includes('interactive') || x.roles.includes('group-item') || x.roles.includes('finding'));
        const focusEligible = sec.elements.filter((x) => x.focusable && !x.flags.disabled && (x.roles.includes('interactive') || x.roles.includes('finding')));
        sec.eligible = { hover: hoverEligible.length, focusVisible: focusEligible.length };
        // with hints the preview samples exactly what the original captured; without them the sampling order is prioritised() (the cap only drops the lowest tiers)
        const hoverHint = args.hints?.hover?.[hintKey], focusHint = args.hints?.focus?.[hintKey];
        // (a hinted key is tried whatever role this side's heuristics give the element: the original already captured it there)
        const hoverTargets = hoverHint ? sec.elements.filter((x) => hoverHint.includes(x.key)) : prioritised(hoverEligible).slice(0, limits.maxHoverTargets);
        const focusTargets = focusHint ? sec.elements.filter((x) => focusHint.includes(x.key)) : prioritised(focusEligible).slice(0, limits.maxFocusTargets);
        if (!hoverHint) for (const x of hoverEligible) if (!hoverTargets.includes(x)) markAttempt(x, 'hover', 'sample-cap');
        if (!focusHint) for (const x of focusEligible) if (!focusTargets.includes(x)) markAttempt(x, 'focus-visible', 'sample-cap');
        const blockerOf = async (k: string) => (await page.evaluate(([r, key]) => (window as any).__pvFidelity.hoverBlocker(r, key), [root, k] as const)) as string | null;
        const sectionY = await page.evaluate(() => Math.round(scrollY));
        for (let i = 0; i < hoverTargets.length; i++) {
          const t = hoverTargets[i]!;
          if (args.shouldStop?.()) { sec.notes.push('hover/focus capture stopped early: the overall verification budget was exhausted'); for (const r of hoverTargets.slice(i)) markAttempt(r, 'hover', 'budget-stopped'); break; }
          sec.coverage.hover.attempted++;
          const h = await handleByKey(page, root, t.key);
          if (!h) { markAttempt(t, 'hover', 'not-hoverable'); continue; }
          let outcome: StateAttempt = 'not-hoverable'; // an element that cannot be hovered simply has no hover observation; the attempt says so
          let recentred = false;
          try {
            // GENUINELY not hoverable (pointer-events none, not rendered, covered) is recorded from the element itself, without waiting out a click timeout; a hover that merely failed
            // is retried once with a longer timeout and, if it still fails, recorded as interrupted — a transient, not a property of the page
            let blocked = await blockerOf(t.key);
            if (!blocked || blocked === COVERED) { // (covered before scrolling proves nothing: the element may simply be clipped by a scroller that scrollIntoView moves)
              await h.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
              blocked = await blockerOf(t.key);
              if (blocked === COVERED) {
                // Covered is only genuine if it is still covered at the viewport CENTRE: the section's top sits at the viewport top, under a sticky / fixed header, and scrollIntoViewIfNeeded does
                // nothing for an element that is already (partly) in view. The scroll is undone below.
                await h.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })).catch(() => undefined);
                recentred = true;
                await page.waitForTimeout(150);
                blocked = await blockerOf(t.key);
              }
              if (blocked === COVERED) { await page.waitForTimeout(500); blocked = await blockerOf(t.key); } // an overlay may be on its way out
            }
            if (!blocked) {
              const forced = args.hints?.hoverSubtree?.[hintKey]?.[t.key] ?? [];
              const ms = (await page.evaluate(([r, k, m]) => (window as any).__pvFidelity.maxTransitionMs(r, k, m), [root, t.key, limits.maxDescendants] as const)) as number;
              const rest = (await page.evaluate(([r, k, m, f]) => (window as any).__pvFidelity.subtree(r, k, m, f), [root, t.key, limits.maxDescendants, forced] as const)) as SubtreeRead | null;
              // an element with pointer-events: none is hovered through a descendant that switches them back on (that matches :hover on the element too)
              const hoverOnce = async (timeout: number): Promise<boolean> => {
                const via = (await page.evaluate(([r, k]) => (window as any).__pvFidelity.hoverThrough(r, k), [root, t.key] as const)) as { x: number; y: number } | null;
                if (via) { await page.mouse.move(via.x, via.y); return true; }
                return h.hover({ timeout }).then(() => true, () => false);
              };
              let hovered = await hoverOnce(2000);
              if (!hovered) {
                blocked = await blockerOf(t.key);
                if (!blocked) {
                  await h.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
                  hovered = await hoverOnce(RETRY_HOVER_MS);
                  if (!hovered) outcome = 'interrupted';
                }
              }
              if (hovered) {
                await page.waitForTimeout(clamp(ms + 80, 120, 1500));
                const sub = await settledSubtree(page, () => page.evaluate(([r, k, m, f]) => (window as any).__pvFidelity.subtree(r, k, m, f), [root, t.key, limits.maxDescendants, forced] as const) as Promise<SubtreeRead | null>, () => page.evaluate(([r, k]) => (window as any).__pvFidelity.animationState(r, k), [root, t.key] as const));
                if (sub === 'unsettled') { outcome = 'unsettled'; sec.notes.push(`hover on "${t.label || t.tag}" kept changing for ${SETTLE_CAP_MS} ms (a running animation), so it is not compared`); }
                else if (sub) { t.states.hover = { subtree: sub.s, effect: subtreeDiffers(rest?.s ?? null, sub.s), ...(sub.dropped > 0 ? { truncated: sub.dropped } : {}), ...(Object.keys(sub.r).length ? { pseudoRef: sub.r } : {}) }; sec.coverage.hover.captured++; outcome = 'captured'; }
              }
            }
          } catch { /* stays not-hoverable */ }
          markAttempt(t, 'hover', outcome);
          await parkPointer(page);
          if (recentred) await page.evaluate((y) => window.scrollTo(0, y), sectionY); // every target starts from the section's own scroll position, on both sides
          await page.waitForTimeout(80);
        }
        for (let i = 0; i < focusTargets.length; i++) {
          const t = focusTargets[i]!;
          if (args.shouldStop?.()) { for (const r of focusTargets.slice(i)) markAttempt(r, 'focus-visible', 'budget-stopped'); break; }
          sec.coverage.focusVisible.attempted++;
          const h = await handleByKey(page, root, t.key);
          if (!h) { markAttempt(t, 'focus-visible', 'not-hoverable'); continue; }
          let outcome: StateAttempt = 'not-hoverable'; // not focusable here: no focus observation
          try {
            // a keyboard event first, so the browser treats the focus as keyboard focus (:focus-visible); the pointer is out of the way, so the focus style is not read under a hover
            await parkPointer(page);
            await page.keyboard.press('Shift');
            await h.scrollIntoViewIfNeeded({ timeout: 1500 });
            const rest = (await page.evaluate(([r, k]) => (window as any).__pvFidelity.subtree(r, k, 0, []), [root, t.key] as const)) as SubtreeRead | null;
            await h.focus();
            const ms = (await page.evaluate(([r, k]) => (window as any).__pvFidelity.maxTransitionMs(r, k, 0), [root, t.key] as const)) as number;
            await page.waitForTimeout(clamp(ms + 80, 120, 1500));
            const sub = await settledSubtree(page, () => page.evaluate(([r, k]) => (window as any).__pvFidelity.subtree(r, k, 0, []), [root, t.key] as const) as Promise<SubtreeRead | null>, () => page.evaluate(([r, k]) => (window as any).__pvFidelity.animationState(r, k), [root, t.key] as const));
            if (sub === 'unsettled') { outcome = 'unsettled'; sec.notes.push(`keyboard focus on "${t.label || t.tag}" kept changing for ${SETTLE_CAP_MS} ms (a running animation), so it is not compared`); }
            else {
              const fi = (await page.evaluate(([r, k]) => (window as any).__pvFidelity.focusInfo(r, k), [root, t.key] as const)) as { focused: boolean; visible: boolean } | null;
              if (sub) { t.states['focus-visible'] = { subtree: sub.s, focusVisibleMatched: !!fi?.visible, effect: subtreeDiffers(rest?.s ?? null, sub.s), ...(Object.keys(sub.r).length ? { pseudoRef: sub.r } : {}) }; sec.coverage.focusVisible.captured++; outcome = 'captured'; }
            }
            await h.evaluate((el) => (el as HTMLElement).blur());
          } catch { /* stays not-hoverable */ }
          markAttempt(t, 'focus-visible', outcome);
        }
      } else {
        sec.notes.push('hover and keyboard focus are captured on the desktop viewport only');
      }
      await thaw();
      if (e.stickyCandidates.length) sec.sticky = await stickyTraces(page, root, e.stickyCandidates);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  }

  return {
    schemaVersion: FIDELITY_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    source: args.source,
    viewports,
    limits,
    statesNotCaptured: STATES_NOT_CAPTURED,
    sections,
  };
}

// ── the immutable baseline ──────────────────────────────────────────────────────────────────

/** The hash binds the baseline's CONTENT (not its capture time), so an unchanged page yields an identical baseline. */
export function baselineHashOf(c: DesignCapture): string {
  return fingerprintOf({ source: { kind: c.source.kind, htmlSha256: c.source.htmlSha256 }, viewports: c.viewports, limits: c.limits, sections: c.sections });
}

export function toBaseline(c: DesignCapture): DesignBaseline {
  return { ...c, baselineSha256: baselineHashOf(c) };
}

export async function readBaseline(path: string): Promise<DesignBaseline | null> {
  if (!existsSync(path)) return null;
  try {
    const b = JSON.parse(await readFile(path, 'utf8')) as DesignBaseline;
    if (b.schemaVersion !== FIDELITY_SCHEMA_VERSION || !Array.isArray(b.sections)) return null;
    // a baseline whose content no longer matches its own hash has been edited: it is NOT trusted
    return baselineHashOf(b) === b.baselineSha256 ? b : null;
  } catch { return null; }
}

/** Does a stored baseline cover this scope (every section, every viewport, and the same snapshot)? */
export function baselineCovers(b: DesignBaseline, sectionIds: string[], viewports: FidelityViewport[], htmlSha256: string | null): boolean {
  if (htmlSha256 && b.source.htmlSha256 !== htmlSha256) return false;
  return sectionIds.every((id) => viewports.every((vp) => b.sections.some((s) => s.sectionId === id && s.viewport === vp.name && s.located)));
}

export class BaselineImmutableError extends Error {}

/**
 * Write-once. An existing valid baseline is never replaced (a correction cycle must compare against the
 * SAME original). A file that exists but fails its own hash or schema check is NOT silently replaced either:
 * that is reported, because overwriting it would be rewriting the baseline.
 */
export async function writeBaselineOnce(path: string, capture: DesignCapture): Promise<DesignBaseline> {
  const existing = await readBaseline(path);
  if (existing) return existing;
  if (existsSync(path)) throw new BaselineImmutableError(`${path} exists but does not verify against its own hash/schema; it is not replaced automatically. Remove it deliberately to recapture the original.`);
  const baseline = toBaseline(capture);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(baseline));
  return baseline;
}

export const htmlSha256Of = (html: string): string => sha256Hex(html);
