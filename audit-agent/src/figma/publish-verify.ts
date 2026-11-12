import type { MarkerGroup, PageAuditFrame } from './publish-plan.ts';

/**
 * C3's Figma VERIFICATION checks — the codified form of `docs/FIGMA-PUBLISH-RUNBOOK.md`'s
 * Step 4, which today is five bullet points of prose a live session has to remember to actually
 * run ("check pixel variance", "check clipsContent", "check bounds", "check marker count", "check
 * Legend position"). Every function here is pure over RECORDED RESULTS — pixel stats, node
 * bounds, id lists — so it needs no live Figma connection to unit-test, and a live session can
 * call it verbatim on what `get_screenshot`/`use_figma` actually returned instead of eyeballing.
 *
 * Never talks to Figma itself — that stays the live session's job (see `publish-ops.ts`).
 */

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** A uniform fill (near-zero standard deviation) is the confirmed `get_screenshot` blank/gray failure mode (IMPLEMENTATION-PLAN.md §6 Spike 1) — never reported as a successful upload. */
export function checkBlankImage(pixels: { mean: number; stdev: number }, opts: { minStdev?: number } = {}): CheckResult {
  const minStdev = opts.minStdev ?? 4;
  const pass = pixels.stdev >= minStdev;
  return {
    name: 'blank-image',
    pass,
    detail: pass ? `stdev ${pixels.stdev.toFixed(2)} — real content, not a uniform fill` : `stdev ${pixels.stdev.toFixed(2)} (mean ${pixels.mean.toFixed(2)}) — looks like a blank/gray render, not real content`,
  };
}

/** The `clipsContent` truncation bug: a Hover variant whose rendered height doesn't reach the full annotation card is clipped to the marker circle's own height. */
export function checkHoverCardNotClipped(renderedHeightPx: number, expectedCardHeightPx: number, opts: { toleranceRatio?: number } = {}): CheckResult {
  const tolerance = opts.toleranceRatio ?? 0.9;
  const pass = renderedHeightPx >= expectedCardHeightPx * tolerance;
  return {
    name: 'hover-card-not-clipped',
    pass,
    detail: pass ? `rendered ${renderedHeightPx}px ≥ expected ${expectedCardHeightPx}px` : `rendered ${renderedHeightPx}px is shorter than the expected ${expectedCardHeightPx}px card — looks clipped to the marker circle (clipsContent bug)`,
  };
}

/** Every top-level child of the page-audit frame and the Legend must stay within the frame's own bounds — "marker sticks out of the frame" is the failure this catches. */
export function checkBounds(node: { label: string; x: number; y: number; width: number; height: number }, frameWidthPx: number): CheckResult {
  const pass = node.x >= 0 && node.y >= 0 && node.x + node.width <= frameWidthPx;
  return {
    name: 'bounds',
    pass,
    detail: pass ? `${node.label} within [0,0]..[${frameWidthPx},∞)` : `${node.label} at (${node.x},${node.y}) size ${node.width}x${node.height} falls outside [0,0]..[${frameWidthPx},∞)`,
  };
}

/** The number of markers actually placed on canvas must equal `markerGroups.length`, with matching finding ids — no invented, dropped, or renumbered markers. */
export function checkMarkerTraceability(placedFindingIds: string[], expected: Pick<MarkerGroup, 'findingId'>[]): CheckResult {
  const placed = new Set(placedFindingIds);
  const wanted = new Set(expected.map((g) => g.findingId));
  const missing = [...wanted].filter((id) => !placed.has(id));
  const extra = [...placed].filter((id) => !wanted.has(id));
  const pass = missing.length === 0 && extra.length === 0;
  return {
    name: 'marker-traceability',
    pass,
    detail: pass ? `all ${wanted.size} marker(s) placed, ids match plan exactly` : `mismatch — missing: [${missing.join(', ') || 'none'}], unexpected: [${extra.join(', ') || 'none'}]`,
  };
}

/**
 * The Legend (and its compact numbered list, which is part of the SAME Figma node per
 * `publish-ops.ts`'s `CreateLegendPanel`) must sit to the right of the page-audit frame, and no
 * stray list content may exist anywhere else — e.g. appended after the Footer inside the main
 * frame, which is the specific regression this check exists for.
 */
export function checkLegendPlacement(legend: { x: number }, frameWidthPx: number, strayListNodes: Array<{ label: string; x: number; y: number }> = []): CheckResult {
  const toTheRight = legend.x >= frameWidthPx;
  const noStrays = strayListNodes.length === 0;
  const pass = toTheRight && noStrays;
  const details: string[] = [];
  details.push(toTheRight ? `Legend.x ${legend.x} ≥ frame width ${frameWidthPx}` : `Legend.x ${legend.x} is INSIDE the frame (width ${frameWidthPx}) — not to the right`);
  if (!noStrays) details.push(`${strayListNodes.length} stray list node(s) found outside the Legend: ${strayListNodes.map((n) => `${n.label}@(${n.x},${n.y})`).join(', ')}`);
  return { name: 'legend-placement', pass, detail: details.join('; ') };
}

/** Never a Match marker — RED/ORANGE/AMBER/GRAY only (Decision Log #32). */
export function checkNoMatchMarkers(placedColors: string[]): CheckResult {
  const allowed = new Set(['RED', 'ORANGE', 'AMBER', 'GRAY']);
  const bad = placedColors.filter((c) => !allowed.has(c));
  const pass = bad.length === 0;
  return { name: 'no-match-markers', pass, detail: pass ? 'every placed marker uses a status-only color' : `disallowed marker color(s) found: ${[...new Set(bad)].join(', ')}` };
}

/**
 * Every internal marker-master/component-library object — the wrapping `StageComponentLibrary`
 * Section AND every individual `CreateMarkerComponentSet` master — MUST be `visible: true`.
 *
 * Decision Log #34 (supersedes and inverts the old `checkComponentLibraryHidden` check, kept only
 * in git history): an earlier iteration hid these objects (`visible: false`) reasoning it was a
 * safe no-op for hover prototyping. That reasoning was wrong. Live A/B diagnosis against
 * `market-entry-real-1` (masters `visible: true`, hover works in Presentation/Prototype mode) vs.
 * `brand-perception-survey-page`/`survey-page-audit` (masters `visible: false`, hover silently
 * broken on every marker despite otherwise well-formed `ON_HOVER`/`CHANGE_TO` reaction data)
 * proved that Figma excludes hidden nodes from prototype navigation — a `CHANGE_TO` reaction
 * pointing into a hidden component set never renders the swap, even though the reaction round-trips
 * fine through the Plugin API and looks correct in `figma-ops.json`. This check now fails the
 * publish if it ever finds a hidden marker master or hidden library Section — the regression this
 * guards against is the exact one just described, in the opposite direction from before.
 */
export function checkComponentLibraryVisible(objects: Array<{ name: string; visible: boolean }>): CheckResult {
  const hiddenOnes = objects.filter((o) => !o.visible);
  const pass = objects.length > 0 && hiddenOnes.length === 0;
  return {
    name: 'component-library-visible',
    pass,
    detail: pass
      ? `all ${objects.length} internal marker-master/component-library object(s) are visible — hover CHANGE_TO can resolve every destination`
      : objects.length === 0
        ? 'no objects were checked — pass the Section and every marker master'
        : `${hiddenOnes.length} object(s) are HIDDEN and will break hover prototyping: ${hiddenOnes.map((o) => o.name).join(', ')} — set .visible = true on each (isolation from the report relies on position, never on hiding)`,
  };
}

/**
 * One marker master's actual, live-queried structural/geometric state — gathered via `use_figma`
 * against the PUBLISHED file, AFTER `FinalizeComponentLibraryLayout` has run. Never inferred from
 * `figma-ops.json`'s initial `masterX`/`masterY` estimate alone (Decision Log #37): those are a
 * pre-publish guess, and Figma Sections auto-manage membership by geometry — a master can render at
 * a plausible-looking position and still have been silently ejected as a top-level sibling, or still
 * overlap a neighbor whose real (not estimated) card turned out taller than expected.
 */
export interface LiveComponentLibraryMaster {
  findingId: string;
  /** `node.parent?.id` as actually read off the live file — the direct structural check a purely geometric "is it inside the bounds" test cannot substitute for. */
  parentId: string | null;
  /** The master's REAL rendered bounds (`node.x`/`node.y`/`node.width`/`node.height` or `absoluteBoundingBox`, in the Section's coordinate space) — never the pre-publish estimate. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Every marker master must be a DIRECT child of the `StageComponentLibrary` Section — never a
 * top-level sibling. Decision Log #37: Figma Sections auto-manage membership by geometry and can
 * silently eject an overflowing/mispositioned member back out to the top level of the page, first
 * documented as a risk in `publish-ops.ts`'s `StageComponentLibrary` regression history and then
 * actually observed live on the Survey file (Marker 01 and Marker 07 both ejected as top-level
 * siblings). A geometric "is it inside the Section's bounds" check cannot catch this on its own — a
 * node can sit visually inside the Section's rectangle and still not actually be its child in the
 * scene graph — so this check reads `parentId` directly instead.
 */
export function checkMasterParentedInLibrarySection(masters: LiveComponentLibraryMaster[], librarySectionId: string): CheckResult {
  const ejected = masters.filter((m) => m.parentId !== librarySectionId);
  const pass = masters.length > 0 && ejected.length === 0;
  return {
    name: 'component-library-parent-containment',
    pass,
    detail: pass
      ? `all ${masters.length} master(s) are direct children of the Component Library Section (${librarySectionId})`
      : masters.length === 0
        ? 'no masters were checked — pass every marker master for this page'
        : `${ejected.length} master(s) are NOT children of the Section (ejected as top-level siblings): ${ejected.map((m) => `${m.findingId} (parent=${m.parentId ?? 'none'})`).join(', ')} — reparent with appendChild and re-run FinalizeComponentLibraryLayout`,
  };
}

/** No two masters' REAL rendered bounds may overlap. Measured live, after `FinalizeComponentLibraryLayout`'s real re-pack — never estimated (an estimate can only ever be checked against another estimate, which is exactly what let the Survey-file overlap/ejection ship unnoticed). */
export function checkNoMasterOverlap(masters: LiveComponentLibraryMaster[]): CheckResult {
  const overlaps: string[] = [];
  for (let i = 0; i < masters.length; i++) {
    for (let j = i + 1; j < masters.length; j++) {
      const a = masters[i]!;
      const b = masters[j]!;
      const overlapsX = a.x < b.x + b.width && b.x < a.x + a.width;
      const overlapsY = a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlapsX && overlapsY) overlaps.push(`${a.findingId} overlaps ${b.findingId}`);
    }
  }
  const pass = overlaps.length === 0;
  return {
    name: 'component-library-no-overlap',
    pass,
    detail: pass ? `all ${masters.length} master(s) occupy distinct, non-overlapping real bounds` : `${overlaps.length} overlap(s) found: ${overlaps.join('; ')}`,
  };
}

/** The Section's own REAL bounds must fully contain every master's REAL bounds. The specific failure this catches: a master rendered above/outside the visible white Component Library area even though `checkMasterParentedInLibrarySection` might separately pass (a node can be a structural child of a Section while Figma still renders it outside the Section's current visual bounds if it was never actually resized to fit). */
export function checkLibrarySectionContainsAllMasters(masters: LiveComponentLibraryMaster[], section: { x: number; y: number; width: number; height: number }): CheckResult {
  const escapees = masters.filter((m) => m.x < section.x || m.y < section.y || m.x + m.width > section.x + section.width || m.y + m.height > section.y + section.height);
  const pass = masters.length > 0 && escapees.length === 0;
  return {
    name: 'component-library-section-contains-all',
    pass,
    detail: pass
      ? `Section (${section.width}x${section.height}) fully contains all ${masters.length} master(s)`
      : masters.length === 0
        ? 'no masters were checked — pass every marker master for this page'
        : `${escapees.length} master(s) extend outside the Section's real bounds: ${escapees.map((m) => m.findingId).join(', ')} — FinalizeComponentLibraryLayout must resize the Section to the union of real master bounds`,
  };
}

/** One marker instance's actual, live-queried hover-prototype state — gathered via `use_figma` against the PUBLISHED file, never inferred from `figma-ops.json` alone. */
export interface LiveMarkerHoverRecord {
  findingId: string;
  /** `instance.reactions.length` on the placed Default-variant instance. */
  reactionCount: number;
  /** `instance.reactions[].trigger.type` for every reaction found. */
  triggerTypes: string[];
  /** Whether `getNodeByIdAsync(destinationId)` resolved to a real node. */
  destinationExists: boolean;
  /** The destination node's own `.visible`. */
  destinationVisible: boolean;
  /** Every ancestor from the destination up to (not including) the page is `visible: true`. */
  ancestryVisible: boolean;
  /** Whether `instance.getMainComponentAsync()` resolved to a real component. */
  mainComponentResolved: boolean;
  /** Whether that main component's parent is a `COMPONENT_SET` (a valid variant, not an orphaned loose component). */
  parentIsComponentSet: boolean;
}

/** A marker instance visible on `01 Page Audit` with zero `ON_HOVER` reactions is dead on arrival in Presentation mode — never silently shipped. */
export function checkMarkerHasHoverReaction(marker: Pick<LiveMarkerHoverRecord, 'findingId' | 'reactionCount' | 'triggerTypes'>): CheckResult {
  const pass = marker.reactionCount > 0 && marker.triggerTypes.includes('ON_HOVER');
  return {
    name: `marker-has-hover-reaction[${marker.findingId}]`,
    pass,
    detail: pass
      ? `${marker.reactionCount} reaction(s) found, including ON_HOVER`
      : marker.reactionCount === 0
        ? 'no reactions at all on this marker instance — WireHoverReaction was never applied or was lost on republish'
        : `${marker.reactionCount} reaction(s) found, but none is ON_HOVER (found: ${marker.triggerTypes.join(', ') || 'none'})`,
  };
}

/**
 * A hover destination only counts as resolvable if it actually renders when navigated to — a node
 * ID that exists but sits behind a hidden ancestor is NOT resolvable in the sense this pipeline
 * needs (Decision Log #34): Presentation mode won't swap to it, so a report that only checked
 * "does the id exist" would have passed on every one of the three broken files.
 */
export function checkHoverTargetResolvable(marker: Pick<LiveMarkerHoverRecord, 'findingId' | 'destinationExists' | 'destinationVisible' | 'ancestryVisible'>): CheckResult {
  const pass = marker.destinationExists && marker.destinationVisible && marker.ancestryVisible;
  const reasons: string[] = [];
  if (!marker.destinationExists) reasons.push('destination node id does not exist');
  if (marker.destinationExists && !marker.destinationVisible) reasons.push('destination node itself is visible: false');
  if (marker.destinationExists && !marker.ancestryVisible) reasons.push('an ancestor (component set and/or wrapping Section) is visible: false');
  return {
    name: `hover-target-resolvable[${marker.findingId}]`,
    pass,
    detail: pass ? 'destination exists and is visible all the way up — Presentation mode can navigate to it' : reasons.join('; '),
  };
}

/** A marker instance whose `mainComponent` is missing, or whose parent isn't a `COMPONENT_SET` (no Default/Hover variant pair to swap between), can never support CHANGE_TO — never shipped as if it were a working marker. */
export function checkMarkerComponentSetValid(marker: Pick<LiveMarkerHoverRecord, 'findingId' | 'mainComponentResolved' | 'parentIsComponentSet'>): CheckResult {
  const pass = marker.mainComponentResolved && marker.parentIsComponentSet;
  return {
    name: `marker-component-set-valid[${marker.findingId}]`,
    pass,
    detail: pass
      ? 'instance.mainComponent resolves and its parent is a COMPONENT_SET'
      : !marker.mainComponentResolved
        ? 'instance.getMainComponentAsync() returned null — the instance references a missing/detached component'
        : 'the main component\'s parent is not a COMPONENT_SET — no Default/Hover variant pair exists to swap between',
  };
}

/** The number of marker instances actually placed on canvas must equal the number carrying a hover reaction — a marker silently missing its `WireHoverReaction` step is caught here even if `marker-traceability` (which only checks finding ids, not reactions) passes. */
export function checkMarkerReactionCountMatches(markerInstanceCount: number, reactionCount: number): CheckResult {
  const pass = markerInstanceCount === reactionCount && markerInstanceCount > 0;
  return {
    name: 'marker-reaction-count-match',
    pass,
    detail: pass
      ? `${markerInstanceCount} marker instance(s), all ${reactionCount} carrying a hover reaction`
      : `${markerInstanceCount} marker instance(s) placed but ${reactionCount} carry a hover reaction — mismatch means at least one marker was placed without ever being wired`,
  };
}

/** Runs every live hover-integrity check for one page's markers, aggregated exactly like `buildVerificationReport` — the checks a live session runs against what `use_figma` actually queried on the published file, never against `figma-ops.json` alone. */
export function buildLiveHoverVerificationReport(pageId: string, records: LiveMarkerHoverRecord[]): PageVerificationReport {
  const checks: CheckResult[] = [
    ...records.map((r) => checkMarkerHasHoverReaction(r)),
    ...records.map((r) => checkHoverTargetResolvable(r)),
    ...records.map((r) => checkMarkerComponentSetValid(r)),
    checkMarkerReactionCountMatches(records.length, records.filter((r) => r.reactionCount > 0 && r.triggerTypes.includes('ON_HOVER')).length),
  ];
  return { pageId, checks, allPassed: checks.every((c) => c.pass) };
}

export interface PageVerificationInput {
  pageId: string;
  frameWidthPx: number;
  /** One entry per uploaded tile block, in upload order. */
  uploadedImages: Array<{ mean: number; stdev: number }>;
  /** One entry per marker's Hover variant, keyed by findingId. */
  hoverCards: Array<{ findingId: string; renderedHeightPx: number; expectedCardHeightPx: number }>;
  /**
   * Every top-level child of the frame — tiles and marker instances — for the bounds sweep.
   * Never the Legend: it's REQUIRED to sit outside frameWidthPx by design (staged to the right of
   * the frame), so checkBounds would fail it every time even when placement is exactly correct.
   * The Legend has its own dedicated, correct check: checkLegendPlacement.
   * Decision Log #35: this comment (and FIGMA-PUBLISH-RUNBOOK.md's Step 2.3) previously said
   * "+ the Legend" — caught on industry-report, the first run to actually query a live published
   * file for every check instead of eyeballing it: checkLegendPlacement passed (Legend correctly
   * at x=1490 against a 1440px frame) while checkBounds simultaneously failed on that exact same
   * node for that exact same position.
   */
  boundsToCheck: Array<{ label: string; x: number; y: number; width: number; height: number }>;
  placedFindingIds: string[];
  placedMarkerColors: string[];
  legend: { x: number };
  strayListNodes?: Array<{ label: string; x: number; y: number }>;
  /** The wrapping Section plus every individual marker-master component set. */
  componentLibraryObjects: Array<{ name: string; visible: boolean }>;
  /** Live-queried, per-marker hover-prototype state (Decision Log #34) — always pass this from what `use_figma` actually read off the published file, never omit it. Optional only for pre-#34 call sites; a page audit report is not fully verified without it. */
  liveMarkerHoverRecords?: LiveMarkerHoverRecord[];
  /**
   * Live-queried structural/geometric state for the Component Library Section itself and every
   * master inside it, read AFTER `FinalizeComponentLibraryLayout` has run (Decision Log #37) —
   * always pass this from what `use_figma` actually read off the published file, never omit it and
   * never substitute `figma-ops.json`'s initial `masterX`/`masterY` estimate. Optional only for
   * pre-#37 call sites; a page audit report is not fully verified without it — this is what caught
   * Marker 01/07 ejected as top-level siblings on the Survey file, which every OTHER check on this
   * page can pass while this one alone catches it.
   */
  componentLibrary?: { sectionId: string; sectionBounds: { x: number; y: number; width: number; height: number }; masters: LiveComponentLibraryMaster[] };
}

export interface PageVerificationReport {
  pageId: string;
  checks: CheckResult[];
  allPassed: boolean;
}

/** Runs every Step-4-equivalent check for one page and aggregates a single PASS/FAIL, exactly what the runbook's Step 5 report needs — now computed, not eyeballed. Folds in the live hover-integrity checks (Decision Log #34) whenever `input.liveMarkerHoverRecords` is provided, and the live component-library containment checks (Decision Log #37) whenever `input.componentLibrary` is provided, so one report covers the static plan-derived checks plus the actual live-node/reaction/containment state. */
export function buildVerificationReport(page: PageAuditFrame, input: PageVerificationInput): PageVerificationReport {
  const live = input.liveMarkerHoverRecords ?? [];
  const checks: CheckResult[] = [
    ...input.uploadedImages.map((px, i) => ({ ...checkBlankImage(px), name: `blank-image[tile ${i}]` })),
    ...input.hoverCards.map((h) => ({ ...checkHoverCardNotClipped(h.renderedHeightPx, h.expectedCardHeightPx), name: `hover-card-not-clipped[${h.findingId}]` })),
    ...input.boundsToCheck.map((n) => checkBounds(n, input.frameWidthPx)),
    checkMarkerTraceability(input.placedFindingIds, page.markerGroups),
    checkLegendPlacement(input.legend, input.frameWidthPx, input.strayListNodes ?? []),
    checkNoMatchMarkers(input.placedMarkerColors),
    checkComponentLibraryVisible(input.componentLibraryObjects),
    ...live.map((r) => checkMarkerHasHoverReaction(r)),
    ...live.map((r) => checkHoverTargetResolvable(r)),
    ...live.map((r) => checkMarkerComponentSetValid(r)),
    ...(input.liveMarkerHoverRecords ? [checkMarkerReactionCountMatches(live.length, live.filter((r) => r.reactionCount > 0 && r.triggerTypes.includes('ON_HOVER')).length)] : []),
    ...(input.componentLibrary
      ? [
          checkMasterParentedInLibrarySection(input.componentLibrary.masters, input.componentLibrary.sectionId),
          checkNoMasterOverlap(input.componentLibrary.masters),
          checkLibrarySectionContainsAllMasters(input.componentLibrary.masters, input.componentLibrary.sectionBounds),
        ]
      : []),
  ];
  return { pageId: page.key, checks, allPassed: checks.every((c) => c.pass) };
}
