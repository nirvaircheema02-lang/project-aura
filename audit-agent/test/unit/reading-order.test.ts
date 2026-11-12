import { describe, expect, it } from 'vitest';
import { inReadingOrder } from '../../src/output/reading-order.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';

/**
 * Findings are drawn in READING ORDER inside a section — top to bottom, left to right along a row, a container
 * before what it contains — never in the audit's detection order (which read 02, 01, 03 …).
 */

type Box = { x: number; y: number; width: number; height: number } | null;

function finding(id: string, box: Box): Finding {
  return {
    identity: { auditId: 'a', runId: 'r', findingId: id, timestamp: '2026-10-14T00:00:00.000Z', dsRegistryVersion: 'ds', policyVersion: 'p' },
    location: { url: 'https://www.kenresearch.com/survey', pageId: 'p', pageName: 'Survey', templateFamily: null, section: 'S', captureState: 'default' },
    component: { productionType: 'paragraph', productionLabel: id, dsComponent: null, dsVariant: null, signature: `sig-${id}` },
    classification: 'MATCH',
    comparison: { mismatches: [], ruleViolations: [] },
    quality: {
      severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [],
      evidence: box ? [{ kind: 'element-screenshot', ref: 'x.png', note: null, box }] : [],
      visualVerdict: 'NOT_CHECKED',
    },
    action: { recommendation: 'x', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: 'MATCH', delta: null, previousRunId: null },
  };
}

const ids = (fs: Finding[]) => fs.map((f) => f.identity.findingId);
const at = (x: number, y: number, width = 100, height = 20): Box => ({ x, y, width, height });

describe('inReadingOrder', () => {
  it('lists a numbered row 01, 02, 03 … however the audit found them', () => {
    const detected = [finding('02', at(356, 1980)), finding('01', at(160, 1980)), finding('04', at(744, 1980)), finding('03', at(552, 1980))];
    expect(ids(inReadingOrder(detected))).toEqual(['01', '02', '03', '04']);
  });

  it('lists top to bottom', () => {
    const detected = [finding('footer-line', at(0, 900)), finding('heading', at(0, 100)), finding('body', at(0, 300))];
    expect(ids(inReadingOrder(detected))).toEqual(['heading', 'body', 'footer-line']);
  });

  it('treats tops a few px apart as one row (left label before right label)', () => {
    const detected = [finding('right', at(400, 1976)), finding('left', at(160, 1980))];
    expect(ids(inReadingOrder(detected))).toEqual(['left', 'right']);
  });

  it('puts an enclosing element before what it contains', () => {
    const detected = [finding('title', at(160, 1980, 176, 24)), finding('card', at(160, 1972, 176, 100)), finding('card-button', at(160, 1980, 176, 84))];
    expect(ids(inReadingOrder(detected))).toEqual(['card', 'card-button', 'title']);
  });

  it('reads a staircase of steps left to right (Phase 1 … 4), not by height', () => {
    // each step is higher than the one before it, as in a rising timeline
    const detected = [
      finding('phase-4', at(1084, 3064, 56, 28)), finding('phase-3', at(824, 3100, 56, 28)),
      finding('phase-2', at(560, 3136, 56, 28)), finding('phase-1', at(300, 3172, 56, 28)),
      finding('text-4', at(1056, 3108, 116, 24)), finding('text-3', at(772, 3144, 156, 24)),
      finding('text-2', at(524, 3180, 132, 24)), finding('text-1', at(280, 3216, 92, 24)),
    ];
    expect(ids(inReadingOrder(detected))).toEqual(['phase-1', 'text-1', 'phase-2', 'text-2', 'phase-3', 'text-3', 'phase-4', 'text-4']);
  });

  it('keeps each numbered card together: 01 card, its number, its title — then 02 …', () => {
    // as the audit finds them: every number first, then the cards, then every title
    const detected = [
      finding('02', at(356, 1980, 176, 24)), finding('01', at(160, 1980, 176, 24)),
      finding('card-02', at(356, 1972, 176, 100)), finding('card-01', at(160, 1972, 176, 100)),
      finding('title-02', at(356, 2004, 176, 40)), finding('title-01', at(160, 2004, 176, 20)),
    ];
    expect(ids(inReadingOrder(detected))).toEqual(['card-01', '01', 'title-01', 'card-02', '02', 'title-02']);
  });

  it('lists a finding with no box after the positioned ones, in the audit\'s order', () => {
    const detected = [finding('b', at(0, 500)), finding('b-note', null), finding('a', at(0, 100))];
    expect(ids(inReadingOrder(detected))).toEqual(['a', 'b', 'b-note']);
    expect(ids(inReadingOrder([finding('n1', null), finding('p', at(0, 5)), finding('n2', null)]))).toEqual(['p', 'n1', 'n2']);
  });

  it('keeps the audit\'s order when nothing can be measured, and never mutates its input', () => {
    const detected = [finding('x', null), finding('y', null), finding('z', null)];
    const before = ids(detected);
    expect(ids(inReadingOrder(detected))).toEqual(['x', 'y', 'z']);
    expect(ids(detected)).toEqual(before);
  });

  it('only reorders — every finding comes back once, unchanged', () => {
    const detected = [finding('c', at(300, 10)), finding('a', at(100, 10)), finding('b', at(200, 300))];
    const out = inReadingOrder(detected);
    expect(out).toHaveLength(3);
    for (const f of detected) expect(out).toContain(f);
  });
});
