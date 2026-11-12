import { createHash } from 'node:crypto';
import { normalizeColor } from '../../t-layer/computed-style.ts';
import type { ComponentType } from '../../skills/s3-component-taxonomy.ts';
import type { AriaElement } from '../../t-layer/element-registry.ts';
import type { DomFacts } from '../../t-layer/dom-facts.ts';

/**
 * No-API B2 (NO-API-SPEC Module B): which elements of a section are
 * component candidates, and what taxonomy type each one is — decided from the
 * accessibility role plus facts B2 reads off the live element, with zero model
 * calls. Pure functions: this module never touches the page.
 *
 * Detection still uses DOM + rendered evidence, never role alone (the B2
 * contract): real controls on the target site carry no role at all ("Sign
 * in" is a `generic [cursor=pointer]`), and a link is only a button when it
 * RENDERS as one. Where the evidence runs out the type is still emitted but
 * with LOW confidence and a signal saying it was inferred — S8 then routes it
 * to review instead of publishing a confident guess.
 */

/** Facts B2 gathers from the live element (NOT by this module) — the rendered evidence classification uses. */
export type { DomFacts } from '../../t-layer/dom-facts.ts';

export interface CandidateClassification {
  componentType: ComponentType;
  label: string;
  domSignals: string[];
  visualSignals: string;
  instanceGroupKey: string;
  confidence: number;
}

/**
 * Where a selected candidate sits in the page hierarchy — facts the selection
 * walk already has (it climbs every candidate's ancestry), carried WITH the
 * candidate so classification can use them without its caller re-walking
 * the page. Classification never sees the other elements itself.
 */
export interface CandidateContext {
  /** Has a `navigation` landmark ancestor. */
  inNavigation: boolean;
  /** Has a `contentinfo` (footer) ancestor. */
  inFooter: boolean;
  /** Ref of the nearest clickable ancestor (link/button/tab/… or `[cursor=pointer]`), or null. */
  clickableAncestor: string | null;
  /**
   * Headings only: the block this heading titles is one of several identical
   * siblings (same size, a same-size heading at the same offset) — a card or
   * list item in a grid, not a band of the page. Null when it is not.
   */
  repeatedUnit: { unit: string; twins: string[] } | null;
}

/** A candidate as `selectCandidates` returns it: the snapshot element plus its hierarchy context. */
export interface SelectedCandidate extends AriaElement {
  selection: CandidateContext;
}

/** An element recognised as the SAME control as a kept candidate — recorded, never silently lost. */
export interface MergedCandidate {
  ref: string;
  keptRef: string;
  reason: string;
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Roles selected as candidates on their own. `spinbutton` is added to the
 * spec's list: it is a native number input (the target's phone field), an
 * input by any definition, and would otherwise never be audited.
 */
const CANDIDATE_ROLES = new Set([
  'link', 'button', 'heading',
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'tab', 'spinbutton',
]);

/** Roles that are clicked, i.e. can be "the same control rendered twice" by a clickable descendant. */
const CLICKABLE_ROLES = new Set(['link', 'button', 'tab', 'checkbox', 'radio', 'switch']);

/**
 * Roles that make an element a control in its own right. When a pointer
 * wrapper and one of these occupy the same box, the control is kept and the
 * wrapper is not: it carries the role, the href and the native styling.
 */
const CONTROL_ROLES = new Set([
  ...CLICKABLE_ROLES,
  'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton',
]);

/**
 * Form-field roles → taxonomy. `switch` is ARIA's checkbox subtype; `slider`/`spinbutton` are native inputs.
 * `combobox` is absent on purpose: its type depends on the tag (see `comboboxType`).
 */
const FIELD_TYPES: Record<string, ComponentType> = {
  textbox: 'input',
  searchbox: 'search',
  checkbox: 'checkbox',
  radio: 'radio',
  switch: 'checkbox',
  slider: 'input',
  spinbutton: 'input',
};

/** Native tags and the roles they carry without any role attribute — "native semantic" evidence. */
const NATIVE_ROLES: Record<string, string[]> = {
  a: ['link'],
  button: ['button'],
  h1: ['heading'], h2: ['heading'], h3: ['heading'], h4: ['heading'], h5: ['heading'], h6: ['heading'],
  input: ['textbox', 'searchbox', 'checkbox', 'radio', 'spinbutton', 'slider', 'combobox', 'button'],
  select: ['combobox', 'listbox'],
  textarea: ['textbox'],
};

/** A clickable descendant covering this much of a selected clickable ancestor (and vice versa) is the same control. */
export const DUPLICATE_COVERAGE = 0.9;

/**
 * A box this small (px) on either side is visually hidden, not rendered for
 * a user: the `sr-only` clip pattern leaves a 1×1 box that Playwright still
 * snapshots with a ref. Its rest state is invisible, so it is not audited.
 */
export const VISUALLY_HIDDEN_MAX_SIDE = 2;

/** An empty link may sit this many px outside the clickable it overlays (sub-pixel layout rounding). */
const OVERLAY_SLACK = 1;

/** How many ancestor levels above a heading are tried as the repeated unit it titles (heading → body → card). */
const REPEAT_UNIT_MAX_DEPTH = 3;

/** Boxes within this many px of each other count as the same size / offset (Playwright rounds to whole px). */
const SAME_BOX_SLACK = 1;

/** LOW confidence (S8 band < 0.5): the type is a best reading, routed to review rather than published as fact. */
const INFERRED_CONFIDENCE = 0.45;

/** Button-rendering height range (px): shorter is inline text, taller is a panel. */
export const BUTTON_MIN_HEIGHT = 24;
export const BUTTON_MAX_HEIGHT = 80;

/** Small-square clickable (px per side) with no text → icon button. */
export const ICON_BUTTON_MAX_SIDE = 48;

/** A clickable at least this large (px²) and taller than a button is a card. */
export const CARD_MIN_AREA = 20_000;

const LABEL_MAX = 60;
const KEY_CLASSES_MAX = 6;
const POINTER = '[cursor=pointer]';

/**
 * Picks the component candidates out of ONE section's elements: every
 * link, button, heading and form control, plus any element the snapshot marks
 * `[cursor=pointer]` (role-less clickable divs are real controls here).
 *
 *  - Zero-size elements are skipped: nothing is rendered to audit.
 *  - Elements whose box is ≤ 2px on a side (`sr-only` clipping) go to
 *    `visuallyHidden`: rendered for assistive tech, invisible to a user.
 *  - Elements entirely off-canvas horizontally go to `offCanvas` —
 *    inactive carousel slides. Both lists are stated coverage boundaries for
 *    the caller to report, not silent drops.
 *  - ONE control, ONE candidate. Playwright never marks `[cursor=pointer]`
 *    on anything inside a marked element, so a control rendered twice shows
 *    up as a marked wrapper around an UNMARKED semantic element of the same
 *    box (`generic [cursor=pointer] > link`). Such a wrapper is not
 *    selected: the link/button/field inside it is, because it carries the
 *    role, the href and the native styling (see `sameBoxControl`). Any other
 *    descendant whose box coincides with a selected clickable ancestor
 *    (≥ 90% overlap both ways) is that same control again and is merged into
 *    it. Smaller controls inside a clickable (a `button` in a card) are kept.
 *  - An EMPTY link (no name, no child elements) lying inside a selected
 *    clickable is that clickable's click overlay — the "stretched link" of a
 *    card — not a second card. It is merged into the clickable.
 *
 * Every merge is returned in `merged` with the ref it was merged into and
 * why, so nothing disappears unexplained. Note what cannot be a candidate
 * here: an UNMARKED role-less element inside a clickable card (a `div` icon
 * with its own click handler) is indistinguishable from decoration in the
 * snapshot — its inherited pointer cursor is not rendered — so it is never
 * guessed into a control.
 *
 * `allElements` (optional, the whole page) is used ONLY to walk ancestry
 * across elements the section filter left out; selection never leaves the
 * section's own list.
 */
export function selectCandidates(
  elements: AriaElement[],
  opts: { viewportWidth: number; allElements?: AriaElement[] | undefined },
): { candidates: SelectedCandidate[]; offCanvas: AriaElement[]; visuallyHidden: AriaElement[]; merged: MergedCandidate[] } {
  const byRef = new Map<string, AriaElement>();
  for (const el of opts.allElements ?? []) byRef.set(el.ref, el);
  for (const el of elements) byRef.set(el.ref, el);
  const childrenOf = new Map<string, AriaElement[]>();
  for (const el of byRef.values()) {
    if (el.parentRef === null) continue;
    const list = childrenOf.get(el.parentRef);
    if (list) list.push(el);
    else childrenOf.set(el.parentRef, [el]);
  }
  const hasChildElement = new Set(childrenOf.keys());

  const candidates: SelectedCandidate[] = [];
  const offCanvas: AriaElement[] = [];
  const visuallyHidden: AriaElement[] = [];
  const merged: MergedCandidate[] = [];
  const selectedClickable = new Set<string>();

  const visibleOnCanvas = (el: AriaElement): boolean =>
    el.box !== undefined && isVisiblySized(el.box) && isOnCanvas(el.box, opts.viewportWidth);
  const wrappedControl = sameBoxControl(elements, byRef, visibleOnCanvas);

  // Document order puts every ancestor before its descendants, so "already
  // selected" is known by the time a descendant is looked at.
  for (const el of elements) {
    if (!isCandidateShape(el)) continue;
    const box = el.box;
    if (!box || box.width <= 0 || box.height <= 0) continue;
    if (!isVisiblySized(box)) {
      visuallyHidden.push(el);
      continue;
    }
    if (!isOnCanvas(box, opts.viewportWidth)) {
      offCanvas.push(el);
      continue;
    }

    const control = wrappedControl.get(el.ref);
    if (control) {
      merged.push({ ref: el.ref, keptRef: control.ref, reason: `pointer wrapper around the same-box ${control.role} ${control.ref} — the semantic element is kept` });
      continue;
    }
    const twin = coincidingSelectedAncestor(el, byRef, selectedClickable);
    if (twin) {
      merged.push({ ref: el.ref, keptRef: twin, reason: `same control as ${twin} (boxes coincide ≥ ${DUPLICATE_COVERAGE * 100}% both ways)` });
      continue;
    }
    if (isEmptyLink(el, hasChildElement)) {
      const host = enclosingSelectedClickable(el, byRef, selectedClickable);
      if (host) {
        merged.push({ ref: el.ref, keptRef: host, reason: `empty link (no name, no child elements) inside clickable ${host} — its click overlay, not a second component` });
        continue;
      }
    }

    candidates.push({ ...el, selection: contextOf(el, byRef, childrenOf) });
    if (isClickable(el)) selectedClickable.add(el.ref);
  }
  return { candidates, offCanvas, visuallyHidden, merged };
}

/**
 * What B2 would offer as a candidate at all: a control/heading role, or the
 * snapshot's `[cursor=pointer]` marker. Exported so B1's section spine can
 * tell whether a strip it leaves out holds anything B2 would have detected.
 */
export function isCandidateShape(el: AriaElement): boolean {
  return CANDIDATE_ROLES.has(el.role) || el.line.includes(POINTER);
}

/** False for zero-size and visually hidden (`sr-only`, ≤ 2px on a side) boxes — nothing a user sees. */
export function isVisiblySized(box: Box): boolean {
  return box.width > VISUALLY_HIDDEN_MAX_SIDE && box.height > VISUALLY_HIDDEN_MAX_SIDE;
}

function isOnCanvas(box: Box, viewportWidth: number): boolean {
  return box.x + box.width > 0 && box.x < viewportWidth;
}

/** Selected only because the snapshot marks it clickable — it has no control role of its own. */
function isCursorOnly(el: AriaElement): boolean {
  return !CANDIDATE_ROLES.has(el.role) && el.line.includes(POINTER);
}

function isClickable(el: AriaElement): boolean {
  return CLICKABLE_ROLES.has(el.role) || el.line.includes(POINTER);
}

function area(box: Box): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function intersectionArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Two boxes are one control's box when each covers ≥ 90% of the other. Both
 * ways, because a descendant always lies inside its ancestor: one-way
 * coverage would also merge the small button inside a card.
 */
function coincide(a: Box, b: Box): boolean {
  const overlap = intersectionArea(a, b);
  const areaA = area(a);
  const areaB = area(b);
  return areaA > 0 && areaB > 0 && overlap / areaA >= DUPLICATE_COVERAGE && overlap / areaB >= DUPLICATE_COVERAGE;
}

/** Ancestors of `el`, nearest first, across the whole page when `byRef` has it. */
function* ancestors(el: AriaElement, byRef: Map<string, AriaElement>): Generator<AriaElement> {
  const seen = new Set<string>([el.ref]);
  for (let ref = el.parentRef; ref !== null && !seen.has(ref); ref = byRef.get(ref)?.parentRef ?? null) {
    seen.add(ref);
    const ancestor = byRef.get(ref);
    if (!ancestor) return;
    yield ancestor;
  }
}

/**
 * Pointer wrapper → the same-box control inside it. Computed up front
 * because the wrapper comes FIRST in document order: deciding it only when
 * its descendant turns up would mean un-selecting it again. Only controls
 * that will themselves be selectable (visible, on canvas) qualify, so a
 * wrapper is never skipped in favour of something that is then skipped too.
 * The first such control in document order wins.
 */
function sameBoxControl(
  elements: AriaElement[],
  byRef: Map<string, AriaElement>,
  visibleOnCanvas: (el: AriaElement) => boolean,
): Map<string, AriaElement> {
  const wrapped = new Map<string, AriaElement>();
  for (const el of elements) {
    if (!CONTROL_ROLES.has(el.role) || !el.box || !visibleOnCanvas(el)) continue;
    for (const ancestor of ancestors(el, byRef)) {
      if (!ancestor.box || !isCursorOnly(ancestor) || wrapped.has(ancestor.ref)) continue;
      if (coincide(el.box, ancestor.box)) wrapped.set(ancestor.ref, el);
    }
  }
  return wrapped;
}

/** The selected clickable ancestor whose box coincides with this element's, if any. */
function coincidingSelectedAncestor(el: AriaElement, byRef: Map<string, AriaElement>, selectedClickable: Set<string>): string | null {
  const box = el.box as Box;
  for (const ancestor of ancestors(el, byRef)) {
    if (!selectedClickable.has(ancestor.ref) || !ancestor.box) continue;
    if (coincide(box, ancestor.box)) return ancestor.ref;
  }
  return null;
}

/**
 * A link with nothing in it: no accessible name and no child element in the
 * snapshot. It cannot be seen on its own — it is a transparent click target
 * (typically `absolute inset-0` over a card). A link holding an image or text
 * is NOT empty, whatever its name.
 */
function isEmptyLink(el: AriaElement, hasChildElement: Set<string>): boolean {
  return el.role === 'link' && el.name.trim() === '' && !/\]:\s*\S/.test(el.line) && !hasChildElement.has(el.ref);
}

/** The selected clickable ancestor whose box contains this element's box, if any. */
function enclosingSelectedClickable(el: AriaElement, byRef: Map<string, AriaElement>, selectedClickable: Set<string>): string | null {
  const box = el.box as Box;
  for (const ancestor of ancestors(el, byRef)) {
    const outer = ancestor.box;
    if (!selectedClickable.has(ancestor.ref) || !outer) continue;
    const inside =
      box.x >= outer.x - OVERLAY_SLACK &&
      box.y >= outer.y - OVERLAY_SLACK &&
      box.x + box.width <= outer.x + outer.width + OVERLAY_SLACK &&
      box.y + box.height <= outer.y + outer.height + OVERLAY_SLACK;
    if (inside) return ancestor.ref;
  }
  return null;
}

function contextOf(el: AriaElement, byRef: Map<string, AriaElement>, childrenOf: Map<string, AriaElement[]>): CandidateContext {
  const context: CandidateContext = { inNavigation: false, inFooter: false, clickableAncestor: null, repeatedUnit: null };
  for (const ancestor of ancestors(el, byRef)) {
    if (ancestor.role === 'navigation') context.inNavigation = true;
    if (ancestor.role === 'contentinfo') context.inFooter = true;
    if (context.clickableAncestor === null && isClickable(ancestor)) context.clickableAncestor = ancestor.ref;
  }
  if (el.role === 'heading') context.repeatedUnit = repeatedUnitOf(el, byRef, childrenOf);
  return context;
}

function sameSize(a: Box, b: Box): boolean {
  return Math.abs(a.width - b.width) <= SAME_BOX_SLACK && Math.abs(a.height - b.height) <= SAME_BOX_SLACK;
}

/**
 * Does this heading title one of several IDENTICAL sibling blocks? Tried for
 * the heading's parent, grandparent and great-grandparent: a sibling of that
 * block with the same size, holding a same-size heading at the same offset,
 * is a twin. Identical boxes are a geometric fact, and a card grid is exactly
 * that — while two sibling page bands virtually never match to the pixel.
 * The page's h1 is never a unit title (a carousel's slides repeat it).
 */
function repeatedUnitOf(heading: AriaElement, byRef: Map<string, AriaElement>, childrenOf: Map<string, AriaElement[]>): { unit: string; twins: string[] } | null {
  const box = heading.box;
  if (!box || heading.line.includes('[level=1]')) return null;
  let level = 0;
  for (const unit of ancestors(heading, byRef)) {
    if (++level > REPEAT_UNIT_MAX_DEPTH) break;
    const unitBox = unit.box;
    if (!unitBox || unit.parentRef === null) continue;
    const dx = box.x - unitBox.x;
    const dy = box.y - unitBox.y;
    const twins: string[] = [];
    for (const sibling of childrenOf.get(unit.parentRef) ?? []) {
      const siblingBox = sibling.box;
      if (sibling === unit || !siblingBox || !sameSize(siblingBox, unitBox)) continue;
      const echo = firstInSubtree(sibling, childrenOf, (e) =>
        e.role === 'heading' && e.box !== undefined && sameSize(e.box, box) &&
        Math.abs(e.box.x - siblingBox.x - dx) <= SAME_BOX_SLACK && Math.abs(e.box.y - siblingBox.y - dy) <= SAME_BOX_SLACK,
      );
      if (echo) twins.push(sibling.ref);
    }
    if (twins.length > 0) return { unit: unit.ref, twins };
  }
  return null;
}

/** The first element in `root`'s subtree (pre-order, root excluded) satisfying `test`. */
function firstInSubtree(root: AriaElement, childrenOf: Map<string, AriaElement[]>, test: (e: AriaElement) => boolean): AriaElement | null {
  const seen = new Set<string>([root.ref]);
  const stack = [...(childrenOf.get(root.ref) ?? [])].reverse();
  while (stack.length > 0) {
    const el = stack.pop() as AriaElement;
    if (seen.has(el.ref)) continue;
    seen.add(el.ref);
    if (test(el)) return el;
    const kids = childrenOf.get(el.ref) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as AriaElement);
  }
  return null;
}

/** A computed px length ("16px") as a number; anything else ("normal", "auto", "") is null. */
function px(value: string): number | null {
  const match = /^(-?\d*\.?\d+)px$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/** True only for a parseable color with non-zero alpha — garbage never counts as a fill. */
function isPaintedColor(value: string): boolean {
  const hex = normalizeColor(value);
  if (!hex || hex.length !== 9) return false;
  return Number.parseInt(hex.slice(7, 9), 16) > 0;
}

function hasGradient(backgroundImage: string): boolean {
  return /gradient\(/i.test(backgroundImage);
}

/** Not rendered — or rendered only for assistive tech (`sr-only`, ≤ 2px) — so there is nothing a user sees to audit. */
function isRendered(facts: DomFacts): boolean {
  const { display, visibility, opacity } = facts.style;
  if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return false;
  const alpha = Number.parseFloat(opacity);
  if (Number.isFinite(alpha) && alpha <= 0) return false;
  return isVisiblySized(facts.box);
}

/**
 * Does it LOOK like a button? A fill (non-transparent background colour or a
 * gradient), or a visible solid border with real horizontal padding (an
 * outlined button) — and in either case a control-sized height. A text link
 * has neither, whatever its tag.
 */
function buttonRendering(facts: DomFacts): string | null {
  const height = facts.box.height;
  if (height < BUTTON_MIN_HEIGHT || height > BUTTON_MAX_HEIGHT) return null;
  const s = facts.style;
  if (isPaintedColor(s.backgroundColor)) return `renders as a button: filled background ${s.backgroundColor}`;
  if (hasGradient(s.backgroundImage)) return 'renders as a button: gradient background';
  const border = px(s.borderTopWidth) ?? 0;
  const padding = px(s.paddingLeft) ?? 0;
  if (border >= 1 && s.borderTopStyle === 'solid' && padding >= 8) return `renders as a button: ${s.borderTopWidth} solid border, ${s.paddingLeft} padding`;
  return null;
}

/**
 * Classifies one candidate into a taxonomy type from its role and rendered
 * facts. Returns null when it is not a component at all: not rendered
 * (display:none, hidden, opacity 0, zero-size or `sr-only` ≤ 2px), an empty
 * heading, or an element that is neither a heading, a form field nor
 * clickable.
 *
 * Order matters and each step is a fact, not a judgment:
 *  heading → section-heading (eyebrow when ≤ 14px and uppercase/tracked);
 *  tab → tabs; form fields → input/search/select/checkbox/radio/textarea
 *  (a combobox is a select only on <select>/<button>: on an <input> it is an
 *  autocomplete TEXT field); then for clickables: small square with no text
 *  → icon-button; renders as a button → button; taller than a button and
 *  large (area ≥ 20,000px², or text + image) → card; other links → link /
 *  nav-link; a native button → button; anything else clickable → button at
 *  LOW confidence 0.45, signalled as inferred.
 *
 * Confidence reflects the evidence behind the ELEMENT — native semantic
 * element 0.9, explicit role attribute 0.8, cursor-pointer generic 0.6 (0.45
 * with no text) — EXCEPT where the type itself is doubtful, which drops it to
 * LOW 0.45 with a signal saying why, so S8 routes it to review instead of
 * publishing a confident guess: a heading that is clickable, sits inside a
 * clickable, a navigation or the footer (an accordion question, a card
 * title, an office label is not evidently a section heading); an empty
 * clickable with no text and no children (a transparent overlay).
 *
 * Hierarchy facts come from `opts` (computed by the caller) or, when the
 * element is one `selectCandidates` returned, from the context it carries.
 */
export function classifyCandidate(
  el: AriaElement,
  facts: DomFacts,
  opts: { inNavigation?: boolean | undefined; inFooter?: boolean | undefined; context?: CandidateContext | undefined } = {},
): CandidateClassification | null {
  if (!isRendered(facts)) return null;

  const context = opts.context ?? selectionOf(el);
  const place: Placement = {
    inNavigation: opts.inNavigation ?? context?.inNavigation ?? false,
    inFooter: opts.inFooter ?? context?.inFooter ?? false,
    clickableAncestor: context?.clickableAncestor ?? null,
    repeatedUnit: context?.repeatedUnit ?? null,
  };

  const tag = facts.tag.toLowerCase();
  const text = facts.text.replace(/\s+/g, ' ').trim();
  const name = el.name.trim();
  const signals: string[] = [`role=${el.role}`, `tag=${tag}`, `cursor=${facts.cursor || 'auto'}`];
  if (facts.roleAttr) signals.push(`role-attr=${facts.roleAttr}`);
  const level = /\[level=(\d)\]/.exec(el.line)?.[1];
  if (level) signals.push(`level=${level}`);
  if (facts.hasSvg) signals.push('has svg');
  if (facts.hasImg) signals.push('has img');
  if (place.inNavigation) signals.push('inside navigation');
  if (place.inFooter) signals.push('inside footer');

  const decision = decideType(el, facts, tag, text, name, place);
  if (!decision) return null;
  signals.push(...decision.signals);

  const evidence = evidenceConfidence(el, facts, tag, text !== '');
  const confidence = decision.forcedConfidence ?? evidence;

  const classes = [...new Set(facts.classes.map((c) => c.trim()).filter((c) => c !== ''))];
  for (const cls of classes.slice(0, KEY_CLASSES_MAX)) signals.push(`class=${cls}`);

  return {
    componentType: decision.type,
    label: labelFor(el, name, text, decision.type, facts.imgAlt),
    domSignals: signals,
    visualSignals: visualSummary(facts),
    instanceGroupKey: `${decision.type}:${tag}:${createHash('sha1').update([...classes].sort().join(' ')).digest('hex').slice(0, 10)}`,
    confidence,
  };
}

/** Hierarchy facts classification may use, resolved from the caller's opts or the selection context. */
interface Placement {
  inNavigation: boolean;
  inFooter: boolean;
  clickableAncestor: string | null;
  repeatedUnit: { unit: string; twins: string[] } | null;
}

type TypeDecision = { type: ComponentType; signals: string[]; forcedConfidence?: number };

/** The context `selectCandidates` attached to this element, when it is one of its candidates. */
function selectionOf(el: AriaElement): CandidateContext | undefined {
  return 'selection' in el ? (el as SelectedCandidate).selection : undefined;
}

function decideType(el: AriaElement, facts: DomFacts, tag: string, text: string, name: string, place: Placement): TypeDecision | null {
  const role = el.role;

  if (role === 'heading') {
    if (!name && !text) return null;
    const fontSize = px(facts.style.fontSize);
    const tracking = px(facts.style.letterSpacing) ?? 0;
    const uppercase = facts.style.textTransform === 'uppercase';
    if (fontSize !== null && fontSize <= 14 && (uppercase || tracking >= 1)) {
      return { type: 'eyebrow', signals: [`small (${facts.style.fontSize}) ${uppercase ? 'uppercase' : `tracked ${facts.style.letterSpacing}`} heading → eyebrow`] };
    }
    const doubt = headingDoubt(el, facts, place);
    if (doubt) return { type: 'section-heading', signals: [doubt], forcedConfidence: INFERRED_CONFIDENCE };
    return { type: 'section-heading', signals: [] };
  }

  if (role === 'tab') return { type: 'tabs', signals: [] };

  if (role === 'combobox') return comboboxType(tag);
  const field = FIELD_TYPES[role];
  if (field) {
    const signals: string[] = [];
    let type: ComponentType = field;
    if (role === 'textbox' && tag === 'textarea') type = 'textarea';
    if (tag === 'select') type = 'select';
    // A pointer cursor on a text field usually means a dropdown trigger — but that is
    // an inference, so it is stated rather than acted on.
    if (role === 'textbox' && (facts.cursor === 'pointer' || el.line.includes(POINTER))) {
      signals.push('cursor:pointer on a text field — may be a dropdown trigger');
    }
    return { type, signals };
  }
  if (tag === 'select') return { type: 'select', signals: [] };

  // Clickability comes from the role or the snapshot's `[cursor=pointer]` marker, never from
  // facts.cursor alone: computed `cursor` is INHERITED, so every span inside a link reads
  // "pointer" and would pass as a control of its own.
  const clickable = CLICKABLE_ROLES.has(role) || el.line.includes(POINTER);
  if (!clickable) return null;

  const { width, height } = facts.box;
  if (width <= ICON_BUTTON_MAX_SIDE && height <= ICON_BUTTON_MAX_SIDE && text === '') {
    return { type: 'icon-button', signals: [`small (${Math.round(width)}×${Math.round(height)}) clickable with no text → icon-button`] };
  }

  const rendering = buttonRendering(facts);
  if (rendering) return { type: 'button', signals: [rendering] };

  // Nothing painted (checked above), no text, no children: a transparent click target laid
  // over something else. Its own box and styles are not what a user sees, so whatever type
  // its geometry suggests is only a reading.
  const overlay = text === '' && name === '' && facts.childElementCount === 0 && !facts.hasImg && !facts.hasSvg;
  const asOverlay = (decision: TypeDecision): TypeDecision =>
    overlay
      ? { type: decision.type, signals: [...decision.signals, 'empty clickable (no text, no child elements) — a transparent overlay, its own box is not what users see'], forcedConfidence: INFERRED_CONFIDENCE }
      : decision;

  const boxArea = width * height;
  if (height > BUTTON_MAX_HEIGHT && (boxArea >= CARD_MIN_AREA || (text !== '' && facts.hasImg))) {
    const why = boxArea >= CARD_MIN_AREA ? `area ${Math.round(boxArea)}px²` : 'text + image';
    return asOverlay({ type: 'card', signals: [`large clickable (${why}) → card`] });
  }

  if (role === 'link') return asOverlay({ type: place.inNavigation ? 'nav-link' : 'link', signals: [] });
  if (role === 'button') return asOverlay({ type: 'button', signals: [] });

  return { type: 'button', signals: ['clickable generic — type inferred', ...(overlay ? ['empty clickable (no text, no child elements)'] : [])], forcedConfidence: INFERRED_CONFIDENCE };
}

/**
 * Why a heading is NOT evidently a section heading, or null when it is.
 * A section heading titles a band of the page; these are headings doing
 * another job, and typing them `section-heading` at 0.9 would publish
 * SectionHeading deviations for an FAQ question or a card title:
 *  - it is itself clickable (`[cursor=pointer]`): an accordion trigger;
 *  - it sits inside a clickable — a known clickable ancestor, or a computed
 *    `cursor: pointer` WITHOUT its own marker (Playwright only omits the
 *    marker under a marked ancestor): a card or link title;
 *  - it titles one of several identical sibling blocks: a card title;
 *  - it sits inside the footer or a navigation: a column / office / menu
 *    label.
 */
function headingDoubt(el: AriaElement, facts: DomFacts, place: Placement): string | null {
  if (el.line.includes(POINTER)) return 'clickable heading ([cursor=pointer]) — an accordion trigger or link title, not evidently a section heading';
  if (place.clickableAncestor) return `inside clickable ${place.clickableAncestor} — a card or link title, not evidently a section heading`;
  if (facts.cursor === 'pointer') return 'computed cursor:pointer without its own snapshot marker — inside a clickable ancestor (a card or link title), not evidently a section heading';
  if (place.repeatedUnit) {
    return `titles ${place.repeatedUnit.unit}, one of ${place.repeatedUnit.twins.length + 1} identical sibling blocks (${place.repeatedUnit.twins.join(', ')}) — a card title, not evidently a section heading`;
  }
  if (place.inFooter) return 'inside the footer (contentinfo) — a column or office label, not evidently a section heading';
  if (place.inNavigation) return 'inside a navigation — a menu group label, not evidently a section heading';
  return null;
}

/**
 * ARIA's combobox is two different controls. On a native <select> (or a
 * <button>: WAI-ARIA's select-only combobox, e.g. a Radix/shadcn Select
 * trigger) it opens a listbox → select. On an <input> (`role=combobox` or
 * `<input list>`) it is an autocomplete TEXT field → input, and must reach
 * B3's input/search rule (R4.10), not the select one. On any other tag
 * (ARIA 1.1's wrapper div) the two cannot be told apart → select at LOW.
 */
function comboboxType(tag: string): TypeDecision {
  if (tag === 'select') return { type: 'select', signals: ['combobox on a native <select>'] };
  if (tag === 'input') return { type: 'input', signals: ['combobox on <input> — an autocomplete text field, not a native select'] };
  if (tag === 'textarea') return { type: 'textarea', signals: ['combobox on <textarea> — an autocomplete text field'] };
  if (tag === 'button') return { type: 'select', signals: ['combobox on <button> — a select-only combobox (listbox trigger)'] };
  return { type: 'select', signals: [`combobox on <${tag}> — select vs autocomplete field is not decidable from the element`], forcedConfidence: INFERRED_CONFIDENCE };
}

/**
 * How strong the evidence that this element IS a control is: a native
 * element carrying its own role (a/button/h1–h6/input…) 0.9; an explicit
 * role attribute 0.8; a generic that is only known to be clickable 0.6, and
 * 0.45 when it has no text either.
 */
function evidenceConfidence(el: AriaElement, facts: DomFacts, tag: string, hasText: boolean): number {
  const native = NATIVE_ROLES[tag]?.includes(el.role) === true && (facts.roleAttr === null || facts.roleAttr === el.role);
  if (native) return 0.9;
  if (facts.roleAttr && el.role !== 'generic') return 0.8;
  return hasText ? 0.6 : 0.45;
}

function labelFor(el: AriaElement, name: string, text: string, type: ComponentType, imgAlt?: string | null): string {
  if (name) return name;
  if (text) return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
  // A logo link or image button: its image's alt text is the only name a reviewer can recognise.
  if (imgAlt) return `${imgAlt.length > LABEL_MAX ? `${imgAlt.slice(0, LABEL_MAX - 1)}…` : imgAlt} (image)`;
  return `(unlabelled ${type} ${el.role})`;
}

/** A short computed-style summary — what was measured, never what a screenshot "shows". */
function visualSummary(facts: DomFacts): string {
  const s = facts.style;
  const background = hasGradient(s.backgroundImage)
    ? `${s.backgroundColor} + gradient`
    : s.backgroundImage && s.backgroundImage !== 'none'
      ? `${s.backgroundColor} + image`
      : s.backgroundColor;
  const parts = [
    `${Math.round(facts.box.width)}×${Math.round(facts.box.height)}px`,
    `display ${s.display}`,
    `bg ${background}`,
    `border-top ${s.borderTopWidth} ${s.borderTopStyle}`,
    `padding ${s.paddingTop} ${s.paddingLeft}`,
    `text ${s.color} ${s.fontSize}/${s.fontWeight}`,
  ];
  if (s.textTransform && s.textTransform !== 'none') parts.push(s.textTransform);
  if (s.letterSpacing && s.letterSpacing !== 'normal') parts.push(`tracking ${s.letterSpacing}`);
  return `deterministic: ${parts.join('; ')}`;
}
