import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { RepairableError, TerminalError } from '../graph/retry.ts';

/**
 * The single place this service talks to Claude. Every AI node goes through
 * `LlmClient`, so the whole B-graph can run against a deterministic
 * implementation in tests (and so a future model/provider change touches one
 * file). Structured output is mandatory — every node returns a Zod-validated
 * object, never free text to be parsed downstream.
 */

export interface LlmImage {
  /** Raw PNG bytes; base64-encoded here rather than by every caller. */
  png: Buffer;
  caption: string;
}

export interface LlmRequest<T> {
  /** Which graph node is asking — used for tracing (§2.6) and for test doubles to branch. */
  nodeId: string;
  system: string;
  prompt: string;
  images?: LlmImage[];
  schema: z.ZodType<T>;
  /** Cheap, mechanical nodes should not pay for deep reasoning. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

export interface LlmResponse<T> {
  data: T;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  /**
   * Images the request could not carry (over an API limit), as `caption — reason`.
   * Callers record these as coverage boundaries: a verdict reached without its
   * picture must say so in the report.
   */
  omittedImages?: string[];
}

export interface LlmClient {
  structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}

/**
 * Output budget. Adaptive thinking counts against max_tokens, so a node that
 * enumerates a whole page needs real headroom; you pay only for tokens
 * actually generated, so a generous ceiling costs nothing when unused.
 * Requests are streamed, so the SDK's non-streaming ~10-minute guard (which
 * refuses max_tokens above ~21k) does not apply.
 */
export const DEFAULT_MAX_TOKENS = 32_000;
/** Opus 5's output ceiling — the most one call can ever return. */
export const MAX_OUTPUT_TOKENS = 128_000;

/** Messages API image limits (vision docs, checked 2026-09-11). */
export const IMAGE_LIMITS = { sidePx: 8000, sidePxWhenOver20Images: 2000, base64Bytes: 10 * 1024 * 1024 } as const;

/**
 * Budget for the whole request body. The API limit is 32 MB; the headroom
 * covers the system prompt, the JSON schema and JSON escaping. Several images
 * that are each legal can still add up past it — and a 413 would make the
 * whole node TERMINAL.
 */
export const REQUEST_BODY_BUDGET_BYTES = 28 * 1024 * 1024;

function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Builds the user turn. An image the API would reject (over the per-side,
 * per-image or whole-request size limit) is replaced by a labelled text note
 * rather than sent: one tall screenshot must not turn a whole node into a
 * TERMINAL 400/413. The note tells the model the picture is missing, so it
 * never "describes" an image it did not receive; `omitted` tells the caller,
 * so the report does too.
 */
export function buildUserContent(images: LlmImage[], prompt: string, system = ''): { content: Anthropic.ContentBlockParam[]; omitted: string[] } {
  const content: Anthropic.ContentBlockParam[] = [];
  const omitted: string[] = [];
  const sideLimit = images.length > 20 ? IMAGE_LIMITS.sidePxWhenOver20Images : IMAGE_LIMITS.sidePx;
  let bodyBytes = Buffer.byteLength(prompt) + Buffer.byteLength(system) + images.reduce((n, i) => n + Buffer.byteLength(i.caption), 0);
  for (const image of images) {
    const size = pngSize(image.png);
    const data = image.png.toString('base64');
    const why = !size
      ? 'not a decodable PNG'
      : size.width > sideLimit || size.height > sideLimit
        ? `${size.width}×${size.height}px, over the ${sideLimit}px per-side limit`
        : data.length > IMAGE_LIMITS.base64Bytes
          ? `${(data.length / 1048576).toFixed(1)} MB base64, over the 10 MB per-image limit`
          : bodyBytes + data.length > REQUEST_BODY_BUDGET_BYTES
            ? 'the request-size budget was already used by earlier images'
            : null;
    if (why) {
      omitted.push(`${image.caption} — ${why}`);
      content.push({ type: 'text', text: `${image.caption} — [screenshot NOT provided: ${why}. Do not describe it; rely on the other evidence.]` });
      continue;
    }
    bodyBytes += data.length;
    content.push({ type: 'text', text: image.caption });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
  }
  // The prompt goes last: images before text is the ordering the vision docs recommend.
  content.push({ type: 'text', text: prompt });
  return { content, omitted };
}

/**
 * The JSON Schema sent to the API: zod's own output, verbatim (minus
 * `$schema`). Deliberately NOT the SDK's `zodOutputFormat` helper: in SDK
 * 0.124.0 it moves every `enum` into description text, so the API never
 * enforced a single enum and one out-of-list value (`"kind": "header"`)
 * failed a whole node after the fact. The flip side — anything zod emits
 * reaches the API unfiltered — is guarded by test/unit/llm-schemas.test.ts.
 */
export function wireSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
}

/**
 * Transient API failures (429, 5xx including 529 overloaded, connection drops,
 * a mid-stream overloaded event) are retried HERE, per call, honouring
 * `retry-after` — not by re-running the whole node: a node retry re-issues
 * every earlier call in it (B2 makes one per section), and the node policy's
 * two attempts ~5 s apart could not ride out an ordinary overload window.
 */
export interface TransportRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const TRANSPORT_RETRY: TransportRetryPolicy = { maxAttempts: 6, baseDelayMs: 2_000, maxDelayMs: 60_000 };

export function isTransientApiError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError && err.status === undefined) {
    const type = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
    return type === 'overloaded_error' || type === 'api_error' || type === 'rate_limit_error';
  }
  return false;
}

function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: Headers | Record<string, string> } | undefined)?.headers;
  const get = (name: string) => (headers instanceof Headers ? headers.get(name) : (headers?.[name] ?? null));
  const ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly retry: TransportRetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(model: string, client?: Anthropic, options: { retry?: TransportRetryPolicy; sleep?: (ms: number) => Promise<void> } = {}) {
    this.model = model;
    // maxRetries: 0 on the SDK is deliberate (IMPLEMENTATION-PLAN.md §3): its own
    // backoff tops out at ~8 s, which would silently multiply against ours. This
    // class owns transport retry; the graph owns node retry.
    this.client = client ?? new Anthropic({ maxRetries: 0 });
    this.retry = options.retry ?? TRANSPORT_RETRY;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * One streamed request with per-call transient retry. The stream handle is
   * kept so a connection dropped MID-STREAM (a plain AnthropicError once the
   * response has started) is retried here rather than failing the node; a
   * missing credential (no response ever started) is not mistaken for one.
   */
  private async send(params: Anthropic.MessageStreamParams, nodeId: string): Promise<Anthropic.Message> {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      let stream: ReturnType<Anthropic['messages']['stream']> | undefined;
      try {
        // Streamed, then collected: vision + adaptive-thinking calls can run for
        // minutes, and streaming is what the SDK requires for long requests. No
        // parse function is attached, so the SDK never parses eagerly — parse()
        // used to throw before stop_reason was read (found by the llm-wire test).
        stream = this.client.messages.stream(params);
        return await stream.finalMessage();
      } catch (err) {
        const droppedMidStream = err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && stream?.response != null;
        if (isTransientApiError(err) || droppedMidStream) {
          if (attempt >= this.retry.maxAttempts) {
            throw new TerminalError(
              `${nodeId}: transient API errors persisted through ${attempt} attempts over ${Math.round((Date.now() - started) / 1000)}s — last: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          const hinted = retryAfterMs(err);
          if (hinted !== null && hinted > this.retry.maxDelayMs) {
            // A server asking for a longer wait than the policy allows is a rate-limit
            // wall, not a blip: fail clearly now rather than sleeping for an hour.
            throw new TerminalError(`${nodeId}: rate limited — the API asks to wait ${Math.round(hinted / 1000)}s, over the ${this.retry.maxDelayMs / 1000}s transport cap`);
          }
          const backoff = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
          await this.sleep(hinted ?? Math.round(backoff / 2 + (Math.random() * backoff) / 2));
          continue;
        }
        // Map SDK errors onto the graph's failure classes (§2.4) so retry policy
        // and escalation behave correctly without string-matching error text.
        if (err instanceof Anthropic.BadRequestError) throw new TerminalError(`${nodeId}: bad request — ${err.message}`);
        if (err instanceof Anthropic.AuthenticationError) throw new TerminalError(`${nodeId}: authentication failed — ${err.message}`);
        if (err instanceof Anthropic.PermissionDeniedError) throw new TerminalError(`${nodeId}: permission denied — ${err.message}`);
        if (err instanceof Anthropic.APIError && err.status === 413) throw new TerminalError(`${nodeId}: request too large for the API — ${err.message}`);
        throw err;
      }
    }
  }

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const { content, omitted } = buildUserContent(req.images ?? [], req.prompt, req.system);
    const base = {
      model: this.model,
      system: req.system,
      thinking: { type: 'adaptive' as const },
      output_config: { format: { type: 'json_schema' as const, schema: wireSchema(req.schema) }, effort: req.effort ?? 'high' },
      messages: [{ role: 'user' as const, content }],
    };

    // Truncation gets ONE retry with double the budget, inside this call — the
    // node-level retry would replay the byte-identical request and truncate again.
    const firstBudget = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const budgets = firstBudget < MAX_OUTPUT_TOKENS ? [firstBudget, Math.min(MAX_OUTPUT_TOKENS, firstBudget * 2)] : [firstBudget];
    let message: Anthropic.Message | undefined;
    for (const [i, budget] of budgets.entries()) {
      message = await this.send({ ...base, max_tokens: budget }, req.nodeId);
      // stop_reason BEFORE parsing: a refusal or a truncated answer is not a
      // malformed answer, and must not be treated as one.
      if (message.stop_reason === 'refusal') {
        throw new TerminalError(`${req.nodeId}: request refused (${message.stop_details?.category ?? 'unspecified'})`);
      }
      if (message.stop_reason !== 'max_tokens') break;
      if (i === budgets.length - 1) {
        throw new TerminalError(`${req.nodeId}: response hit max_tokens even at ${budgets.join(' then ')} tokens — the request asks for more output than one call can hold`);
      }
    }
    if (!message) throw new TerminalError(`${req.nodeId}: no response`);

    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new RepairableError(`${req.nodeId}: structured output did not match the node schema — not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new RepairableError(`${req.nodeId}: structured output did not match the node schema — ${issues}`);
    }
    const data = parsed.data;

    return {
      data,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      },
      omittedImages: omitted,
    };
  }
}

/** True when a real API credential is resolvable — the B-graph's AI nodes cannot run without one. */
export function hasApiCredential(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
}
