import { describe, expect, it } from 'vitest';
import { defaultCandidateSectionIds, deriveSectionCandidates, resolveScope, sectionIdFor, type SectionCandidate } from '../../src/session/scope.ts';
import type { ScopeRecord } from '../../src/output/redesign-store.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

const F1 = 'a'.repeat(32);
const F2 = 'b'.repeat(32);
const F3 = 'c'.repeat(32);

describe('sectionIdFor', () => {
  it('slugifies the section name', () => {
    expect(sectionIdFor('Hero Section', new Set())).toBe('hero-section');
  });

  it('appends a collision suffix -2, -3, ... when the base id is already used', () => {
    expect(sectionIdFor('Hero', new Set(['hero']))).toBe('hero-2');
    expect(sectionIdFor('Hero', new Set(['hero', 'hero-2']))).toBe('hero-3');
  });
});

describe('deriveSectionCandidates', () => {
  it('one candidate per distinct section, in first-seen order, findingIds accumulated', () => {
    const findings = [makeFinding({ findingId: F1, section: 'Hero' }), makeFinding({ findingId: F2, section: 'Content' }), makeFinding({ findingId: F3, section: 'Hero' })];
    const candidates = deriveSectionCandidates(findings);
    expect(candidates.map((c) => c.name)).toEqual(['Hero', 'Content']);
    expect(candidates[0]).toMatchObject({ name: 'Hero', findingIds: [F1, F3] });
    expect(candidates[1]).toMatchObject({ name: 'Content', findingIds: [F2] });
  });

  it('isGlobal is true for header/footer section names, case-insensitively; false otherwise', () => {
    const findings = [makeFinding({ findingId: F1, section: 'Header' }), makeFinding({ findingId: F2, section: 'FOOTER' }), makeFinding({ findingId: F3, section: 'Hero' })];
    const candidates = deriveSectionCandidates(findings);
    expect(candidates.find((c) => c.name === 'Header')!.isGlobal).toBe(true);
    expect(candidates.find((c) => c.name === 'FOOTER')!.isGlobal).toBe(true);
    expect(candidates.find((c) => c.name === 'Hero')!.isGlobal).toBe(false);
  });

  it('two distinct section names that slugify to the same id get collision-suffixed ids', () => {
    const findings = [makeFinding({ findingId: F1, section: 'Hero!!' }), makeFinding({ findingId: F2, section: 'Hero??' })];
    const candidates = deriveSectionCandidates(findings);
    expect(candidates.map((c) => c.sectionId)).toEqual(['hero', 'hero-2']);
  });
});

describe('defaultCandidateSectionIds', () => {
  it('every non-global candidate, global ones excluded', () => {
    const candidates: SectionCandidate[] = [
      { sectionId: 'hero', name: 'Hero', isGlobal: false, findingIds: [F1] },
      { sectionId: 'header', name: 'Header', isGlobal: true, findingIds: [F2] },
      { sectionId: 'content', name: 'Content', isGlobal: false, findingIds: [F3] },
    ];
    expect(defaultCandidateSectionIds(candidates)).toEqual(['hero', 'content']);
  });
});

describe('resolveScope — redesign-only scope: always auto-derives, never pauses to ask (2026-09-28)', () => {
  const cand = (sectionId: string, isGlobal = false, findingIds: string[] = [F1]): SectionCandidate => ({ sectionId, name: sectionId, isGlobal, findingIds });

  it('full-page mode is always auto — every content section in scope, globals excluded', () => {
    const candidates = [cand('hero'), cand('header', true), cand('footer', true), cand('content')];
    const decision = resolveScope('full-page', candidates, null);
    expect(decision.kind).toBe('auto');
    expect(decision.record.mode).toBe('full-page');
    expect(decision.record.sectionIds).toEqual(['content', 'hero']); // sorted
    expect(decision.record.excludedSectionIds).toEqual(['header', 'footer']);
    expect(decision.record.candidateSectionIds).toEqual(decision.record.sectionIds);
  });

  it('exactly one non-global candidate → auto, genuinely unambiguous; the global one is listed as excluded, not silently dropped', () => {
    const candidates = [cand('hero'), cand('header', true)];
    const decision = resolveScope('selected-sections', candidates, null);
    expect(decision.kind).toBe('auto');
    expect(decision.record.sectionIds).toEqual(['hero']);
    expect(decision.record.excludedSectionIds).toEqual(['header']);
  });

  it('several candidates, nothing recorded yet → still auto (never asks) — every non-global section with a Fix finding', () => {
    const candidates = [cand('hero'), cand('content'), cand('header', true)];
    const decision = resolveScope('selected-sections', candidates, null);
    expect(decision.kind).toBe('auto');
    expect(decision.record.sectionIds).toEqual(['hero', 'content']);
    expect(decision.record.excludedSectionIds).toEqual(['header']);
  });

  it('a previous scope recorded, candidate set has since changed → still auto to the CURRENT candidate set, never asks about the change', () => {
    const candidates = [cand('hero'), cand('content'), cand('newsection'), cand('header', true)];
    const previous: ScopeRecord = { mode: 'selected-sections', sectionIds: ['hero'], excludedSectionIds: [], candidateSectionIds: ['content', 'hero'], resolvedAt: '2026-09-17T10:00:00.000Z' };
    const decision = resolveScope('selected-sections', candidates, previous);
    expect(decision.kind).toBe('auto');
    expect(decision.record.sectionIds).toEqual(['hero', 'content', 'newsection']);
  });

  it('zero non-global candidates → auto with an empty scope, not an error and not a question', () => {
    const candidates = [cand('header', true), cand('footer', true)];
    const decision = resolveScope('selected-sections', candidates, null);
    expect(decision.kind).toBe('auto');
    expect(decision.record.sectionIds).toEqual([]);
    expect(decision.reason).toContain('No non-global section contains a Fix-decision finding');
  });
});
