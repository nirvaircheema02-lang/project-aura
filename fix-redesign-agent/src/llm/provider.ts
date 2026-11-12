import type { z } from 'zod';
import { TerminalError } from '../retry.ts';
import { AnthropicLlmClient, hasApiCredential, type LlmClient, type LlmRequest, type LlmResponse } from './client.ts';
import { ClaudeSessionLlmClient } from './claude-session-client.ts';
import type { RedesignPaths } from '../output/redesign-store.ts';

/**
 * Model access for C2/R3/R5/L2/L3's judgment. Two providers (`config.judgmentProvider`,
 * default `claude-session`):
 *
 *  - `claude-session`: no external model API, no credential — `ClaudeSessionLlmClient` writes
 *    a pending judgment bundle and the pipeline checkpoints; the Session Agent (the Claude
 *    Code instance the run was started from) performs the judgment and submits it via
 *    `judgment submit`. Needs `judgmentCtx` (this run's `paths`/`redesignRunId`) — every
 *    judgment-node call site in pipeline.ts has both by the time it calls this.
 *  - `anthropic-api`: the original behavior. Unlike audit-agent there is no `no-api` default
 *    for THIS provider — planning a redesign from free-text findings against a live DOM
 *    genuinely needs semantic judgment. The client itself is audit-agent's proven wrapper
 *    (`client.ts`, vendored): streamed requests, `stop_reason` read before parsing, the
 *    node's zod schema sent verbatim as the JSON schema, transient errors retried per call
 *    honouring `retry-after`.
 */
export function createLlmClient(config: { anthropicModel: string; judgmentProvider: 'claude-session' | 'anthropic-api'; deterministicJudgments?: boolean }, judgmentCtx?: { paths: Pick<RedesignPaths, 'judgmentsDir'>; redesignRunId: string }): LlmClient {
  if (config.judgmentProvider === 'claude-session') {
    if (!judgmentCtx) throw new TerminalError('claude-session mode: this node was called with no run context (paths/redesignRunId) to write a judgment bundle into — an orchestrator wiring bug, not a user error.');
    return new ClaudeSessionLlmClient(judgmentCtx.paths, judgmentCtx.redesignRunId, { deterministic: config.deterministicJudgments === true });
  }
  if (!hasApiCredential()) {
    throw new TerminalError('R3/R5/C2/L2 need a model: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in fix-redesign-agent/.env (gitignored) or the environment — or set judgmentProvider to "claude-session" (the default) to run inside this Claude Code session with no credential. `redesign --dry-run` needs neither.');
  }
  return new AnthropicLlmClient(config.anthropicModel);
}

export { hasApiCredential };

/**
 * Test double: answers each node from a script, validated against the node's own schema
 * exactly like a real response would be — so a test cannot accidentally hand a node an
 * object the schema would have rejected on the wire. Records every request for assertions.
 */
export class ScriptedLlmClient implements LlmClient {
  readonly requests: Array<{ nodeId: string; system: string; prompt: string; imageCount: number }> = [];
  private readonly script: Map<string, unknown[]>;

  constructor(script: Record<string, unknown[]>) {
    this.script = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  }

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.requests.push({ nodeId: req.nodeId, system: req.system, prompt: req.prompt, imageCount: req.images?.length ?? 0 });
    const queue = this.script.get(req.nodeId);
    const next = queue?.shift();
    if (next === undefined) throw new TerminalError(`ScriptedLlmClient: no scripted answer left for ${req.nodeId}`);
    const parsed = (req.schema as z.ZodType<T>).safeParse(next);
    if (!parsed.success) {
      throw new TerminalError(`ScriptedLlmClient: scripted answer for ${req.nodeId} does not match the node schema — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return { data: parsed.data, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, omittedImages: [] };
  }
}
