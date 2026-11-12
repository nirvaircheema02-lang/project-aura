import { describe, expect, it } from 'vitest';
import {
  checkBlankImage,
  checkBounds,
  checkComponentLibraryVisible,
  checkHoverCardNotClipped,
  checkHoverTargetResolvable,
  checkLegendPlacement,
  checkMarkerComponentSetValid,
  checkMarkerHasHoverReaction,
  checkMarkerReactionCountMatches,
  checkMarkerTraceability,
  checkNoMatchMarkers,
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
    expect(checkBounds({ label: 'legend', x: 1400, y: 0, width: 300, height: 500 }, 1440).pass).toBe(false);
  });
  it('passes a node fully inside [0,0]..[frameWidth,∞)', () => {
    expect(checkBounds({ label: 'marker-1', x: 100, y: 200, width: 32, height: 32 }, 1440).pass).toBe(true);
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
