import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config/index.ts';
import { openDb, type Database } from '../../src/db/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { auditPage } from '../../src/agents/page-graph.ts';
import type { PageResult } from '../../src/skills/s0-result-contract.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { ScriptedLlmClient } from '../helpers/scripted-llm.ts';
import { KNOWN_WRONG_PAGE } from '../helpers/known-wrong-page.ts';
import { startMockMessagesApi, visualTokens, WireCheckedLlmClient, writeMessage, type MockMessagesApi } from '../helpers/mock-messages-api.ts';
import { AnthropicLlmClient, buildUserContent } from '../../src/llm/client.ts';
import Anthropic from '@anthropic-ai/sdk';
import { RepairableError, TerminalError, classify } from '../../src/graph/retry.ts';

/**
 * The REAL Claude client path, exercised without a credential. Every other
 * B-graph test hands answers straight back from the scripted stand-in, which
 * means the code that actually talks to Claude — request construction, the
 * structured-output schema the SDK generates, image encoding, response
 * parsing, error mapping — had never run once. Here all six nodes send real
 * SDK requests over HTTP to a local stand-in that enforces the documented API
 * limits and answers with the scripted data.
 */

let api: MockMessagesApi;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let db: Database;
let dir: string;
let result: PageResult | undefined;
const model = 'claude-opus-5';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-wire-'));
  const config = loadConfig();
  const registry = await loadDsRegistry(config.designSystemPath);
  db = openDb(join(dir, 'audit.db'));
  api = await startMockMessagesApi();
  server = await startLocalServer({ '/market-entry': { body: KNOWN_WRONG_PAGE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();

  result = await auditPage(
    `${server.origin}/market-entry`,
    {
      db,
      registry,
      aiMode: 'anthropic-api',
      llm: new WireCheckedLlmClient(api, new ScriptedLlmClient(), model),
      config,
      pool,
      politeness: new Politeness(0),
      evidenceRoot: join(dir, 'evidence'),
    },
    { runId: 'run-wire-1' },
  );
}, 180_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  await api?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('real AnthropicLlmClient → Messages API wire contract', () => {
  it('every AI node reached the API through the real client, in graph order, and every request was valid', () => {
    // B2 runs once per section (it needs each section's own evidence); every other node once per page.
    const distinct = api.checks.map((c) => c.node).filter((n, i, all) => n !== all[i - 1]);
    expect(distinct).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    for (const check of api.checks) expect(check.problems, `${check.node}: ${check.problems.join('; ')}`).toEqual([]);
  });

  it('B1 and B2 actually SEND the screenshots their prompts tell the model to use', () => {
    // Regression: both prompts referred to screenshots while sending none, so a real
    // model would have been asked to report "visual signals" from images it never saw.
    const b1 = api.checks.find((c) => c.node === 'B1')!;
    expect(b1.images.length).toBeGreaterThan(0);
    const b2 = api.checks.filter((c) => c.node === 'B2');
    expect(b2.length).toBeGreaterThan(0);
    for (const call of b2) expect(call.images.length).toBe(1);
  });

  it('sends the configured model with adaptive thinking and a valid effort', () => {
    for (const check of api.checks) {
      expect(check.model).toBe(model);
      expect(check.thinking).toBe('adaptive');
      expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(check.effort);
    }
  });

  it('every node\'s schema reached the API as structured-output JSON Schema (additionalProperties:false throughout)', () => {
    // inspectRequest rejects any object missing additionalProperties:false or any
    // unsupported keyword with a 400 — so a clean run means the SDK's generated
    // schema is acceptable for all six nodes.
    for (const check of api.checks) expect(check.schemaObjects).toBeGreaterThan(0);
  });

  it('screenshots travel as decodable PNGs inside the documented image limits', () => {
    const withImages = api.checks.filter((c) => c.images.length > 0);
    expect(withImages.length).toBeGreaterThan(0); // at least B1 tiles / B2 crops / B5 evidence
    for (const check of withImages) {
      const limit = check.images.length > 20 ? 2000 : 8000;
      for (const img of check.images) {
        expect(img.width).toBeLessThanOrEqual(limit);
        expect(img.height).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('the SDK parsed every response back into the node\'s schema, and the audit completed on it', () => {
    expect(result).toBeDefined();
    // Same known-wrong page as the scripted test — the measured 44px CTA must still be caught
    // when the answers travel through the real client instead of being handed back in-process.
    const deviation = result!.findings.find(
      (f) => f.classification === 'DEVIATION' && f.comparison.mismatches.some((m) => m.property === 'height' && m.actual === '44px'),
    );
    expect(deviation).toBeDefined();
  });
});

describe('real client failure mapping (§2.4) against real SDK errors', () => {
  /** A server that answers every request with an HTTP error, or with a (streamed) message ending in `stopReason`. */
  async function clientAgainst(reply: { status: number; body: object } | { stopReason: 'end_turn' | 'max_tokens' | 'refusal'; text: string }) {
    const { createServer } = await import('node:http');
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if ('status' in reply) {
          res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
          return;
        }
        const streamed = (JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { stream?: boolean }).stream === true;
        writeMessage(res, { id: 'm', model, text: reply.text, stopReason: reply.stopReason, inputTokens: 1 }, streamed);
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const baseURL = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    const client = new AnthropicLlmClient(model, new Anthropic({ baseURL, apiKey: 'x', maxRetries: 0 }), { sleep: async () => {} });
    return { client, baseURL, close: () => new Promise<void>((r) => s.close(() => r())) };
  }
  const req = { nodeId: 'B1', system: 's', prompt: 'p', schema: z.object({ a: z.string() }) };

  it('a 400 (e.g. a schema the API refuses) is TERMINAL — no retry budget burned on a request that cannot succeed', async () => {
    const { client, close } = await clientAgainst({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } } });
    await expect(client.structured(req)).rejects.toBeInstanceOf(TerminalError);
    await close();
  });

  it('a 529 overload is retried PER CALL with backoff, and succeeds when the overload passes', async () => {
    const { createServer } = await import('node:http');
    let calls = 0;
    const s = createServer((request, res) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        calls++;
        if (calls <= 2) {
          res.writeHead(529, { 'content-type': 'application/json', ...(calls === 2 ? { 'retry-after': '7' } : {}) }).end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
          return;
        }
        writeMessage(res, { id: 'm', model, text: '{"a":"ok"}', stopReason: 'end_turn', inputTokens: 1 }, true);
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const waits: number[] = [];
    const client = new AnthropicLlmClient(model, new Anthropic({ baseURL: `http://127.0.0.1:${(s.address() as { port: number }).port}`, apiKey: 'x', maxRetries: 0 }), {
      sleep: async (ms) => void waits.push(ms),
    });
    const res = await client.structured(req);
    expect(res.data).toEqual({ a: 'ok' });
    expect(calls).toBe(3); // two overloads ridden out inside ONE node attempt
    expect(waits[1]).toBe(7000); // retry-after honoured
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('a persistent overload ends TERMINAL after the transport budget, so the node is not re-run on top of it', async () => {
    const { baseURL, close } = await clientAgainst({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    const client = new AnthropicLlmClient(model, new Anthropic({ baseURL, apiKey: 'x', maxRetries: 0 }), {
      sleep: async () => {},
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const err = await client.structured(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect(String(err)).toContain('persisted through 3 attempts');
    expect(classify(err)).toBe('TERMINAL');
    await close();
  });

  it('a truncated response is retried ONCE with double the budget, never parsed as a partial result', async () => {
    const { createServer } = await import('node:http');
    const budgets: number[] = [];
    const s = createServer((request, res) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { max_tokens: number };
        budgets.push(body.max_tokens);
        const truncated = budgets.length === 1;
        writeMessage(res, { id: 'm', model, text: truncated ? '{"a":' : '{"a":"done"}', stopReason: truncated ? 'max_tokens' : 'end_turn', inputTokens: 1 }, true);
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const client = new AnthropicLlmClient(model, new Anthropic({ baseURL: `http://127.0.0.1:${(s.address() as { port: number }).port}`, apiKey: 'x', maxRetries: 0 }), { sleep: async () => {} });
    const res = await client.structured(req);
    expect(res.data).toEqual({ a: 'done' });
    expect(budgets).toEqual([32_000, 64_000]); // not the byte-identical replay the node retry would send
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('truncating even at the doubled budget is TERMINAL, naming both budgets', async () => {
    const { client, close } = await clientAgainst({ stopReason: 'max_tokens', text: '{"a":' });
    const err = await client.structured(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect(String(err)).toContain('32000 then 64000');
    await close();
  });

  it('a connection dropped MID-STREAM is retried per call, not failed as a node', async () => {
    const { createServer } = await import('node:http');
    let calls = 0;
    const s = createServer((request, res) => {
      request.resume();
      request.on('end', () => {
        calls++;
        if (calls === 1) {
          // message_start arrives, then the socket dies before message_stop.
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        writeMessage(res, { id: 'm2', model, text: '{"a":"ok"}', stopReason: 'end_turn', inputTokens: 1 }, true);
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const client = new AnthropicLlmClient(model, new Anthropic({ baseURL: `http://127.0.0.1:${(s.address() as { port: number }).port}`, apiKey: 'x', maxRetries: 0 }), { sleep: async () => {} });
    expect((await client.structured(req)).data).toEqual({ a: 'ok' });
    expect(calls).toBe(2);
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('a retry-after beyond the transport cap fails clearly instead of sleeping for an hour', async () => {
    const { createServer } = await import('node:http');
    const s = createServer((request, res) => {
      request.resume();
      request.on('end', () => res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' }).end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })));
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const slept: number[] = [];
    const client = new AnthropicLlmClient(model, new Anthropic({ baseURL: `http://127.0.0.1:${(s.address() as { port: number }).port}`, apiKey: 'x', maxRetries: 0 }), { sleep: async (ms) => void slept.push(ms) });
    const err = await client.structured(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect(String(err)).toMatch(/asks to wait 3600s/);
    expect(slept).toEqual([]);
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('a refusal is TERMINAL — never retried, never parsed as output', async () => {
    const { client, close } = await clientAgainst({ stopReason: 'refusal', text: '' });
    const err = await client.structured(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect(classify(err)).toBe('TERMINAL');
    await close();
  });

  it('an answer that does not fit the node schema is REPAIRABLE with the schema error named', async () => {
    const { client, close } = await clientAgainst({ stopReason: 'end_turn', text: '{"b": 1}' });
    const err = await client.structured(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepairableError);
    expect(String(err)).toContain('did not match the node schema');
    await close();
  });
});

describe('oversized screenshots never fail a node', () => {
  function png(width: number, height: number): Buffer {
    const header = Buffer.alloc(24);
    header.writeUInt32BE(0x89504e47, 0);
    header.writeUInt32BE(0x0d0a1a0a, 4);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header;
  }

  it('replaces an over-limit image with a labelled note instead of sending it', () => {
    const { content, omitted } = buildUserContent([{ png: png(1440, 9000), caption: 'Section "Footer"' }, { png: png(1440, 900), caption: 'Tile 1' }], 'go');
    expect(omitted).toHaveLength(1);
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
    expect(JSON.stringify(content)).toContain('screenshot NOT provided');
    expect(content.at(-1)).toEqual({ type: 'text', text: 'go' }); // prompt stays last
  });

  it('keeps the whole request under the body budget, omitting (and reporting) images past it', () => {
    // Each ~6 MB image is individually legal; five of them are not, together.
    const big = (i: number) => ({ png: Buffer.concat([png(1440, 2000), Buffer.alloc(4.5 * 1024 * 1024)]), caption: `strip ${i}` });
    const { content, omitted } = buildUserContent([big(1), big(2), big(3), big(4), big(5)], 'go');
    const sent = content.filter((b) => b.type === 'image').length;
    expect(sent).toBeGreaterThan(0);
    expect(sent + omitted.length).toBe(5);
    expect(omitted.every((o) => o.includes('request-size budget'))).toBe(true);
    const bytes = content.reduce((n, b) => n + (b.type === 'image' && b.source.type === 'base64' ? b.source.data.length : 0), 0);
    expect(bytes).toBeLessThanOrEqual(28 * 1024 * 1024);
  });

  it('applies the stricter 2000px limit once a request carries more than 20 images', () => {
    const images = Array.from({ length: 21 }, (_, i) => ({ png: png(2400, 900), caption: `img ${i}` }));
    expect(buildUserContent(images, 'go').omitted).toHaveLength(21);
    expect(buildUserContent(images.slice(0, 20), 'go').omitted).toHaveLength(0);
  });
});

describe('visual-token math used for sizing', () => {
  it('matches the documented high-resolution tier table', () => {
    expect(visualTokens(200, 200)).toBe(64);
    expect(visualTokens(1000, 1000)).toBe(1296);
    expect(visualTokens(1920, 1080)).toBe(2691);
    expect(visualTokens(2000, 1500)).toBe(3888);
  });
});
