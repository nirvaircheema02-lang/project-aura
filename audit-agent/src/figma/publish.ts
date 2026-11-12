import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildPublishInstruction, FIGMA_CONTRACT_VERSION, mergePublishedNodes } from './prompt-contract.ts';
import { buildPublishPlan } from './publish-plan.ts';
import { saveProject, type ProjectFile, type RunPaths } from '../output/run-store.ts';
import type { AuditData } from '../agents/c2-json-writer/index.ts';

const execFileAsync = promisify(execFile);

/**
 * LEGACY / INACTIVE PATH — do not extend, nothing in the CLI calls `publishToFigma`. This module
 * is the OLD headless text-instruction publish mechanism (confirmed-failed on Figma OAuth,
 * IMPLEMENTATION-PLAN.md §6 Spike 3, explicitly out of scope for v1). The CURRENT supported path
 * is `src/figma/publish-ops.ts` (a structured, tested operation plan) replayed by a live,
 * Figma-MCP-authenticated session per `docs/FIGMA-PUBLISH-RUNBOOK.md`. Kept here (not deleted)
 * only because IMPLEMENTATION-PLAN.md still cites this exact spike result and tests still assert
 * its documented failure mode — not because it's a viable path to extend.
 *
 * C3 — Figma Publisher (v1.0 §11). The write itself is NOT a deterministic
 * SDK call: Figma's MCP server only accepts connections from allowlisted
 * clients, so the only path that writes real Figma content is a headless
 * Claude Code run that IS such a client (IMPLEMENTATION-PLAN.md §6).
 *
 * Two verified constraints shape this module:
 *  1. Headless auth currently fails ("OAuth session expired and could not be
 *     refreshed") — out of scope for v1 by explicit decision, so a publish
 *     attempt reports that clearly instead of hanging or pretending.
 *  2. Screenshot delivery is a confirmed-unresolved blocker, so the plan ships
 *     labelled placeholders rather than blank images.
 *
 * Everything up to the invocation — plan, instruction, idempotent node
 * bookkeeping — is deterministic and fully tested without credentials.
 */

export type PublishOutcome =
  | { status: 'published'; nodes: Partial<ProjectFile['figmaNodes']>; contractVersion: string }
  | { status: 'no-figma-file'; detail: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'failed'; detail: string };

export interface PublishDeps {
  /** Injected so tests drive the whole path without a real Claude Code/Figma round trip. */
  invoke?: (instruction: { system: string; prompt: string }) => Promise<string>;
  claudeBin?: string;
  /**
   * The CALLING session's own resolved AI_MODE (from its AiProvider), distinct from
   * `data.run.aiMode` (the mode the run being published was AUDITED under, read back
   * from data.json). A no-api SESSION must never start a headless Claude Code run even
   * to publish a run that itself was audited in anthropic-api mode — the file's recorded
   * mode alone is not proof of what this process is configured to do right now
   * (third-pass review MS-3/OUT-5). Omit only from tests that don't care which session
   * mode is simulated.
   */
  mode?: 'no-api' | 'anthropic-api';
}

/** Default transport: a headless Claude Code run, the only client Figma's MCP server allowlists for writes. */
async function invokeHeadlessClaude(instruction: { system: string; prompt: string }, bin = 'claude'): Promise<string> {
  const { stdout } = await execFileAsync(
    bin,
    ['-p', `${instruction.system}\n\n${instruction.prompt}`, '--output-format', 'json'],
    { maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60_000 },
  );
  return stdout;
}

/** Pulls the returned node map out of the publisher's reply, tolerating surrounding prose. */
export function parsePublishedNodes(output: string): Partial<ProjectFile['figmaNodes']> {
  const candidates = output.match(/\{[\s\S]*\}/g) ?? [];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const nested = (parsed.result ?? parsed) as Partial<ProjectFile['figmaNodes']>;
      if (nested && typeof nested === 'object' && ('pages' in nested || 'frames' in nested || 'markers' in nested)) {
        return {
          pages: (nested.pages ?? {}) as Record<string, string>,
          frames: (nested.frames ?? {}) as Record<string, string>,
          markers: (nested.markers ?? {}) as Record<string, string>,
          imageHashes: (nested.imageHashes ?? {}) as Record<string, string>,
        };
      }
    } catch {
      /* not JSON — keep looking */
    }
  }
  return {};
}

export async function publishToFigma(
  data: AuditData,
  project: ProjectFile,
  paths: RunPaths,
  deps: PublishDeps = {},
): Promise<{ outcome: PublishOutcome; project: ProjectFile }> {
  const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);

  // The Figma write is a headless Claude Code run — a model client. A no-api run never starts
  // one (Decision Log #31): the plan above is complete and deterministic; only the write waits.
  // Checked against BOTH the run's own recorded mode (data.run.aiMode) and the calling
  // session's actual mode (deps.mode) — the file alone cannot prove what this process is
  // configured to do right now (third-pass review MS-3/OUT-5).
  if (!deps.invoke && (data.run.aiMode === 'no-api' || deps.mode === 'no-api')) {
    const planReady = `The deterministic publish plan (${Object.keys(plan.pages).length} pages, ${plan.pageAudits.length} page audit frame(s)) is ready; publish it from an explicitly model-enabled session.`;
    const detail =
      data.run.aiMode === 'no-api'
        ? `AI_MODE=no-api: the Figma write goes through a headless Claude Code run (a model client), which no-api mode never starts. ${planReady}`
        : `This session is configured AI_MODE=no-api. The Figma write goes through a headless Claude Code run (a model client), which no-api mode never starts — even though this run was audited in ${data.run.aiMode ?? 'a model-backed'} mode. ${planReady}`;
    return { outcome: { status: 'unavailable', detail }, project };
  }

  if (!project.figmaFileKey) {
    return {
      outcome: {
        status: 'no-figma-file',
        detail:
          'This project has no Figma file yet. Create one in the configured team/project (create_new_file needs an explicit projectId, or the file lands in personal drafts) and record its key in project.json.',
      },
      project,
    };
  }

  const instruction = buildPublishInstruction(plan, project);
  const invoke = deps.invoke ?? ((i) => invokeHeadlessClaude(i, deps.claudeBin));

  let output: string;
  try {
    output = await invoke({ system: instruction.system, prompt: instruction.prompt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The verified v1 failure mode: no usable Figma credential in a headless run.
    if (/authenticat|OAuth|credential/i.test(message)) {
      return {
        outcome: {
          status: 'unavailable',
          detail:
            `Figma publishing is unavailable in this environment: ${message.split('\n')[0]}. ` +
            'Headless Figma auth is a known, out-of-scope-for-v1 blocker — run the publish from an authenticated interactive session.',
        },
        project,
      };
    }
    return { outcome: { status: 'failed', detail: message.split('\n')[0] ?? message }, project };
  }

  const nodes = parsePublishedNodes(output);
  const updated = mergePublishedNodes(project, nodes);
  await saveProject(paths, updated);
  return { outcome: { status: 'published', nodes, contractVersion: plan.contractVersion }, project: updated };
}
