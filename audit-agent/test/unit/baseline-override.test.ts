import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Database } from '../../src/db/index.ts';
import { createRun, setRunStatus } from '../../src/graph/state.ts';
import { applyHistory, baselineRunProblem, previousRunFor, recordAuditHistory, writeFindings } from '../../src/skills/s7-audit-state-history.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';

/**
 * `audit-page --baseline-run`: the operator names which COMPLETED run a re-audit diffs against.
 * Without it the baseline is the page's most recent other run, exactly as before.
 */

let db: Database;
let dir: string;

function finding(runId: string, classification: Finding['classification']): Finding {
  return {
    identity: { auditId: 'a', runId, findingId: 'el-1', timestamp: '2026-10-08T10:00:00.000Z', dsRegistryVersion: 'ds', policyVersion: 'p' },
    location: { url: 'https://www.kenresearch.com/survey', pageId: 'page-1', pageName: 'Survey', templateFamily: null, section: 'Hero', captureState: 'default' },
    component: { productionType: 'button', productionLabel: 'CTA', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig' },
    classification,
    comparison: { mismatches: [], ruleViolations: [] },
    quality: { severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
    action: { recommendation: 'x', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: classification, delta: null, previousRunId: null },
  };
}

function completedRun(runId: string, pageId: string, completedAt: number, classification: Finding['classification']): void {
  createRun(db, { run_id: runId, run_type: 'single-page', url: 'https://www.kenresearch.com/survey', ds_registry_version: 'v', policy_version: 'p' });
  setRunStatus(db, runId, 'COMPLETE');
  writeFindings(db, [finding(runId, classification)]);
  recordAuditHistory(db, { pageId, runId, domHash: 'd', dsRegistryVersion: 'ds' });
  db.prepare('UPDATE audit_history SET completed_at = ? WHERE run_id = ?').run(completedAt, runId);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-baseline-'));
  db = openDb(join(dir, 'test.db'));
  completedRun('canonical', 'page-1', 1000, 'DEVIATION'); // the legitimate previous audit
  completedRun('experiment', 'page-1', 2000, 'MATCH'); // a newer test run
  completedRun('other-page', 'page-2', 3000, 'MATCH');
  createRun(db, { run_id: 'still-running', run_type: 'single-page', url: 'https://www.kenresearch.com/survey', ds_registry_version: 'v', policy_version: 'p' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('re-audit baseline override', () => {
  it('without the flag the baseline is still the most recent other run (default unchanged)', () => {
    expect(previousRunFor(db, 'page-1', 'current')).toBe('experiment');
    const [out] = applyHistory(db, 'page-1', 'current', [finding('current', 'DEVIATION')]);
    expect(out!.history.previousRunId).toBe('experiment');
  });

  it('with the flag the chosen run is the baseline, whatever is newer', () => {
    const [out] = applyHistory(db, 'page-1', 'current', [finding('current', 'DEVIATION')], 'canonical');
    expect(out!.history.previousRunId).toBe('canonical');
    expect(out!.history.previousStatus).toBe('DEVIATION');
    expect(out!.history.delta).toBe('STILL_OPEN');
  });

  it('accepts a completed run that audited this page', () => {
    expect(baselineRunProblem(db, 'canonical')).toBeNull();
    expect(baselineRunProblem(db, 'canonical', 'page-1')).toBeNull();
  });

  it('rejects a baseline that does not exist', () => {
    expect(baselineRunProblem(db, 'nope')).toMatch(/does not exist/);
  });

  it('rejects a baseline that is not COMPLETE', () => {
    expect(baselineRunProblem(db, 'still-running')).toMatch(/not COMPLETE/);
  });

  it('rejects a baseline that audited a different page', () => {
    expect(baselineRunProblem(db, 'other-page', 'page-1')).toMatch(/did not audit this page/);
  });
});
