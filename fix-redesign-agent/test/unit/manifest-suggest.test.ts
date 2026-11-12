import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import { classifyMismatches, suggestBucket, type SuggestInput } from '../../src/manifest/suggest.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

/**
 * Every rule (R1–R8) in suggestBucket's decision table (§9.1, Decision Log #24) — first match
 * wins, so each case is built to fall through the earlier rules deliberately. Rule ids and
 * confidence read straight from src/manifest/suggest.ts, not invented.
 */

function withComponent(finding: Finding, component: Partial<Finding['component']>): Finding {
  return { ...finding, component: { ...finding.component, ...component } };
}
function withAction(finding: Finding, action: Partial<Finding['action']>): Finding {
  return { ...finding, action: { ...finding.action, ...action } };
}
function withReview(finding: Finding, review: Finding['review']): Finding {
  return { ...finding, review };
}

const baseInput = (overrides: Partial<SuggestInput> = {}): Omit<SuggestInput, 'finding'> => ({
  instanceCount: 1,
  verified: false,
  plausibilityBar: 0.85,
  reuse: 'single',
  ...overrides,
});

describe('classifyMismatches', () => {
  it('none when there are no mismatches', () => {
    expect(classifyMismatches([])).toBe('none');
  });
  it('cosmetic when every mismatch is a cosmetic property', () => {
    expect(classifyMismatches([{ property: 'color' }, { property: 'padding-left' }])).toBe('cosmetic');
  });
  it('structural when any mismatch is a non-cosmetic property', () => {
    expect(classifyMismatches([{ property: 'color' }, { property: 'display' }])).toBe('structural');
  });
  it('structural when every mismatch is non-cosmetic', () => {
    expect(classifyMismatches([{ property: 'display' }, { property: 'position' }])).toBe('structural');
  });
});

describe('suggestBucket — decision table R1–R8', () => {
  it('R1: a registryUpdateRef routes to new-component regardless of classification', () => {
    const finding = withAction(makeFinding({ findingId: 'a'.repeat(32), classification: 'INCORRECT' }), { registryUpdateRef: 'reg-42' });
    const s = suggestBucket({ finding, ...baseInput() });
    expect(s).toMatchObject({ bucket: 'new-component', rule: 'R1', confidence: 'high' });
  });

  it('R1: classification DS_CANDIDATE routes to new-component', () => {
    const finding = makeFinding({ findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE' });
    const s = suggestBucket({ finding, ...baseInput() });
    expect(s).toMatchObject({ bucket: 'new-component', rule: 'R1' });
  });

  it('R1: classification NEW_COMPONENT routes to new-component', () => {
    const finding = makeFinding({ findingId: 'a'.repeat(32), classification: 'NEW_COMPONENT' });
    const s = suggestBucket({ finding, ...baseInput() });
    expect(s).toMatchObject({ bucket: 'new-component', rule: 'R1' });
  });

  it('R2: classification MATCH routes to existing-correct, high confidence', () => {
    const finding = makeFinding({ findingId: 'a'.repeat(32), classification: 'MATCH' });
    const s = suggestBucket({ finding, ...baseInput() });
    expect(s).toMatchObject({ bucket: 'existing-correct', rule: 'R2', confidence: 'high' });
  });

  it('R3: DEVIATION/INCORRECT + matched DS component + verified fixed -> page-fix-only, high confidence', () => {
    const finding = withComponent(makeFinding({ findingId: 'a'.repeat(32), classification: 'INCORRECT' }), { dsComponent: 'Button' });
    const s = suggestBucket({ finding, ...baseInput({ verified: true }) });
    expect(s).toMatchObject({ bucket: 'page-fix-only', rule: 'R3', confidence: 'high' });
    expect(s.reason).toMatch(/verified/i);
  });

  it('R3: unverified but only cosmetic mismatches -> page-fix-only, medium confidence', () => {
    const finding = withComponent(
      makeFinding({ findingId: 'a'.repeat(32), classification: 'DEVIATION', mismatches: [{ property: 'color', actual: 'red', expected: 'blue', expectedToken: null, comparison: 'exact', delta: null }] }),
      { dsComponent: 'Button' },
    );
    const s = suggestBucket({ finding, ...baseInput({ verified: false }) });
    expect(s).toMatchObject({ bucket: 'page-fix-only', rule: 'R3', confidence: 'medium' });
    expect(s.reason).toMatch(/cosmetic/i);
  });

  it('R4: unverified structural mismatch against a matched DS component -> existing-needs-update, low confidence at 1 instance', () => {
    const finding = withComponent(
      makeFinding({ findingId: 'a'.repeat(32), classification: 'INCORRECT', mismatches: [{ property: 'display', actual: 'inline', expected: 'flex', expectedToken: null, comparison: 'exact', delta: null }] }),
      { dsComponent: 'Button' },
    );
    const s = suggestBucket({ finding, ...baseInput({ verified: false, instanceCount: 1 }) });
    expect(s).toMatchObject({ bucket: 'existing-needs-update', rule: 'R4', confidence: 'low' });
    expect(s.reason).not.toMatch(/repeats/);
  });

  it('R4: repeating structural mismatch (>=2 instances) -> medium confidence, reason names the repeat count', () => {
    const finding = withComponent(
      makeFinding({ findingId: 'a'.repeat(32), classification: 'INCORRECT', mismatches: [{ property: 'display', actual: 'inline', expected: 'flex', expectedToken: null, comparison: 'exact', delta: null }] }),
      { dsComponent: 'Button' },
    );
    const s = suggestBucket({ finding, ...baseInput({ verified: false, instanceCount: 3 }) });
    expect(s).toMatchObject({ bucket: 'existing-needs-update', rule: 'R4', confidence: 'medium' });
    expect(s.reason).toContain('repeats 3×');
  });

  it('R5: UNVERIFIED classification with a matched DS component -> existing-correct, low confidence', () => {
    const finding = withComponent(makeFinding({ findingId: 'a'.repeat(32), classification: 'UNVERIFIED' }), { dsComponent: 'Button' });
    const s = suggestBucket({ finding, ...baseInput() });
    expect(s).toMatchObject({ bucket: 'existing-correct', rule: 'R5', confidence: 'low' });
  });

  it('R6: top possible-match score at/above the plausibility bar -> existing-needs-update, medium confidence', () => {
    const finding = withReview(withComponent(makeFinding({ findingId: 'a'.repeat(32), classification: 'NEEDS_REVIEW' }), { dsComponent: null }), {
      status: 'NEEDS_REVIEW',
      reason: 'no exact match',
      node: 'n1',
      signals: [],
      possibleMatches: [{ dsComponent: 'Card', dsFile: 'core-v2/src/molecules/Card.tsx', dsVariant: null, score: 0.9, why: 'similar shape' }],
      observed: [],
    });
    const s = suggestBucket({ finding, ...baseInput({ plausibilityBar: 0.85, instanceCount: 1, reuse: 'single' }) });
    expect(s).toMatchObject({ bucket: 'existing-needs-update', rule: 'R6', confidence: 'medium' });
    expect(s.reason).toContain('0.90');
  });

  it('R7: no plausible match but the pattern repeats on this page (>=2 instances) -> new-component, medium confidence', () => {
    const finding = withComponent(makeFinding({ findingId: 'a'.repeat(32), classification: 'NEEDS_REVIEW' }), { dsComponent: null });
    const s = suggestBucket({ finding, ...baseInput({ plausibilityBar: 0.85, instanceCount: 2, reuse: 'repeated-on-page' }) });
    expect(s).toMatchObject({ bucket: 'new-component', rule: 'R7', confidence: 'medium' });
    expect(s.reason).toMatch(/repeats 2×/);
  });

  it('R7: no plausible match but the pattern recurs on other audited pages -> new-component, reason names cross-page recurrence', () => {
    const finding = withComponent(makeFinding({ findingId: 'a'.repeat(32), classification: 'NEEDS_REVIEW' }), { dsComponent: null });
    const s = suggestBucket({ finding, ...baseInput({ plausibilityBar: 0.85, instanceCount: 1, reuse: 'multi-page' }) });
    expect(s).toMatchObject({ bucket: 'new-component', rule: 'R7' });
    expect(s.reason).toMatch(/recurs on other audited pages/);
  });

  it('R8: single instance, no plausible match -> unresolved, low confidence (a legitimate outcome, never forced)', () => {
    const finding = withComponent(makeFinding({ findingId: 'a'.repeat(32), classification: 'NEEDS_REVIEW' }), { dsComponent: null });
    const s = suggestBucket({ finding, ...baseInput({ plausibilityBar: 0.85, instanceCount: 1, reuse: 'single' }) });
    expect(s).toMatchObject({ bucket: 'unresolved', rule: 'R8', confidence: 'low' });
  });
});
