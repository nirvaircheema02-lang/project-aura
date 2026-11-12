import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { AnthropicLlmClient, type LlmClient, type LlmRequest, type LlmResponse } from '../../src/llm/client.ts';
import { B1SectionsSchema, B2ComponentsSchema, B3MatchesSchema, B4ExpectationsSchema, B5VerdictsSchema, B6EvaluationsSchema } from '../../src/llm/schemas/b-nodes.ts';
import { ScriptedLlmClient } from './scripted-llm.ts';

/**
 * A local stand-in for POST /v1/messages that lets the REAL AnthropicLlmClient
 * run end to end — real SDK, real request construction, real HTTP, real
 * structured-output parsing — without a credential and without spending
 * anything. Every request is checked against the documented API limits.
 *
 * It does NOT judge anything: the answer each node receives comes from the
 * scripted stand-in (handed over through `next`), so what this proves is the
 * wire contract, never model quality.
 *
 * Limits, from the Messages API / vision docs (checked 2026-09-11):
 * - structured outputs: every object needs `additionalProperties: false`;
 *   numeric/string length constraints are unsupported (the SDK strips them)
 * - images: ≤ 600 per request (1M-context models), ≤ 8000 px per side, and
 *   ≤ 2000 px per side for EVERY image once a request carries more than 20;
 *   ≤ 10 MB base64 per image; PNG/JPEG/GIF/WebP only
 * - request body ≤ 32 MB
 * - Opus 5: adaptive thinking (no budget_tokens), effort low..max,
 *   `thinking: disabled` only at effort ≤ high, max_tokens ≤ 128000
 * - token cost of an image: ⌈w/28⌉ × ⌈h/28⌉ visual tokens after downscaling
 *   to the high-resolution tier (2576 px long edge, 4784 tokens max)
 */

export interface WireImage {
  width: number;
  height: number;
  base64Bytes: number;
  visualTokens: number;
}

export interface WireCheck {
  node: string;
  model: string;
  bodyBytes: number;
  maxTokens: number;
  effort: string | undefined;
  thinking: string | undefined;
  images: WireImage[];
  textChars: number;
  /** Rough: text at ~4 chars/token plus exact visual-token math. Good enough to size a run, not to bill it. */
  estimatedInputTokens: number;
  schemaObjects: number;
  problems: string[];
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const UNSUPPORTED_SCHEMA_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength'];

/** PNG IHDR: width/height are the two big-endian u32s at byte offsets 16 and 20. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function visualTokens(width: number, height: number): number {
  const LONG_EDGE = 2576;
  const MAX_TOKENS = 4784;
  let scale = Math.min(1, LONG_EDGE / Math.max(width, height));
  let w = Math.max(1, Math.floor(width * scale));
  let h = Math.max(1, Math.floor(height * scale));
  let tokens = Math.ceil(w / 28) * Math.ceil(h / 28);
  // Shrink further until under the visual-token cap, preserving aspect ratio.
  while (tokens > MAX_TOKENS) {
    scale *= 0.98;
    w = Math.max(1, Math.floor(width * scale));
    h = Math.max(1, Math.floor(height * scale));
    tokens = Math.ceil(w / 28) * Math.ceil(h / 28);
  }
  return tokens;
}

function checkSchema(node: unknown, path: string, problems: string[], counter: { objects: number }): void {
  if (!node || typeof node !== 'object') return;
  const schema = node as Record<string, unknown>;
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
    counter.objects++;
    if (schema.additionalProperties !== false) problems.push(`schema ${path || '<root>'}: object without additionalProperties:false`);
    const props = Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {});
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!props.includes(req)) problems.push(`schema ${path}: required "${req}" is not a property`);
    }
  }
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (keyword in schema) problems.push(`schema ${path || '<root>'}: unsupported keyword "${keyword}" reached the API`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value)) value.forEach((v, i) => checkSchema(v, `${path}/${key}/${i}`, problems, counter));
    else if (value && typeof value === 'object') checkSchema(value, `${path}/${key}`, problems, counter);
  }
}

export function inspectRequest(raw: Buffer, node: string): WireCheck {
  const problems: string[] = [];
  const body = JSON.parse(raw.toString('utf-8')) as Record<string, any>;

  if (raw.length > 32 * 1024 * 1024) problems.push(`request body ${(raw.length / 1e6).toFixed(1)} MB exceeds 32 MB`);
  if (typeof body.model !== 'string' || !body.model) problems.push('missing model');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 128_000) problems.push(`max_tokens ${body.max_tokens} outside 1..128000`);

  const thinking = body.thinking?.type as string | undefined;
  if (body.thinking && 'budget_tokens' in body.thinking) problems.push('thinking.budget_tokens is rejected on Opus 5 — use adaptive');
  if (thinking !== undefined && thinking !== 'adaptive' && thinking !== 'disabled') problems.push(`thinking.type "${thinking}" not valid for Opus 5`);

  const effort = body.output_config?.effort as string | undefined;
  if (effort !== undefined && !EFFORTS.has(effort)) problems.push(`effort "${effort}" invalid`);
  if (thinking === 'disabled' && (effort === 'xhigh' || effort === 'max')) problems.push('thinking disabled with effort xhigh/max returns 400 on Opus 5');
  if ('output_format' in body) problems.push('deprecated top-level output_format sent');

  const format = body.output_config?.format;
  const counter = { objects: 0 };
  if (!format || format.type !== 'json_schema' || typeof format.schema !== 'object') problems.push('no json_schema output_config.format');
  else checkSchema(format.schema, '', problems, counter);

  const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
  if (messages.at(-1)?.role !== 'user') problems.push('last message is not a user turn (assistant prefill 400s on Opus 5)');

  const images: WireImage[] = [];
  let textChars = typeof body.system === 'string' ? body.system.length : 0;
  for (const message of messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content as Array<Record<string, any>>);
    for (const block of blocks) {
      if (block.type === 'text') textChars += String(block.text).length;
      if (block.type === 'image') {
        const source = block.source ?? {};
        if (source.type !== 'base64') continue;
        if (!MEDIA_TYPES.has(source.media_type)) problems.push(`image media_type ${source.media_type} unsupported`);
        const data = String(source.data);
        const size = pngSize(Buffer.from(data.slice(0, 64), 'base64'));
        if (!size) {
          problems.push('image is not a decodable PNG');
          continue;
        }
        images.push({ ...size, base64Bytes: data.length, visualTokens: visualTokens(size.width, size.height) });
      }
    }
  }
  if (images.length > 600) problems.push(`${images.length} images exceeds 600 per request`);
  const perSideLimit = images.length > 20 ? 2000 : 8000;
  images.forEach((img, i) => {
    if (img.width > perSideLimit || img.height > perSideLimit) {
      problems.push(`image ${i + 1} is ${img.width}×${img.height}px — over the ${perSideLimit}px per-side limit${images.length > 20 ? ' that applies once a request has more than 20 images' : ''}`);
    }
    if (img.base64Bytes > 10 * 1024 * 1024) problems.push(`image ${i + 1} is ${(img.base64Bytes / 1e6).toFixed(1)} MB base64, over 10 MB`);
  });

  return {
    node,
    model: body.model,
    bodyBytes: raw.length,
    maxTokens: body.max_tokens,
    effort,
    thinking,
    images,
    textChars,
    estimatedInputTokens: Math.round(textChars / 4) + images.reduce((n, i) => n + i.visualTokens, 0),
    schemaObjects: counter.objects,
    problems,
  };
}

export interface MockMessage {
  id: string;
  model: string;
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'refusal';
  inputTokens: number;
}

/** A complete Messages API response, as JSON or as the SSE event sequence a streamed request receives. */
export function writeMessage(res: ServerResponse, msg: MockMessage, streamed: boolean): void {
  const outputTokens = Math.max(1, Math.ceil(msg.text.length / 4));
  if (!streamed) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: msg.id, type: 'message', role: 'assistant', model: msg.model,
        content: [{ type: 'text', text: msg.text }],
        stop_reason: msg.stopReason, stop_sequence: null,
        usage: { input_tokens: msg.inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    );
    return;
  }
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: msg.id, type: 'message', role: 'assistant', model: msg.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: msg.inputTokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: msg.text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: msg.stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

export interface MockMessagesApi {
  baseURL: string;
  checks: WireCheck[];
  /** The answer the next request receives, and which node it is for. Set by `WireCheckedLlmClient`. */
  next: { node: string; data: unknown } | null;
  close(): Promise<void>;
}

export async function startMockMessagesApi(): Promise<MockMessagesApi> {
  const api: MockMessagesApi = { baseURL: '', checks: [], next: null, close: async () => {} };
  let counter = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: req.url } }));
        return;
      }
      const pending = api.next;
      api.next = null;
      const raw = Buffer.concat(chunks);
      const check = inspectRequest(raw, pending?.node ?? 'unknown');
      api.checks.push(check);
      if (check.problems.length > 0) {
        // Exactly what the real API would do with an invalid request.
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: check.problems.join('; ') } }),
        );
        return;
      }
      const streamed = (JSON.parse(raw.toString('utf-8')) as { stream?: boolean }).stream === true;
      writeMessage(
        res,
        { id: `msg_wire_${++counter}`, model: check.model, text: JSON.stringify(pending?.data ?? {}), stopReason: 'end_turn', inputTokens: check.estimatedInputTokens },
        streamed,
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return api;
}

const NODE_SCHEMAS: Record<string, z.ZodType> = {
  B1: B1SectionsSchema,
  B2: B2ComponentsSchema,
  B3: B3MatchesSchema,
  B4: B4ExpectationsSchema,
  B5: B5VerdictsSchema,
  B6: B6EvaluationsSchema,
};

export interface ScriptedMessagesApi {
  baseURL: string;
  checks: WireCheck[];
  /** Requests received so far (including ones being held). */
  received: number;
  close(): Promise<void>;
}

/**
 * A stand-in Messages API for a SEPARATE process (the real CLI, spawned). With
 * no in-process side channel, it works out which node is asking from the
 * system prompt ("…(B4)…"), answers with the scripted stand-in against that
 * node's real schema, and still enforces every wire check. `mode: 'fail'`
 * answers everything with a 400; `mode: 'hold'` never answers (to test an
 * interrupt mid-call).
 */
export async function startScriptedMessagesApi(mode: 'answer' | 'fail' | 'hold' = 'answer'): Promise<ScriptedMessagesApi> {
  const scripted = new ScriptedLlmClient();
  const api: ScriptedMessagesApi = { baseURL: '', checks: [], received: 0, close: async () => {} };
  const held: ServerResponse[] = [];
  let counter = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      api.received++;
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString('utf-8')) as { system?: string; stream?: boolean; messages?: Array<{ content: Array<{ type: string; text?: string }> }> };
      const node = body.system?.match(/\(([AB]\d)\)/)?.[1] ?? 'unknown';
      const check = inspectRequest(raw, node);
      api.checks.push(check);
      if (mode === 'hold') {
        held.push(res);
        return;
      }
      if (mode === 'fail' || check.problems.length > 0) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: check.problems.join('; ') || 'e2e: every request refused' } }),
        );
        return;
      }
      const blocks = body.messages?.at(-1)?.content ?? [];
      const prompt = [...blocks].reverse().find((b) => b.type === 'text')?.text ?? '';
      const schema = NODE_SCHEMAS[node];
      if (!schema) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `no script for ${node}` } }));
        return;
      }
      const { data } = await scripted.structured({ nodeId: node, system: body.system ?? '', prompt, schema });
      writeMessage(res, { id: `msg_e2e_${++counter}`, model: check.model, text: JSON.stringify(data), stopReason: 'end_turn', inputTokens: check.estimatedInputTokens }, body.stream === true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () =>
    new Promise<void>((resolve) => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return api;
}

/**
 * The real AnthropicLlmClient, talking to the local stand-in. `answers`
 * decides what each node gets back; this client makes the request travel
 * the real path (SDK → HTTP → validation → SDK parse) to get it.
 */
export class WireCheckedLlmClient implements LlmClient {
  private readonly real: AnthropicLlmClient;
  private readonly api: MockMessagesApi;
  private readonly answers: LlmClient;

  constructor(api: MockMessagesApi, answers: LlmClient, model: string) {
    this.api = api;
    this.answers = answers;
    this.real = new AnthropicLlmClient(model, new Anthropic({ baseURL: api.baseURL, apiKey: 'wire-check-offline-no-real-key', maxRetries: 0 }));
  }

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const answer = await this.answers.structured(req);
    this.api.next = { node: req.nodeId, data: answer.data };
    return this.real.structured(req);
  }
}
