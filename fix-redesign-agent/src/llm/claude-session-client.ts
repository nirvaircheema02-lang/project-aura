import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { LlmClient, LlmRequest, LlmResponse } from './client.ts';
import { wireSchema } from './client.ts';
import { fingerprintOf } from '../session/fingerprint.ts';
import { TerminalError } from '../retry.ts';
import { AwaitingJudgmentError } from '../judgment/types.ts';
import { composeR3Replay, type PriorR3 } from '../judgment/replay.ts';
import { deterministicJudgment } from '../judgment/deterministic.ts';
import type { JudgmentResultFile, PendingJudgmentBundle } from '../judgment/types.ts';
import { isJudgmentNodeId, JUDGMENT_SCHEMAS } from '../judgment/schema-registry.ts';
import { judgmentBundlePath, judgmentResultPath, type RedesignPaths } from '../output/redesign-store.ts';

/**
 * `claude-session` judgmentProvider (docs/ARCHITECTURE.md §judgmentProvider). Never calls an
 * external model API and never spawns a nested `claude` process — every `.structured()` call
 * either:
 *   (a) finds an already-submitted, schema-validated result for this exact request and
 *       returns it, synthesizing an `LlmResponse` with zero usage (no tokens were spent — the
 *       Session Agent already running this pipeline did the judgment), or
 *   (b) writes a versioned pending bundle (instructions, prompt, referenced image PATHS —
 *       never re-embedded bytes — and the expected JSON Schema) and throws
 *       `AwaitingJudgmentError`, which `pipeline.ts` catches to checkpoint the run as
 *       `awaiting-judgment` rather than fail or retry it.
 *
 * There is no path in this class that fabricates a judgment — a result only ever reaches a
 * caller after `judgment submit` has validated it against `JUDGMENT_SCHEMAS[nodeId]` (the
 * node's REAL Zod schema, not just the looser recorded JSON Schema shape).
 */
export class ClaudeSessionLlmClient implements LlmClient {
  private readonly paths: Pick<RedesignPaths, 'judgmentsDir'>;
  private readonly redesignRunId: string;

  private readonly deterministic: boolean;

  constructor(paths: Pick<RedesignPaths, 'judgmentsDir'>, redesignRunId: string, opts: { deterministic?: boolean } = {}) {
    this.paths = paths;
    this.redesignRunId = redesignRunId;
    this.deterministic = opts.deterministic === true;
  }

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    if (!isJudgmentNodeId(req.nodeId)) {
      throw new TerminalError(`${req.nodeId}: claude-session mode only supports the six judgment nodes (C2, RV, R3, R5, L2, L3) — got an unrecognized nodeId`);
    }
    const bundleId = fingerprintOf({
      nodeId: req.nodeId,
      system: req.system,
      prompt: req.prompt,
      images: (req.images ?? []).map((i) => i.caption),
      schema: wireSchema(req.schema),
    }).slice(0, 16);
    const resultPath = judgmentResultPath(this.paths, bundleId);

    if (existsSync(resultPath)) {
      const raw = JSON.parse(await readFile(resultPath, 'utf8')) as JudgmentResultFile;
      // Validate against the node's REAL schema — `req.schema` here — never the recorded
      // JSON Schema alone, so a submission cannot slip past on a looser wire-shape match.
      const parsed = req.schema.safeParse(raw.data);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new TerminalError(
          `${req.nodeId}: the submitted judgment for bundle ${bundleId} does not match the node's schema — ${issues}. Re-run \`judgment submit ${this.redesignRunId} --file <result.json> --bundle ${bundleId}\` with a corrected result.`,
        );
      }
      return { data: parsed.data, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    }

    // R3: replay earlier answers finding-by-finding, only on byte-identical evidence (see judgment/replay.ts).
    if (req.nodeId === 'R3') {
      const replay = await this.tryReplayR3(req.prompt, req.schema);
      if (replay) return { data: replay, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    }

    // Deterministic mode (config): answer from the prompt itself, validated against the node's real schema; anything it cannot answer pauses as usual.
    if (this.deterministic) {
      const d = deterministicJudgment(req.nodeId, req.prompt);
      const parsed = d === null ? null : req.schema.safeParse(d);
      if (parsed?.success) return { data: parsed.data, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    }

    const bundlePath = judgmentBundlePath(this.paths, bundleId);
    if (!existsSync(bundlePath)) {
      const bundle: PendingJudgmentBundle = {
        schemaVersion: 1,
        bundleId,
        redesignRunId: this.redesignRunId,
        nodeId: req.nodeId,
        createdAt: new Date().toISOString(),
        instructions: req.system,
        prompt: req.prompt,
        images: (req.images ?? []).map((i) => ({ path: i.path ?? null, caption: i.caption })),
        jsonSchema: wireSchema(req.schema),
        effort: req.effort ?? null,
      };
      await writeFile(bundlePath, JSON.stringify(bundle, null, 2));
    }
    throw new AwaitingJudgmentError(req.nodeId, bundleId, bundlePath);
  }

  private async tryReplayR3<T>(prompt: string, schema: z.ZodType<T>): Promise<T | null> {
    const dir = this.paths.judgmentsDir;
    if (!existsSync(dir)) return null;
    const priors: PriorR3[] = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.result.json')) continue;
      const id = f.slice(0, -'.result.json'.length);
      const bPath = judgmentBundlePath(this.paths, id);
      if (!existsSync(bPath)) continue;
      try {
        const result = JSON.parse(await readFile(judgmentResultPath(this.paths, id), 'utf8')) as JudgmentResultFile;
        const bundle = JSON.parse(await readFile(bPath, 'utf8')) as PendingJudgmentBundle;
        if (bundle.nodeId !== 'R3' || result.nodeId !== 'R3') continue;
        priors.push({ prompt: bundle.prompt, data: result.data as PriorR3['data'] });
      } catch {
        continue; // an unreadable earlier file is simply not a replay source
      }
    }
    const composed = composeR3Replay(prompt, priors);
    if (!composed) return null;
    const parsed = schema.safeParse(composed);
    return parsed.success ? parsed.data : null;
  }
}

/** Validates a Session Agent's submitted judgment against the node's real schema before it is ever written as a result file — shared by the `judgment submit` CLI command. */
export function validateJudgmentSubmission(nodeId: string, data: unknown): { ok: true; data: unknown } | { ok: false; issues: string } {
  if (!isJudgmentNodeId(nodeId)) return { ok: false, issues: `unrecognized nodeId "${nodeId}" — expected one of C2, RV, R3, R5, L2, L3` };
  const schema = JUDGMENT_SCHEMAS[nodeId] as z.ZodType;
  const parsed = schema.safeParse(data);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, data: parsed.data };
}
