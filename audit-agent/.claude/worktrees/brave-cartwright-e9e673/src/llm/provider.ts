import { TerminalError } from '../graph/retry.ts';
import { AnthropicLlmClient, hasApiCredential, type LlmClient, type LlmRequest, type LlmResponse } from './client.ts';

/**
 * Execution mode (ARCHITECTURE.md Decision Log #31). Every AI node — A2, A4
 * and B1–B6 — has two strategies behind the same graph node:
 *
 *  - `no-api` (the v1 DEFAULT): deterministic. Playwright capture, the DOM,
 *    computed styles, the Design System's own source and tokens, and the
 *    measurable DS rules decide everything; whatever cannot be proven without
 *    semantic judgment is published as NEEDS_REVIEW or UNVERIFIED, never
 *    guessed. No model API is called and no credential is needed.
 *  - `anthropic-api`: the Claude path built for step 11 — kept intact and
 *    isolated behind `LlmClient`, and DISABLED unless explicitly configured.
 *
 * The mode is part of the policy version (run-metadata.ts): a no-api result
 * and a model result are different baselines, so a re-audit that changes
 * modes never reports the difference as a page regression (Decision Log #29).
 */

export type AiMode = 'no-api' | 'anthropic-api';

export const AI_MODES: readonly AiMode[] = ['no-api', 'anthropic-api'];

/** v1 runs without any model API. */
export const DEFAULT_AI_MODE: AiMode = 'no-api';

/**
 * The effective mode: `AI_MODE` in the environment (or `.env`) wins, then the
 * config file's `aiMode`, then the no-api default. An unknown value is an
 * error — silently falling back could start a billed run nobody asked for, or
 * a no-api run someone believed was model-backed.
 */
export function resolveAiMode(env: NodeJS.ProcessEnv = process.env, configured?: AiMode): AiMode {
  const raw = env.AI_MODE?.trim();
  if (raw) {
    if (!(AI_MODES as readonly string[]).includes(raw)) {
      throw new Error(`AI_MODE="${raw}" is not a valid execution mode — use one of: ${AI_MODES.join(', ')} (default: ${DEFAULT_AI_MODE}).`);
    }
    return raw as AiMode;
  }
  return configured ?? DEFAULT_AI_MODE;
}

/**
 * The model client used when no model may be called. Any call is a bug in a
 * node's no-api strategy, so it fails loudly (TERMINAL — never retried)
 * instead of quietly reaching the network; `attempts` lets a test prove the
 * run made zero model calls.
 */
export class DisabledLlmClient implements LlmClient {
  attempts = 0;

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.attempts++;
    throw new TerminalError(`${req.nodeId}: a model call was attempted in AI_MODE=no-api — no-api mode never calls a model API (this is a bug in the node's deterministic strategy)`);
  }
}

export interface AiProvider {
  mode: AiMode;
  /** The model client — a DisabledLlmClient in no-api mode. */
  llm: LlmClient;
  /** One line for the run header and reports. */
  description: string;
}

/**
 * Builds the provider for a run. Only `anthropic-api` ever constructs the
 * Anthropic client, and only when a credential exists: no-api startup never
 * reads, requires or mentions a key.
 */
export function createAiProvider(mode: AiMode, anthropicModel: string): AiProvider {
  if (mode === 'no-api') {
    return { mode, llm: new DisabledLlmClient(), description: 'no-api (deterministic — no model API calls)' };
  }
  if (!hasApiCredential()) {
    throw new Error('AI_MODE=anthropic-api needs ANTHROPIC_API_KEY (in audit-agent/.env, gitignored, or exported). Unset AI_MODE to run the default no-api mode.');
  }
  return { mode, llm: new AnthropicLlmClient(anthropicModel), description: `anthropic-api (${anthropicModel})` };
}
