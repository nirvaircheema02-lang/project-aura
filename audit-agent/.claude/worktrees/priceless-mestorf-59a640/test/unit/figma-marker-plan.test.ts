import { describe, expect, it } from 'vitest';
import { buildMarkerGroups, colorForMarkerStatus, selectGlobalComponents } from '../../src/figma/publish-plan.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';

/**
 * The approved interactive-marker system (Decision Log #32) — generalized from the manual
 * curation done for market-entry-real-1 into deterministic, reusable code. These tests are the
 * regression protection: a future audit of ANY page must get the same root-cause deduplication,
 * placement, and marker↔finding traceability without anyone hand-picking representatives again.
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
      evidence: [{ kind: 'element-screenshot', ref: `/tmp/el-${seq}.png`, note: null, box: { x: 100, y: seq * 100, width: 50, height: 30 } }],
      visualVerdict: 'NOT_CHECKED',
    },
    action: { recommendation: 'fix it', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: over.classification, delta: null, previousRunId: null },
  };
  return { ...base, ...over, identity: { ...base.identity, ...(over.identity ?? {}) }, quality: { ...base.quality, ...(over.quality ?? {}) } };
}

const ruleViolation = (ruleId: string, title: string, why = `${ruleId} broken`) => ({ ruleId, title, why });

describe('colorForMarkerStatus — status-only color, never MATCH', () => {
  it('maps the four marker-eligible statuses to their fixed colors', () => {
    expect(colorForMarkerStatus('INCORRECT')).toBe('RED');
    expect(colorForMarkerStatus('DEVIATION')).toBe('ORANGE');
    expect(colorForMarkerStatus('NEEDS_REVIEW')).toBe('AMBER');
    expect(colorForMarkerStatus('UNVERIFIED')).toBe('GRAY');
  });
  it('returns null for MATCH and neutral classifications — never a marker color for them', () => {
    expect(colorForMarkerStatus('MATCH')).toBeNull();
    expect(colorForMarkerStatus('NEW_COMPONENT')).toBeNull();
    expect(colorForMarkerStatus('DS_CANDIDATE')).toBeNull();
  });
});

describe('buildMarkerGroups — root-cause deduplication', () => {
  it('a rule violated by 5+ findings becomes exactly ONE root-cause marker, never one per finding', () => {
    const findings = Array.from({ length: 5 }, () => finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Two-Font Pairing')] } }));
    const { groups, truncated } = buildMarkerGroups(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isRootCause).toBe(true);
    expect(groups[0]!.affectedCount).toBe(5);
    expect(groups[0]!.affectedFindingIds).toHaveLength(5);
    expect(groups[0]!.color).toBe('RED');
    expect(truncated).toBe(false);
    // The representative's id must be one of the 5 real findings — never invented.
    expect(findings.map((f) => f.identity.findingId)).toContain(groups[0]!.findingId);
  });

  it('a rule violated by exactly ONE finding becomes its own individual (non-root-cause) marker', () => {
    const solo = finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation('R3.6', 'Border Radius Decision Table')] } });
    const { groups } = buildMarkerGroups([solo]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isRootCause).toBe(false);
    expect(groups[0]!.affectedCount).toBe(1);
    expect(groups[0]!.findingId).toBe(solo.identity.findingId);
  });

  it('a finding claimed by a bigger rule group never ALSO produces its own marker for a smaller co-occurring rule', () => {
    // 3 findings share R1.4 (root cause); one of them ALSO violates R3.6 alone.
    const r14only = Array.from({ length: 2 }, () => finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Two-Font Pairing')] } }));
    const both = finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Two-Font Pairing'), ruleViolation('R3.6', 'Border Radius Decision Table')] } });
    const { groups } = buildMarkerGroups([...r14only, both]);
    // R1.4 has 3 members (root cause, one marker); R3.6 has only 1 member (`both`) but it's
    // already claimed by R1.4 — so R3.6 gets NO marker of its own, and total stays at 1.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isRootCause).toBe(true);
    expect(groups[0]!.affectedCount).toBe(3);
  });

  it('property-drift findings with no rule violations group by their mismatch-property signature', () => {
    const mk = () => finding({ classification: 'DEVIATION', comparison: { mismatches: [{ property: 'font-weight', actual: '400', expected: '500', expectedToken: null, comparison: 'exact', delta: null }], ruleViolations: [] } });
    const { groups } = buildMarkerGroups([mk(), mk()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isRootCause).toBe(true);
    expect(groups[0]!.affectedCount).toBe(2);
    expect(groups[0]!.color).toBe('ORANGE');
    expect(groups[0]!.bullets[0]).toContain('font-weight: 400 → 500');
  });

  it('MATCH findings never produce a page-audit marker, even with a measured box', () => {
    const { groups } = buildMarkerGroups([finding({ classification: 'MATCH' })]);
    expect(groups).toHaveLength(0);
  });

  it('NEEDS_REVIEW and UNVERIFIED findings DO produce a page-audit marker (widened Decision Log #32), colored AMBER/GRAY', () => {
    const needsReview = finding({ classification: 'NEEDS_REVIEW', review: { status: 'NEEDS_REVIEW', reason: 'Resembles two DS components equally', node: 'B3', signals: [], possibleMatches: [], observed: [] } });
    const unverified = finding({ classification: 'UNVERIFIED', review: { status: 'UNVERIFIED', reason: 'Element detached before comparison', node: 'B4', signals: [], possibleMatches: [], observed: [] } });
    const { groups } = buildMarkerGroups([needsReview, unverified]);
    expect(groups).toHaveLength(2);
    const byId = new Map(groups.map((g) => [g.findingId, g]));
    expect(byId.get(needsReview.identity.findingId)!.color).toBe('AMBER');
    expect(byId.get(needsReview.identity.findingId)!.explanation).toContain('Resembles two DS components equally');
    expect(byId.get(unverified.identity.findingId)!.color).toBe('GRAY');
    // Regression: shortName must never itself contain the status word — formatLegendLine
    // (publish-ops.ts) always appends "— <StatusTitleCase>" on top of shortName, so embedding it
    // here too produced a literal "link — Needs Review — Needs Review" on the first real run
    // this was checked against (market-entry-real-1's backfilled figma-ops.json).
    expect(byId.get(needsReview.identity.findingId)!.shortName).not.toMatch(/Needs Review/i);
    expect(byId.get(unverified.identity.findingId)!.shortName).not.toMatch(/Unverified/i);
  });

  it('groups repeated NEEDS_REVIEW findings sharing the same reason into one root-cause marker, never one per finding', () => {
    const same = () => finding({ classification: 'NEEDS_REVIEW', review: { status: 'NEEDS_REVIEW', reason: 'Ambiguous CTA variant', node: 'B3', signals: [], possibleMatches: [], observed: [] } });
    const { groups } = buildMarkerGroups([same(), same(), same()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isRootCause).toBe(true);
    expect(groups[0]!.affectedCount).toBe(3);
    expect(groups[0]!.color).toBe('AMBER');
  });

  it('a finding with no measured box is excluded — never a guessed marker position', () => {
    const noBox = finding({ classification: 'INCORRECT', quality: { severity: 'HIGH', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' } });
    const { groups } = buildMarkerGroups([noBox]);
    expect(groups).toHaveLength(0);
  });

  it('numbers markers 1..N in top-to-bottom reading order of their box, not findings-array order', () => {
    const bottom = finding({ classification: 'INCORRECT', quality: { severity: 'HIGH', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [{ kind: 'element-screenshot', ref: '/tmp/bottom.png', note: null, box: { x: 0, y: 900, width: 10, height: 10 } }], visualVerdict: 'NOT_CHECKED' }, comparison: { mismatches: [], ruleViolations: [ruleViolation('RX', 'X')] } });
    const top = finding({ classification: 'INCORRECT', quality: { severity: 'HIGH', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [{ kind: 'element-screenshot', ref: '/tmp/top.png', note: null, box: { x: 0, y: 10, width: 10, height: 10 } }], visualVerdict: 'NOT_CHECKED' }, comparison: { mismatches: [], ruleViolations: [ruleViolation('RY', 'Y')] } });
    const { groups } = buildMarkerGroups([bottom, top]); // bottom passed FIRST in the array
    expect(groups.map((g) => g.findingId)).toEqual([top.identity.findingId, bottom.identity.findingId]);
    expect(groups[0]!.number).toBe(1);
    expect(groups[1]!.number).toBe(2);
  });

  it('caps at maxMarkers and reports truncation rather than silently dropping the count', () => {
    const findings = Array.from({ length: 8 }, (_, i) => finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation(`R${i}`, `Rule ${i}`)] } }));
    const { groups, truncated, total } = buildMarkerGroups(findings, { maxMarkers: 3 });
    expect(groups).toHaveLength(3);
    expect(truncated).toBe(true);
    // `total` is the count BEFORE the cap — lets the Legend's capture note say "top 3 of 8", not just "capped".
    expect(total).toBe(8);
  });

  it('reports total === groups.length when nothing was truncated', () => {
    const findings = Array.from({ length: 2 }, (_, i) => finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation(`R${i}`, `Rule ${i}`)] } }));
    const { groups, truncated, total } = buildMarkerGroups(findings);
    expect(truncated).toBe(false);
    expect(total).toBe(groups.length);
  });
});

describe('MarkerGroup.legendTitle / legendSecondary — Decision Log #33, the "richer Market Entry treatment" for the Legend\'s per-finding rows', () => {
  it('a rule-based INCORRECT/DEVIATION finding gets "{Category} mismatch" — category via categorizeIssue, never the raw rule title verbatim', () => {
    const f = finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Two-Font Pairing (Serif + Sans)')] } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.legendTitle).toBe('Typography mismatch');
  });

  it('a radius-rule finding categorizes to "Radius mismatch" (categorizeIssue\'s "Radius/Shape" bucket, first segment only — no slash in a Legend title)', () => {
    const f = finding({ classification: 'INCORRECT', comparison: { mismatches: [], ruleViolations: [ruleViolation('R3.1', 'Border Radius Decision Table')] } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.legendTitle).toBe('Radius mismatch');
  });

  it('a multi-property drift with no single named rule gets "{Component} property drift"', () => {
    const f = finding({ classification: 'DEVIATION', component: { productionType: 'button', productionLabel: 'x', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig' }, comparison: { mismatches: [{ property: 'font-weight', actual: '400', expected: '500', expectedToken: null, comparison: 'exact', delta: null }], ruleViolations: [] } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.legendTitle).toBe('Button property drift');
  });

  it('a NEEDS_REVIEW/UNVERIFIED finding with a clean, short productionLabel gets "{Label} {type}"', () => {
    const f = finding({ classification: 'NEEDS_REVIEW', component: { productionType: 'link', productionLabel: 'Procurement', dsComponent: null, dsVariant: null, signature: 'sig' } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.legendTitle).toBe('Procurement link');
  });

  it('never shows raw/awkward extracted text when a clean issue title can be generated instead — a long, run-on productionLabel falls back to a generic type-based title', () => {
    const rawLabel = '01Employee EngagementWant to know what drives your people?'; // a real extracted label, seen on a real audit
    const f = finding({ classification: 'NEEDS_REVIEW', component: { productionType: 'button', productionLabel: rawLabel, dsComponent: null, dsVariant: null, signature: 'sig' } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.legendTitle).not.toContain(rawLabel);
    expect(groups[0]!.legendTitle).toBe('Button');
  });

  it('never shows a placeholder-style productionLabel like "(unlabelled icon-button generic)" — falls back to the clean type-based title instead', () => {
    const placeholderLabel = '(unlabelled icon-button generic)'; // a real extracted label, seen on a real audit — short enough to pass a naive length check
    const f = finding({ classification: 'NEEDS_REVIEW', component: { productionType: 'icon-button', productionLabel: placeholderLabel, dsComponent: null, dsVariant: null, signature: 'sig' } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.legendTitle).not.toContain(placeholderLabel);
    expect(groups[0]!.legendTitle).not.toMatch(/[()]/);
    expect(groups[0]!.legendTitle).toBe('Icon-button');
  });

  it('the secondary line stays neutral and concise: context + a short diff + "root cause, N elements" / "unique, N elements" (matching the reference file\'s own wording)', () => {
    const findings = Array.from({ length: 3 }, () => finding({ classification: 'INCORRECT', location: { url: 'u', pageId: 'p1', pageName: 'P1', templateFamily: null, section: 'Header', captureState: 'default' }, comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Two-Font Pairing')] } }));
    const { groups } = buildMarkerGroups(findings);
    expect(groups[0]!.legendSecondary).toContain('Header button');
    expect(groups[0]!.legendSecondary).toContain('root cause, 3 elements');
  });

  it('a unique (non-repeated) finding says "unique, 1 element", not "root cause"', () => {
    const f = finding({ classification: 'DEVIATION', comparison: { mismatches: [{ property: 'padding', actual: '4px', expected: '8px', expectedToken: null, comparison: 'exact', delta: null }], ruleViolations: [] } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.legendSecondary).toContain('unique, 1 element');
  });

  it('never shows a raw run-on section name in the secondary line — falls back to just the component type when the section reads like a sentence, not a label', () => {
    const rawSection = 'Survey Consulting that shapes critical decisions.'; // ends in a period, > 30 chars — a real section value, seen on a real audit
    const f = finding({ classification: 'INCORRECT', location: { url: 'u', pageId: 'p1', pageName: 'P1', templateFamily: null, section: rawSection, captureState: 'default' }, comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Two-Font Pairing')] } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.legendSecondary).not.toContain(rawSection);
  });

  it('exposes productionType directly, matching component.productionType — no re-parsing shortName for it', () => {
    const f = finding({ classification: 'INCORRECT', component: { productionType: 'nav-link', productionLabel: 'x', dsComponent: null, dsVariant: null, signature: 'sig' }, comparison: { mismatches: [], ruleViolations: [ruleViolation('R1.4', 'Two-Font Pairing')] } });
    const { groups } = buildMarkerGroups([f]);
    expect(groups[0]!.productionType).toBe('nav-link');
  });
});

describe('selectGlobalComponents — Header/Navbar/Footer, generalized from the manual curation', () => {
  const withSection = (section: string, classification: Finding['classification'] = 'INCORRECT') =>
    finding({ classification, location: { url: 'u', pageId: 'p1', pageName: 'P1', templateFamily: null, section, captureState: 'default' } });

  it('groups findings by section name, matching case-insensitively and by substring (e.g. "Site Footer")', () => {
    const groups = selectGlobalComponents([withSection('Header'), withSection('Site Footer'), withSection('HEADER'), withSection('Our Consulting Services')]);
    const sections = groups.map((g) => g.sectionName).sort();
    expect(sections).toEqual(['HEADER', 'Header', 'Site Footer']);
    expect(groups.find((g) => g.sectionName === 'HEADER')!.totalFindings).toBe(1);
  });

  it('caps representatives per section but reports the TRUE total count, never silently shrinking it', () => {
    const findings = Array.from({ length: 10 }, () => withSection('Footer'));
    const [group] = selectGlobalComponents(findings, { maxPerSection: 3 });
    expect(group!.totalFindings).toBe(10);
    expect(group!.representatives).toHaveLength(3);
  });

  it('prefers INCORRECT representatives over DEVIATION, and colors them correctly', () => {
    const findings = [withSection('Header', 'DEVIATION'), withSection('Header', 'INCORRECT')];
    const [group] = selectGlobalComponents(findings, { maxPerSection: 1 });
    expect(group!.representatives[0]!.status).toBe('INCORRECT');
    expect(group!.representatives[0]!.color).toBe('RED');
  });

  it('ignores non-global sections and findings without evidence', () => {
    const groups = selectGlobalComponents([withSection('Our Consulting Services')]);
    expect(groups).toHaveLength(0);
  });

  it('never includes a MATCH finding, even from a global section', () => {
    const groups = selectGlobalComponents([withSection('Header', 'MATCH')]);
    expect(groups).toHaveLength(0);
  });
});

describe('buildMarkerGroups — annotation-card placement (right, then left, then below)', () => {
  const withBoxX = (x: number) =>
    finding({
      classification: 'INCORRECT',
      quality: { severity: 'HIGH', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [{ kind: 'element-screenshot', ref: '/tmp/e.png', note: null, box: { x, y: 10, width: 20, height: 20 } }], visualVerdict: 'NOT_CHECKED' },
      comparison: { mismatches: [], ruleViolations: [ruleViolation('RX', 'X')] },
    });

  it('prefers right when there is room to the right', () => {
    const { groups } = buildMarkerGroups([withBoxX(50)], { frameWidthPx: 1440 });
    expect(groups[0]!.placement).toBe('right');
  });
  it('falls back to left when right would overflow the frame but left fits', () => {
    const { groups } = buildMarkerGroups([withBoxX(1300)], { frameWidthPx: 1440 });
    expect(groups[0]!.placement).toBe('left');
  });
  it('falls back to below when neither side fits (narrow frame)', () => {
    const { groups } = buildMarkerGroups([withBoxX(150)], { frameWidthPx: 320, cardWidthPx: 300, cardGapPx: 12 });
    expect(groups[0]!.placement).toBe('below');
  });
});
