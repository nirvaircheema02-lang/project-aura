import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scoreCompliance } from '../../src/skills/s0-result-contract.ts';
import { classify, severityFor } from '../../src/skills/s5-compliance-classification.ts';
import { bandOf, escalationFor, isCalibrationSample, routesToNewComponentEvaluator } from '../../src/skills/s8-confidence-escalation-policy.ts';
import { componentSignature, isOffDomainUtilityLink, patternPath } from '../../src/skills/s3-component-taxonomy.ts';
import { compareToExpected } from '../../src/t-layer/token-comparator.ts';
import { deltaFor } from '../../src/skills/s7-audit-state-history.ts';
import { proposeRegistryUpdate, transitionRegistryUpdate } from '../../src/skills/s9-registry-update-governance.ts';
import { openDb, type Database } from '../../src/db/index.ts';
import type { Mismatch } from '../../src/skills/s0-result-contract.ts';

const mismatch = (over: Partial<Mismatch> = {}): Mismatch => ({
  property: 'height',
  actual: '44px',
  expected: '48px',
  expectedToken: '--button-height-md',
  comparison: 'length-px',
  delta: -4,
  ...over,
});

describe('S0 compliance scoring (v1.0 §13)', () => {
  it('excludes NEW_COMPONENT and DS_CANDIDATE from the denominator', () => {
    const score = scoreCompliance([
      { classification: 'MATCH' },
      { classification: 'MATCH' },
      { classification: 'DEVIATION' },
      { classification: 'INCORRECT' },
      { classification: 'NEW_COMPONENT' },
      { classification: 'DS_CANDIDATE' },
    ]);
    expect(score.compliancePercent).toBe(50); // 2 / (2+1+1)
    expect(score.newComponent).toBe(1);
    expect(score.dsCandidate).toBe(1);
  });

  it('returns null rather than 0% when nothing scoreable was found', () => {
    expect(scoreCompliance([{ classification: 'NEW_COMPONENT' }]).compliancePercent).toBeNull();
  });
});

describe('S5 classification and severity', () => {
  it('a rule violation is INCORRECT, not DEVIATION — even with no measured mismatch', () => {
    expect(classify({ hasDsMatch: true, mismatches: [], ruleViolations: [{ ruleId: 'R1.2', title: 't', why: 'w' }] })).toBe('INCORRECT');
  });

  it('measured differences alone are DEVIATION; nothing at all is MATCH', () => {
    expect(classify({ hasDsMatch: true, mismatches: [mismatch()], ruleViolations: [] })).toBe('DEVIATION');
    expect(classify({ hasDsMatch: true, mismatches: [], ruleViolations: [] })).toBe('MATCH');
  });

  it('brand-identity rule violations are CRITICAL', () => {
    const input = { hasDsMatch: true, mismatches: [], ruleViolations: [{ ruleId: 'R1.2', title: 't', why: 'w' }] };
    expect(severityFor({ ...input, classification: 'INCORRECT' })).toBe('CRITICAL');
  });

  it('severity is magnitude-aware — a 4px drift and a 20px drift differ', () => {
    const small = severityFor({ hasDsMatch: true, ruleViolations: [], mismatches: [mismatch({ delta: -4 })], classification: 'DEVIATION' });
    const large = severityFor({ hasDsMatch: true, ruleViolations: [], mismatches: [mismatch({ delta: -20 })], classification: 'DEVIATION' });
    expect(small).toBe('LOW');
    expect(large).toBe('MEDIUM');
  });

  it('a wrong typeface outranks a small spacing drift', () => {
    expect(
      severityFor({
        hasDsMatch: true,
        ruleViolations: [],
        mismatches: [mismatch({ property: 'font-family', actual: 'Arial', expected: 'DM Sans', comparison: 'exact', delta: null })],
        classification: 'DEVIATION',
      }),
    ).toBe('HIGH');
  });
});

describe('S8 confidence policy', () => {
  it('bands follow the documented thresholds', () => {
    expect(bandOf(0.9)).toBe('HIGH');
    expect(bandOf(0.85)).toBe('HIGH');
    expect(bandOf(0.6)).toBe('MEDIUM');
    expect(bandOf(0.49)).toBe('LOW');
  });

  it('a LOW-confidence match routes to B6 instead of becoming a shaky Deviation (§3)', () => {
    expect(routesToNewComponentEvaluator({ dsComponent: 'Button', confidence: 0.3 })).toBe(true);
    expect(routesToNewComponentEvaluator({ dsComponent: 'Button', confidence: 0.9 })).toBe(false);
    expect(routesToNewComponentEvaluator({ dsComponent: null, confidence: 0.99 })).toBe(true);
  });

  it('escalates low confidence, unresolved placeholders, and visual disagreement — with reasons', () => {
    expect(escalationFor({ findingId: 'f1', confidence: 0.2 }).reasons).toContain('LOW_CONFIDENCE');
    expect(escalationFor({ findingId: 'f1', confidence: 0.95, containsPlaceholderValue: true }).reasons).toContain('PLACEHOLDER_VALUE');
    expect(escalationFor({ findingId: 'f1', confidence: 0.95, visualVerdict: 'FALSE_POSITIVE' }).reasons).toContain('VISUAL_FALSE_POSITIVE');
  });

  it('calibration sampling is deterministic per finding, so a re-run does not churn the review queue', () => {
    const first = isCalibrationSample('finding-abc');
    expect(isCalibrationSample('finding-abc')).toBe(first);
    const sampled = Array.from({ length: 2000 }, (_, i) => isCalibrationSample(`f${i}`)).filter(Boolean).length;
    expect(sampled).toBeGreaterThan(40); // ~5% of 2000, loosely bounded
    expect(sampled).toBeLessThan(160);
  });
});

describe('S3 taxonomy and dedup signature', () => {
  it('repeated siblings collapse to one pattern identity', () => {
    const base = { componentType: 'card', role: 'generic', styleFacts: { display: 'block' } };
    const a = componentSignature({ ...base, structuralPath: 'main > div:nth-of-type(1)' });
    const b = componentSignature({ ...base, structuralPath: 'main > div:nth-of-type(3)' });
    expect(a).toBe(b);
    expect(patternPath('main > div:nth-of-type(3) > span')).toBe('main > div > span');
  });

  it('different patterns keep different signatures', () => {
    const a = componentSignature({ componentType: 'card', role: 'generic', styleFacts: {}, structuralPath: 'main > div' });
    const b = componentSignature({ componentType: 'button', role: 'button', styleFacts: {}, structuralPath: 'main > button' });
    expect(a).not.toBe(b);
  });

  it('excludes off-domain utility links but keeps genuine off-site CTAs', () => {
    const origin = 'https://www.kenresearch.com';
    expect(isOffDomainUtilityLink({ href: 'https://forms.office.com/t', auditedOrigin: origin, componentType: 'link', label: 'IT Support' })).toBe(true);
    expect(isOffDomainUtilityLink({ href: 'https://calendly.com/x', auditedOrigin: origin, componentType: 'link', label: 'Book a discovery call' })).toBe(false);
    expect(isOffDomainUtilityLink({ href: '/report-store', auditedOrigin: origin, componentType: 'link', label: 'Reports' })).toBe(false);
  });
});

describe('Token comparator (deterministic — code decides, not the model)', () => {
  const tokens = new Map([
    ['--button-height-md', '48px'],
    ['--color-brand-red', '#b01f24'],
  ]);

  it('catches a 4px height difference and reports the delta', () => {
    const { mismatches } = compareToExpected({
      actual: { height: '44px' },
      expected: [{ property: 'height', token: '--button-height-md', literal: null }],
      effectiveTokens: tokens,
      rootFontSizePx: 16,
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ actual: '44px', expected: '48px', delta: -4, comparison: 'length-px' });
  });

  it('treats sub-pixel jitter as compliant', () => {
    const { mismatches } = compareToExpected({
      actual: { height: '47.6px' },
      expected: [{ property: 'height', token: '--button-height-md', literal: null }],
      effectiveTokens: tokens,
      rootFontSizePx: 16,
    });
    expect(mismatches).toEqual([]);
  });

  it('compares colors perceptually, not as strings — rgb() vs hex for the same color passes', () => {
    const { mismatches } = compareToExpected({
      actual: { color: 'rgb(176, 31, 36)' },
      expected: [{ property: 'color', token: '--color-brand-red', literal: null }],
      effectiveTokens: tokens,
      rootFontSizePx: 16,
    });
    expect(mismatches).toEqual([]);
  });

  it('reports an expectation naming an undefined token as unresolved, never as compliant', () => {
    const { mismatches, unresolved } = compareToExpected({
      actual: { height: '44px' },
      expected: [{ property: 'height', token: '--not-a-real-token', literal: null }],
      effectiveTokens: tokens,
      rootFontSizePx: 16,
    });
    expect(mismatches).toEqual([]);
    expect(unresolved[0]?.reason).toContain('not defined in the Design System');
  });
});

describe('S7 re-audit delta model (v1.0 §10)', () => {
  it('maps previous/current status onto the four deltas', () => {
    expect(deltaFor(null, 'DEVIATION')).toBe('NEW_ISSUE');
    expect(deltaFor('DEVIATION', 'DEVIATION')).toBe('STILL_OPEN');
    expect(deltaFor('DEVIATION', 'MATCH')).toBe('RESOLVED');
    expect(deltaFor('MATCH', 'INCORRECT')).toBe('REGRESSION');
    expect(deltaFor('MATCH', 'MATCH')).toBe('UNCHANGED_COMPLIANT');
  });
});

describe('S9 registry update governance', () => {
  let db: Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-agent-s9-'));
    db = openDb(join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('absorbs a repeated pattern into the existing live proposal instead of duplicating it', () => {
    const first = proposeRegistryUpdate(db, { candidateRef: 'cand-1', signature: 'sig-a', proposedBy: 'B6' });
    const second = proposeRegistryUpdate(db, { candidateRef: 'cand-2', signature: 'sig-a', proposedBy: 'B6' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.candidateRef).toBe('cand-1');
    expect(db.prepare('SELECT COUNT(*) as n FROM registry_update_requests').get()).toEqual({ n: 1 });
  });

  it('enforces the lifecycle and refuses an out-of-order transition', () => {
    proposeRegistryUpdate(db, { candidateRef: 'cand-1', signature: 'sig-a', proposedBy: 'B6' });
    expect(() => transitionRegistryUpdate(db, 'cand-1', 'MERGED', 'design@kenresearch.com')).toThrow(/illegal transition/);
    transitionRegistryUpdate(db, 'cand-1', 'UNDER_REVIEW', 'design@kenresearch.com');
    transitionRegistryUpdate(db, 'cand-1', 'APPROVED', 'design@kenresearch.com');
    transitionRegistryUpdate(db, 'cand-1', 'MERGED', 'design@kenresearch.com');
    expect(db.prepare('SELECT status FROM registry_update_requests WHERE candidate_ref = ?').get('cand-1')).toMatchObject({ status: 'MERGED' });
  });

  // Third-pass review CH-2: candidateRef is DETERMINISTIC per pattern signature (`cand-<sig>`,
  // B6), so a re-audit proposes the exact same ref every time — a REJECTED (or APPROVED/MERGED)
  // decision must never be re-inserted under that primary key.
  it('re-proposing a REJECTED pattern never crashes on the primary key — it returns the decision as-is', () => {
    proposeRegistryUpdate(db, { candidateRef: 'cand-1', signature: 'sig-a', proposedBy: 'B6' });
    transitionRegistryUpdate(db, 'cand-1', 'REJECTED', 'design@kenresearch.com');

    const reproposed = proposeRegistryUpdate(db, { candidateRef: 'cand-1', signature: 'sig-a', proposedBy: 'B6' });
    expect(reproposed).toEqual({ candidateRef: 'cand-1', created: false, status: 'REJECTED' });
    expect(db.prepare('SELECT COUNT(*) as n FROM registry_update_requests').get()).toEqual({ n: 1 });

    // Also true for a fully MERGED pattern — a re-audit of the same page must not re-propose it either.
    proposeRegistryUpdate(db, { candidateRef: 'cand-2', signature: 'sig-b', proposedBy: 'B6' });
    transitionRegistryUpdate(db, 'cand-2', 'UNDER_REVIEW', 'design@kenresearch.com');
    transitionRegistryUpdate(db, 'cand-2', 'APPROVED', 'design@kenresearch.com');
    transitionRegistryUpdate(db, 'cand-2', 'MERGED', 'design@kenresearch.com');
    expect(proposeRegistryUpdate(db, { candidateRef: 'cand-2', signature: 'sig-b', proposedBy: 'B6' })).toMatchObject({ created: false, status: 'MERGED' });
  });

  it('a rejected proposal frees the signature for a future proposal', () => {
    proposeRegistryUpdate(db, { candidateRef: 'cand-1', signature: 'sig-a', proposedBy: 'B6' });
    transitionRegistryUpdate(db, 'cand-1', 'REJECTED', 'design@kenresearch.com');
    const again = proposeRegistryUpdate(db, { candidateRef: 'cand-2', signature: 'sig-a', proposedBy: 'B6' });
    expect(again.created).toBe(true);
  });
});

describe('pre-run review regressions (pure)', () => {
  it('ref normalization accepts what a model echoes back, and nothing else', async () => {
    const { normalizeRef } = await import('../../src/agents/refs.ts');
    expect(normalizeRef('e63')).toBe('e63');
    expect(normalizeRef('ref=e63')).toBe('e63');
    expect(normalizeRef('[ref=e63]')).toBe('e63');
    expect(normalizeRef(' E63 ')).toBe('e63');
    expect(normalizeRef('f1e5')).toBeNull(); // frame refs are not produced by the snapshot parser
    expect(normalizeRef('button')).toBeNull();
  });

  it('rule ids normalize to the D5 shape', async () => {
    const { normalizeRuleId } = await import('../../src/agents/b4-compliance-auditor/index.ts');
    expect(normalizeRuleId('Rule R1.2')).toBe('R1.2');
    expect(normalizeRuleId('r4.1.1')).toBe('R4.1.1');
    expect(normalizeRuleId('R1')).toBeNull();
  });

  it('B5 resolves a finding to its EXACT element, not the first instance sharing its signature', async () => {
    const { componentForFinding } = await import('../../src/agents/b5-visual-verifier/index.ts');
    const card = (elId: string) => ({ elId, ref: `e${elId.length}`, signature: 'same-signature-for-all-4-cards' }) as never;
    const components = [card('s1-0'), card('s1-1'), card('s1-2'), card('s1-3')];
    const finding = { quality: { evidence: [{ kind: 'computed-style', ref: 's1-2', note: null }] } } as never;
    expect((componentForFinding(finding, components) as { elId: string }).elId).toBe('s1-2');
  });

  it('NOT_COMPARED matches are excluded from the score, and counted', () => {
    const f = (classification: 'MATCH' | 'DEVIATION', reasons: string[] = []) => ({ classification, quality: { escalationReasons: reasons } });
    const score = scoreCompliance([f('MATCH'), f('MATCH', ['NOT_COMPARED', 'MODEL_OMITTED']), f('DEVIATION')]);
    expect(score).toMatchObject({ match: 1, deviation: 1, notCompared: 1, compliancePercent: 50 });
  });

  it('an out-of-range confidence is forced LOW and flagged, never clamped to HIGH', async () => {
    const { normalizeConfidence } = await import('../../src/skills/s8-confidence-escalation-policy.ts');
    expect(normalizeConfidence(0.9)).toEqual({ value: 0.9, outOfContract: false });
    expect(normalizeConfidence(90)).toEqual({ value: 0.4, outOfContract: true });
    expect(normalizeConfidence(Number.NaN).outOfContract).toBe(true);
    expect(bandOf(normalizeConfidence(90).value)).toBe('LOW');
  });
});

describe('B1 section roots on the recorded target page (second-pass review)', () => {
  const load = async () => {
    const { readFileSync } = await import('node:fs');
    const { parseAriaSnapshot } = await import('../../src/t-layer/element-registry.ts');
    return parseAriaSnapshot(readFileSync('test/fixtures/templates/consulting-subpage/aria-snapshot.yaml', 'utf-8'));
  };

  it('records the real hierarchy: the nav sits under the 100px header wrapper', async () => {
    const els = await load();
    expect(els.find((e) => e.ref === 'e21')).toMatchObject({ parentRef: 'e2', depth: 2 });
    expect(els.find((e) => e.ref === 'e1')).toMatchObject({ parentRef: null, depth: 0 });
  });

  it('a 60px nav root is NOT promoted — it used to become the whole 9,516px page', async () => {
    const { promoteToContainer } = await import('../../src/agents/b1-page-analyzer/index.ts');
    const els = await load();
    const nav = els.find((e) => e.ref === 'e21')!;
    expect(promoteToContainer(nav, els, 9516).ref).toBe('e21');
  });

  it('a heading root is promoted to its nearest section-sized ancestor, never the page root', async () => {
    const { promoteToContainer } = await import('../../src/agents/b1-page-analyzer/index.ts');
    const els = await load();
    for (const heading of els.filter((e) => e.role === 'heading' && e.box)) {
      const root = promoteToContainer(heading, els, 9516);
      expect(root.ref).not.toBe('e1');
      expect(root.box!.height).toBeLessThanOrEqual(9516 / 2);
    }
  });

  it('the outline offers the full-width header wrapper, so the model can cite the real header', async () => {
    const { compactOutline } = await import('../../src/agents/b1-page-analyzer/index.ts');
    const els = await load();
    expect(compactOutline(els).text).toMatch(/^e2 generic \[y=0 h=100\]$/m);
  });
});

describe('sub-rule citations (second-pass review)', () => {
  it('R4.1.2 resolves to its defined parent R4.1; an invented branch still does not', async () => {
    const { resolveRuleId } = await import('../../src/agents/b4-compliance-auditor/index.ts');
    const valid = new Set(['R1.2', 'R4.1']);
    expect(resolveRuleId('R4.1.2', valid)).toBe('R4.1');
    expect(resolveRuleId('R1.2', valid)).toBe('R1.2');
    expect(resolveRuleId('R9.9', valid)).toBeNull();
    expect(resolveRuleId('R4.2.1', valid)).toBeNull();
  });
});
