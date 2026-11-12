import { describe, expect, it } from 'vitest';
import {
  emptyNewComponentPlan,
  NEW_COMPONENT_PLAN_CANDIDATE_SOURCES,
  NEW_COMPONENT_PLAN_CLASSIFICATIONS,
  parseNewComponentPlan,
  type NewComponentPlan,
  type NewComponentPlanEntry,
} from '../../src/output/new-component-plan.ts';

/**
 * The New Component Plan is deliberately a SEPARATE sidecar from the Fix Plan (fix-plan.ts) —
 * these tests pin that it stays that shape: findingId-only reference, no decision enum (there is
 * no Fix/Skip/Keep-for-Review here, only "selected for the Design System" or not), and no
 * dependency on Fix Plan's own schema.
 */

function entry(over: Partial<NewComponentPlanEntry> = {}): NewComponentPlanEntry {
  return { findingId: 'b'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-21T10:00:00.000Z', note: null, candidateSource: 'current_state', ...over };
}
function plan(entries: NewComponentPlanEntry[], over: Partial<NewComponentPlan> = {}): NewComponentPlan {
  return { schemaVersion: 1, runId: 'run-a', updatedAt: null, entries, ...over };
}

describe('NewComponentPlanSchema — a selection, not a decision', () => {
  it('accepts a well-formed sparse plan, including an empty one (nothing selected yet is legitimate, not a failure)', () => {
    expect(parseNewComponentPlan(plan([])).ok).toBe(true);
    const parsed = parseNewComponentPlan(plan([entry()]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan.entries[0]!.classification).toBe('DS_CANDIDATE');
  });

  it('accepts both NEW_COMPONENT and DS_CANDIDATE and nothing else — never a Fix Plan decision value', () => {
    for (const classification of NEW_COMPONENT_PLAN_CLASSIFICATIONS) expect(parseNewComponentPlan(plan([entry({ classification })])).ok).toBe(true);
    const bad = parseNewComponentPlan(plan([entry({ classification: 'fix' as never })]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContain('entries.0.classification');
  });

  it('refuses a wrong schemaVersion rather than guessing at a future shape', () => {
    expect(parseNewComponentPlan(plan([], { schemaVersion: 2 as never })).ok).toBe(false);
  });

  it('refuses an empty findingId — the only join key must actually identify something', () => {
    const bad = parseNewComponentPlan(plan([entry({ findingId: '' })]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContain('findingId');
  });

  it('has no `decision` field at all — the schema itself makes a Fix/Skip/Keep-for-Review value impossible to write here', () => {
    const withDecision = { ...entry(), decision: 'fix' } as unknown as NewComponentPlanEntry;
    // Zod strips unknown keys by default rather than rejecting them — assert the parsed result
    // simply has no such field, so a caller can never read a "decision" back out of this file.
    const parsed = parseNewComponentPlan(plan([withDecision]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('decision' in parsed.plan.entries[0]!).toBe(false);
  });

  it('reports every issue at once, in the same format fix-plan.ts / loadConfig use', () => {
    const bad = parseNewComponentPlan({ schemaVersion: 1, runId: '', updatedAt: null, entries: [entry({ classification: 'nope' as never })] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues).toContain('  - runId:');
      expect(bad.issues).toContain('  - entries.0.classification:');
    }
  });
});

describe('candidateSource — distinguishes a current-state B6 candidate from a post-fix opportunity', () => {
  it('defaults to current_state when the field is absent — every plan exported before this field existed still parses', () => {
    const { findingId, classification, selectedAt, note } = entry();
    const parsed = parseNewComponentPlan(plan([{ findingId, classification, selectedAt, note } as NewComponentPlanEntry]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan.entries[0]!.candidateSource).toBe('current_state');
  });

  it('accepts both current_state and post_fix and nothing else', () => {
    for (const candidateSource of NEW_COMPONENT_PLAN_CANDIDATE_SOURCES) expect(parseNewComponentPlan(plan([entry({ candidateSource })])).ok).toBe(true);
    const bad = parseNewComponentPlan(plan([entry({ candidateSource: 'model_guess' as never })]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContain('entries.0.candidateSource');
  });

  it('accepts an optional relatedFindingIds list for a post_fix entry representing several repeated instances', () => {
    const parsed = parseNewComponentPlan(plan([entry({ candidateSource: 'post_fix', relatedFindingIds: ['c'.repeat(32), 'd'.repeat(32)] })]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan.entries[0]!.relatedFindingIds).toEqual(['c'.repeat(32), 'd'.repeat(32)]);
  });

  it('does not require relatedFindingIds — a current_state entry never carries it', () => {
    const parsed = parseNewComponentPlan(plan([entry()]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan.entries[0]!.relatedFindingIds).toBeUndefined();
  });
});

describe('emptyNewComponentPlan', () => {
  it('is a VALID plan for the run, not an error state', () => {
    const empty = emptyNewComponentPlan('run-z');
    expect(parseNewComponentPlan(empty).ok).toBe(true);
    expect(empty.entries).toEqual([]);
    expect(empty.runId).toBe('run-z');
  });
});
