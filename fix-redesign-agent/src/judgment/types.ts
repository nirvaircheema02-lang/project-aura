/**
 * `claude-session` judgment mode — the pipeline's five AI/hybrid nodes (C2, R3, R5, L2, L3)
 * write one of these instead of calling the Anthropic API, then checkpoint. The Session Agent
 * (the Claude Code instance the run was started from) reads it via `judgment show`, performs
 * the judgment itself, and records the result via `judgment submit` — which is what the
 * pipeline reads back on its next invocation.
 */

export interface PendingJudgmentImage {
  /** The file this image lives at on disk — never re-embedded into the bundle. Null when the request built this image from bytes with no known source file. */
  path: string | null;
  caption: string;
}

export interface PendingJudgmentBundle {
  schemaVersion: 1;
  bundleId: string;
  redesignRunId: string;
  nodeId: string;
  createdAt: string;
  /** The system prompt the node would have sent. */
  instructions: string;
  /** The user-turn prompt text. */
  prompt: string;
  images: PendingJudgmentImage[];
  /** `wireSchema(schema)` — the exact JSON Schema a submitted result must satisfy (the real Zod schema, looked up by nodeId, is what `judgment submit` actually validates against). */
  jsonSchema: unknown;
  effort: string | null;
}

export interface JudgmentResultFile {
  schemaVersion: 1;
  bundleId: string;
  nodeId: string;
  submittedAt: string;
  /** The judgment itself — MUST validate against `JUDGMENT_SCHEMAS[nodeId]` before this file is ever written. */
  data: unknown;
}

/**
 * Thrown by `ClaudeSessionLlmClient.structured()` when no submitted result exists yet for a
 * judgment request — never a hard failure (§ never RETRYABLE/REPAIRABLE/TERMINAL): the
 * orchestrator (`pipeline.ts`) catches this specifically and checkpoints the run as
 * `awaiting-judgment` rather than failing it or retrying the node.
 */
export class AwaitingJudgmentError extends Error {
  readonly nodeId: string;
  readonly bundleId: string;
  readonly bundlePath: string;

  constructor(nodeId: string, bundleId: string, bundlePath: string) {
    super(`${nodeId}: awaiting Session Agent judgment (bundle ${bundleId}) — run \`judgment show\` then \`judgment submit\``);
    this.nodeId = nodeId;
    this.bundleId = bundleId;
    this.bundlePath = bundlePath;
  }
}
