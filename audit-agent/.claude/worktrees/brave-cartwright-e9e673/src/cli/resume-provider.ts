import { createAiProvider, DisabledLlmClient, resolveAiMode, type AiMode, type AiProvider } from '../llm/provider.ts';

/**
 * The provider a `resume` should use, or a reason it cannot proceed.
 *
 * A run keeps the execution mode it started with: its pages so far were audited under it,
 * and mixing modes inside one run would mix two baselines (Decision Log #29/#31). The
 * REQUESTED mode is resolved UNCONDITIONALLY first — an invalid AI_MODE must still be
 * reported here, exactly as it would starting a new run, never silently skipped because a
 * recorded mode existed to fall back to. When the two disagree, resume refuses and names
 * both, rather than silently preferring the recorded one — a model-mode run resumed from a
 * process configured no-api used to spend real API calls with no sign anything unusual
 * happened (third-pass review MS-1).
 *
 * Past the Publish Gate the remaining work — writing C2/Excel from the already-persisted A4
 * result — is entirely deterministic; no model call is ever made there, so finishing a run
 * recorded in anthropic-api mode must never be blocked on a credential it does not need
 * (third-pass review MS-2).
 *
 * Kept in its own module (no top-level side effects) so it can be unit-tested without
 * loading src/cli/index.ts, which parses process.argv at import time.
 */
export function resolveResumeProvider(
  runId: string,
  run: { policy_version: string },
  atNode: 'A2' | 'A4',
  env: NodeJS.ProcessEnv,
  config: { aiMode: AiMode; anthropicModel: string },
): { ok: true; provider: AiProvider } | { ok: false; message: string } {
  let requested: AiMode;
  try {
    requested = resolveAiMode(env, config.aiMode);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const recorded = /\+ai-(no-api|anthropic-api)\+/.exec(run.policy_version)?.[1] as AiMode | undefined;
  if (recorded && requested !== recorded) {
    return {
      ok: false,
      message:
        `Run ${runId} was started in ${recorded} mode; this environment asks for ${requested}. ` +
        `Resume it with AI_MODE=${recorded} to match how it started, or start a new run for a ${requested} baseline.`,
    };
  }
  const mode = recorded ?? requested;
  try {
    const provider: AiProvider =
      atNode === 'A4'
        ? { mode, llm: new DisabledLlmClient(), description: `${mode} (publish gate — remaining work is deterministic)` }
        : createAiProvider(mode, config.anthropicModel);
    return { ok: true, provider };
  } catch (err) {
    return { ok: false, message: `${err instanceof Error ? err.message : String(err)} (run ${runId} was started in ${recorded ?? 'an unrecorded'} mode)` };
  }
}
