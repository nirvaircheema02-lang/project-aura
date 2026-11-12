import { describe, expect, it } from 'vitest';
import {
  countByDecision,
  emptyFixPlan,
  FIX_PLAN_DECISIONS,
  mergeFixPlans,
  parseFixPlan,
  partitionByKnownFindings,
  type FixPlan,
  type FixPlanEntry,
} from '../../src/output/fix-plan.ts';

/**
 * The fix plan is the one file in this repo that arrives from OUTSIDE it — downloaded by a
 * browser, possibly hand-edited, then imported back. These tests pin the trust boundary: what
 * it accepts, what it refuses, and the merge semantics that decide whether an import can ever
 * lose a decision someone already made.
 */

function entry(over: Partial<FixPlanEntry> = {}): FixPlanEntry {
  return { findingId: 'a'.repeat(32), decision: 'fix', decidedAt: '2026-09-18T10:00:00.000Z', decidedBy: null, note: null, source: 'html-report', ...over };
}
function plan(entries: FixPlanEntry[], over: Partial<FixPlan> = {}): FixPlan {
  return { schemaVersion: 1, runId: 'run-a', updatedAt: null, entries, ...over };
}

describe('FixPlanSchema — what a downloaded, possibly hand-edited file is allowed to be', () => {
  it('accepts a well-formed sparse plan, including an empty one (zero decisions is legitimate, not a failure)', () => {
    expect(parseFixPlan(plan([])).ok).toBe(true);
    const parsed = parseFixPlan(plan([entry()]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan.entries[0]!.decision).toBe('fix');
  });

  it('accepts every decision in FIX_PLAN_DECISIONS and nothing else', () => {
    for (const decision of FIX_PLAN_DECISIONS) expect(parseFixPlan(plan([entry({ decision })])).ok).toBe(true);
    const bad = parseFixPlan(plan([entry({ decision: 'maybe' as never })]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContain('entries.0.decision');
  });

  it('refuses a wrong schemaVersion rather than guessing at a future shape', () => {
    expect(parseFixPlan(plan([], { schemaVersion: 2 as never }).valueOf()).ok).toBe(false);
  });

  it('refuses an empty findingId — the only join key must actually identify something', () => {
    const bad = parseFixPlan(plan([entry({ findingId: '' })]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContain('findingId');
  });

  it('keeps decidedBy/note nullable but required — an absent key is a malformed entry, not an implied null', () => {
    expect(parseFixPlan(plan([entry({ decidedBy: 'design@kenresearch.com', note: 'ships next sprint' })])).ok).toBe(true);
    const missing = { ...entry() } as Record<string, unknown>;
    delete missing.note;
    expect(parseFixPlan(plan([missing as unknown as FixPlanEntry])).ok).toBe(false);
  });

  it('reports every issue at once, in the same format loadConfig uses', () => {
    const bad = parseFixPlan({ schemaVersion: 1, runId: '', updatedAt: null, entries: [entry({ decision: 'nope' as never })] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues).toContain('  - runId:');
      expect(bad.issues).toContain('  - entries.0.decision:');
    }
  });
});

describe('mergeFixPlans — the default import mode, which must never silently lose a decision', () => {
  it('upserts by findingId: a re-decided finding takes the incoming value', () => {
    const existing = plan([entry({ findingId: 'f1', decision: 'skip' })]);
    const incoming = plan([entry({ findingId: 'f1', decision: 'fix' })]);
    expect(mergeFixPlans(existing, incoming).entries).toEqual([expect.objectContaining({ findingId: 'f1', decision: 'fix' })]);
  });

  it('PRESERVES existing entries the incoming file never mentions — the whole point of merge-by-default', () => {
    const existing = plan([entry({ findingId: 'f1', decision: 'fix' }), entry({ findingId: 'f2', decision: 'skip' })]);
    const incoming = plan([entry({ findingId: 'f3', decision: 'keep_for_review' })]);
    const merged = mergeFixPlans(existing, incoming);
    expect(merged.entries.map((e) => e.findingId).sort()).toEqual(['f1', 'f2', 'f3']);
  });

  it('cannot represent retraction — clearing a decision and re-exporting does NOT delete the earlier import (--replace is the tool for that)', () => {
    const existing = plan([entry({ findingId: 'f1', decision: 'fix' })]);
    const clearedAndReExported = plan([]); // the reviewer cleared f1, so it is simply absent
    expect(mergeFixPlans(existing, clearedAndReExported).entries).toHaveLength(1);
  });

  it('keeps the existing runId — a merge never re-points a plan at a different run', () => {
    expect(mergeFixPlans(plan([], { runId: 'run-a' }), plan([], { runId: 'run-b' })).runId).toBe('run-a');
  });
});

describe('partitionByKnownFindings — unknown ids are reported and dropped, never written', () => {
  it('splits known from unknown against this run\'s own findingIds', () => {
    const { known, unknown } = partitionByKnownFindings([entry({ findingId: 'f1' }), entry({ findingId: 'ghost' })], new Set(['f1', 'f2']));
    expect(known.map((e) => e.findingId)).toEqual(['f1']);
    expect(unknown.map((e) => e.findingId)).toEqual(['ghost']);
  });

  it('an all-unknown file partitions to zero known — the signature of an import aimed at the wrong run', () => {
    const { known, unknown } = partitionByKnownFindings([entry({ findingId: 'x' }), entry({ findingId: 'y' })], new Set(['f1']));
    expect(known).toHaveLength(0);
    expect(unknown).toHaveLength(2);
  });
});

describe('countByDecision / emptyFixPlan', () => {
  it('counts each decision independently', () => {
    const counts = countByDecision(plan([entry({ findingId: '1', decision: 'fix' }), entry({ findingId: '2', decision: 'fix' }), entry({ findingId: '3', decision: 'skip' }), entry({ findingId: '4', decision: 'keep_for_review' })]));
    expect(counts).toEqual({ fix: 2, skip: 1, keep_for_review: 1 });
  });

  it('an empty plan is a VALID plan for the run, not an error state', () => {
    const empty = emptyFixPlan('run-z');
    expect(parseFixPlan(empty).ok).toBe(true);
    expect(empty.entries).toEqual([]);
    expect(countByDecision(empty)).toEqual({ fix: 0, skip: 0, keep_for_review: 0 });
  });
});
