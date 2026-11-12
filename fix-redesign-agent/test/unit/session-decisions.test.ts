import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint, emptyDecisionsFile, isApprovalReusable, latestDecisionFor, readDecisions, recordDecision, type DecisionRecord, type DecisionsFile } from '../../src/session/decisions.ts';

let root: string;
let decisionsJsonPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-decisions-'));
  decisionsJsonPath = join(root, 'decisions.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const rec = (overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  gate: 'G2',
  outcome: 'approve',
  fingerprint: 'fp-1',
  unitId: null,
  by: 'reviewer@example.com',
  at: '2026-09-18T10:00:00.000Z',
  note: null,
  ...overrides,
});

describe('readDecisions', () => {
  it('missing file → emptyDecisionsFile, never throws', async () => {
    const file = await readDecisions(decisionsJsonPath, 'run-1');
    expect(file).toEqual(emptyDecisionsFile('run-1'));
  });
});

describe('recordDecision', () => {
  it('is append-only: two decisions for the same gate both persist (a rejection round, then an approval)', async () => {
    await recordDecision(decisionsJsonPath, 'run-1', rec({ outcome: 'request-changes', fingerprint: 'fp-1' }));
    const updated = await recordDecision(decisionsJsonPath, 'run-1', rec({ outcome: 'approve', fingerprint: 'fp-2', at: '2026-09-18T11:00:00.000Z' }));
    expect(updated.decisions).toHaveLength(2);
    const reread = await readDecisions(decisionsJsonPath, 'run-1');
    expect(reread.decisions.map((d) => d.outcome)).toEqual(['request-changes', 'approve']);
  });
});

describe('latestDecisionFor', () => {
  it('null when never decided', () => {
    expect(latestDecisionFor(emptyDecisionsFile('run-1'), 'G4', 'comp-1')).toBeNull();
  });

  it('returns the LAST decision recorded for a gate, across multiple', async () => {
    await recordDecision(decisionsJsonPath, 'run-1', rec({ outcome: 'request-changes', fingerprint: 'fp-1' }));
    const file = await recordDecision(decisionsJsonPath, 'run-1', rec({ outcome: 'approve', fingerprint: 'fp-2' }));
    expect(latestDecisionFor(file, 'G2')).toMatchObject({ outcome: 'approve', fingerprint: 'fp-2' });
  });

  it('matches gate AND unitId — per-component gates (G4/G5) are tracked independently of one another', () => {
    const file: DecisionsFile = {
      schemaVersion: 1,
      redesignRunId: 'run-1',
      decisions: [rec({ gate: 'G4', unitId: 'comp-1', outcome: 'approve-design' }), rec({ gate: 'G4', unitId: 'comp-2', outcome: 'request-changes' })],
    };
    expect(latestDecisionFor(file, 'G4', 'comp-1')).toMatchObject({ unitId: 'comp-1', outcome: 'approve-design' });
    expect(latestDecisionFor(file, 'G4', 'comp-2')).toMatchObject({ unitId: 'comp-2', outcome: 'request-changes' });
    expect(latestDecisionFor(file, 'G4', 'comp-3')).toBeNull();
  });
});

describe('isApprovalReusable', () => {
  it('false when never decided', () => {
    expect(isApprovalReusable(emptyDecisionsFile('run-1'), 'G2', null, 'fp-1')).toBe(false);
  });

  it('false when the outcome is not an approval outcome (e.g. request-changes)', () => {
    const file: DecisionsFile = { schemaVersion: 1, redesignRunId: 'run-1', decisions: [rec({ outcome: 'request-changes', fingerprint: 'fp-1' })] };
    expect(isApprovalReusable(file, 'G2', null, 'fp-1')).toBe(false);
  });

  it('false when the fingerprint differs, even though the outcome IS an approval', () => {
    const file: DecisionsFile = { schemaVersion: 1, redesignRunId: 'run-1', decisions: [rec({ outcome: 'approve', fingerprint: 'fp-1' })] };
    expect(isApprovalReusable(file, 'G2', null, 'fp-2')).toBe(false);
  });

  it('true only when the outcome is an approval AND the fingerprint matches exactly', () => {
    const file: DecisionsFile = { schemaVersion: 1, redesignRunId: 'run-1', decisions: [rec({ outcome: 'approve', fingerprint: 'fp-1' })] };
    expect(isApprovalReusable(file, 'G2', null, 'fp-1')).toBe(true);
  });

  it('recognizes every approval outcome variant: approve, approve-and-push, approve-design', () => {
    for (const outcome of ['approve', 'approve-and-push', 'approve-design'] as const) {
      const file: DecisionsFile = { schemaVersion: 1, redesignRunId: 'run-1', decisions: [rec({ gate: 'G4', unitId: 'comp-1', outcome, fingerprint: 'fp-1' })] };
      expect(isApprovalReusable(file, 'G4', 'comp-1', 'fp-1')).toBe(true);
    }
  });

  it('recognizes G1\'s OWN outcome, "resolved", as reusable — found live: without this, a run with any acknowledgement-requiring conflict (§8.2) re-asked "resolved?" forever, since \'resolved\' is G1Outcome\'s only value and was missing from the approval-outcome list', () => {
    const file: DecisionsFile = { schemaVersion: 1, redesignRunId: 'run-1', decisions: [rec({ gate: 'G1', outcome: 'resolved', fingerprint: 'fp-1' })] };
    expect(isApprovalReusable(file, 'G1', null, 'fp-1')).toBe(true);
    expect(isApprovalReusable(file, 'G1', null, 'fp-2')).toBe(false); // still requires an exact fingerprint match
  });
});

describe('computeFingerprint', () => {
  it('same input → same fingerprint', () => {
    expect(computeFingerprint({ a: 1, b: [1, 2] })).toBe(computeFingerprint({ a: 1, b: [1, 2] }));
  });

  it('different input → different fingerprint', () => {
    expect(computeFingerprint({ a: 1 })).not.toBe(computeFingerprint({ a: 2 }));
  });
});
