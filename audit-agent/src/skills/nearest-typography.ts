/**
 * Nearest typography match — the audit's permanent rule for WHICH Design System
 * size a rendered typographic value is compared against.
 *
 * A heading's DS size is a VISUAL decision, not a semantic one. An `<h2>` that
 * renders at 32px is not "level 2" (39.06px) because of its tag: the DS offers
 * 31.25px and 39.06px, 31.25px is 0.75px away and 39.06px is 7.06px away, so
 * 31.25px is the size it is audited against and recommended to take. The tag
 * stays what it is — a recommendation never asks to change the HTML level just
 * to adopt a nearer visual size.
 *
 * The rule, for a numeric scale property (font-size):
 *  1. read the actual rendered value, in px;
 *  2. normalise every valid DS size of the relevant component/family to px at the
 *     viewport the element was captured at (`px` as is, `rem` × the page's root
 *     font size, `em` × the element's own size — `lengthToPx`, the same
 *     conversion the comparator uses, so a candidate here is exactly the value
 *     the comparison later checks);
 *  3. the candidate with the smallest absolute px distance wins — always, not
 *     "first";
 *  4. only candidates EQUALLY close (within rounding noise) are ever separated by
 *     anything else, in this order: contextual/component evidence (how many of
 *     the candidate's other governed properties the element already fits) → visual
 *     hierarchy (the candidate that keeps the element's rank among the page's
 *     headings) → semantic heading level (closest to the element's own tag) →
 *     the larger size (never demote an element on a coin-flip).
 *
 * Pure: no I/O, no DS knowledge — B3 (heading level), B4 (tied variants) and the
 * R1.3 type-scale check all call it with their own candidates.
 */

/** Two candidates whose distances from the rendered size differ by less than this are equally close — rounding noise, not a real difference. */
export const NEAREST_TIE_EPSILON_PX = 0.01;

/** One valid DS size the rendered value could be compared against. */
export interface SizeCandidate<T = unknown> {
  /** Stable identity within the candidate set (`h3`, `lg`). */
  id: string;
  /** The candidate's size normalised to px at the viewport the element was captured at. */
  sizePx: number;
  /** Share (0..1) of the candidate's OTHER governed properties the element already fits; null when none could be compared. */
  context?: number | null;
  /** The semantic heading level the DS binds this candidate to, when it binds one (SectionHeading level 3 renders an `<h3>`). */
  semanticLevel?: number | null;
  payload: T;
}

export interface NearestOptions {
  /** The element's own semantic heading level (1–6) — supporting evidence, used only to break an exact tie. */
  semanticLevel?: number | null;
  /** Rendered sizes (px) of the OTHER headings on the page — the visual hierarchy the choice must not reorder. */
  pageHeadingSizesPx?: ReadonlyArray<number>;
}

export type NearestDecidedBy = 'only-candidate' | 'distance' | 'context' | 'hierarchy' | 'semantic-level' | 'order';

export interface NearestSizeChoice<T> {
  chosen: SizeCandidate<T>;
  actualPx: number;
  /** |actual − chosen|, in px. */
  distancePx: number;
  /** Every candidate with its distance, nearest first. */
  ranked: Array<{ candidate: SizeCandidate<T>; distancePx: number }>;
  /** What settled it: the distance alone, or — only for a genuine tie — the tier that separated the tied candidates. */
  decidedBy: NearestDecidedBy;
  /** The other candidates exactly as close as the chosen one (empty when the distance alone decided). */
  tied: Array<SizeCandidate<T>>;
}

/** Plain-language names for what settled a choice — one wording for every report that quotes it. */
export const DECIDED_BY_TEXT: Record<NearestDecidedBy, string> = {
  'only-candidate': 'the only candidate',
  distance: 'the nearest size',
  context: 'how many of its other typography properties the element already fits',
  hierarchy: "keeping the element's rank among the page's headings",
  'semantic-level': "the element's own heading level",
  order: 'the larger size',
};

/** `31.248` → `31.25px`, `32` → `32px`: at most two decimals, trailing zeros dropped. */
export function formatPx(px: number): string {
  return `${Math.round(px * 100) / 100}px`;
}

/** Sizes within half a pixel are the same visual size for ranking purposes (the comparator's own jitter tolerance). */
const bucket = (px: number) => Math.round(px * 2) / 2;

/** How many DISTINCT page heading sizes are visibly larger than `px` — the element's rank in the page's visual hierarchy (0 = the largest). */
function hierarchyRank(px: number, pageSizesPx: ReadonlyArray<number>): number {
  const here = bucket(px);
  return new Set(pageSizesPx.map(bucket).filter((s) => s > here)).size;
}

export function pickNearestSize<T>(actualPx: number, candidates: ReadonlyArray<SizeCandidate<T>>, opts: NearestOptions = {}): NearestSizeChoice<T> | null {
  if (!Number.isFinite(actualPx) || actualPx <= 0) return null;
  const measured = candidates
    .map((candidate, order) => ({ candidate, order, distancePx: Math.abs(candidate.sizePx - actualPx) }))
    .filter((r) => Number.isFinite(r.distancePx))
    .sort((a, b) => a.distancePx - b.distancePx || b.candidate.sizePx - a.candidate.sizePx || a.order - b.order);
  const first = measured[0];
  if (!first) return null;
  const ranked = measured.map((r) => ({ candidate: r.candidate, distancePx: r.distancePx }));
  const done = (pool: typeof measured, decidedBy: NearestDecidedBy, tied: typeof measured): NearestSizeChoice<T> => {
    const chosen = pool[0] ?? first;
    return { chosen: chosen.candidate, actualPx, distancePx: chosen.distancePx, ranked, decidedBy, tied: tied.filter((r) => r !== chosen).map((r) => r.candidate) };
  };

  let pool = measured.filter((r) => r.distancePx - first.distancePx < NEAREST_TIE_EPSILON_PX);
  if (pool.length === 1) return done(pool, measured.length === 1 ? 'only-candidate' : 'distance', []);

  // A genuine tie. Separate the tied candidates by evidence, strongest first; a tier that cannot
  // tell them apart (no evidence, or the same evidence) passes the whole pool on to the next.
  const tied = pool;
  const tiers: Array<[NearestDecidedBy, (r: (typeof measured)[number]) => number | null]> = [
    // Contextual/component evidence: the candidate whose other governed properties the element already fits.
    ['context', (r) => (r.candidate.context === undefined || r.candidate.context === null ? null : -r.candidate.context)],
    // Visual hierarchy: the candidate that keeps the element where it already ranks among the page's headings.
    [
      'hierarchy',
      (r) => {
        const sizes = opts.pageHeadingSizesPx;
        return sizes && sizes.length > 0 ? Math.abs(hierarchyRank(r.candidate.sizePx, sizes) - hierarchyRank(actualPx, sizes)) : null;
      },
    ],
    // Semantic heading level — supporting evidence, so only ever a tie-breaker, never the first rule.
    [
      'semantic-level',
      (r) => (opts.semanticLevel != null && r.candidate.semanticLevel != null ? Math.abs(r.candidate.semanticLevel - opts.semanticLevel) : null),
    ],
  ];
  for (const [name, score] of tiers) {
    const scores = pool.map(score);
    if (scores.some((s) => s === null)) continue; // not every tied candidate has this evidence — it cannot separate them
    const best = Math.min(...(scores as number[]));
    const next = pool.filter((_, i) => Math.abs((scores[i] as number) - best) < 1e-9);
    if (next.length === pool.length) continue; // same evidence for all of them
    pool = next;
    if (pool.length === 1) return done(pool, name, tied);
  }
  // Nothing separates them: the larger size (an element is never demoted on a coin-flip), then input order.
  pool = [...pool].sort((a, b) => b.candidate.sizePx - a.candidate.sizePx || a.order - b.order);
  return done(pool, 'order', tied);
}
