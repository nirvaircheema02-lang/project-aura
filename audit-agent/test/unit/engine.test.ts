import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Database } from '../../src/db/index.ts';
import { createRun, decideCheckpoint, getFanOut, getRun } from '../../src/graph/state.ts';
import { runGraph, resumeGraph, type GraphDefinition } from '../../src/graph/engine.ts';
import { TerminalError } from '../../src/graph/retry.ts';

const noSleep = async () => {};

function freshRun(db: Database, runId = 'run-1') {
  return createRun(db, {
    run_id: runId,
    run_type: 'single-page',
    url: `https://www.kenresearch.com/${runId}`,
    ds_registry_version: 'abc123',
    policy_version: 'v1',
  });
}

describe('graph engine — proof with synthetic nodes (build sequence step 1)', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-agent-engine-'));
    db = openDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sequential edges chain nodes in order, threading each node\'s output to the next', async () => {
    freshRun(db);
    const graph: GraphDefinition = {
      start: 'a',
      nodes: {
        a: async (_ctx, input: number) => input + 1,
        b: async (_ctx, input: number) => input * 10,
        c: async (_ctx, input: number) => input - 3,
      },
      executionTypes: { a: 'deterministic', b: 'deterministic', c: 'deterministic' },
      edges: [
        { type: 'sequential', from: 'a', to: 'b' },
        { type: 'sequential', from: 'b', to: 'c' },
      ],
    };
    const outcome = await runGraph(db, 'run-1', graph, 1, noSleep);
    expect(outcome).toEqual({ kind: 'complete', result: 17 }); // (1+1)*10 - 3
    expect(getRun(db, 'run-1')?.status).toBe('COMPLETE');
  });

  it('conditional edges route to the first matching branch, or the fallback if none match', async () => {
    freshRun(db);
    const graph: GraphDefinition = {
      start: 'match',
      nodes: {
        match: async (_ctx, input: { confidence: number }) => input,
        highPath: async () => 'HIGH_PATH',
        lowPath: async () => 'LOW_PATH',
      },
      executionTypes: { match: 'ai', highPath: 'deterministic', lowPath: 'deterministic' },
      edges: [
        {
          type: 'conditional',
          from: 'match',
          branches: [{ to: 'highPath', when: (r: any) => r.confidence >= 0.85 }],
          fallback: 'lowPath',
        },
      ],
    };
    const highOutcome = await runGraph(db, 'run-1', graph, { confidence: 0.9 }, noSleep);
    expect(highOutcome).toEqual({ kind: 'complete', result: 'HIGH_PATH' });

    freshRun(db, 'run-2');
    const lowOutcome = await runGraph(db, 'run-2', graph, { confidence: 0.2 }, noSleep);
    expect(lowOutcome).toEqual({ kind: 'complete', result: 'LOW_PATH' });
  });

  it('fan-out/fan-in: one branch exhausting retries never blocks its siblings or the consolidation step (§2.4 partial fan-in)', async () => {
    freshRun(db);
    const pages = ['p1', 'p2', 'BAD_PAGE', 'p4'];
    const graph: GraphDefinition = {
      start: 'dispatch',
      nodes: {
        dispatch: async () => pages,
        pageAudit: async (_ctx, page: string) => {
          if (page === 'BAD_PAGE') throw new TerminalError('simulated unrecoverable page failure');
          return `audited:${page}`;
        },
        consolidate: async () => 'CONSOLIDATED',
      },
      executionTypes: { dispatch: 'deterministic', pageAudit: 'deterministic', consolidate: 'deterministic' },
      edges: [
        { type: 'fan-out', from: 'dispatch', to: 'pageAudit', items: (s: any) => s as string[], concurrency: 4 },
        { type: 'fan-in', from: 'dispatch', to: 'consolidate' },
      ],
    };
    const outcome = await runGraph(db, 'run-1', graph, undefined, noSleep);
    expect(outcome).toEqual({ kind: 'complete', result: 'CONSOLIDATED' });

    const counts = getFanOut(db, 'run-1');
    expect(counts).toEqual({ dispatched: 4, completed: 3, failed: 1, retrying: 0, cache_hits: 0 });

    const escalations = db
      .prepare("SELECT * FROM escalation_queue WHERE run_id = ? AND reason = 'NODE_FAILURE'")
      .all('run-1');
    expect(escalations).toHaveLength(1);
  });

  it('gate: pauses the run and moves it to the AWAITING_* status; resumeGraph re-checks and proceeds once approved', async () => {
    freshRun(db);
    const graph: GraphDefinition = {
      start: 'a',
      nodes: {
        a: async (_ctx, input: number) => input,
        b: async (_ctx, input: number) => input * 2,
      },
      executionTypes: { a: 'deterministic', b: 'deterministic' },
      edges: [{ type: 'gate', from: 'a', to: 'b', name: 'scope_confirmation', timeoutMs: 60_000 }],
    };

    const paused = await runGraph(db, 'run-1', graph, 21, noSleep);
    expect(paused).toEqual({ kind: 'paused', status: 'AWAITING_SCOPE_CONFIRMATION', at: 'a' });
    expect(getRun(db, 'run-1')?.status).toBe('AWAITING_SCOPE_CONFIRMATION');

    // Resuming before a decision is made must not make forward progress (never auto-approve).
    const stillPaused = await resumeGraph(db, 'run-1', graph, 'a', 21, noSleep);
    expect(stillPaused.kind).toBe('paused');

    decideCheckpoint(db, 'run-1', 'scope_confirmation', 'APPROVED', 'design@kenresearch.com');
    const resumed = await resumeGraph(db, 'run-1', graph, 'a', 21, noSleep);
    expect(resumed).toEqual({ kind: 'complete', result: 42 });
    expect(getRun(db, 'run-1')?.status).toBe('COMPLETE');
  });

  it('gate: a REJECTED checkpoint aborts the run rather than proceeding', async () => {
    freshRun(db);
    const graph: GraphDefinition = {
      start: 'a',
      nodes: { a: async (_ctx, input: number) => input, b: async () => 'SHOULD_NOT_RUN' },
      executionTypes: { a: 'deterministic', b: 'deterministic' },
      edges: [{ type: 'gate', from: 'a', to: 'b', name: 'publish_confirmation', timeoutMs: 60_000 }],
    };
    await runGraph(db, 'run-1', graph, 1, noSleep);
    decideCheckpoint(db, 'run-1', 'publish_confirmation', 'REJECTED', 'design@kenresearch.com');
    const outcome = await resumeGraph(db, 'run-1', graph, 'a', 1, noSleep);
    expect(outcome).toEqual({ kind: 'aborted', status: 'ABORTED', at: 'a' });
    expect(getRun(db, 'run-1')?.status).toBe('ABORTED');
  });

  it('a node exhausting its retry policy fails the run and writes a NODE_FAILURE escalation row', async () => {
    freshRun(db);
    let attempts = 0;
    const graph: GraphDefinition = {
      start: 'flaky',
      nodes: {
        flaky: async () => {
          attempts++;
          throw new Error('transient tool failure');
        },
      },
      executionTypes: { flaky: 'deterministic' }, // 3 attempts per §2.4
      edges: [],
    };
    const outcome = await runGraph(db, 'run-1', graph, undefined, noSleep);
    expect(outcome.kind).toBe('failed');
    expect(attempts).toBe(3);
    expect(getRun(db, 'run-1')?.status).toBe('FAILED');
    const escalations = db.prepare("SELECT * FROM escalation_queue WHERE run_id = ?").all('run-1');
    expect(escalations).toHaveLength(1);
  });

  it('a TERMINAL error skips remaining retry attempts entirely', async () => {
    freshRun(db);
    let attempts = 0;
    const graph: GraphDefinition = {
      start: 'deadEnd',
      nodes: {
        deadEnd: async () => {
          attempts++;
          throw new TerminalError('404 — page genuinely gone');
        },
      },
      executionTypes: { deadEnd: 'deterministic' },
      edges: [],
    };
    await runGraph(db, 'run-1', graph, undefined, noSleep);
    expect(attempts).toBe(1); // no retry budget burned on a TERMINAL failure
  });
});
