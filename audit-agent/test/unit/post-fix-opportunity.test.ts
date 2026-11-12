import { describe, expect, it } from 'vitest';
import { computePostFixOpportunities } from '../../src/agents/b6-new-component-evaluator/post-fix-opportunity.ts';
import type { Finding, PossibleMatch } from '../../src/skills/s0-result-contract.ts';

/**
 * Post-Fix Component Opportunity is a render-time inference over already-persisted findings —
 * these tests exercise the pure function directly, with no graph/session/LLM involved, mirroring
 * how B6's own deterministic gate (`PLAUSIBLE_MATCH_SCORE`) is reused rather than reinvented.
 */

let counter = 0;
function finding(over: Partial<Finding> & { classification: Finding['classification'] }): Finding {
  counter += 1;
  const base: Finding = {
    identity: { auditId: 'audit-1', runId: 'run-1', findingId: `f${counter}`.padEnd(32, '0'), timestamp: '2026-09-21T10:00:00.000Z', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1' },
    location: { url: 'https://example.com/a', pageId: 'p1', pageName: 'A', templateFamily: null, section: 'Header', captureState: 'default' },
    component: { productionType: 'nav-link', productionLabel: 'Home', dsComponent: null, dsVariant: null, signature: 'sig-1' },
    classification: over.classification,
    comparison: { mismatches: [], ruleViolations: [] },
    quality: { severity: 'HIGH', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
    action: { recommendation: 'Decide which Design System component this is', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: over.classification, delta: null, previousRunId: null },
  };
  return { ...base, ...over, identity: { ...base.identity, ...(over.identity ?? {}) }, component: { ...base.component, ...(over.component ?? {}) } };
}

const R1_4 = { ruleId: 'R1.4', title: 'Two-Font Pairing', why: 'set in Arial — not a Design System typeface', severity: 'HIGH' as const };
const R3_6 = { ruleId: 'R3.6', title: 'Border Radius Decision Table', why: 'border-radius 3px is not on the Design System radius scale', severity: 'LOW' as const };

function b6Incorrect(over: Partial<Finding> = {}, violations: Finding['comparison']['ruleViolations'] = [R1_4], possibleMatches: PossibleMatch[] = []): Finding {
  return finding({
    classification: 'INCORRECT',
    comparison: { mismatches: [], ruleViolations: violations },
    review: { status: 'NEEDS_REVIEW', reason: 'the DS component is for a human to name', node: 'B6', signals: [], possibleMatches, observed: [] },
    ...over,
  });
}

describe('computePostFixOpportunities — a separate, render-time hypothesis, never a B6 classification change', () => {
  it('surfaces a repeated, unmatched pattern whose only known blocker is a measured foundation violation', () => {
    const findings = [b6Incorrect({ component: { productionType: 'nav-link', productionLabel: 'Home', dsComponent: null, dsVariant: null, signature: 'sig-a' } }), b6Incorrect({ component: { productionType: 'nav-link', productionLabel: 'Home', dsComponent: null, dsVariant: null, signature: 'sig-a' } })];
    const result = computePostFixOpportunities(findings);
    expect(result).toHaveLength(1);
    expect(result[0]!.instances).toBe(2);
    expect(result[0]!.productionType).toBe('nav-link');
    expect(result[0]!.whatToFixFirst).toEqual(['Two-Font Pairing: set in Arial — not a Design System typeface']);
    expect(result[0]!.ruledOutDsComponent).toBeNull();
    expect(result[0]!.confidence).toBe('MEDIUM'); // only 2 instances — below the instances>=3 bar for HIGH
  });

  it('reports HIGH confidence when 3+ instances share the identical set of violations', () => {
    const sig = { productionType: 'button', productionLabel: 'Get in Touch', dsComponent: null, dsVariant: null, signature: 'sig-b' };
    const findings = [b6Incorrect({ component: sig }), b6Incorrect({ component: sig }), b6Incorrect({ component: sig })];
    const result = computePostFixOpportunities(findings);
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe('HIGH');
  });

  it('names the representative finding and lists the others as relatedFindingIds — never duplicating finding content', () => {
    const sig = { productionType: 'link', productionLabel: 'Market Entry', dsComponent: null, dsVariant: null, signature: 'sig-c' };
    const findings = [b6Incorrect({ component: sig }), b6Incorrect({ component: sig }), b6Incorrect({ component: sig })];
    const result = computePostFixOpportunities(findings);
    expect(result[0]!.representativeFindingId).toBe(findings[0]!.identity.findingId);
    expect(result[0]!.relatedFindingIds).toEqual([findings[1]!.identity.findingId, findings[2]!.identity.findingId]);
  });

  it('excludes a group where any instance has a plausible existing DS look-alike (score >= 0.35) — fixing it would just conform to that component', () => {
    const sig = { productionType: 'button', productionLabel: 'CTA', dsComponent: null, dsVariant: null, signature: 'sig-d' };
    const plausible: PossibleMatch = { dsComponent: 'Button', dsFile: 'atoms/Button.tsx', dsVariant: 'primary', score: 0.4, why: 'shares 3 of 4 governed properties' };
    const findings = [b6Incorrect({ component: sig }, [R1_4], [plausible]), b6Incorrect({ component: sig })];
    expect(computePostFixOpportunities(findings)).toHaveLength(0);
  });

  it('still surfaces the opportunity when a look-alike was checked but scored below the plausible threshold, and names it as ruled out', () => {
    const sig = { productionType: 'button', productionLabel: 'CTA', dsComponent: null, dsVariant: null, signature: 'sig-e' };
    const weak: PossibleMatch = { dsComponent: 'Button', dsFile: 'atoms/Button.tsx', dsVariant: 'primary', score: 0.3, why: 'shares 1 of 4 governed properties' };
    const findings = [b6Incorrect({ component: sig }, [R1_4], [weak]), b6Incorrect({ component: sig }, [R1_4], [weak])];
    const result = computePostFixOpportunities(findings);
    expect(result).toHaveLength(1);
    expect(result[0]!.ruledOutDsComponent).toBe('Button');
  });

  it('excludes a single, non-repeated instance — the same repetition bar B6 itself requires for DS_CANDIDATE', () => {
    const findings = [b6Incorrect()];
    expect(computePostFixOpportunities(findings)).toHaveLength(0);
  });

  it('excludes a group already containing a MATCH finding — an existing DS component already fits this signature', () => {
    const sig = { productionType: 'button', productionLabel: 'CTA', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-f' };
    const findings = [finding({ classification: 'MATCH', component: sig }), b6Incorrect({ component: { ...sig, dsComponent: null } })];
    expect(computePostFixOpportunities(findings)).toHaveLength(0);
  });

  it('excludes a group already classified NEW_COMPONENT or DS_CANDIDATE today — never a duplicate suggestion', () => {
    const sig = { productionType: 'chip', productionLabel: 'Filter', dsComponent: null, dsVariant: null, signature: 'sig-g' };
    const already = finding({ classification: 'DS_CANDIDATE', component: sig });
    const findings = [already, b6Incorrect({ component: sig })];
    expect(computePostFixOpportunities(findings)).toHaveLength(0);
  });

  it('never surfaces a NEEDS_REVIEW-only group — no structured expected-value data exists without re-auditing', () => {
    const sig = { productionType: 'card', productionLabel: 'Report card', dsComponent: null, dsVariant: null, signature: 'sig-h' };
    const findings = [
      finding({ classification: 'NEEDS_REVIEW', component: sig, review: { status: 'NEEDS_REVIEW', reason: 'no comparable DS property', node: 'B6', signals: [], possibleMatches: [], observed: [] } }),
      finding({ classification: 'NEEDS_REVIEW', component: sig, review: { status: 'NEEDS_REVIEW', reason: 'no comparable DS property', node: 'B6', signals: [], possibleMatches: [], observed: [] } }),
    ];
    expect(computePostFixOpportunities(findings)).toHaveLength(0);
  });

  it('never surfaces a group whose INCORRECT findings came from B4 (a matched component\'s own deviation), not B6', () => {
    const sig = { productionType: 'button', productionLabel: 'CTA', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-i' };
    const findings = [
      finding({ classification: 'INCORRECT', component: sig, comparison: { mismatches: [], ruleViolations: [R1_4] } }),
      finding({ classification: 'INCORRECT', component: sig, comparison: { mismatches: [], ruleViolations: [R1_4] } }),
    ];
    expect(computePostFixOpportunities(findings)).toHaveLength(0);
  });

  it('lists one distinct entry per violation type, deduped, even when several instances share the exact same violation', () => {
    const sig = { productionType: 'section-heading', productionLabel: 'IPO Advisory', dsComponent: null, dsVariant: null, signature: 'sig-j' };
    const findings = [b6Incorrect({ component: sig }, [R1_4, R3_6]), b6Incorrect({ component: sig }, [R1_4, R3_6]), b6Incorrect({ component: sig }, [R1_4])];
    const result = computePostFixOpportunities(findings);
    expect(result).toHaveLength(1);
    expect(result[0]!.whatToFixFirst).toEqual(['Two-Font Pairing: set in Arial — not a Design System typeface', 'Border Radius Decision Table: border-radius 3px is not on the Design System radius scale']);
    // 2 of 3 share both rule ids, 1 shares only R1.4 — not perfectly consistent, so MEDIUM despite 3 instances.
    expect(result[0]!.confidence).toBe('MEDIUM');
  });
});
