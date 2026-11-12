import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSpanRecords, initTracing, MemorySpanExporter, readSpans, withNodeSpan } from '../../src/tracing/index.ts';

describe('tracing (vendored §2.6, JSONL sink — Decision Log #4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fra-trace-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records one span per node attempt with run/node/attempt, OK and ERROR, and rethrows the error', async () => {
    const memory = new MemorySpanExporter();
    initTracing(memory);
    await withNodeSpan({ runId: 'r', nodeId: 'R1', attempt: 1 }, async () => 'ok');
    await expect(withNodeSpan({ runId: 'r', nodeId: 'R4', attempt: 2 }, async () => Promise.reject(new Error('boom\nsecond line')))).rejects.toThrow('boom');
    expect(memory.records.map((s) => [s.nodeId, s.attempt, s.status, s.errorDetail])).toEqual([
      ['R1', 1, 'OK', null],
      ['R4', 2, 'ERROR', 'boom'],
    ]);
    expect(memory.records[0]!.endedAt).toBeGreaterThanOrEqual(memory.records[0]!.startedAt);
  });

  it('re-pointing the sink at a .jsonl path writes lines that readSpans reads back in order', async () => {
    const path = join(dir, 'run', 'trace.jsonl');
    initTracing(path);
    await withNodeSpan({ runId: 'run-1', nodeId: 'R3', attempt: 1, isAi: true, model: 'claude-opus-5' }, async () => 1);
    await withNodeSpan({ runId: 'run-1', nodeId: 'R5', attempt: 1, isAi: true, model: 'claude-opus-5' }, async () => 1);
    const spans = readSpans(path);
    expect(spans.map((s) => s.nodeId)).toEqual(['R3', 'R5']);
    expect(spans[0]!.model).toBe('claude-opus-5');
    expect(spans[0]!.runId).toBe('run-1');
  });

  it('appendSpanRecords carries buffered records into the file; readSpans of a missing file is []', () => {
    const path = join(dir, 'x', 'trace.jsonl');
    expect(readSpans(path)).toEqual([]);
    appendSpanRecords(path, [{ spanId: 's', runId: 'r', nodeId: 'R1', attempt: 1, status: 'OK', startedAt: 1, endedAt: 2, errorDetail: null, model: null }]);
    expect(readSpans(path)).toHaveLength(1);
  });
});
