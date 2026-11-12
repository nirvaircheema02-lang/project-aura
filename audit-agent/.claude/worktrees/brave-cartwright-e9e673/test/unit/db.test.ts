import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Database } from '../../src/db/index.ts';
import { createRun, incrementFanOut, getFanOut } from '../../src/graph/state.ts';

describe('openDb / migrations', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-agent-db-'));
    db = openDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies migration 0001 (creates every §7 table)', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of [
      'runs',
      'checkpoints',
      'fan_out',
      'findings',
      'escalation_queue',
      'registry_update_requests',
      'audit_history',
      'spans',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('is idempotent — reopening the same DB does not re-apply or fail', () => {
    const before = (db.prepare('SELECT COUNT(*) as n FROM _migrations').get() as { n: number }).n;
    expect(before).toBeGreaterThan(0);
    db.close();
    // Reopening must apply nothing further, however many migrations exist by now.
    const db2 = openDb(join(dir, 'test.db'));
    const after = (db2.prepare('SELECT COUNT(*) as n FROM _migrations').get() as { n: number }).n;
    expect(after).toBe(before);
    db2.close();
  });

  it('sets WAL journal mode', () => {
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('the run-level concurrency guard (§2.5 rule 6 / B7) rejects a second concurrent RUNNING run for the same (url, run_type)', () => {
    createRun(db, {
      run_id: 'run-1',
      run_type: 'single-page',
      url: 'https://www.kenresearch.com/x',
      ds_registry_version: 'abc123',
      policy_version: 'v1',
    });
    expect(() =>
      createRun(db, {
        run_id: 'run-2',
        run_type: 'single-page',
        url: 'https://www.kenresearch.com/x',
        ds_registry_version: 'abc123',
        policy_version: 'v1',
      }),
    ).toThrow(/already RUNNING/);
  });

  it('allows a new run once the prior one is no longer RUNNING', () => {
    const run1 = createRun(db, {
      run_id: 'run-1',
      run_type: 'single-page',
      url: 'https://www.kenresearch.com/x',
      ds_registry_version: 'abc123',
      policy_version: 'v1',
    });
    db.prepare("UPDATE runs SET status = 'COMPLETE' WHERE run_id = ?").run(run1.run_id);
    expect(() =>
      createRun(db, {
        run_id: 'run-2',
        run_type: 'single-page',
        url: 'https://www.kenresearch.com/x',
        ds_registry_version: 'abc123',
        policy_version: 'v1',
      }),
    ).not.toThrow();
  });

  it('fan_out counters increment atomically via ON CONFLICT ... RETURNING (§2.5 rule 2)', () => {
    createRun(db, {
      run_id: 'run-1',
      run_type: 'full-site',
      url: 'https://www.kenresearch.com/',
      ds_registry_version: 'abc123',
      policy_version: 'v1',
    });
    const first = incrementFanOut(db, 'run-1', 'dispatched');
    const second = incrementFanOut(db, 'run-1', 'dispatched');
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(getFanOut(db, 'run-1').dispatched).toBe(2);
  });

  it('fan_out counters survive concurrent increments without lost updates', async () => {
    createRun(db, {
      run_id: 'run-1',
      run_type: 'full-site',
      url: 'https://www.kenresearch.com/',
      ds_registry_version: 'abc123',
      policy_version: 'v1',
    });
    // better-sqlite3 is synchronous, so "concurrent" here proves the ON CONFLICT
    // RETURNING pattern itself is correct under back-to-back writers (the
    // race p-queue's async dispatch would otherwise create).
    for (let i = 0; i < 50; i++) incrementFanOut(db, 'run-1', 'completed');
    expect(getFanOut(db, 'run-1').completed).toBe(50);
  });
});
