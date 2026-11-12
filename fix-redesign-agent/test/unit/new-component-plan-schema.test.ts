import { describe, expect, it } from 'vitest';
import { emptyNewComponentPlan, parseNewComponentPlan } from '../../src/library/new-component-plan-schema.ts';
import { TerminalError } from '../../src/retry.ts';

const validPlan = () => ({
  schemaVersion: 1,
  runId: 'page-audit',
  updatedAt: '2026-09-17T10:00:00.000Z',
  entries: [
    { findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'post_fix', relatedFindingIds: ['b'.repeat(32)] },
  ],
});

describe('parseNewComponentPlan', () => {
  it('parses a valid plan', () => {
    const parsed = parseNewComponentPlan(validPlan(), '/fake/new-component-plan.json');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', candidateSource: 'post_fix' });
  });

  it('rejects a bad classification enum value, naming the field path', () => {
    const bad = validPlan();
    bad.entries[0]!.classification = 'NOT_A_REAL_CLASSIFICATION' as never;
    expect(() => parseNewComponentPlan(bad, '/fake/new-component-plan.json')).toThrow(TerminalError);
    try {
      parseNewComponentPlan(bad, '/fake/new-component-plan.json');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).message).toContain('entries.0.classification');
    }
  });

  it('rejects a bad candidateSource enum value, naming the field path', () => {
    const bad = validPlan();
    bad.entries[0]!.candidateSource = 'not_a_real_source' as never;
    try {
      parseNewComponentPlan(bad, '/fake/new-component-plan.json');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).message).toContain('entries.0.candidateSource');
    }
  });

  it('defaults candidateSource to current_state when omitted (plans exported before the field existed)', () => {
    const legacy = validPlan();
    delete (legacy.entries[0] as { candidateSource?: unknown }).candidateSource;
    const parsed = parseNewComponentPlan(legacy, '/fake/new-component-plan.json');
    expect(parsed.entries[0]!.candidateSource).toBe('current_state');
  });
});

describe('emptyNewComponentPlan', () => {
  it('builds a schemaVersion 1 plan with no entries, for the given run id', () => {
    expect(emptyNewComponentPlan('page-audit')).toEqual({ schemaVersion: 1, runId: 'page-audit', updatedAt: null, entries: [] });
  });
});
