import { describe, expect, it } from 'vitest';
import {
  checkBlankImage,
  checkBounds,
  checkComponentLibraryVisible,
  checkHoverCardNotClipped,
  checkHoverTargetResolvable,
  checkLegendPlacement,
  checkLibrarySectionContainsAllMasters,
  checkMarkerComponentSetValid,
  checkMarkerHasHoverReaction,
  checkMarkerReactionCountMatches,
  checkMarkerTraceability,
  checkMasterParentedInLibrarySection,
  checkNoMasterOverlap,
  checkNoMatchMarkers,
  type LiveComponentLibraryMaster,
} from '../../src/figma/publish-verify.ts';

/**
 * The codified form of docs/FIGMA-PUBLISH-RUNBOOK.md's Step 4 — previously five bullet points of
 * prose a live session had to remember to run by hand ("check pixel variance", "check
 * clipsContent", "check bounds", "check marker count", "check Legend position"). These tests are
 * the regression protection: a future publish must actually FAIL these checks on the exact
 * failure modes already discovered once on market-entry-real-1, not rely on someone re-noticing.
 */

describe('checkBlankImage — the confirmed get_screenshot blank/gray failure mode', () => {
  it('fails a uniform-fill (near-zero stdev) image — the reproduced blank/gray bug', () => {
    const result = checkBlankImage({ mean: 128, stdev: 0.3 });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/blank\/gray/);
  });
  it('passes a real, visually varied image', () => {
    const result = checkBlankImage({ mean: 140, stdev: 42.7 });
    expect(result.pass).toBe(true);
  });
});

describe('checkHoverCardNotClipped — the clipsContent truncation bug', () => {
  it('fails when the rendered card is only as tall as the marker circle (clipped)', () => {
    const result = checkHoverCardNotClipped(24, 180);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/clipped/);
  });
  it('passes when the rendered card reaches its full expected height', () => {
    const result = checkHoverCardNotClipped(182, 180);
    expect(result.pass).toBe(true);
  });
});

describe('checkBounds — the "marker sticks out of the frame" bug', () => {
  it('fails a node whose x is negative', () => {
    expect(checkBounds({ label: 'marker-3', x: -5, y: 10, width: 32, height: 32 }, 1440).pass).toBe(false);
  });
  it('fails a node that overflows the frame width', () => {
    expect(checkBounds({ label: 'card', x: 1400, y: 0, width: 300, height: 500 }, 1440).pass).toBe(false);
  });
  it('passes a node fully inside [0,0]..[frameWidth,∞)', () => {
    expect(checkBounds({ label: 'marker-1', x: 100, y: 200, width: 32, height: 32 }, 1440).pass).toBe(true);
  });
});

describe('boundsToCheck contract — MUST exclude the Legend (Decision Log #35)', () => {
  it('demonstrates why: the Legend is REQUIRED to sit outside frameWidthPx by design, so feeding it to checkBounds fails every time even when placement is exactly correct', () => {
    // Real numbers from the industry-report run: a 1440px frame, Legend staged at x=1490
    // (to the right, past LIBRARY_GAP_PX) — exactly what StageComponentLibrary/CreateLegendPanel
    // are supposed to produce, and exactly what checkLegendPlacement (below) confirms is correct.
    const legend = { label: 'Legend panel', x: 1490, y: 0, width: 420, height: 646 };
    expect(checkBounds(legend, 1440).pass).toBe(false); // checkBounds alone, misapplied here, always fails this
    expect(checkLegendPlacement({ x: legend.x }, 1440, []).pass).toBe(true); // its real, dedicated check passes
  });
  it('the fix: boundsToCheck should carry only the frame\'s own top-level children (tiles, marker instances) — never the Legend, which has its own checkLegendPlacement', () => {
    const tilesAndMarkers = [
      { label: 'tile-0', x: 0, y: 0, width: 1440, height: 900 },
      { label: 'marker-1', x: 120, y: 300, width: 32, height: 32 },
    ];
    expect(tilesAndMarkers.every((n) => checkBounds(n, 1440).pass)).toBe(true);
  });
});

describe('checkMarkerTraceability — no invented, dropped, or renumbered markers', () => {
  const expected = [{ findingId: 'f-1' }, { findingId: 'f-2' }, { findingId: 'f-3' }];
  it('passes when placed ids exactly match the plan', () => {
    expect(checkMarkerTraceability(['f-1', 'f-2', 'f-3'], expected).pass).toBe(true);
  });
  it('fails when a marker from the plan was never placed', () => {
    const result = checkMarkerTraceability(['f-1', 'f-2'], expected);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('f-3');
  });
  it('fails when an extra, unplanned marker was placed', () => {
    const result = checkMarkerTraceability(['f-1', 'f-2', 'f-3', 'f-invented'], expected);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('f-invented');
  });
});

describe('checkLegendPlacement — never inside/after the main frame, never a stray list node', () => {
  it('passes when the Legend sits to the right of the frame and nothing stray exists', () => {
    expect(checkLegendPlacement({ x: 1490 }, 1440, []).pass).toBe(true);
  });
  it('fails when the Legend x is inside the frame (not to the right)', () => {
    const result = checkLegendPlacement({ x: 200 }, 1440, []);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/INSIDE the frame/);
  });
  it('fails when a stray numbered-list node exists outside the Legend (the "list after the Footer" regression)', () => {
    const result = checkLegendPlacement({ x: 1490 }, 1440, [{ label: 'stray-list', x: 50, y: 9200 }]);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('stray-list');
  });
});

describe('checkNoMatchMarkers — status-only colors, never a MATCH marker', () => {
  it('passes with only RED/ORANGE/AMBER/GRAY', () => {
    expect(checkNoMatchMarkers(['RED', 'ORANGE', 'AMBER', 'GRAY']).pass).toBe(true);
  });
  it('fails if a GREEN/MATCH-style color ever appears', () => {
    const result = checkNoMatchMarkers(['RED', 'GREEN']);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('GREEN');
  });
});

describe('checkComponentLibraryVisible — every internal marker-master/component-library object MUST be visible:true (Decision Log #34 — inverted from the old, disproven checkComponentLibraryHidden)', () => {
  it('passes when the Section and every marker master are all visible', () => {
    const result = checkComponentLibraryVisible([
      { name: 'Component library (internal — not report content)', visible: true },
      { name: 'Marker 01', visible: true },
      { name: 'Marker 02', visible: true },
    ]);
    expect(result.pass).toBe(true);
  });
  it('fails when the Section is hidden — this is the exact bug that broke hover on brand-perception-survey-page and survey-page-audit', () => {
    const result = checkComponentLibraryVisible([{ name: 'Component library (internal — not report content)', visible: false }]);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/HIDDEN/);
  });
  it('fails when any individual marker master is hidden, even if the Section itself is visible', () => {
    const result = checkComponentLibraryVisible([
      { name: 'Component library (internal — not report content)', visible: true },
      { name: 'Marker 01 — button — Two-Font Pairing (Serif + Sans)', visible: false },
      { name: 'Marker 02', visible: true },
    ]);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('Marker 01');
  });
  it('fails (does not silently pass) when given an empty list', () => {
    const result = checkComponentLibraryVisible([]);
    expect(result.pass).toBe(false);
  });
});

describe('checkMasterParentedInLibrarySection — a master must be a direct child of the Section, not a top-level sibling (Decision Log #37, live bug: Survey file Marker 01/07 ejected)', () => {
  const SECTION_ID = 'section:123';
  it('passes when every master is parented directly under the Section', () => {
    const masters: LiveComponentLibraryMaster[] = [
      { findingId: 'f-1', parentId: SECTION_ID, x: 0, y: 0, width: 300, height: 200 },
      { findingId: 'f-2', parentId: SECTION_ID, x: 0, y: 260, width: 300, height: 220 },
    ];
    expect(checkMasterParentedInLibrarySection(masters, SECTION_ID).pass).toBe(true);
  });
  it('fails and names exactly the ejected masters — reproduces the live Survey-file bug (Marker 01 and Marker 07 as top-level siblings)', () => {
    const masters: LiveComponentLibraryMaster[] = [
      { findingId: 'marker-01', parentId: 'page:root', x: 0, y: 0, width: 300, height: 200 }, // ejected — parent is the page, not the Section
      { findingId: 'marker-02', parentId: SECTION_ID, x: 0, y: 260, width: 300, height: 220 },
      { findingId: 'marker-07', parentId: null, x: 0, y: 520, width: 300, height: 180 }, // ejected — no parent at all
    ];
    const result = checkMasterParentedInLibrarySection(masters, SECTION_ID);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('marker-01');
    expect(result.detail).toContain('marker-07');
    expect(result.detail).not.toContain('marker-02');
  });
  it('fails (does not silently pass) when given an empty list', () => {
    expect(checkMasterParentedInLibrarySection([], SECTION_ID).pass).toBe(false);
  });
});

describe('checkNoMasterOverlap — real rendered bounds, never estimated (Decision Log #37)', () => {
  it('passes when every master occupies a distinct vertical slot', () => {
    const masters: LiveComponentLibraryMaster[] = [
      { findingId: 'f-1', parentId: 's', x: 0, y: 0, width: 300, height: 200 },
      { findingId: 'f-2', parentId: 's', x: 0, y: 260, width: 300, height: 220 },
    ];
    expect(checkNoMasterOverlap(masters).pass).toBe(true);
  });
  it('fails and names both findings when a real card turned out taller than its neighbor\'s gap assumed', () => {
    const masters: LiveComponentLibraryMaster[] = [
      { findingId: 'f-1', parentId: 's', x: 0, y: 0, width: 300, height: 280 }, // real height exceeds the 260px gap to the next master
      { findingId: 'f-2', parentId: 's', x: 0, y: 260, width: 300, height: 220 },
    ];
    const result = checkNoMasterOverlap(masters);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('f-1');
    expect(result.detail).toContain('f-2');
  });
  it('passes trivially for zero or one master', () => {
    expect(checkNoMasterOverlap([]).pass).toBe(true);
    expect(checkNoMasterOverlap([{ findingId: 'f-1', parentId: 's', x: 0, y: 0, width: 300, height: 200 }]).pass).toBe(true);
  });
});

describe('checkLibrarySectionContainsAllMasters — the Section\'s real bounds must fully contain every master (Decision Log #37)', () => {
  const section = { x: 2000, y: 0, width: 380, height: 900 };
  it('passes when every master sits fully inside the Section', () => {
    const masters: LiveComponentLibraryMaster[] = [
      { findingId: 'f-1', parentId: 's', x: 2020, y: 20, width: 300, height: 200 },
      { findingId: 'f-2', parentId: 's', x: 2020, y: 260, width: 300, height: 220 },
    ];
    expect(checkLibrarySectionContainsAllMasters(masters, section).pass).toBe(true);
  });
  it('fails and names a master rendered above/outside the Section — the reported "visually positioned outside/above the white Component Library area" bug', () => {
    const masters: LiveComponentLibraryMaster[] = [
      { findingId: 'f-1', parentId: 's', x: 2020, y: -40, width: 300, height: 200 }, // starts above the Section's own top edge
      { findingId: 'f-2', parentId: 's', x: 2020, y: 260, width: 300, height: 220 },
    ];
    const result = checkLibrarySectionContainsAllMasters(masters, section);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('f-1');
    expect(result.detail).not.toContain('f-2');
  });
  it('fails and names a master extending past the Section\'s bottom edge (Section never resized to fit)', () => {
    const masters: LiveComponentLibraryMaster[] = [{ findingId: 'f-tall', parentId: 's', x: 2020, y: 800, width: 300, height: 400 }];
    const result = checkLibrarySectionContainsAllMasters(masters, section);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('f-tall');
  });
  it('fails (does not silently pass) when given an empty list', () => {
    expect(checkLibrarySectionContainsAllMasters([], section).pass).toBe(false);
  });
});

describe('checkMarkerHasHoverReaction — a visible marker with zero ON_HOVER reactions is dead in Presentation mode', () => {
  it('passes when an ON_HOVER reaction is present', () => {
    expect(checkMarkerHasHoverReaction({ findingId: 'f-1', reactionCount: 1, triggerTypes: ['ON_HOVER'] }).pass).toBe(true);
  });
  it('fails when there are zero reactions at all', () => {
    const result = checkMarkerHasHoverReaction({ findingId: 'f-1', reactionCount: 0, triggerTypes: [] });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/no reactions/);
  });
  it('fails when reactions exist but none is ON_HOVER', () => {
    const result = checkMarkerHasHoverReaction({ findingId: 'f-1', reactionCount: 1, triggerTypes: ['ON_CLICK'] });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('ON_CLICK');
  });
});

describe('checkHoverTargetResolvable — a destination is only resolvable if it actually renders when navigated to (Decision Log #34)', () => {
  it('passes when the destination exists and is visible all the way up', () => {
    const result = checkHoverTargetResolvable({ findingId: 'f-1', destinationExists: true, destinationVisible: true, ancestryVisible: true });
    expect(result.pass).toBe(true);
  });
  it('fails when the destination node id does not exist', () => {
    const result = checkHoverTargetResolvable({ findingId: 'f-1', destinationExists: false, destinationVisible: false, ancestryVisible: false });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/does not exist/);
  });
  it('fails when the destination exists but is itself hidden', () => {
    const result = checkHoverTargetResolvable({ findingId: 'f-1', destinationExists: true, destinationVisible: false, ancestryVisible: true });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/destination node itself/);
  });
  it('fails when the destination is visible but an ancestor (component set / Section) is hidden — the exact bug found on all three broken files', () => {
    const result = checkHoverTargetResolvable({ findingId: 'f-1', destinationExists: true, destinationVisible: true, ancestryVisible: false });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/ancestor/);
  });
});

describe('checkMarkerComponentSetValid — a marker instance must reference a real component whose parent is a COMPONENT_SET', () => {
  it('passes for a normal Default-variant instance', () => {
    expect(checkMarkerComponentSetValid({ findingId: 'f-1', mainComponentResolved: true, parentIsComponentSet: true }).pass).toBe(true);
  });
  it('fails when the main component cannot be resolved (missing/detached)', () => {
    const result = checkMarkerComponentSetValid({ findingId: 'f-1', mainComponentResolved: false, parentIsComponentSet: false });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/missing\/detached/);
  });
  it('fails when the main component exists but its parent is not a COMPONENT_SET', () => {
    const result = checkMarkerComponentSetValid({ findingId: 'f-1', mainComponentResolved: true, parentIsComponentSet: false });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/not a COMPONENT_SET/);
  });
});

describe('checkMarkerReactionCountMatches — marker count and prototype-reaction count must match exactly', () => {
  it('passes when every marker instance carries a hover reaction', () => {
    expect(checkMarkerReactionCountMatches(9, 9).pass).toBe(true);
  });
  it('fails when fewer reactions exist than marker instances', () => {
    const result = checkMarkerReactionCountMatches(9, 7);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('9 marker instance(s) placed but 7');
  });
  it('fails (does not silently pass) when there are zero markers', () => {
    expect(checkMarkerReactionCountMatches(0, 0).pass).toBe(false);
  });
});
