import { describe, expect, it } from 'vitest';
import { buildFigmaOperationPlan, clampMarkerY, formatLegendPrimaryLine, legendCaptureNote, legendColorKeyLine, type FigmaOp } from '../../src/figma/publish-ops.ts';
import { buildTileCompositePlan } from '../../src/figma/page-composite-plan.ts';
import type { MarkerGroup, PageAuditFrame, PublishPlan } from '../../src/figma/publish-plan.ts';
import { FIGMA_PAGES } from '../../src/figma/publish-plan.ts';

/**
 * Regression protection for the bugs docs/FIGMA-PUBLISH-RUNBOOK.md's Step 3 previously
 * documented as prose ("already caught once, will recur if skipped") — clipsContent, marker
 * Y-clamping, never-place-a-raw-uncropped-tile-past-block-0, and the Legend+list living in the
 * SAME op so it can't land after the Footer. Every rule here is now a field on a typed
 * operation, asserted directly, not something a future publish has to remember.
 */

function marker(over: Partial<MarkerGroup> & { number: number; findingId: string; box: MarkerGroup['box'] }): MarkerGroup {
  return {
    status: 'INCORRECT',
    color: 'RED',
    severityText: 'High',
    shortName: `Component ${over.number}`,
    explanation: 'because',
    bullets: ['prop: a → b'],
    dsLine: 'Button · R1',
    isRootCause: false,
    affectedCount: 1,
    affectedFindingIds: [over.findingId],
    placement: 'right',
    evidenceRef: null,
    confidence: 0.9,
    confidenceBand: 'HIGH',
    recommendation: 'fix it',
    section: 'Body',
    propertiesTotal: 1,
    productionType: 'button',
    legendTitle: `Component ${over.number}`,
    legendSecondary: 'Body button · unique, 1 element',
    ...over,
  };
}

function emptyPages(): PublishPlan['pages'] {
  return Object.fromEntries(FIGMA_PAGES.map((p) => [p, { tiles: [], rows: [], headers: [] }])) as PublishPlan['pages'];
}

function fixturePlan(pageAudits: PageAuditFrame[]): PublishPlan {
  return {
    contractVersion: 'test',
    runId: 'run-test',
    targetUrl: 'https://example.com/page',
    dsRegistryVersion: 'ds-test',
    renderingEngine: 'test-engine',
    aiMode: 'no-api',
    pages: emptyPages(),
    pageAudits,
    rootCauseCards: [],
    needsReviewCards: { cards: [], total: 0 },
    globalComponents: [],
    imageDelivery: { status: 'deferred-unresolved-spike', wouldUpload: [], note: 'n/a' },
  };
}

describe('clampMarkerY — structurally impossible to place a marker above the frame edge', () => {
  it('clamps a negative Y to 0', () => expect(clampMarkerY(-3)).toBe(0));
  it('leaves a non-negative Y unchanged', () => {
    expect(clampMarkerY(0)).toBe(0);
    expect(clampMarkerY(42)).toBe(42);
  });
});

describe('formatLegendPrimaryLine — exactly "NN legendTitle — StatusTitleCase" (Decision Log #33: legendTitle, never the raw shortName)', () => {
  it('formats INCORRECT with a zero-padded number', () => {
    const g = marker({ number: 1, findingId: 'f-1', box: { x: 0, y: 0, width: 1, height: 1 }, legendTitle: 'Sign up button', status: 'INCORRECT' });
    expect(formatLegendPrimaryLine(g)).toBe('01 Sign up button — Incorrect');
  });
  it('formats NEEDS_REVIEW as two title-cased words, not ALL CAPS', () => {
    const g = marker({ number: 4, findingId: 'f-4', box: { x: 0, y: 0, width: 1, height: 1 }, legendTitle: 'Form fields', status: 'NEEDS_REVIEW', color: 'AMBER' });
    expect(formatLegendPrimaryLine(g)).toBe('04 Form fields — Needs Review');
  });
});

describe('buildFigmaOperationPlan — Page Audit frame ops', () => {
  // tile 0 whole (1000px), tile 1's top 100px (the sticky header) cropped away.
  const compositePlan = buildTileCompositePlan(2, 1440, 1000, 100);
  const inTile0 = marker({ number: 1, findingId: 'f-in-tile0', box: { x: 50, y: 50, width: 20, height: 20 } }); // realY 50 < tileHeightPx -> unaffected
  const inCroppedHeaderBand = marker({ number: 2, findingId: 'f-in-header-band', box: { x: 50, y: 1050, width: 20, height: 20 } }); // tileIndex 1, withinTile 50 < headerHeightPx 100 -> never captured
  const inTile1Body = marker({ number: 3, findingId: 'f-in-tile1-body', box: { x: 50, y: 1150, width: 20, height: 20 } }); // tileIndex 1, withinTile 150 -> remapped

  const page: PageAuditFrame = {
    key: 'page-1',
    url: 'https://example.com/page',
    title: 'https://example.com/page',
    complianceLabel: 'n/a',
    screenshots: [],
    markers: [],
    cards: [],
    markerGroups: [inTile0, inCroppedHeaderBand, inTile1Body],
    markerGroupsTruncated: false,
    markerGroupsTotal: 3,
  };

  const plan = fixturePlan([page]);
  const result = buildFigmaOperationPlan(plan, { 'page-1': compositePlan }, { figmaFileKey: null, figmaFileUrl: null, figmaTeamPlanKey: 'team::123' });

  it('every CreateMarkerComponentSet op carries clipsContent: false literally — never a step left to remember', () => {
    const sets = result.ops.filter((o): o is Extract<FigmaOp, { op: 'CreateMarkerComponentSet' }> => o.op === 'CreateMarkerComponentSet');
    expect(sets.length).toBeGreaterThan(0);
    for (const s of sets) expect(s.clipsContent).toBe(false);
  });

  it('never places a raw, uncropped tile past block 0 (the "repeats the header" bug)', () => {
    const uploads = result.ops.filter((o): o is Extract<FigmaOp, { op: 'UploadTileBlock' }> => o.op === 'UploadTileBlock');
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatchObject({ tileIndex: 0, sourceCropY: 0, sourceCropHeight: 1000 });
    expect(uploads[1]).toMatchObject({ tileIndex: 1, sourceCropY: 100, sourceCropHeight: 900 }); // cropped by exactly headerHeightPx
  });

  it('places a marker whose Y falls inside a cropped, unrecoverable header band NOWHERE — reported as a coverage gap instead of faked', () => {
    const placedIds = result.ops.filter((o): o is Extract<FigmaOp, { op: 'PlaceMarkerInstance' }> => o.op === 'PlaceMarkerInstance').map((o) => o.findingId);
    expect(placedIds).toEqual(['f-in-tile0', 'f-in-tile1-body']); // f-in-header-band never placed
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0]).toMatchObject({ pageId: 'page-1', findingId: 'f-in-header-band', number: 2 });
  });

  it('remaps a tile-1 marker into compacted composite space, and every placed Y is clamped >= 0', () => {
    const placements = result.ops.filter((o): o is Extract<FigmaOp, { op: 'PlaceMarkerInstance' }> => o.op === 'PlaceMarkerInstance');
    const tile0Marker = placements.find((p) => p.findingId === 'f-in-tile0')!;
    expect(tile0Marker.y).toBe(50); // unaffected, tile 0
    const tile1Marker = placements.find((p) => p.findingId === 'f-in-tile1-body')!;
    expect(tile1Marker.y).toBe(1000 + (150 - 100)); // 1000 (tile0 height) + (withinTile - headerHeight)
    for (const p of placements) expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it('stages the component-set master library to the RIGHT of the Legend, at the frame\'s own top (y: 0) — never below the frame, never readable as a second findings list after the Footer', () => {
    const staged = result.ops.find((o): o is Extract<FigmaOp, { op: 'StageComponentLibrary' }> => o.op === 'StageComponentLibrary' && o.pageId === 'page-1')!;
    const legend = result.ops.find((o): o is Extract<FigmaOp, { op: 'CreateLegendPanel' }> => o.op === 'CreateLegendPanel' && o.pageId === 'page-1')!;
    // The regression this guards: an earlier version staged this at y >= totalHeightPx + 5000 —
    // still "far away", but on the SAME vertical axis a reader scrolls down to read the report,
    // so a real multi-tile page (brand-perception-survey-page) rendered it as a visible duplicate
    // findings list below the Footer the first time anyone actually scrolled that far.
    expect(staged.y).toBe(0);
    expect(staged.x).toBeGreaterThanOrEqual(legend.x + legend.widthPx);
    expect(staged.sectionLabel.toLowerCase()).toContain('internal');
  });

  it('is always emitted with visible: true — Decision Log #34: hiding this Section (an earlier, disproven fix) made Figma silently drop hover CHANGE_TO navigation for every marker in the file on brand-perception-survey-page, survey-page-audit, and report-store-page; isolation from the report now relies only on the horizontal staging position, never on hiding', () => {
    const staged = result.ops.find((o): o is Extract<FigmaOp, { op: 'StageComponentLibrary' }> => o.op === 'StageComponentLibrary' && o.pageId === 'page-1')!;
    expect(staged.visible).toBe(true);
  });

  it('every individual marker master is ALSO emitted with visible: true, independent of the Section — Decision Log #34: a hidden marker master (even with a perfectly well-formed ON_HOVER/CHANGE_TO reaction) breaks Presentation-mode hover on that marker, confirmed by live A/B diagnosis against the working market-entry-real-1 reference (masters visible: true)', () => {
    const markerSets = result.ops.filter((o): o is Extract<FigmaOp, { op: 'CreateMarkerComponentSet' }> => o.op === 'CreateMarkerComponentSet' && o.pageId === 'page-1');
    expect(markerSets.length).toBeGreaterThan(0);
    for (const m of markerSets) expect(m.visible).toBe(true);
  });

  it('the Legend panel sits to the right of the frame, and its numbered list is the SAME op — structurally never a detached panel or content after the Footer', () => {
    const legend = result.ops.find((o): o is Extract<FigmaOp, { op: 'CreateLegendPanel' }> => o.op === 'CreateLegendPanel' && o.pageId === 'page-1')!;
    expect(legend.x).toBe(compositePlan.tileWidthPx + 50);
    expect(legend.y).toBe(0);
    // Only the two markers that were actually placed appear — never the coverage-gap marker,
    // so the list corresponds exactly with what's really on the page.
    expect(legend.lines.map((l) => l.findingId)).toEqual(['f-in-tile0', 'f-in-tile1-body']);
    expect(legend.lines[0]!.primary).toBe('01 Component 1 — Incorrect');
    expect(legend.lines[0]!.secondary.length).toBeGreaterThan(0);
  });

  it('keeps the URL at the top exactly as before (title === page.title) and the status color key unchanged', () => {
    const legend = result.ops.find((o): o is Extract<FigmaOp, { op: 'CreateLegendPanel' }> => o.op === 'CreateLegendPanel' && o.pageId === 'page-1')!;
    expect(legend.title).toBe('https://example.com/page');
    expect(legend.colorKeyLine).toBe(legendColorKeyLine());
  });

  it('every line carries a colored primary string and a separate neutral secondary string — never one flat combined line', () => {
    const legend = result.ops.find((o): o is Extract<FigmaOp, { op: 'CreateLegendPanel' }> => o.op === 'CreateLegendPanel' && o.pageId === 'page-1')!;
    expect(legend.lines.length).toBeGreaterThan(0);
    for (const line of legend.lines) {
      expect(line.primary.length).toBeGreaterThan(0);
      expect(line.secondary.length).toBeGreaterThan(0);
      expect(['RED', 'ORANGE', 'AMBER', 'GRAY']).toContain(line.color);
      // The primary line is "NN <title> — <Status>" — never the raw secondary content leaking into it.
      expect(line.primary).toMatch(/^\d{2} .+ — (Incorrect|Deviation|Needs Review|Unverified)$/);
    }
  });

  it('captureNote is null when nothing was truncated ("retain the capture note only when relevant")', () => {
    const legend = result.ops.find((o): o is Extract<FigmaOp, { op: 'CreateLegendPanel' }> => o.op === 'CreateLegendPanel' && o.pageId === 'page-1')!;
    expect(legend.captureNote).toBeNull();
  });

  it('the numbered findings list appears exactly ONCE per page — one CreateLegendPanel op, no second list-bearing op', () => {
    const legendOps = result.ops.filter((o) => o.op === 'CreateLegendPanel' && o.pageId === 'page-1');
    expect(legendOps).toHaveLength(1);
    // No other op on this page carries a `lines` array — the list has exactly one home.
    const otherOpsWithLines = result.ops.filter((o) => o.op !== 'CreateLegendPanel' && 'pageId' in o && o.pageId === 'page-1' && 'lines' in o);
    expect(otherOpsWithLines).toHaveLength(0);
  });

  it('nothing is staged below the frame\'s own height — the specific coordinate space a "content after the Footer" bug would occupy', () => {
    const frameHeight = compositePlan.totalHeightPx;
    const opsForPage = result.ops.filter((o) => 'pageId' in o && o.pageId === 'page-1');
    for (const op of opsForPage) {
      if (op.op === 'CreateMarkerComponentSet' || op.op === 'WireHoverReaction') continue; // no geometry of their own
      const y = 'y' in op ? op.y : 0;
      expect(y, `${op.op} must not sit below the frame (height ${frameHeight})`).toBeLessThan(frameHeight);
    }
  });

  it('never doubles the status word in a legend line (legendTitle must not itself already end with the status)', () => {
    const needsReviewMarker = marker({ number: 1, findingId: 'f-nr', box: { x: 0, y: 0, width: 1, height: 1 }, legendTitle: 'link', status: 'NEEDS_REVIEW', color: 'AMBER' });
    const line = formatLegendPrimaryLine(needsReviewMarker);
    expect(line).toBe('01 link — Needs Review');
    expect(line.match(/Needs Review/g)).toHaveLength(1);
  });

  it('every CreatePageAuditFrame is clipsContent: false (the component-set truncation bug is not the only place this must hold)', () => {
    const frame = result.ops.find((o): o is Extract<FigmaOp, { op: 'CreatePageAuditFrame' }> => o.op === 'CreatePageAuditFrame')!;
    expect(frame.clipsContent).toBe(false);
    expect(frame.heightPx).toBe(compositePlan.totalHeightPx);
  });
});

describe('buildFigmaOperationPlan — a page with no composite plan is skipped, never faked', () => {
  const page: PageAuditFrame = {
    key: 'page-no-tiles',
    url: 'https://example.com/other',
    title: 'https://example.com/other',
    complianceLabel: 'n/a',
    screenshots: [],
    markers: [],
    cards: [],
    markerGroups: [marker({ number: 1, findingId: 'f-x', box: { x: 0, y: 0, width: 10, height: 10 } })],
    markerGroupsTruncated: false,
    markerGroupsTotal: 1,
  };
  const result = buildFigmaOperationPlan(fixturePlan([page]), {}, { figmaFileKey: null, figmaFileUrl: null, figmaTeamPlanKey: null });

  it('reports the page in missingCompositePlanFor and emits no Page Audit frame ops for it (03 Component Findings cards are independent of the composite plan and still render)', () => {
    expect(result.missingCompositePlanFor).toEqual(['page-no-tiles']);
    const frameOpTypes = new Set(['CreatePageAuditFrame', 'UploadTileBlock', 'CreateMarkerComponentSet', 'PlaceMarkerInstance', 'WireHoverReaction', 'StageComponentLibrary', 'CreateLegendPanel']);
    expect(result.ops.some((o) => frameOpTypes.has(o.op) && 'pageId' in o && o.pageId === 'page-no-tiles')).toBe(false);
    expect(result.ops.some((o) => o.op === 'CreateComponentFindingCards' && o.pageId === 'page-no-tiles')).toBe(true);
  });
});

describe('buildFigmaOperationPlan — EnsureFile mode', () => {
  it('creates when the project has no Figma file yet', () => {
    const result = buildFigmaOperationPlan(fixturePlan([]), {}, { figmaFileKey: null, figmaFileUrl: null, figmaTeamPlanKey: 'team::1' });
    const ensure = result.ops.find((o): o is Extract<FigmaOp, { op: 'EnsureFile' }> => o.op === 'EnsureFile')!;
    expect(ensure.mode).toBe('create');
  });
  it('mutates the existing file rather than duplicating when one is already known', () => {
    const result = buildFigmaOperationPlan(fixturePlan([]), {}, { figmaFileKey: 'ABC123', figmaFileUrl: 'https://figma.com/design/ABC123', figmaTeamPlanKey: 'team::1' });
    const ensure = result.ops.find((o): o is Extract<FigmaOp, { op: 'EnsureFile' }> => o.op === 'EnsureFile')!;
    expect(ensure.mode).toBe('mutate');
    expect(ensure.figmaFileKey).toBe('ABC123');
  });
});

describe('buildFigmaOperationPlan — the locked six-page structure (never redesigned per run)', () => {
  it('always creates exactly these six pages, in this exact order — no raw-table fallback, no invented layout', () => {
    const result = buildFigmaOperationPlan(fixturePlan([]), {}, { figmaFileKey: null, figmaFileUrl: null, figmaTeamPlanKey: null });
    const pageNames = result.ops.filter((o): o is Extract<FigmaOp, { op: 'EnsurePage' }> => o.op === 'EnsurePage').map((o) => o.pageName);
    expect(pageNames).toEqual(['00 Overview', '01 Page Audit', '02 Root Causes', '03 Component Findings', '04 Needs Review', '05 Global Components']);
  });

  it('never emits a raw-table op — CreateRootCauseCards/CreateComponentFindingCards/CreateNeedsReviewCards/CreateGlobalComponentCards only, for a page with real content', () => {
    const page = marker({ number: 1, findingId: 'f-only', box: { x: 0, y: 0, width: 10, height: 10 } });
    const pageAudit: PageAuditFrame = { key: 'p', url: 'https://example.com', title: 'https://example.com', complianceLabel: 'n/a', screenshots: [], markers: [], cards: [], markerGroups: [page], markerGroupsTruncated: false, markerGroupsTotal: 1 };
    const compositePlan = buildTileCompositePlan(1, 1440, 900, 0);
    const result = buildFigmaOperationPlan(fixturePlan([pageAudit]), { p: compositePlan }, { figmaFileKey: null, figmaFileUrl: null, figmaTeamPlanKey: null });
    const opTypes = new Set(result.ops.map((o) => o.op));
    expect(opTypes.has('CreateComponentFindingCards' as FigmaOp['op'])).toBe(true);
    // TypeScript already forbids constructing a 'CreateTable' op (it's not in the FigmaOp union) —
    // this assertion is the runtime mirror of that compile-time guarantee.
    expect([...opTypes]).not.toContain('CreateTable');
  });
});

describe('legendColorKeyLine — generated from colorForMarkerStatus, never hand-typed', () => {
  it('produces exactly the approved color key text', () => {
    expect(legendColorKeyLine()).toBe('Red = Incorrect · Orange = Deviation · Amber = Needs Review · Gray = Unverified');
  });
});

describe('CreateLegendPanel — captureNote populates when the page really was truncated', () => {
  it('wires page.markerGroupsTotal through to a non-null captureNote', () => {
    const compositePlan = buildTileCompositePlan(1, 1440, 900, 0);
    const m = marker({ number: 1, findingId: 'f-1', box: { x: 10, y: 10, width: 10, height: 10 } });
    const page: PageAuditFrame = {
      key: 'page-truncated',
      url: 'https://example.com/t',
      title: 'https://example.com/t',
      complianceLabel: 'n/a',
      screenshots: [],
      markers: [],
      cards: [],
      markerGroups: [m],
      markerGroupsTruncated: true,
      markerGroupsTotal: 19,
    };
    const result2 = buildFigmaOperationPlan(fixturePlan([page]), { 'page-truncated': compositePlan }, { figmaFileKey: null, figmaFileUrl: null, figmaTeamPlanKey: null });
    const legend = result2.ops.find((o): o is Extract<FigmaOp, { op: 'CreateLegendPanel' }> => o.op === 'CreateLegendPanel' && o.pageId === 'page-truncated')!;
    expect(legend.captureNote).not.toBeNull();
    expect(legend.captureNote).toBe(legendCaptureNote(1, 19));
  });
});

describe('legendCaptureNote — generated, never hand-typed; null exactly when nothing was truncated', () => {
  it('returns null when shown === total', () => {
    expect(legendCaptureNote(7, 7)).toBeNull();
  });
  it('returns null when shown > total (defensive — should never happen, but never a bogus note)', () => {
    expect(legendCaptureNote(8, 7)).toBeNull();
  });
  it('returns a short, concrete sentence — not raw/technical jargon — when truncated', () => {
    const note = legendCaptureNote(12, 19);
    expect(note).not.toBeNull();
    expect(note).toContain('12');
    expect(note).toContain('19');
    expect(note!.length).toBeLessThan(160); // stays a short sentence, not a paragraph
    expect(note).not.toMatch(/root-cause\/unique marker groups/); // the old, more jargon-heavy wording
  });
});
