import { describe, expect, it } from 'vitest';
import { countDecisions, parseAuditData, parseFixPlan, partitionFixPlanEntries, type FixPlan } from '../../src/audit-link/index.ts';
import { TerminalError } from '../../src/retry.ts';
import { makeFinding, makeFixPlanEntry } from '../helpers/fixture-audit-run.ts';

describe('data.json read-side contract (Decision Log #6)', () => {
  it('accepts a real-shaped document and passes unknown top-level keys through', () => {
    const data = parseAuditData({ schemaVersion: 1, run: { runId: 'r', targetUrl: 'https://x', extra: true }, findings: [makeFinding({ findingId: 'a'.repeat(32) })], websiteSummary: { compliancePercent: 0 } }, '/p/data.json');
    expect(data.findings[0]!.identity.findingId).toBe('a'.repeat(32));
    expect((data as Record<string, unknown>).websiteSummary).toEqual({ compliancePercent: 0 });
    expect((data.run as Record<string, unknown>).extra).toBe(true);
  });

  it('fails TERMINAL naming the field when a finding breaks the S0 contract', () => {
    const broken = makeFinding({ findingId: 'a'.repeat(32) }) as unknown as { identity: Record<string, unknown> };
    delete broken.identity.findingId;
    const err = (() => {
      try {
        parseAuditData({ schemaVersion: 1, run: { runId: 'r', targetUrl: 'https://x' }, findings: [broken] }, '/p/data.json');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/data\.json at \/p\/data\.json does not match its contract/);
    expect((err as Error).message).toMatch(/findings\.0\.identity\.findingId/);
  });
});

describe('fix-plan.json read-side contract (Part 1 schema v1)', () => {
  const valid: FixPlan = { schemaVersion: 1, runId: 'r', updatedAt: null, entries: [makeFixPlanEntry('a'.repeat(32), 'fix')] };

  it('accepts a valid plan and rejects a bad decision / wrong schemaVersion with the field named', () => {
    expect(parseFixPlan(valid, '/p/fix-plan.json').entries).toHaveLength(1);
    expect(() => parseFixPlan({ ...valid, entries: [{ ...valid.entries[0]!, decision: 'FIX' }] }, '/p/fix-plan.json')).toThrow(/entries\.0\.decision/);
    expect(() => parseFixPlan({ ...valid, schemaVersion: 2 }, '/p/fix-plan.json')).toThrow(/schemaVersion/);
  });

  it('partitions known/unknown ids; a repeated id keeps the LAST entry and is reported', () => {
    const plan: FixPlan = { ...valid, entries: [makeFixPlanEntry('a'.repeat(32), 'skip'), makeFixPlanEntry('z'.repeat(32), 'fix'), makeFixPlanEntry('a'.repeat(32), 'fix')] };
    const { known, unknownIds, duplicateIds } = partitionFixPlanEntries(plan, new Set(['a'.repeat(32), 'b'.repeat(32)]));
    expect(known.map((e) => [e.findingId, e.decision])).toEqual([['a'.repeat(32), 'fix']]);
    expect(unknownIds).toEqual(['z'.repeat(32)]);
    expect(duplicateIds).toEqual(['a'.repeat(32)]);
  });

  it('counts decisions, with undecided = findings that have no entry at all', () => {
    expect(countDecisions([makeFixPlanEntry('a', 'fix'), makeFixPlanEntry('b', 'fix'), makeFixPlanEntry('c', 'keep_for_review')], 10)).toEqual({ fix: 2, skip: 0, keep_for_review: 1, undecided: 7 });
  });
});
