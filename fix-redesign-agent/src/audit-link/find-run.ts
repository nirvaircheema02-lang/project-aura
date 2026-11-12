import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TerminalError } from '../retry.ts';

/**
 * Run resolution — ARCHITECTURE.md Q3. This repo does NOT vendor audit-agent's
 * `run-store.ts` or re-implement Run-ID / Run-Name lookup: it shells out, cross-process,
 * to audit-agent's own `find-run` CLI (defined by the approved Part 1 plan) so the answer
 * always comes from the live, current owner of that layout.
 *
 *   pnpm run agent find-run --run-id <id>
 *   pnpm run agent find-run --run-name "<name>"
 *
 * Always an argv ARRAY, never a template-string shell command — a human-typed display name
 * may legitimately contain quotes. `cwd` is set to `auditAgentRepoRoot` because two parts of
 * audit-agent's CLI resolve relative to it differently (`import.meta.dirname` vs
 * `process.cwd()`); cwd-ing there satisfies both, exactly like a human at that prompt.
 *
 * ── stdout contract this side expects (Decision Log #7) ────────────────────────────────
 * On the single-unambiguous-match case `find-run` exits 0 and prints ONE JSON object line:
 *   {"projectName": "...", "runId": "...", "displayName": "...", "targetUrl": "...", "runDir": "/abs/path"}
 * `runDir` is preferred; when absent the run folder is composed from audit-agent's LOCKED,
 * documented layout `projects/<projectName>/runs/<runId>` (audit-run/SKILL.md) and a warning
 * is recorded. Zero or multiple matches exit non-zero with the candidates as text — this side
 * never guesses: it surfaces that text and stops.
 */

export type AuditRunRef = { runId: string; runName?: undefined } | { runName: string; runId?: undefined };

export interface ResolvedAuditRun {
  projectName: string;
  runId: string;
  displayName: string;
  targetUrl: string | null;
  /** Absolute path of the run folder — where data.json / fix-plan.json / run.json live. */
  runDir: string;
}

export interface ExecResult {
  /** Exit code; null when the process could not be spawned at all (see `spawnError`). */
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}
export type ExecFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>;

export const FIND_RUN_COMMAND = 'pnpm';

export function findRunArgs(ref: AuditRunRef): string[] {
  return ref.runId !== undefined ? ['run', 'agent', 'find-run', '--run-id', ref.runId] : ['run', 'agent', 'find-run', '--run-name', ref.runName];
}

export function describeRef(ref: AuditRunRef): string {
  return ref.runId !== undefined ? `Run ID "${ref.runId}"` : `Run Name "${ref.runName}"`;
}

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      if (!err) return resolve({ code: 0, ...out });
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code === 'string') return resolve({ code: null, spawnError: code, ...out });
      resolve({ code: typeof code === 'number' ? code : 1, ...out });
    });
  });

/** The configured root must actually be audit-agent — a wrong path must fail here, not as a confusing pnpm error. */
export function assertAuditAgentRepo(auditAgentRepoRoot: string): void {
  const pkgPath = join(auditAgentRepoRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new TerminalError(`auditAgentRepoRoot "${auditAgentRepoRoot}" has no package.json — it must point at the audit-agent repo (fix-redesign-agent.config.json / FIX_REDESIGN_AGENT_AUDIT_AGENT_REPO_ROOT)`);
  }
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown }).name;
  } catch (err) {
    throw new TerminalError(`auditAgentRepoRoot "${auditAgentRepoRoot}": package.json is unreadable — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (name !== 'audit-agent') {
    throw new TerminalError(`auditAgentRepoRoot "${auditAgentRepoRoot}" is package "${String(name)}", not "audit-agent"`);
  }
}

/**
 * `projectName` becomes a path segment both in the `runDir` composed below AND, on our own
 * side, in `redesignPaths(projectsRoot, r1.sourceRun.projectName, ...)` — the root of every
 * file this repo itself writes for the run. A `find-run` that ever printed `../../etc` (a bug,
 * a compromised audit-agent checkout, or a corrupted run record) must never be allowed to steer
 * either side's writes outside its own tree. Checked once, at the exact boundary where this
 * untrusted external process's text output first becomes typed data.
 */
const SAFE_PATH_SEGMENT = /^[^/\\\0]+$/;
function isSafePathSegment(s: string): boolean {
  return s.length > 0 && s !== '.' && s !== '..' && SAFE_PATH_SEGMENT.test(s);
}

/** Parses `find-run`'s stdout per the contract above. Exported so the contract is unit-testable without a child process. */
export function parseFindRunStdout(stdout: string, auditAgentRepoRoot: string): { run: ResolvedAuditRun; warnings: string[] } {
  const warnings: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const o = obj as Record<string, unknown>;
    if (typeof o.projectName !== 'string' || typeof o.runId !== 'string') continue;
    if (!isSafePathSegment(o.projectName) || !isSafePathSegment(o.runId)) {
      throw new TerminalError(
        `find-run printed a projectName/runId that isn't a safe single path segment (projectName="${o.projectName}", runId="${o.runId}") — refusing to use it to build any file path. This looks like a corrupted run record or a bug in audit-agent's find-run, not a name to work around.`,
      );
    }
    let runDir: string;
    if (typeof o.runDir === 'string' && o.runDir.length > 0) {
      runDir = o.runDir;
    } else {
      runDir = join(auditAgentRepoRoot, 'projects', o.projectName, 'runs', o.runId);
      warnings.push(`find-run printed no runDir — composed ${runDir} from audit-agent's documented projects/<project>/runs/<runId> layout`);
    }
    return {
      run: {
        projectName: o.projectName,
        runId: o.runId,
        displayName: typeof o.displayName === 'string' && o.displayName.length > 0 ? o.displayName : o.runId,
        targetUrl: typeof o.targetUrl === 'string' ? o.targetUrl : null,
        runDir,
      },
      warnings,
    };
  }
  throw new TerminalError(
    `audit-agent's find-run exited 0 but printed no JSON object with projectName + runId — this side expects one line like ` +
      `{"projectName":"…","runId":"…","displayName":"…","targetUrl":"…","runDir":"/abs/path"} (see src/audit-link/find-run.ts). stdout was:\n${stdout.trim() || '(empty)'}`,
  );
}

/**
 * Resolves ONE audit run via audit-agent's CLI. Proceeds only on the single-unambiguous-match
 * outcome; every other outcome is TERMINAL with audit-agent's own text attached so the
 * operator can pick a candidate or supply the exact Run ID.
 */
export async function resolveAuditRun(auditAgentRepoRoot: string, ref: AuditRunRef, exec: ExecFn = defaultExec): Promise<{ run: ResolvedAuditRun; warnings: string[] }> {
  assertAuditAgentRepo(auditAgentRepoRoot);
  const args = findRunArgs(ref);
  const result = await exec(FIND_RUN_COMMAND, args, { cwd: auditAgentRepoRoot });
  const said = `${result.stdout}\n${result.stderr}`.trim();

  if (result.code === null) {
    throw new TerminalError(`could not run "${FIND_RUN_COMMAND} ${args.join(' ')}" in ${auditAgentRepoRoot} (${result.spawnError ?? 'spawn failed'}) — pnpm must be on PATH and audit-agent installed`);
  }
  if (result.code !== 0) {
    if (/unknown command\s+'?find-run'?/i.test(said)) {
      throw new TerminalError(
        `audit-agent at ${auditAgentRepoRoot} has no "find-run" command yet. That command is part of the approved Part 1 (Fix Plan Review Workflow) ` +
          `and must land in audit-agent before this agent can resolve runs. Nothing was done.`,
      );
    }
    throw new TerminalError(`audit-agent could not resolve ${describeRef(ref)} to exactly one run (find-run exit ${result.code}). It said:\n${said || '(no output)'}\n→ pick one of the candidates above, or pass --run-id with the exact Run ID.`);
  }
  const parsed = parseFindRunStdout(result.stdout, auditAgentRepoRoot);
  if (!existsSync(parsed.run.runDir)) {
    throw new TerminalError(`find-run resolved ${describeRef(ref)} to ${parsed.run.runDir}, but that folder does not exist`);
  }
  return parsed;
}
