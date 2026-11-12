import { describe, expect, it } from 'vitest';
import { buildNeedsReviewCards, buildRootCauseCards, cardStatusColor, categorizeIssue, severityCardColor } from '../../src/figma/publish-plan.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';

/**
 * Regression protection for the reference-template correction (market-entry-real-1's approved
 * card layout): 02 Root Causes / 03 Component Findings / 04 Needs Review / 05 Global Components
 * must render as the SAME evidence-card format as the reference file — never a raw table. These
 * tests lock the card content/color/dedup rules in code so the next audit can't silently
 * regress back to a spreadsheet-style page.
 */

let seq = 0;
function finding(over: Partial<Finding> & { classification: Finding['classification'] }): Finding {
  seq++;
  const base: Finding = {
    identity: { auditId: 'a', runId: 'run-1', findingId: `f-${seq}`, timestamp: '2026-09-15T10:00:00.000Z', dsRegistryVersion: 'ds', policyVersion: 'p' },
    location: { url: 'u', pageId: 'p1', pageName: 'P1', templateFamily: null, section: 'Body', captureState: 'default' },
    component: { productionType: 'button', productionLabel: 'x', dsComponent: 'Button', dsVariant: 'primary', signature: `sig-${seq}` },
    classification: over.classification,
    comparison: { mismatches: [], ruleViolations: [] },
    quality: {
      severity: 'HIGH',
      confidence: 0.9,
      confidenceBand: 'HIGH',
      escalationStatus: 'NONE',
      escalationReasons: [],
      evidence: [{ kind: 'element-screenshot', ref: `/tmp/el-${seq}.png`, note: null, box: { x: 0, y: seq * 10, width: 10, height: 10 } }],
      visualVerdict: 'NOT_CHECKED',
    },
    action: { recommendation: 'fix it', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: over.classification, delta: null, previousRunId: null },
  };
  return { ...base, ...over, identity: { ...base.identity, ...(over.identity ?? {}) }, quality: { ...base.quality, ...(over.quality ?? {}) }, component: { ...base.component, ...(over.component ?? {}) } };
}

const ruleViolation = (ruleId: string, title: string, severity?: Finding['quality']['severity']) => ({ ruleId, title, why: `${ruleId} broken`, severity });

describe('cardStatusColor — the reference file\'s 2-tone card scheme, distinct from the 4-tone marker scheme', () => {
  it('INCORRECT is RED, everything else marker-eligible is AMBER', () => {
    expect(cardStatusColor('INCORRECT')).toBe('RED');
    expect(cardStatusColor('DEVIATION')).toBe('AMBER');
    expect(cardStatusColor('NEEDS_REVIEW')).toBe('AMBER');
    expect(cardStatusColor('UNVERIFIED')).toBe('AMBER');
  });
});

describe('severityCardColor — Root Causes category-pill color', () => {
  it('HIGH/CRITICAL is RED, MEDIUM is AMBER, LOW/INFO is GRAY', () => {
    expect(severityCardColor('CRITICAL')).toBe('RED');
    expect(severityCardColor('HIGH')).toBe('RED');
    expect(severityCardColor('MEDIUM')).toBe('AMBER');
    expect(severityCardColor('LOW')).toBe('GRAY');
    expect(severityCardColor('INFO')).toBe('GRAY');
  });
});

describe('categorizeIssue — presentational bucket, not a new classification', () => {
  it('categorizes a typography-worded rule as Typography', () => {
    expect(categorizeIssue('Two-Font Pairing (Serif + Sans)', ['button'])).toBe('Typography');
  });
  it('categorizes a radius-worded rule as Radius/Shape', () => {
    expect(categorizeIssue('Border Radius Decision Table', ['button'])).toBe('Radius/Shape');
  });
  it('falls back to the affected component type for a property-drift group with no rule', () => {
    expect(categorizeIssue(null, ['input'])).toBe('Forms/Inputs');
    expect(categorizeIssue(null, ['button'])).toBe('Buttons');
  });
});

describe('buildRootCauseCards — page-wide rule dedup, multi-type affected list', () => {
  it('groups the SAME rule across DIFFERENT component types into one card with a multi-type affected list', () => {
    const findings = [
      finding({ classification: 'INCORRECT', component: { productionType: 'button', productionLabel: 'x', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-a' }, comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Off-DS typeface')] } }),
      finding({ classification: 'INCORRECT', component: { productionType: 'eyebrow', productionLabel: 'x', dsComponent: null, dsVariant: null, signature: 'sig-b' }, comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Off-DS typeface')] } }),
      finding({ classification: 'INCORRECT', component: { productionType: 'nav-link', productionLabel: 'x', dsComponent: null, dsVariant: null, signature: 'sig-c' }, comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Off-DS typeface')] } }),
    ];
    const cards = buildRootCauseCards(findings);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.occurrences).toBe(3);
    expect(cards[0]!.affectedTypes.sort()).toEqual(['button', 'eyebrow', 'nav-link']);
    expect(cards[0]!.category).toBe('Typography');
  });

  it('never claims a finding for two cards (largest group wins, same principle as buildMarkerGroups)', () => {
    const shared = finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'A'), ruleViolation('R9.9', 'B, solo')] } });
    const others = Array.from({ length: 2 }, () => finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'A')] } }));
    const cards = buildRootCauseCards([shared, ...others]);
    expect(cards).toHaveLength(1); // R1.4 (3 members) claims `shared`; R9.9 (1 member, already claimed) gets no card
    expect(cards[0]!.occurrences).toBe(3);
  });

  it('produces a card even for a single-occurrence group (uncapped, unlike buildMarkerGroups)', () => {
    const cards = buildRootCauseCards([finding({ classification: 'DEVIATION', comparison: { mismatches: [{ property: 'padding', actual: '10px', expected: '8px', expectedToken: null, comparison: 'exact', delta: null }], ruleViolations: [] } })]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.occurrences).toBe(1);
  });

  it('never includes MATCH/NEEDS_REVIEW/UNVERIFIED findings — Root Causes is INCORRECT/DEVIATION only', () => {
    const cards = buildRootCauseCards([finding({ classification: 'MATCH' }), finding({ classification: 'NEEDS_REVIEW' }), finding({ classification: 'UNVERIFIED' })]);
    expect(cards).toHaveLength(0);
  });
});

describe('buildNeedsReviewCards — curated, diversity-sampled, true count always reported', () => {
  it('never dumps every finding — caps at max and reports the true total', () => {
    const findings = Array.from({ length: 30 }, () => finding({ classification: 'NEEDS_REVIEW' }));
    const { cards, total } = buildNeedsReviewCards(findings, { max: 8 });
    expect(cards).toHaveLength(8);
    expect(total).toBe(30);
  });

  it('samples for diversity across component types rather than taking the first N of one repeated type', () => {
    const buttons = Array.from({ length: 20 }, () => finding({ classification: 'NEEDS_REVIEW', component: { productionType: 'button', productionLabel: 'x', dsComponent: null, dsVariant: null, signature: `sig-btn-${Math.random()}` } }));
    const cards2 = [finding({ classification: 'NEEDS_REVIEW', component: { productionType: 'card', productionLabel: 'x', dsComponent: null, dsVariant: null, signature: 'sig-card' } })];
    const { cards } = buildNeedsReviewCards([...buttons, ...cards2], { max: 4 });
    expect(cards.map((c) => c.productionType)).toContain('card'); // the single non-button type must appear, not be crowded out
  });

  it('excludes findings with no evidence screenshot — never a card with nothing to show', () => {
    const noEvidence = finding({ classification: 'UNVERIFIED', quality: { severity: 'INFO', confidence: 0, confidenceBand: 'LOW', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' } });
    const { cards, total } = buildNeedsReviewCards([noEvidence]);
    expect(cards).toHaveLength(0);
    expect(total).toBe(0);
  });
});
