import type { GlobalComponentGroup, MarkerColor, MarkerGroup, NeedsReviewCard, PageAuditFrame, PublishPlan, RootCauseCard, SummaryTile } from './publish-plan.ts';
import { cardStatusColor, colorForMarkerStatus, statusTitleCase } from './publish-plan.ts';
import { remapMarkerY, type TileCompositePlan } from './page-composite-plan.ts';
import type { ProjectFile } from '../output/run-store.ts';

/**
 * C3's Figma OPERATION plan — the mechanical replacement for `docs/FIGMA-PUBLISH-RUNBOOK.md`'s
 * Step 3 prose. Every rule that previously lived only as a sentence a live session had to
 * remember ("set clipsContent=false right after combineAsVariants", "clamp a marker whose real Y
 * is 0-15px from the top", "the Legend's numbered list sits directly under it, never after the
 * Footer") is now a literal field on a typed operation object, computed once, tested, and
 * incapable of being forgotten on the next page.
 *
 * This module does NOT talk to Figma — `buildFigmaOperationPlan` is pure and deterministic over
 * `PublishPlan` + the per-page `TileCompositePlan`s, exactly like `publish-plan.ts` itself. A
 * live, Figma-MCP-authenticated session is still what actually calls `create_new_file`/
 * `use_figma`/`upload_assets` per op (Figma's own node ids don't exist before creation — that
 * part cannot be precomputed) — but it now REPLAYS this list in order instead of applying
 * judgment to 70 lines of prose. See `docs/FIGMA-PUBLISH-RUNBOOK.md` for the replay procedure and
 * `publish-verify.ts` for the matching, equally codified verification checks.
 *
 * One deliberate exception to "fully precomputed": the internal Component Library's final layout
 * (Decision Log #37). `CreateMarkerComponentSet`'s `masterX`/`masterY` and `StageComponentLibrary`'s
 * `widthPx`/`heightPx` are INITIAL values only, estimated from text content before any real Figma
 * node exists — they cannot be the final source of truth, because Figma Sections auto-manage
 * membership by geometry and can silently eject an overflowing/mispositioned master back out as a
 * top-level sibling (reported live on the Survey file: Marker 01/07). `FinalizeComponentLibraryLayout`
 * is the required live measure → re-pack → resize → re-verify pass this module cannot precompute —
 * see that op's own doc comment for the exact procedure, and `publish-verify.ts`'s
 * `checkMasterParentedInLibrarySection`/`checkNoMasterOverlap`/`checkLibrarySectionContainsAllMasters`
 * for what actually gates a publish on it having been done correctly.
 */

/** A marker's real, page-scroll-space Y sits inside a band no tile ever captured. Never guessed, never placed — the marker is dropped and the gap is named here instead of silently disappearing. */
export interface MarkerCoverageGap {
  pageId: string;
  findingId: string;
  number: number;
  reason: string;
}

/** The approved reference file's (market-entry-real-1) Overview tile color: bad=RED, good=GREEN, caution=AMBER, neutral count=BLACK. Never a raw table — every tile is a colored stat card. */
export type TileColor = 'RED' | 'GREEN' | 'AMBER' | 'GRAY' | 'BLACK';

/** A marker master's Hover-variant content — verbatim, the same fields `PageAuditFrame.markerGroups[]` already carries, never invented or reworded. Named so `estimateMasterCardHeightPx`/`layoutComponentLibrary` can size a card from exactly what `CreateMarkerComponentSet` is about to build. */
export interface MasterHoverCardContent {
  shortName: string;
  status: string;
  severityText: string;
  explanation: string;
  bullets: string[];
  dsLine: string;
  findingLabel: string;
}

export type FigmaOp =
  | { op: 'EnsureFile'; mode: 'create' | 'mutate'; figmaFileKey: string | null; figmaTeamPlanKey: string | null; fileName: string }
  | { op: 'EnsurePage'; pageName: string }
  | { op: 'CreateSummaryTiles'; pageName: string; tiles: Array<SummaryTile & { color: TileColor }> }
  /** The reference file's stacked root-cause card format (category + occurrence pills, explanation, affected-types/expected footer) — never the flat `pages['02 Global Issues']` table rows. */
  | { op: 'CreateRootCauseCards'; pageName: string; cards: RootCauseCard[] }
  /** One evidence card per markerGroups entry, same numbering as the Page Audit markers — screenshot thumbnail, status/severity/confidence/rule/section pills, actual→expected, recommendation, finding id. Never a wide raw table. `cardColor` is the reference file's 2-tone card scheme (RED=Incorrect, AMBER=everything else) — deliberately distinct from `color` (the 4-tone marker scheme used on the Page Audit page) so a live session never has to re-derive it. */
  | { op: 'CreateComponentFindingCards'; pageName: string; pageId: string; cards: Array<MarkerGroup & { cardColor: 'RED' | 'AMBER' }> }
  /** Curated, diversity-sampled review cards — evidence thumbnail, status pill, confidence, reason, possible DS matches. Never a dump of every raw row. */
  | { op: 'CreateNeedsReviewCards'; pageName: string; cards: NeedsReviewCard[]; shown: number; total: number }
  | { op: 'CreateGlobalComponentCards'; groups: GlobalComponentGroup[] }
  | { op: 'CreatePageAuditFrame'; pageId: string; title: string; widthPx: number; heightPx: number; clipsContent: false }
  /** `sourceCropY`/`sourceCropHeight` come straight from the tested `TileCompositePlan.blocks[]` — for every block past index 0, `sourceCropY === headerHeightPx`, so a raw uncropped tile (which would repeat the sticky header, or in the worst case get discarded as "no new content" and leave a visible gap) can never be emitted by construction. */
  | { op: 'UploadTileBlock'; pageId: string; tileIndex: number; tilePath: string; sourceCropY: number; sourceCropHeight: number; destX: 0; destY: number; widthPx: number }
  | {
      op: 'CreateMarkerComponentSet';
      pageId: string;
      findingId: string;
      number: number;
      color: MarkerColor;
      /** Literal, not a step to remember — `set.clipsContent = false` immediately after `combineAsVariants` (the bug that truncated every hover card to the marker circle's own height). */
      clipsContent: false;
      /**
       * MUST be `true` — literal, not a step to remember. Decision Log #34 (superseding #32's
       * `visible: false` guidance below, which was WRONG): Figma's Presentation/Prototype-mode
       * `CHANGE_TO` hover-swap silently no-ops when the destination variant's component SET is
       * `visible: false`, even though the reaction data itself (trigger, navigation,
       * destinationId) is completely valid and round-trips fine through the Plugin API — hidden
       * nodes are excluded from prototype navigation by Figma itself, not by anything this
       * pipeline does. This was diagnosed by live A/B comparison: `market-entry-real-1` (hover
       * works) has every marker COMPONENT_SET `visible: true`; `brand-perception-survey-page`,
       * `survey-page-audit`, and an initial `report-store-page` build (hover broken in all three)
       * had every marker COMPONENT_SET `visible: false`, with otherwise-identical, well-formed
       * `ON_HOVER`/`CHANGE_TO` reaction data. Isolation now relies ONLY on position (staged far to
       * the right of the Legend by `StageComponentLibrary`, itself also now `visible: true` for
       * the same reason) — never on hiding, which breaks the interaction this whole system exists
       * to provide. See `publish-verify.ts`'s `checkMarkerHoverIntegrity` for the live-node check
       * that now guards this regression.
       */
      visible: true;
      /**
       * An INITIAL placement hint only — in the SAME coordinate space as `StageComponentLibrary`'s
       * `(x, y)` — computed by `layoutComponentLibrary` from every master's ESTIMATED card height on
       * this page. Decision Log #37 (supersedes #36's framing below): a live session MUST NOT stop
       * after placing a master at `(masterX, masterY)` and treat that as done — it must immediately
       * `appendChild` this master into the `StageComponentLibrary` Section (never leave it a
       * top-level sibling), and this page's `FinalizeComponentLibraryLayout` op — which runs only
       * after every master on the page has been created and parented — is what actually repositions
       * every master using its REAL rendered bounds and is the true source of truth for final layout.
       * `masterX`/`masterY` exist only so the master has SOME reasonable position before that pass
       * runs; never report a publish as correct because these two numbers looked right in
       * `figma-ops.json` — only `FinalizeComponentLibraryLayout` plus `publish-verify.ts`'s live
       * containment checks establish that.
       *
       * Decision Log #36 (real bug, incomplete fix): computing this from estimated text height alone
       * closed the "flat guessed gap" bug but not the deeper one — Figma Sections auto-manage
       * membership by geometry and can silently eject an overflowing/mispositioned member as a
       * visible top-level sibling (first documented in `StageComponentLibrary`'s regression history
       * below), which an estimate-only placement cannot reliably prevent. Reported live on the Survey
       * file: Marker 01 and Marker 07 ejected as top-level siblings despite a plausible-looking
       * estimated position.
       */
      masterX: number;
      masterY: number;
      hoverCard: MasterHoverCardContent;
      placement: 'left' | 'right' | 'below';
    }
  /** `y` is already `clampMarkerY`-clamped — a marker 0-15px from the top can no longer sit partially above the frame edge, because the value placed here was never negative to begin with. */
  | { op: 'PlaceMarkerInstance'; pageId: string; findingId: string; x: number; y: number }
  | { op: 'WireHoverReaction'; pageId: string; findingId: string }
  /**
   * Staged to the RIGHT of the Legend (`x >= legend.x + legend.widthPx + LIBRARY_GAP_PX`, always
   * `y: 0`) — NOT below the frame. Earlier versions staged this `y: totalHeightPx + 5000` (still
   * technically "far away", but on the SAME vertical axis a reader scrolls down to read the
   * report) — that read as a duplicate numbered findings list appearing after the Footer the
   * first time a real multi-page-tall report was actually scrolled (caught on
   * brand-perception-survey-page). Horizontal staging fixed that.
   *
   * MUST be `visible: true` — literal, not a step to remember. A later iteration (Decision Log
   * #32) additionally hid this Section (and every `CreateMarkerComponentSet` master inside it),
   * reasoning that hiding was a safe no-op for hover prototyping. That reasoning was WRONG and is
   * now Decision Log #34: hiding the Section (or any marker master) makes Figma's
   * Presentation/Prototype-mode `CHANGE_TO` hover-swap silently fail on every marker in the file —
   * confirmed by live A/B diagnosis against `market-entry-real-1` (masters `visible: true`, hover
   * works) vs. `brand-perception-survey-page`/`survey-page-audit` (masters `visible: false`, hover
   * broken on every marker despite otherwise-correct reaction data). Isolation from the report now
   * relies ONLY on horizontal position, never on hiding. `sectionLabel` is the internal-library
   * marker Figma Section this should be wrapped in — purely for Layers-panel legibility; it stays
   * visible on the canvas (far right of the Legend) but is never seen by a reader scrolling the
   * report vertically, which is the only isolation this pipeline needs or should rely on.
   *
   * `widthPx`/`heightPx` are an INITIAL size ONLY (estimated from `layoutComponentLibrary`) — enough
   * to create a real, non-degenerate Section before any master exists. They are NOT the Section's
   * final size: this page's `FinalizeComponentLibraryLayout` op resizes it afterward from every
   * master's REAL rendered bounds. Never skip that resize because these two numbers looked
   * reasonable.
   *
   * Decision Log #37 — THIS OP RUNS FIRST, before any `CreateMarkerComponentSet` op for the page:
   * create the empty Section here, then `appendChild` every subsequent master into it AS IT IS
   * CREATED. Do not create masters first and wrap them in a Section afterward — that ordering is
   * exactly what produced the reported live bug (Marker 01/07 on the Survey file ejected as
   * top-level siblings): Figma Sections auto-manage membership by geometry, and a Section built
   * around already-existing, already-positioned nodes (rather than one children are explicitly
   * `appendChild`-ed into from the start) is what silently drops an overflowing/mispositioned member
   * back out to the top level. `sectionLabel` is the internal-library marker Figma Section this
   * should be wrapped in — purely for Layers-panel legibility.
   */
  | { op: 'StageComponentLibrary'; pageId: string; x: number; y: 0; sectionLabel: string; visible: true; widthPx: number; heightPx: number }
  /**
   * Decision Log #37 — the actual source of truth for final component-library layout, and the
   * direct fix for masters visually escaping the Section on live files (Survey: Marker 01/07).
   * Runs ONCE per page, AFTER every `CreateMarkerComponentSet` for that page has been created AND
   * `appendChild`-ed into the `StageComponentLibrary` Section from the SAME page — never before, and
   * never skipped in favor of trusting `masterX`/`masterY`/`widthPx`/`heightPx` alone. A live session
   * must, in order:
   *   1. Read every master currently parented under this page's Section and confirm
   *      `master.parent === section` for each — if any is NOT (Figma ejected it as a top-level
   *      sibling), reparent it back with `appendChild` before continuing.
   *   2. Read each master's REAL rendered bounds (`width`/`height` as Figma actually computed them —
   *      never the pre-publish estimate).
   *   3. Re-pack every master into a single column using those REAL heights, `gapPx` between
   *      successive masters and `paddingPx` around the stack — the SAME algorithm
   *      `layoutComponentLibrary` used for the initial estimate, just fed real numbers instead of
   *      estimated ones — and move each master to its new, final position.
   *   4. Resize the Section to the union of every master's final real bounds, plus `paddingPx` on
   *      every side — never a size decided in advance.
   *   5. Re-check `master.parent === section` for every master ONE more time after the resize/move
   *      (a resize is itself a potential re-trigger of Figma's geometry-based membership rules) —
   *      this final state is what `publish-verify.ts`'s `checkMasterParentedInLibrarySection`/
   *      `checkNoMasterOverlap`/`checkLibrarySectionContainsAllMasters` actually verify against.
   * `paddingPx`/`gapPx` are handed through from the SAME constants the initial estimate used
   * (`LIBRARY_SIDE_PADDING_PX`/`MASTER_CARD_GAP_PX`) purely so the final look stays visually
   * consistent with the initial one — they are not load-bearing for correctness the way steps 1-5
   * above are.
   */
  | { op: 'FinalizeComponentLibraryLayout'; pageId: string; afterAllMastersCreatedAndParented: true; paddingPx: number; gapPx: number }
  /**
   * The compact numbered list is `lines`, part of THIS SAME op — structurally impossible to
   * place after the Footer or as a detached panel, because there is no separate "list" op to
   * misplace. `widthPx` is fixed and shared with `StageComponentLibrary`'s x computation so the
   * two never overlap. `colorKeyLine` is the exact "Red = Incorrect · Orange = Deviation · ..."
   * subtitle text (from `legendColorKeyLine()`) — a live session must use it verbatim, never
   * retype the color key from memory (that's exactly the "reusable code, not prompt memory" gap
   * this field closes).
   *
   * Each `lines[]` entry is TWO generated strings, not one (Decision Log #33, "richer Market
   * Entry treatment"): `primary` (`group.legendTitle`, a short issue name + status — build as ONE
   * text node colored by `color`, the SAME symbolic RED/ORANGE/AMBER/GRAY every other op already
   * uses, mapped to the Legend-text hex palette documented in the runbook — deliberately distinct
   * from the marker-circle hex palette) and `secondary` (`group.legendSecondary`, a neutral,
   * concise detail line — build as a second text node, always gray, regardless of `color`). Never
   * collapse these back into one flat string, and never substitute either for the finding's raw
   * `shortName`/`explanation`/`bullets` — those stay exactly as before, unrelated fields still
   * used by the Hover card and Component Finding cards.
   *
   * `captureNote` is generated (`legendCaptureNote`), never hand-typed, and is `null` whenever
   * nothing was actually truncated — render its small bordered card ONLY when non-null ("retain
   * the capture note only when relevant").
   */
  | {
      op: 'CreateLegendPanel';
      pageId: string;
      x: number;
      y: number;
      widthPx: number;
      title: string;
      colorKeyLine: string;
      lines: Array<{ primary: string; secondary: string; findingId: string; color: MarkerColor }>;
      captureNote: string | null;
    };

export interface FigmaOperationPlan {
  contractVersion: string;
  runId: string;
  targetUrl: string;
  ops: FigmaOp[];
  /** Markers whose real element sits inside a header band no tile ever captured — reported, never silently dropped (runbook Step 3.3). */
  coverageGaps: MarkerCoverageGap[];
  /** Page ids present in `plan.pageAudits` with no entry in `compositePlans` — that page's audit frame/tiles/markers are skipped entirely rather than faked; regenerate its composite plan (e.g. `pnpm figma-plan <runId>`) before publishing. */
  missingCompositePlanFor: string[];
}

const LEGEND_X_GAP_PX = 50;
const LEGEND_WIDTH_PX = 420;
const LIBRARY_GAP_PX = 200;

// Component-library master layout (fixes inconsistent spacing/overlap/escape reported across
// Market Entry, Brand Perception, Survey, Report Store, and Industry Report): every master is
// packed into a single column, one page at a time, stacked top to bottom by its own estimated
// card height plus this fixed safety gap — never a flat guessed constant applied to every master
// regardless of its actual (variable-length) hover-card content.
const MASTER_CARD_WIDTH_PX = 300; // matches the on-page hover card width (publish-plan.ts's cardWidthPx default)
const MASTER_CARD_TOP_BOTTOM_PADDING_PX = 32;
const MASTER_CARD_LINE_HEIGHT_PX = 18;
const MASTER_CARD_CHARS_PER_LINE = 38; // deliberately conservative (undercounts chars/line) so a wrapped line count leans tall, never short
const MASTER_CARD_GAP_PX = 60; // safety gap between successive masters, beyond each one's own estimated height
const LIBRARY_SIDE_PADDING_PX = 40; // margin around the packed stack so the wrapping Section's own bounds never clip a master at its edge

function estimateTextLines(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / MASTER_CARD_CHARS_PER_LINE));
}

/**
 * A conservative, deterministic ESTIMATE of a marker master's Hover-variant rendered height from
 * its actual (variable-length) text content — never a live Figma measurement, because none exists
 * yet at plan-build time (the node isn't created until a live session replays this op). Biased tall
 * on purpose: undercounting chars-per-line inflates the line count, so this only ever wastes a
 * little vertical space in a hidden staging area — the failure mode this function exists to
 * prevent is UNDERestimating and causing the next master's card to overlap this one.
 */
export function estimateMasterCardHeightPx(hoverCard: Pick<MasterHoverCardContent, 'shortName' | 'explanation' | 'bullets' | 'dsLine' | 'findingLabel'>): number {
  const lines =
    estimateTextLines(hoverCard.shortName) +
    1 + // status + severity row
    estimateTextLines(hoverCard.explanation) +
    hoverCard.bullets.reduce((sum, bullet) => sum + estimateTextLines(bullet), 0) +
    estimateTextLines(hoverCard.dsLine) +
    estimateTextLines(hoverCard.findingLabel);
  return MASTER_CARD_TOP_BOTTOM_PADDING_PX + lines * MASTER_CARD_LINE_HEIGHT_PX;
}

export interface ComponentLibraryLayout {
  /** Absolute (x, y) per master, keyed by findingId — the SAME coordinate space as `StageComponentLibrary`'s own (x, y). */
  positions: Map<string, { x: number; y: number }>;
  /** The wrapping Section's own bounds — sized to exactly contain every packed master, computed from the SAME pass, never guessed separately. */
  widthPx: number;
  heightPx: number;
}

/**
 * Packs every marker master on one page into a single column starting at `(originX, originY)`, top
 * to bottom, each one's slot sized by `estimateMasterCardHeightPx` plus a fixed safety gap. This is
 * the missing piece that caused the reported bug: previously no op carried a master's own position
 * at all (only the library Section's single shared origin existed), so a live session had to invent
 * per-master spacing itself — producing a different, ad hoc gap on every file instead of one
 * deterministic layout, and occasionally a card tall enough to overlap the next one or escape the
 * Section entirely. `heightPx` reflects the real packed content (plus padding), so the Section this
 * replays into can be sized to fit exactly instead of a fixed guess.
 */
export function layoutComponentLibrary(masters: Array<{ findingId: string; hoverCard: Parameters<typeof estimateMasterCardHeightPx>[0] }>, originX: number, originY: number): ComponentLibraryLayout {
  const positions = new Map<string, { x: number; y: number }>();
  let y = originY + LIBRARY_SIDE_PADDING_PX;
  for (const master of masters) {
    positions.set(master.findingId, { x: originX + LIBRARY_SIDE_PADDING_PX, y });
    y += estimateMasterCardHeightPx(master.hoverCard) + MASTER_CARD_GAP_PX;
  }
  const heightPx = masters.length === 0 ? 0 : y - MASTER_CARD_GAP_PX - originY + LIBRARY_SIDE_PADDING_PX;
  return { positions, widthPx: MASTER_CARD_WIDTH_PX + LIBRARY_SIDE_PADDING_PX * 2, heightPx };
}

/** `Math.max(0, y)` — a marker whose real Y maps to just above the frame (0–15px) is clamped onto it instead of sticking out. Its own function so the rule is asserted directly, not re-derived inline on every call site. */
export function clampMarkerY(y: number): number {
  return Math.max(0, y);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The Legend row's colored primary line — Decision Log #33's "richer Market Entry treatment":
 * `"NN {legendTitle} — {StatusTitleCase}"`. `legendTitle` is already a short, generated issue name
 * (never the raw shortName/productionLabel) — see `MarkerGroup.legendTitle`'s own doc comment.
 */
export function formatLegendPrimaryLine(group: MarkerGroup): string {
  return `${pad2(group.number)} ${group.legendTitle} — ${statusTitleCase(group.status)}`;
}

/** The Legend's color-key subtitle, generated from `colorForMarkerStatus`'s own domain (never hand-typed) — "Red = Incorrect · Orange = Deviation · Amber = Needs Review · Gray = Unverified". */
export function legendColorKeyLine(): string {
  const order: Array<MarkerGroup['status']> = ['INCORRECT', 'DEVIATION', 'NEEDS_REVIEW', 'UNVERIFIED'];
  return order.map((status) => `${statusTitleCase(colorForMarkerStatus(status)!)} = ${statusTitleCase(status)}`).join(' · ');
}

/**
 * The Legend's small "Capture note" card body — generated, never hand-typed, and `null` whenever
 * nothing was actually truncated ("retain the capture note only when relevant"). `shown` is the
 * number of groups actually selected for this page (`page.markerGroups.length`, already capped);
 * `total` is the count BEFORE that cap (`page.markerGroupsTotal`). Kept to one short, concrete
 * sentence — no jargon like "root-cause/unique marker groups" — per "avoid long technical/raw
 * text when a concise explanation is enough".
 */
export function legendCaptureNote(shown: number, total: number): string | null {
  if (shown >= total) return null;
  return `Showing the top ${shown} of ${total} finding groups on this page — see figma-plan.json or the dashboard for the complete set.`;
}

const AMBER_TILE_LABELS = new Set(['Deviation', 'Needs review', 'Unverified', 'Awaiting review', 'Coverage limits']);
const RED_TILE_LABELS = new Set(['Compliance', 'Incorrect']);
const GREEN_TILE_LABELS = new Set(['Match']);
const GRAY_TILE_LABELS = new Set(['DS candidates', 'New components']);

/** The Overview stat tile's color — matches the reference file's own tile-by-tile scheme exactly (Compliance/Incorrect=RED, Match=GREEN, Deviation/Needs review/Unverified/Awaiting review=AMBER, neutral counts=BLACK/GRAY). Label-keyed, not classification-keyed, because tiles are C2's own summary labels, not findings. */
export function summaryTileColor(label: string, value?: string): TileColor {
  // The Coverage Gate's colour is its verdict: green when it passed, red when anything is unaccounted, gray when never recorded.
  if (label === 'Coverage gate') return value === 'PASSED' ? 'GREEN' : value?.startsWith('INCOMPLETE') ? 'RED' : 'GRAY';
  if (RED_TILE_LABELS.has(label)) return 'RED';
  if (GREEN_TILE_LABELS.has(label)) return 'GREEN';
  if (AMBER_TILE_LABELS.has(label)) return 'AMBER';
  if (GRAY_TILE_LABELS.has(label)) return 'GRAY';
  return 'BLACK';
}

function buildHoverCard(group: MarkerGroup): MasterHoverCardContent {
  return {
    shortName: group.shortName,
    status: statusTitleCase(group.status),
    severityText: group.severityText,
    explanation: group.explanation,
    bullets: group.bullets,
    dsLine: group.dsLine,
    findingLabel: `Finding: ${group.findingId}`,
  };
}

function buildPageAuditOps(page: PageAuditFrame, compositePlan: TileCompositePlan | undefined, coverageGaps: MarkerCoverageGap[]): FigmaOp[] {
  if (!compositePlan) return [];
  const ops: FigmaOp[] = [];

  ops.push({ op: 'CreatePageAuditFrame', pageId: page.key, title: page.title, widthPx: compositePlan.tileWidthPx, heightPx: compositePlan.totalHeightPx, clipsContent: false });

  for (const block of compositePlan.blocks) {
    ops.push({
      op: 'UploadTileBlock',
      pageId: page.key,
      tileIndex: block.tileIndex,
      tilePath: `screenshots/${page.key}/page-tile-${block.tileIndex}.png`,
      sourceCropY: block.sourceCropY,
      sourceCropHeight: block.sourceCropHeight,
      destX: 0,
      destY: block.destY,
      widthPx: compositePlan.tileWidthPx,
    });
  }

  const legendX = compositePlan.tileWidthPx + LEGEND_X_GAP_PX;
  const libraryX = legendX + LEGEND_WIDTH_PX + LIBRARY_GAP_PX;
  // Only groups that will actually get a master placed (i.e. not dropped as a coverage gap below)
  // are laid out — computed up front so every CreateMarkerComponentSet op already knows its own
  // INITIAL (masterX, masterY) instead of a live session having to invent spacing per master.
  const publishableGroups = page.markerGroups.filter(
    (group) => remapMarkerY(group.box.y, compositePlan.tileHeightPx, compositePlan.headerHeightPx, compositePlan.blocks.length) !== null,
  );
  const libraryLayout = layoutComponentLibrary(
    publishableGroups.map((group) => ({ findingId: group.findingId, hoverCard: buildHoverCard(group) })),
    libraryX,
    0,
  );

  // Decision Log #37: the Section is created FIRST, before any master — every CreateMarkerComponentSet
  // op below is appended into this ALREADY-EXISTING Section, never wrapped in one after the fact.
  ops.push({
    op: 'StageComponentLibrary',
    pageId: page.key,
    x: libraryX,
    y: 0,
    sectionLabel: 'Component library (internal — not report content)',
    visible: true,
    widthPx: libraryLayout.widthPx,
    heightPx: libraryLayout.heightPx,
  });

  const legendLines: Array<{ primary: string; secondary: string; findingId: string; color: MarkerColor }> = [];
  for (const group of page.markerGroups) {
    const compositeY = remapMarkerY(group.box.y, compositePlan.tileHeightPx, compositePlan.headerHeightPx, compositePlan.blocks.length);
    if (compositeY === null) {
      const pastLastTile = Math.floor(group.box.y / compositePlan.tileHeightPx) >= compositePlan.blocks.length;
      const reason = pastLastTile
        ? 'real element Y falls past the last tile B1 ever captured — the page\'s real scrollHeight exceeded what was tiled, no tile ever captured it'
        : 'real element Y falls inside a cropped, unrecoverable header band — no tile ever captured it';
      coverageGaps.push({ pageId: page.key, findingId: group.findingId, number: group.number, reason });
      continue; // never placed, never faked — matches remapMarkerY's own contract
    }

    const masterPos = libraryLayout.positions.get(group.findingId)!;
    ops.push({
      op: 'CreateMarkerComponentSet',
      pageId: page.key,
      findingId: group.findingId,
      number: group.number,
      color: group.color,
      clipsContent: false,
      visible: true,
      masterX: masterPos.x,
      masterY: masterPos.y,
      hoverCard: buildHoverCard(group),
      placement: group.placement,
    });
    ops.push({ op: 'PlaceMarkerInstance', pageId: page.key, findingId: group.findingId, x: group.box.x, y: clampMarkerY(compositeY) });
    ops.push({ op: 'WireHoverReaction', pageId: page.key, findingId: group.findingId });

    legendLines.push({ primary: formatLegendPrimaryLine(group), secondary: group.legendSecondary, findingId: group.findingId, color: group.color });
  }

  // Decision Log #37: runs once, after every master above has been created AND parented — the real
  // measure/re-pack/resize/re-verify pass, never replaced by trusting the estimates above alone.
  ops.push({ op: 'FinalizeComponentLibraryLayout', pageId: page.key, afterAllMastersCreatedAndParented: true, paddingPx: LIBRARY_SIDE_PADDING_PX, gapPx: MASTER_CARD_GAP_PX });

  ops.push({
    op: 'CreateLegendPanel',
    pageId: page.key,
    x: legendX,
    y: 0,
    widthPx: LEGEND_WIDTH_PX,
    colorKeyLine: legendColorKeyLine(),
    title: page.title,
    lines: legendLines,
    captureNote: legendCaptureNote(page.markerGroups.length, page.markerGroupsTotal),
  });

  return ops;
}

/**
 * The complete, ordered Figma write — six pages (Overview, Page Audits, Root Causes, Component
 * Findings, Needs Review, Global Components), all content sourced from `plan` alone (never
 * recomputed). A live session replays this array 1:1, calling the matching real MCP tool per op.
 */
export function buildFigmaOperationPlan(
  plan: PublishPlan,
  compositePlans: Record<string, TileCompositePlan>,
  project: Pick<ProjectFile, 'figmaFileKey' | 'figmaFileUrl' | 'figmaTeamPlanKey'>,
  opts: { displayName?: string | undefined } = {},
): FigmaOperationPlan {
  const ops: FigmaOp[] = [];
  const coverageGaps: MarkerCoverageGap[] = [];
  const missingCompositePlanFor = plan.pageAudits.filter((p) => !compositePlans[p.key]).map((p) => p.key);

  ops.push({
    op: 'EnsureFile',
    mode: project.figmaFileKey ? 'mutate' : 'create',
    figmaFileKey: project.figmaFileKey,
    figmaTeamPlanKey: project.figmaTeamPlanKey,
    // The run's DISPLAY name, preserved verbatim — never plan.runId (a slug). Falls back to the
    // old "<url> · <runId>" form only when no display name was supplied (e.g. a very old run
    // published before run.json existed).
    fileName: opts.displayName ?? `${plan.targetUrl} · ${plan.runId}`,
  });

  ops.push({ op: 'EnsurePage', pageName: '00 Overview' });
  ops.push({ op: 'CreateSummaryTiles', pageName: '00 Overview', tiles: plan.pages['00 Overview'].tiles.map((t) => ({ ...t, color: summaryTileColor(t.label, t.value) })) });

  ops.push({ op: 'EnsurePage', pageName: '01 Page Audit' });
  for (const page of plan.pageAudits) {
    ops.push(...buildPageAuditOps(page, compositePlans[page.key], coverageGaps));
  }

  ops.push({ op: 'EnsurePage', pageName: '02 Root Causes' });
  ops.push({ op: 'CreateRootCauseCards', pageName: '02 Root Causes', cards: plan.rootCauseCards });

  ops.push({ op: 'EnsurePage', pageName: '03 Component Findings' });
  for (const page of plan.pageAudits) {
    ops.push({ op: 'CreateComponentFindingCards', pageName: '03 Component Findings', pageId: page.key, cards: page.markerGroups.map((g) => ({ ...g, cardColor: cardStatusColor(g.status) })) });
  }

  ops.push({ op: 'EnsurePage', pageName: '04 Needs Review' });
  ops.push({ op: 'CreateNeedsReviewCards', pageName: '04 Needs Review', cards: plan.needsReviewCards.cards, shown: plan.needsReviewCards.cards.length, total: plan.needsReviewCards.total });

  ops.push({ op: 'EnsurePage', pageName: '05 Global Components' });
  ops.push({ op: 'CreateGlobalComponentCards', groups: plan.globalComponents });

  return { contractVersion: plan.contractVersion, runId: plan.runId, targetUrl: plan.targetUrl, ops, coverageGaps, missingCompositePlanFor };
}
