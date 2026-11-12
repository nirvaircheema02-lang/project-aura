import { isCandidateShape, isVisiblySized } from '../b2-component-detector/deterministic.ts';
import type { B1Sections } from '../../llm/schemas/b-nodes.ts';
import type { AriaElement } from '../../t-layer/element-registry.ts';

/**
 * No-API B1 (NO-API-SPEC Module B): the page's top-level sections derived from
 * the accessibility snapshot alone — its DOM hierarchy (`parentRef`) and its
 * geometry — with zero model calls.
 *
 * The output has exactly the shape of `B1SectionsSchema`, so B1's existing
 * resolution code (ref normalization, container promotion, de-duplication)
 * runs on it unchanged, whichever strategy produced the map.
 *
 * Why the hierarchy and not a visual guess: the snapshot's nesting IS the
 * page's structure. A "section spine" walks it from the page root and only
 * descends through WRAPPERS (a node spanning most of the page whose children
 * are the real bands); everything else it meets is a section. Anything this
 * cannot decide without semantic judgment falls back to the plainest label
 * ("content", "Section N") — a coarse label is safe, a confident wrong one is
 * not. Every section's `note` says which rule produced it.
 *
 * What the map is FOR decides its shape: B2 offers each section every
 * element whose box lies inside the section root's y-range (full width,
 * ±4px), and the first section to offer an element claims it. So the map is
 * built to hand every control to the section it belongs to: bands never
 * overlap vertically, and a node whose y-range cannot be separated from a
 * band's (a sidebar beside a column, an overlay) is never interleaved with
 * the bands (see `deterministicSections`).
 */

export type DeterministicSection = B1Sections['sections'][number];
type SectionKind = DeterministicSection['kind'];
type Box = { x: number; y: number; width: number; height: number };

/** A node taller than this fraction of the page is a candidate WRAPPER rather than a section. */
export const WRAPPER_PAGE_FRACTION = 0.5;

/** Bands shorter than this are strips inside a section (a divider, a live region), never a section of their own. */
export const MIN_SECTION_BAND_HEIGHT = 24;

/**
 * A wrapper's children must be section-sized bands: at least this tall
 * (B1's SECTION_MIN_HEIGHT — the smallest real section container)…
 */
export const WRAPPER_BAND_MIN_HEIGHT = 120;

/** …and at least this fraction of the wrapper's width (a band spans the column, a side image does not). */
export const WRAPPER_BAND_MIN_WIDTH_FRACTION = 0.5;

/**
 * B2's `sectionElements` slack: an element belongs to a section's y-band when
 * its box lies within the root's y-range widened by this many px. Two bands
 * overlapping by more than this can offer the same element twice.
 */
export const BAND_SLACK = 4;

/** A band starting within this many px of the page top can be the header band. */
export const TOP_BAND_MAX_Y = 200;

/** A header band is a strip, not a panel: taller than this and it is a hero or content section. */
export const TOP_BAND_MAX_HEIGHT = 200;

/** Repeated links/cards under one container at or above this count make a listing (sampled, not enumerated). */
export const LISTING_MIN_ITEMS = 12;

/** Section names are display labels; a whole FAQ question as a name helps nobody. */
const SECTION_NAME_MAX = 80;

/** How many refs a note lists before summarising the rest as a count. */
const NOTE_MAX_REFS = 5;

/** Landmarks are kept as sections even when shorter than MIN_SECTION_BAND_HEIGHT: their role says they are one. */
const LANDMARK_ROLES = new Set(['banner', 'navigation', 'contentinfo', 'main', 'form', 'region']);

const LANDMARK_LABELS: Record<string, string> = {
  banner: 'Header',
  navigation: 'Navigation',
  contentinfo: 'Footer',
  form: 'Form',
};

/** A section holding any of these is a data-entry section. */
const FORM_FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox']);

/** §2.7: per-visitor content is out of compliance scope — these phrases announce it. */
const PERSONALIZED_TEXT = /recommended for you|recently viewed|based on your|picked for you/i;

/**
 * Roles whose NAME titles a block of content: headings, landmarks and named
 * groupings. Only these can announce a personalized block. Body copy
 * ("…a plan based on your business goals") and control labels (a "Recently
 * viewed" menu link) mention the phrases without the block being per-visitor.
 */
const TITLE_ROLES = new Set([
  'heading', 'banner', 'navigation', 'main', 'contentinfo', 'region', 'complementary', 'form', 'search',
  'group', 'list', 'grid', 'feed', 'tabpanel', 'dialog',
]);

const POINTER = '[cursor=pointer]';

/** One section as the spine places it, with every stated reason gathered on the way. */
interface Band {
  el: AriaElement;
  wrappers: string[];
  notes: string[];
}

/** A band-level node the spine did NOT make a section, and why. */
interface Skipped extends Band {
  why: string;
}

/**
 * Divides a page into its top-level sections from its aria snapshot.
 *
 * 1. Section spine. The depth-0 page root is never a section; it is expanded
 *    into its element children. A child taller than half the page is a
 *    WRAPPER, and is expanded the same way, recursively, when its children
 *    are real bands: at least two section-sized ones (≥ 120px tall, ≥ half
 *    its width) — or exactly one that is itself taller than half the page (a
 *    pass-through `main > div > bands…`) — AND no two of them overlap
 *    vertically. An h1 plus its paragraph and form is a hero, not three
 *    bands; a sidebar beside a column cannot be told apart by a y-band, so
 *    such a node stays ONE section rather than handing the sidebar's
 *    controls to whichever band shares their y. Any other child is a
 *    section. Children that cannot be a visible band are skipped: zero-size,
 *    entirely off-canvas horizontally (a closed drawer, an inactive slide),
 *    shorter than 24px unless a landmark, and control-less decorations
 *    laid over a band (a background blob).
 * 2. Out of flow. A root child lying inside a taller root child's y-range (a
 *    fixed cookie bar, chat bubble or side column) is not interleaved with
 *    the bands. Neither is a spine section overlapping an earlier one.
 * 3. Rescue. Whatever step 1–2 left out that holds controls no section's
 *    y-range covers is not dropped silently: a left-out node whose y-range
 *    holds only its OWN controls becomes a section (placed so it claims
 *    them first); one whose y-range holds other sections' controls too is
 *    listed AFTER every in-flow section, so each band claims its own
 *    controls before it. Controls that still fall outside every section are
 *    listed in the nearest section's note.
 *
 * Sections come back in document order by y (then x) — position:fixed and
 * reordered flex bands sit anywhere in the DOM — except that a rescued node
 * goes where it claims only its own controls, and out-of-flow sections come
 * last.
 */
export function deterministicSections(
  elements: AriaElement[],
  opts: { pageHeight: number; viewportWidth: number },
): DeterministicSection[] {
  const viewportWidth = opts.viewportWidth;
  const children = childrenIndex(elements);
  const byRef = new Map(elements.map((e) => [e.ref, e]));
  const docIndex = new Map(elements.map((e, i) => [e.ref, i]));
  const pageHeight = opts.pageHeight > 0 ? opts.pageHeight : lowestBottom(elements);
  const tallThreshold = pageHeight * WRAPPER_PAGE_FRACTION;

  // What B2 would offer as a candidate, and how many such elements each subtree holds.
  const offerable = (el: AriaElement): boolean =>
    el.depth > 0 && isCandidateShape(el) && el.box !== undefined && isVisiblySized(el.box) && isOnCanvas(el.box, viewportWidth);
  const controls = controlCounts(elements, offerable);
  const holdsControls = (el: AriaElement): boolean => (controls.get(el.ref) ?? 0) > 0;

  const spine: Band[] = [];
  const skipped: Skipped[] = [];
  const visited = new Set<string>();

  /** Splits a node's element children into possible bands and the sub-24px slivers left out. */
  const partition = (kids: AriaElement[]): { bands: AriaElement[]; slivers: AriaElement[] } => {
    const visible = kids.filter((k) => k.box !== undefined && k.box.width > 0 && k.box.height > 0 && isOnCanvas(k.box, viewportWidth));
    const slivers = visible.filter((k) => (k.box as Box).height < MIN_SECTION_BAND_HEIGHT && !LANDMARK_ROLES.has(k.role));
    const tall = visible.filter((k) => !slivers.includes(k));
    const holding = tall.filter(holdsControls);
    // A control-less node laid over a band (a decorative background) holds nothing B2 could
    // detect, but as a section its y-range would claim the band's controls: leave it out.
    const bands = tall.filter((k) => holdsControls(k) || !holding.some((h) => overlapsY(k.box as Box, h.box as Box)));
    return { bands, slivers };
  };

  const take = (kids: AriaElement[], wrappers: string[], atRoot: boolean): void => {
    const { bands, slivers } = partition(kids);
    for (const sliver of slivers) skipped.push({ el: sliver, wrappers, notes: [], why: `shorter than ${MIN_SECTION_BAND_HEIGHT}px` });
    for (const band of bands) {
      const host = atRoot ? enclosingSibling(band, bands, docIndex) : null;
      if (host) skipped.push({ el: band, wrappers, notes: [], why: `out of flow — lies inside the y-range of ${host.ref}` });
      else consider(band, wrappers);
    }
  };

  const consider = (node: AriaElement, wrappers: string[]): void => {
    if (visited.has(node.ref)) return; // the tree is acyclic by construction; this is only a guard
    visited.add(node.ref);
    const box = node.box as Box; // band candidates always have a box
    const notes: string[] = [];
    if (box.height > tallThreshold) {
      const kids = children.get(node.ref) ?? [];
      const verdict = wrapperVerdict(node, partition(kids).bands, tallThreshold);
      if (verdict.expand) {
        take(kids, [...wrappers, node.ref], false);
        return;
      }
      if (verdict.why) notes.push(verdict.why);
    }
    spine.push({ el: node, wrappers, notes });
  };

  // Elements with no referenceable parent: the page root(s) (depth 0) — or, when the
  // root line carries no ref, the root's children themselves.
  const tops = elements.filter((e) => e.parentRef === null);
  const rootKids: AriaElement[] = [];
  for (const top of tops) {
    if (top.depth === 0) {
      visited.add(top.ref);
      rootKids.push(...(children.get(top.ref) ?? []));
    } else {
      rootKids.push(top);
    }
  }
  take(rootKids, [], true);

  const byPosition = (a: Band, b: Band): number => {
    const ba = a.el.box as Box;
    const bb = b.el.box as Box;
    return ba.y - bb.y || ba.x - bb.x || (docIndex.get(a.el.ref) ?? 0) - (docIndex.get(b.el.ref) ?? 0);
  };

  // In-flow bands never overlap: a spine section overlapping an earlier one (a child
  // overflowing its wrapper, a band pulled over the previous one) is set aside for rescue.
  spine.sort(byPosition);
  const inFlow: Band[] = [];
  for (const band of spine) {
    const clash = inFlow.find((q) => overlapsY(band.el.box as Box, q.el.box as Box));
    if (clash) skipped.push({ ...band, why: `overlaps section ${clash.el.ref} by more than ${BAND_SLACK}px` });
    else inFlow.push(band);
  }

  const spineRefs = new Set(inFlow.map((band) => band.el.ref));
  const { ordered, tail } = rescue(inFlow, skipped, elements, byRef, offerable, byPosition);
  const sections = [...ordered, ...tail];
  noteUnoffered(sections, elements, offerable);
  noteForeignClaims(sections, spineRefs, elements, byRef, offerable);

  const hasBanner = sections.some((s) => s.el.role === 'banner');
  let heroAssigned = false;
  let navAssigned = false;
  let headerNamed = false;
  return sections.map(({ el, wrappers, notes }, index) => {
    const descendants = descendantsOf(el, children);
    const kind = sectionKind(el, descendants, { heroAssigned, navAssigned });
    if (kind.kind === 'hero') heroAssigned = true;
    if (kind.kind === 'nav') navAssigned = true;
    const name = sectionName(el, descendants, kind.kind, index, viewportWidth, !hasBanner && !headerNamed);
    if (name.name === 'Header') headerNamed = true;
    const personalized = personalizationEvidence(el, descendants);
    const listing = listingEvidence(el, descendants, children);

    const why = [kind.why, name.why];
    if (personalized.phrase) why.push(`personalized: "${personalized.phrase}" (${personalized.where})`);
    else if (personalized.mention) why.push(personalized.mention);
    if (listing) why.push(`listing: ${listing}`);
    if (wrappers.length > 0) why.push(`inside wrapper ${wrappers.join(' > ')}`);
    why.push(...notes);

    return {
      name: name.name,
      kind: kind.kind,
      rootRef: el.ref,
      personalized: personalized.phrase !== null,
      isListing: listing !== null,
      note: `deterministic: ${why.join('; ')}`,
    };
  });
}

/**
 * Should this tall node be split into its children? Only when they are real
 * bands (two section-sized, or one page-tall pass-through) that do not
 * overlap vertically. `why` explains a refusal worth stating.
 */
function wrapperVerdict(node: AriaElement, bands: AriaElement[], tallThreshold: number): { expand: boolean; why: string | null } {
  const minWidth = (node.box as Box).width * WRAPPER_BAND_MIN_WIDTH_FRACTION;
  const sectionSized = bands.filter((b) => (b.box as Box).height >= WRAPPER_BAND_MIN_HEIGHT && (b.box as Box).width >= minWidth);
  const passThrough = sectionSized.length === 1 && (sectionSized[0]?.box as Box).height > tallThreshold;
  if (sectionSized.length < 2 && !passThrough) return { expand: false, why: null };
  const clash = firstVerticalOverlap(bands);
  if (clash) {
    const [a, b] = clash;
    return {
      expand: false,
      why: `not split: its children ${a.ref} (${yRange(a)}) and ${b.ref} (${yRange(b)}) overlap vertically — side-by-side columns or an overlay a y-band cannot tell apart — so it stays one section`,
    };
  }
  return { expand: true, why: null };
}

/**
 * Step 3 of `deterministicSections`: give every left-out node that holds
 * controls no in-flow section covers a place where it claims them — and ONLY
 * them — under B2's first-claim-wins. `ordered` is the in-flow sections plus
 * rescued ones; `tail` must come after all of them.
 */
function rescue(
  inFlow: Band[],
  skipped: Skipped[],
  elements: AriaElement[],
  byRef: Map<string, AriaElement>,
  offerable: (el: AriaElement) => boolean,
  byPosition: (a: Band, b: Band) => number,
): { ordered: Band[]; tail: Band[] } {
  const offered = elements.filter(offerable);
  const skippedRefs = new Set(skipped.map((s) => s.el.ref));
  const own = new Map<string, AriaElement[]>();
  for (const el of offered) {
    const host = ancestorOrSelfIn(el, skippedRefs, byRef);
    if (host) own.set(host, [...(own.get(host) ?? []), el]);
  }

  const ordered = [...inFlow];
  const tail: Band[] = [];
  for (const skip of [...skipped].sort(byPosition)) {
    const box = skip.el.box as Box;
    const mine = (own.get(skip.el.ref) ?? []).filter((e) => withinBand(e.box as Box, box));
    if (mine.length === 0) continue; // nothing B2 could detect in it: leaving it out loses nothing
    const mineRefs = new Set(mine.map((e) => e.ref));
    const foreign = offered.filter((e) => !mineRefs.has(e.ref) && withinBand(e.box as Box, box) && !isDescendant(e, skip.el, byRef));
    const coveredBy = (e: AriaElement): Band | undefined => inFlow.find((s) => withinBand(e.box as Box, s.el.box as Box));

    if (foreign.length === 0) {
      // Its y-range holds only its own controls: as a section it takes exactly those — as
      // long as it comes before any section whose y-range also holds them.
      const rescued: Band = { el: skip.el, wrappers: skip.wrappers, notes: [...skip.notes, `kept as a section although ${skip.why}: its y-range holds only its own controls (${refList(mine)})`] };
      const firstCovering = ordered.findIndex((s) => mine.some((e) => withinBand(e.box as Box, s.el.box as Box)));
      if (firstCovering >= 0) {
        rescued.notes.push(`placed before ${ordered[firstCovering]?.el.ref}, whose y-range also holds them`);
        ordered.splice(firstCovering, 0, rescued);
      } else {
        const at = ordered.findIndex((s) => byPosition(rescued, s) < 0);
        ordered.splice(at < 0 ? ordered.length : at, 0, rescued);
      }
      continue;
    }

    // Its y-range also holds other sections' controls, so it can only come last.
    const uncovered = mine.filter((e) => !coveredBy(e));
    if (uncovered.length > 0) {
      tail.push({
        el: skip.el,
        wrappers: skip.wrappers,
        notes: [...skip.notes, `${skip.why}; listed after the in-flow sections so each claims its own controls first — it adds ${refList(uncovered)}, which no other section covers`],
      });
    }
    // Its controls inside an in-flow band's y-range go to that band under first-claim-wins:
    // detected, but under the band's name. Say so on the band.
    const attributed = new Map<Band, AriaElement[]>();
    for (const e of mine) {
      const host = coveredBy(e);
      if (host) attributed.set(host, [...(attributed.get(host) ?? []), e]);
    }
    for (const [host, els] of attributed) {
      host.notes.push(`controls of ${skip.el.ref}, left out as a section (${skip.why}), render in this y-range and are attributed to it by B2: ${refList(els)}`);
    }
  }
  tail.sort(byPosition);
  return { ordered, tail };
}

/**
 * States every candidate-shaped element that no section's y-range covers —
 * B2 will never offer it — in the note of the section nearest to it, so
 * the gap is on record rather than silent.
 */
function noteUnoffered(sections: Band[], elements: AriaElement[], offerable: (el: AriaElement) => boolean): void {
  if (sections.length === 0) return;
  const lost = new Map<Band, AriaElement[]>();
  for (const el of elements) {
    if (!offerable(el)) continue;
    const box = el.box as Box;
    if (sections.some((s) => withinBand(box, s.el.box as Box))) continue;
    let nearest = sections[0] as Band;
    for (const s of sections) if (verticalGap(box, s.el.box as Box) < verticalGap(box, nearest.el.box as Box)) nearest = s;
    lost.set(nearest, [...(lost.get(nearest) ?? []), el]);
  }
  for (const [section, els] of lost) {
    section.notes.push(`${els.length} control(s) near this section lie outside every section's y-range and are never offered to B2: ${refList(els)}`);
  }
}

/**
 * States every control that B2 will attribute to a section it does not
 * belong to: a descendant of one section rendered outside that section's
 * y-range and inside another's (a fixed "Join meeting" button that is a
 * child of the header but sits mid-page). It is still detected — under the
 * other section's name — and the receiving section's note says so. (Controls
 * of left-out nodes are stated by `rescue`; this covers the spine sections.)
 */
function noteForeignClaims(
  sections: Band[],
  spineRefs: Set<string>,
  elements: AriaElement[],
  byRef: Map<string, AriaElement>,
  offerable: (el: AriaElement) => boolean,
): void {
  const foreign = new Map<Band, { els: AriaElement[]; owners: Set<string> }>();
  for (const el of elements) {
    if (!offerable(el)) continue;
    const claimer = sections.find((s) => withinBand(el.box as Box, s.el.box as Box));
    const owner = ancestorOrSelfIn(el, spineRefs, byRef);
    if (!claimer || owner === null || owner === claimer.el.ref) continue;
    const entry = foreign.get(claimer) ?? { els: [], owners: new Set<string>() };
    entry.els.push(el);
    entry.owners.add(owner);
    foreign.set(claimer, entry);
  }
  for (const [section, { els, owners }] of foreign) {
    section.notes.push(`controls of section ${[...owners].join(', ')} render in this y-range and are attributed to it by B2: ${refList(els)}`);
  }
}

/** parentRef → element children, in document order. */
function childrenIndex(elements: AriaElement[]): Map<string, AriaElement[]> {
  const index = new Map<string, AriaElement[]>();
  for (const el of elements) {
    if (el.parentRef === null) continue;
    const list = index.get(el.parentRef);
    if (list) list.push(el);
    else index.set(el.parentRef, [el]);
  }
  return index;
}

/** How many `offerable` elements each subtree holds (self included). Pre-order input, so a reverse pass sums children first. */
function controlCounts(elements: AriaElement[], offerable: (el: AriaElement) => boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i] as AriaElement;
    const total = (counts.get(el.ref) ?? 0) + (offerable(el) ? 1 : 0);
    counts.set(el.ref, total);
    if (el.parentRef !== null) counts.set(el.parentRef, (counts.get(el.parentRef) ?? 0) + total);
  }
  return counts;
}

/** Every element below `root` in the hierarchy, pre-order (= document order). */
function descendantsOf(root: AriaElement, children: Map<string, AriaElement[]>): AriaElement[] {
  const out: AriaElement[] = [];
  const seen = new Set<string>([root.ref]);
  const stack = [...(children.get(root.ref) ?? [])].reverse();
  while (stack.length > 0) {
    const el = stack.pop() as AriaElement;
    if (seen.has(el.ref)) continue;
    seen.add(el.ref);
    out.push(el);
    const kids = children.get(el.ref) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as AriaElement);
  }
  return out;
}

/** The first element below `root` (pre-order) that satisfies `test`, without walking the rest of the subtree. */
function firstDescendant(root: AriaElement, children: Map<string, AriaElement[]>, test: (e: AriaElement) => boolean): AriaElement | null {
  const seen = new Set<string>([root.ref]);
  const stack = [...(children.get(root.ref) ?? [])].reverse();
  while (stack.length > 0) {
    const el = stack.pop() as AriaElement;
    if (seen.has(el.ref)) continue;
    seen.add(el.ref);
    if (test(el)) return el;
    const kids = children.get(el.ref) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as AriaElement);
  }
  return null;
}

/** The nearest ancestor-or-self of `el` whose ref is in `refs`, or null. */
function ancestorOrSelfIn(el: AriaElement, refs: Set<string>, byRef: Map<string, AriaElement>): string | null {
  const seen = new Set<string>();
  for (let ref: string | null = el.ref; ref !== null && !seen.has(ref); ref = byRef.get(ref)?.parentRef ?? null) {
    seen.add(ref);
    if (refs.has(ref)) return ref;
  }
  return null;
}

function isDescendant(el: AriaElement, root: AriaElement, byRef: Map<string, AriaElement>): boolean {
  return ancestorOrSelfIn(el, new Set([root.ref]), byRef) !== null;
}

/** Page height when the caller has none: the lowest box edge in the snapshot. */
function lowestBottom(elements: AriaElement[]): number {
  let bottom = 0;
  for (const el of elements) if (el.box) bottom = Math.max(bottom, el.box.y + el.box.height);
  return bottom;
}

function isOnCanvas(box: Box, viewportWidth: number): boolean {
  return box.x + box.width > 0 && box.x < viewportWidth;
}

/** Vertical overlap beyond B2's slack — the amount at which one element can be offered by both. */
function overlapsY(a: Box, b: Box): boolean {
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > BAND_SLACK;
}

/** B2's `sectionElements` membership test: `inner` lies within `band`'s y-range ± the slack. */
function withinBand(inner: Box, band: Box): boolean {
  return inner.y >= band.y - BAND_SLACK && inner.y + inner.height <= band.y + band.height + BAND_SLACK;
}

function verticalGap(a: Box, b: Box): number {
  return Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
}

function yRange(el: AriaElement): string {
  const box = el.box as Box;
  return `y ${Math.round(box.y)}..${Math.round(box.y + box.height)}`;
}

/** The first pair (in the given order) of boxes overlapping vertically beyond the slack. */
function firstVerticalOverlap(bands: AriaElement[]): [AriaElement, AriaElement] | null {
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i] as AriaElement;
      const b = bands[j] as AriaElement;
      if (overlapsY(a.box as Box, b.box as Box)) return [a, b];
    }
  }
  return null;
}

/**
 * The sibling whose y-range contains this band's and which is the larger of
 * the two (taller; then larger area; then earlier in the DOM) — the
 * in-flow block an overlay or side column sits over. Null when none does.
 */
function enclosingSibling(band: AriaElement, siblings: AriaElement[], docIndex: Map<string, number>): AriaElement | null {
  const box = band.box as Box;
  for (const other of siblings) {
    if (other === band) continue;
    const outer = other.box as Box;
    if (!withinBand(box, outer)) continue;
    const larger =
      outer.height > box.height ||
      (outer.height === box.height && outer.width * outer.height > box.width * box.height) ||
      (outer.height === box.height && outer.width * outer.height === box.width * box.height && (docIndex.get(other.ref) ?? 0) < (docIndex.get(band.ref) ?? 0));
    if (larger) return other;
  }
  return null;
}

function isH1(el: AriaElement): boolean {
  return el.role === 'heading' && el.line.includes('[level=1]');
}

/** A link or navigation landmark in the band that ends above the h1's top — a breadcrumb row over a title. */
function hasNavRowAbove(h1: AriaElement, descendants: AriaElement[]): boolean {
  const top = (h1.box as Box).y;
  return descendants.some((e) => (e.role === 'link' || e.role === 'navigation') && e.box !== undefined && e.box.height > 0 && e.box.y + e.box.height <= top + BAND_SLACK);
}

/**
 * The header band: a short strip at the very top carrying the site
 * navigation (a nav landmark that is not a breadcrumb trail, or at least
 * three links for sites that mark up their header as plain divs).
 */
function isTopNavBand(section: AriaElement, descendants: AriaElement[]): boolean {
  const box = section.box as Box;
  if (box.y > TOP_BAND_MAX_Y || box.height > TOP_BAND_MAX_HEIGHT) return false;
  if (descendants.some((e) => e.role === 'navigation' && !/breadcrumb/i.test(e.name))) return true;
  return descendants.filter((e) => e.role === 'link').length >= 3;
}

/**
 * Kind from structural facts only, in priority order: contentinfo → footer;
 * banner / navigation landmark → nav; the first section holding an h1 →
 * hero (see below for a short top band); a top nav band → nav; a section
 * holding a text field → form; everything else → content. Stats, cards,
 * testimonials, CTAs and charts need semantic judgment, so they are never
 * claimed here — "content" is the safe default, not a guess.
 *
 * A short top band holding both navigation and the page's first h1 is one
 * of two things. A title band under the header — a breadcrumb row, then
 * the page title — is the hero: a header band came before it AND a
 * link/navigation row ends above the h1. A header whose logo is the h1 (the
 * logo sits BESIDE the navigation, not below it) is nav. Anything not
 * matching the title-band shape stays nav: the coarser reading.
 */
function sectionKind(
  section: AriaElement,
  descendants: AriaElement[],
  seen: { heroAssigned: boolean; navAssigned: boolean },
): { kind: SectionKind; why: string } {
  const box = section.box as Box;
  if (section.role === 'contentinfo') return { kind: 'footer', why: 'contentinfo landmark → footer' };
  if (section.role === 'banner') return { kind: 'nav', why: 'banner landmark → nav' };
  if (section.role === 'navigation') return { kind: 'nav', why: 'navigation landmark → nav' };
  const topNav = isTopNavBand(section, descendants);
  const h1 = seen.heroAssigned ? undefined : [section, ...descendants].find(isH1);
  if (h1 && !topNav) return { kind: 'hero', why: `first section containing an h1 (${h1.ref}) → hero` };
  if (h1 && seen.navAssigned && hasNavRowAbove(h1, descendants)) {
    return { kind: 'hero', why: `first section containing an h1 (${h1.ref}), under the header band with its navigation row above the h1 (a title band) → hero` };
  }
  if (topNav) {
    return { kind: 'nav', why: `top band (y=${Math.round(box.y)}, h=${Math.round(box.height)}) carrying the site navigation → nav` };
  }
  if (section.role === 'form') return { kind: 'form', why: 'form landmark → form' };
  const field = descendants.find((e) => FORM_FIELD_ROLES.has(e.role));
  if (field) return { kind: 'form', why: `contains a ${field.role} (${field.ref}) → form` };
  return { kind: 'content', why: 'no landmark, h1 or text field → content' };
}

function clip(text: string, max = SECTION_NAME_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "e1 link "Back to top" (y 5990..6010), …" — capped, the rest counted. */
function refList(els: AriaElement[]): string {
  const shown = els.slice(0, NOTE_MAX_REFS).map((e) => `${e.ref} ${e.role}${e.name ? ` "${clip(e.name, 40)}"` : ''} (${yRange(e)})`);
  const more = els.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/**
 * Name: the section's own aria name; else its first heading (a visible one
 * preferred over a heading on an off-canvas slide); else its landmark label;
 * else, for an unnamed top nav band, "Header" — only for the first one and
 * only when no banner landmark will carry that name — or "Navigation";
 * else "Section N".
 *
 * One stated departure from heading-first: a banner or contentinfo landmark
 * is named by its landmark label, because the first heading inside a footer
 * is a column title ("About Ken Research"), not the section's name.
 */
function sectionName(
  section: AriaElement,
  descendants: AriaElement[],
  kind: SectionKind,
  index: number,
  viewportWidth: number,
  headerFree: boolean,
): { name: string; why: string } {
  const own = section.name.trim();
  if (own) return { name: clip(own), why: 'named by its aria name' };
  const landmark = LANDMARK_LABELS[section.role];
  if (landmark && (section.role === 'banner' || section.role === 'contentinfo')) {
    return { name: landmark, why: `named by its ${section.role} landmark` };
  }
  const headings = descendants.filter((e) => e.role === 'heading' && e.name.trim() !== '');
  const heading = headings.find((e) => e.box && e.box.width > 0 && e.box.height > 0 && isOnCanvas(e.box, viewportWidth)) ?? headings[0];
  if (heading) return { name: clip(heading.name), why: `named by heading ${heading.ref}` };
  if (landmark) return { name: landmark, why: `named by its ${section.role} landmark` };
  if (kind === 'nav' && headerFree) return { name: 'Header', why: 'first unnamed top navigation band, labelled Header' };
  if (kind === 'nav') return { name: 'Navigation', why: 'unnamed navigation band (the header is named already), labelled Navigation' };
  return { name: `Section ${index + 1}`, why: 'no aria name, heading or landmark to name it' };
}

/**
 * Is this section per-visitor content (§2.7)? Only a TITLE can say so: the
 * section's own aria name, or the name of a heading, landmark or named
 * grouping inside it ("Recommended for you"). A matching phrase anywhere
 * else — body copy ("a plan based on your goals"), a menu link ("Recently
 * viewed") — is recorded as a `mention` and does NOT exclude the section: a
 * false exclusion silently removes a whole section from the audit.
 */
function personalizationEvidence(
  section: AriaElement,
  descendants: AriaElement[],
): { phrase: string | null; where: string; mention: string | null } {
  for (const el of [section, ...descendants]) {
    if (el !== section && !TITLE_ROLES.has(el.role)) continue;
    const match = PERSONALIZED_TEXT.exec(el.name);
    if (match) return { phrase: match[0], where: `${el === section ? 'its own name' : `${el.role} ${el.ref}`}`, mention: null };
  }
  for (const el of [section, ...descendants]) {
    const match = PERSONALIZED_TEXT.exec(el.line);
    if (match) {
      return {
        phrase: null,
        where: '',
        mention: `"${match[0]}" appears only in ${el.role} ${el.ref} — body copy or a control label, not a section title, so the section is NOT treated as personalized`,
      };
    }
  }
  return { phrase: null, where: '', mention: null };
}

function isLinkOrCard(el: AriaElement): boolean {
  return el.role === 'link' || el.line.includes(POINTER);
}

/**
 * The repeating unit's role pattern: the unit's own role when it is the link
 * or clickable card, else `unit>inner` for the first link/card inside it
 * (`listitem>link`, `generic>generic[cursor=pointer]`). Units without any
 * link or card are not listing items. Names and text are deliberately left
 * out — every item of a listing has different content.
 */
function itemPattern(unit: AriaElement, children: Map<string, AriaElement[]>): string | null {
  const own = (e: AriaElement) => (e.role !== 'link' && e.line.includes(POINTER) ? `${e.role}[cursor=pointer]` : e.role);
  if (isLinkOrCard(unit)) return own(unit);
  const inner = firstDescendant(unit, children, isLinkOrCard);
  return inner ? `${unit.role}>${own(inner)}` : null;
}

/**
 * A listing is at least 12 SIBLING units under one container sharing one role
 * pattern, each a link or clickable card. Siblings, not any 12 links in the
 * section: a footer's 31 links spread over four link columns is navigation,
 * not a result grid, and a false "listing" would sample it instead of
 * auditing it. A grid split into rows of fewer than 12 is missed — that errs
 * toward full enumeration, which is the safe direction.
 */
function listingEvidence(section: AriaElement, descendants: AriaElement[], children: Map<string, AriaElement[]>): string | null {
  for (const container of [section, ...descendants]) {
    const units = children.get(container.ref) ?? [];
    if (units.length < LISTING_MIN_ITEMS) continue;
    const counts = new Map<string, number>();
    for (const unit of units) {
      const pattern = itemPattern(unit, children);
      if (pattern) counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
    }
    for (const [pattern, count] of counts) {
      if (count >= LISTING_MIN_ITEMS) return `${count} × ${pattern} under ${container.ref}`;
    }
  }
  return null;
}
