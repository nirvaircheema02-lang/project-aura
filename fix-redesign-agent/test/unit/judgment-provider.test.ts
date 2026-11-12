import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSessionLlmClient, validateJudgmentSubmission } from '../../src/llm/claude-session-client.ts';
import { createLlmClient } from '../../src/llm/provider.ts';
import { AwaitingJudgmentError } from '../../src/judgment/types.ts';
import { listJudgmentBundles, onlyPendingBundle, readJudgmentBundle, writeJudgmentResult } from '../../src/judgment/store.ts';
import { ensureRedesignDirs, judgmentBundlePath, judgmentResultPath, redesignPaths, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { MappingProposalSchema } from '../../src/mapping/model-schema.ts';
import type { LlmRequest } from '../../src/llm/client.ts';
import { TerminalError } from '../../src/retry.ts';

/**
 * `claude-session` judgmentProvider (docs/ARCHITECTURE.md §judgmentProvider) — the no-API path
 * for C2/R3/R5/L2/L3. Covers requirement #8's list: pending-bundle creation, schema validation
 * (valid + invalid submission), checkpoint/resume (a resolved bundle answers the SAME request
 * deterministically), retry limits (a still-pending bundle is never re-created/duplicated), and
 * that no external model or network call is ever made.
 */

let root: string;
let paths: RedesignPaths;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fra-judgment-'));
  paths = redesignPaths(root, 'proj', 'run-1');
  await ensureRedesignDirs(paths);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const c2Request: LlmRequest<unknown> = {
  nodeId: 'C2',
  system: 'You are the Element Mapper.',
  prompt: 'finding-1 vs candidate-a, candidate-b',
  images: [{ png: Buffer.from('fake-png'), caption: 'Live page crop', path: '/tmp/crop.png' }],
  schema: MappingProposalSchema,
};

const validC2Result = { proposals: [{ findingId: 'finding-1', selectedCandidateId: 'candidate-a', confidence: 0.9, reasoning: 'text and role match' }] };

describe('ClaudeSessionLlmClient — no external model/network call, ever', () => {
  it('never calls fetch, and needs no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN', async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    const originalToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls++;
      throw new Error('network call attempted — claude-session mode must never reach the network');
    }) as typeof fetch;
    try {
      const client = new ClaudeSessionLlmClient(paths, 'run-1');
      await expect(client.structured(c2Request)).rejects.toBeInstanceOf(AwaitingJudgmentError);
      await writeJudgmentResult(paths, (await listJudgmentBundles(paths))[0]!.bundleId, 'C2', validC2Result);
      const res = await client.structured(c2Request);
      expect(res.data).toEqual(validC2Result);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      if (originalToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
    }
  });

  it('createLlmClient never requires a credential when judgmentProvider is claude-session (the default)', () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createLlmClient({ anthropicModel: 'claude-opus-5', judgmentProvider: 'claude-session' }, { paths, redesignRunId: 'run-1' })).not.toThrow();
      expect(() => createLlmClient({ anthropicModel: 'claude-opus-5', judgmentProvider: 'anthropic-api' })).toThrow(TerminalError);
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});

describe('ClaudeSessionLlmClient — pending-bundle creation (checkpoint half)', () => {
  it('writes a versioned pending bundle with instructions/prompt/image paths/expected schema, then throws AwaitingJudgmentError', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    const err = await client.structured(c2Request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwaitingJudgmentError);
    const e = err as AwaitingJudgmentError;
    expect(e.nodeId).toBe('C2');
    expect(existsSync(e.bundlePath)).toBe(true);
    expect(e.bundlePath).toBe(judgmentBundlePath(paths, e.bundleId));

    const bundle = JSON.parse(readFileSync(e.bundlePath, 'utf8'));
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      bundleId: e.bundleId,
      redesignRunId: 'run-1',
      nodeId: 'C2',
      instructions: c2Request.system,
      prompt: c2Request.prompt,
      images: [{ path: '/tmp/crop.png', caption: 'Live page crop' }],
    });
    expect(bundle.jsonSchema).toMatchObject({ type: 'object' });
    expect(bundle.createdAt).toBeTruthy();
  });

  it('the SAME request content is content-addressed to the SAME bundleId — never duplicated on a second call (retry-limit safety)', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    const first = (await client.structured(c2Request).catch((e: unknown) => e)) as AwaitingJudgmentError;
    const second = (await client.structured(c2Request).catch((e: unknown) => e)) as AwaitingJudgmentError;
    expect(second.bundleId).toBe(first.bundleId);
    const bundles = await listJudgmentBundles(paths);
    expect(bundles).toHaveLength(1); // no duplicate bundle written for the identical request
  });

  it('a genuinely different request (different prompt) gets its OWN bundle — never conflated with an unrelated pending judgment', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    await client.structured(c2Request).catch(() => {});
    await client.structured({ ...c2Request, prompt: 'a completely different finding set' }).catch(() => {});
    const bundles = await listJudgmentBundles(paths);
    expect(bundles).toHaveLength(2);
    expect(new Set(bundles.map((b) => b.bundleId)).size).toBe(2);
  });

  it('rejects a nodeId outside the five judgment nodes without writing any bundle', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    await expect(client.structured({ ...c2Request, nodeId: 'R1' })).rejects.toBeInstanceOf(TerminalError);
    expect(await listJudgmentBundles(paths)).toHaveLength(0);
  });
});

describe('ClaudeSessionLlmClient — schema validation on submit', () => {
  it('a validated, submitted result is returned on the next call with the SAME request, with zero usage (no tokens spent)', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    const pending = (await client.structured(c2Request).catch((e: unknown) => e)) as AwaitingJudgmentError;
    await writeJudgmentResult(paths, pending.bundleId, 'C2', validC2Result);

    const res = await client.structured(c2Request);
    expect(res.data).toEqual(validC2Result);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });

  it('a submitted result that fails the REAL node schema (not just the recorded wire shape) is refused, naming the issues — never silently accepted', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    const pending = (await client.structured(c2Request).catch((e: unknown) => e)) as AwaitingJudgmentError;
    // confidence must be a number per MappingProposalSchema — this is a STRING, an invalid submission.
    await writeJudgmentResult(paths, pending.bundleId, 'C2', { proposals: [{ findingId: 'finding-1', selectedCandidateId: 'candidate-a', confidence: 'high', reasoning: 'nope' }] });

    const err = await client.structured(c2Request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/does not match the node's schema/);
    expect((err as Error).message).toContain('judgment submit');
  });

  it('validateJudgmentSubmission (shared with the CLI) accepts a valid C2 result and rejects an invalid one by name', () => {
    const ok = validateJudgmentSubmission('C2', validC2Result);
    expect(ok.ok).toBe(true);
    const bad = validateJudgmentSubmission('C2', { proposals: 'not-an-array' });
    expect(bad.ok).toBe(false);
    const unknownNode = validateJudgmentSubmission('R1', {});
    expect(unknownNode.ok).toBe(false);
  });
});

describe('judgment/store.ts — listing and lookup used by the CLI', () => {
  it('onlyPendingBundle auto-selects when exactly one bundle is unsubmitted, and refuses to guess otherwise', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    expect(onlyPendingBundle(await listJudgmentBundles(paths))).toBeNull(); // none yet

    const first = (await client.structured(c2Request).catch((e: unknown) => e)) as AwaitingJudgmentError;
    const only = onlyPendingBundle(await listJudgmentBundles(paths));
    expect(only?.bundleId).toBe(first.bundleId);

    await client.structured({ ...c2Request, prompt: 'a second, different judgment' }).catch(() => {});
    expect(onlyPendingBundle(await listJudgmentBundles(paths))).toBeNull(); // two pending now — ambiguous, must ask

    await writeJudgmentResult(paths, first.bundleId, 'C2', validC2Result);
    const rows = await listJudgmentBundles(paths);
    expect(rows.find((r) => r.bundleId === first.bundleId)?.submitted).toBe(true);
  });

  it('readJudgmentBundle round-trips exactly what was written, and returns null for an unknown id', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    const pending = (await client.structured(c2Request).catch((e: unknown) => e)) as AwaitingJudgmentError;
    const bundle = await readJudgmentBundle(paths, pending.bundleId);
    expect(bundle?.nodeId).toBe('C2');
    expect(await readJudgmentBundle(paths, 'nonexistent')).toBeNull();
  });

  it('writeJudgmentResult writes to judgmentResultPath, readable back as JudgmentResultFile', async () => {
    const client = new ClaudeSessionLlmClient(paths, 'run-1');
    const pending = (await client.structured(c2Request).catch((e: unknown) => e)) as AwaitingJudgmentError;
    await writeJudgmentResult(paths, pending.bundleId, 'C2', validC2Result, () => new Date('2026-09-23T00:00:00.000Z'));
    const raw = JSON.parse(readFileSync(judgmentResultPath(paths, pending.bundleId), 'utf8'));
    expect(raw).toMatchObject({ schemaVersion: 1, bundleId: pending.bundleId, nodeId: 'C2', submittedAt: '2026-09-23T00:00:00.000Z', data: validC2Result });
  });
});
