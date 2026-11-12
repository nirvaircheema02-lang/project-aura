import type { Finding } from '../skills/s0-result-contract.ts';

/**
 * REPORT ORDERING RULE — permanent, DISPLAY ONLY, shared by every report surface.
 *
 *   Within one section (or one Global Header / Global Footer sub-group), findings are listed in the order a
 *   reader meets them on the page: top to bottom, and left to right along one visual row.
 *
 * Why it exists: the audit finds elements in passes (headings and paragraphs, then buttons, then cards, then
 * repeated blocks recovered by the verification loop), so `data.json` lists them in DETECTION order. Drawn as is, a
 * numbered list reads 02, 01, 03 … and a card's button appears pages below its own title. The page-absolute box the
 * evidence already carries (`quality.evidence[].box` — what C3 places markers from) is the only input: no new
 * capture, no guess.
 *
 * The order is:
 *  1. ROWS and COLUMNS (recursive XY-cut): elements are split into rows wherever an empty horizontal band of at
 *     least `GAP_PX` runs across them, else into columns wherever an empty vertical band does — so a staircase of
 *     steps (Phase 1 lowest … Phase 4 highest) reads as columns 1 → 4, not by its heights;
 *  2. where neither cut applies, visual ROW (tops within `ROW_TOLERANCE_PX` of the row's first element — a 4px
 *     text-baseline difference must not put the right-hand label before the left-hand one), LEFT to RIGHT;
 *  3. an enclosing element before what it contains (larger area first at the same spot: a card before its title);
 *  4. what an element contains follows it IMMEDIATELY, in the same order — a numbered card's number, its title and
 *     its button stay together with that card (01 …, then 02 …) instead of every card's number being listed
 *     before any card's title;
 *  5. the audit's own order, for everything else.
 * A finding with no measurable box has no known position: it is listed after the positioned ones, in the audit's own order
 * (never guessed into the middle of the page).
 *
 * What it never does: change a finding, its id, its status or its recommendation, or reorder `data.json`. The
 * Fix Plan, the Figma plan, the Excel report and every count read the findings exactly as the audit stored them.
 */
export const ROW_TOLERANCE_PX = 12;
/** A box counts as inside another when it overshoots its edges by no more than this (sub-pixel rounding). */
export const CONTAIN_TOLERANCE_PX = 2;
/** The empty space that separates two rows (or two columns) of elements. */
export const GAP_PX = 16;

interface Placed {
  finding: Finding;
  index: number;
  x: number;
  y: number;
  area: number;
  box: { x: number; y: number; width: number; height: number };
}

/** The box of the element itself: its own element screenshot first, any other evidence box otherwise. */
function boxOf(f: Finding): { x: number; y: number; width: number; height: number } | null {
  const evidence = f.quality.evidence;
  const own = evidence.find((e) => e.kind === 'element-screenshot' && e.box);
  return own?.box ?? evidence.find((e) => e.box)?.box ?? null;
}

/** Plain top-to-bottom, left-to-right order: rows by their first element's top, then left to right, then enclosing before enclosed. */
function bandSort(items: readonly Placed[]): Placed[] {
  const byTop = [...items].sort((a, b) => a.y - b.y || a.index - b.index);
  const rowOf = new Map<Placed, number>();
  let row = -1;
  let rowTop = Number.NaN;
  for (const p of byTop) {
    if (Number.isNaN(rowTop) || p.y - rowTop > ROW_TOLERANCE_PX) {
      row += 1;
      rowTop = p.y;
    }
    rowOf.set(p, row);
  }
  return [...items].sort((a, b) => rowOf.get(a)! - rowOf.get(b)! || a.x - b.x || b.area - a.area || a.index - b.index);
}

/** Splits items into consecutive groups wherever the projection onto one axis has an empty gap of at least GAP_PX. */
function cut(items: readonly Placed[], axis: 'x' | 'y'): Placed[][] | null {
  const lo = (p: Placed) => (axis === 'y' ? p.box.y : p.box.x);
  const hi = (p: Placed) => (axis === 'y' ? p.box.y + p.box.height : p.box.x + p.box.width);
  const sorted = [...items].sort((a, b) => lo(a) - lo(b) || a.index - b.index);
  const groups: Placed[][] = [[sorted[0]!]];
  let reach = hi(sorted[0]!);
  for (const p of sorted.slice(1)) {
    if (lo(p) - reach >= GAP_PX) groups.push([p]);
    else groups[groups.length - 1]!.push(p);
    reach = Math.max(reach, hi(p));
  }
  return groups.length > 1 ? groups : null;
}

/**
 * Sibling order by recursive XY-cut: split into rows wherever a full-width horizontal gap separates the elements,
 * else into columns wherever a full-height vertical gap does, and recurse. A staircase (Phase 1 lowest … Phase 4
 * highest) therefore reads as four columns, 1 → 4, instead of being sorted by its heights.
 */
function orderSiblings(items: readonly Placed[]): Placed[] {
  if (items.length <= 1) return [...items];
  const rows = cut(items, 'y');
  if (rows) return rows.flatMap(orderSiblings);
  const columns = cut(items, 'x');
  if (columns) return columns.flatMap(orderSiblings);
  return bandSort(items);
}

export function inReadingOrder(findings: readonly Finding[]): Finding[] {
  const placed: Placed[] = [];
  const unplaced: Finding[] = [];
  findings.forEach((finding, index) => {
    const box = boxOf(finding);
    if (box) placed.push({ finding, index, x: box.x, y: box.y, area: box.width * box.height, box });
    else unplaced.push(finding);
  });

  // Containment: each element hangs under the SMALLEST larger box that encloses it.
  const flat = bandSort(placed);
  const contains = (outer: Placed['box'], inner: Placed['box']) =>
    inner.x >= outer.x - CONTAIN_TOLERANCE_PX &&
    inner.y >= outer.y - CONTAIN_TOLERANCE_PX &&
    inner.x + inner.width <= outer.x + outer.width + CONTAIN_TOLERANCE_PX &&
    inner.y + inner.height <= outer.y + outer.height + CONTAIN_TOLERANCE_PX;
  const children = new Map<Placed, Placed[]>();
  const roots: Placed[] = [];
  flat.forEach((p, i) => {
    let parent: Placed | null = null;
    for (let j = 0; j < i; j += 1) {
      const outer = flat[j]!;
      if (outer.area <= p.area || !contains(outer.box, p.box)) continue;
      if (!parent || outer.area <= parent.area) parent = outer;
    }
    if (parent) children.set(parent, [...(children.get(parent) ?? []), p]);
    else roots.push(p);
  });

  const out: Finding[] = [];
  const walk = (p: Placed): void => {
    out.push(p.finding);
    for (const child of orderSiblings(children.get(p) ?? [])) walk(child);
  };
  orderSiblings(roots).forEach(walk);
  return [...out, ...unplaced];
}
