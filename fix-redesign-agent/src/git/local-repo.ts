import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TerminalError } from '../retry.ts';

/**
 * A small, local `git` wrapper for Workflow B — ARCHITECTURE.md §9.0/§9.4. Always an argv
 * ARRAY passed to `execFile`, never a template-string shell command (the same discipline
 * `audit-link/find-run.ts` uses for audit-agent's CLI). Every branch or commit operation
 * checks `assertGitRepo` first — §9.0's "checked once, up front, refuses cleanly" rule: the
 * DS folder having no `.git` today (§0.2, §19.1) must surface as one clear refusal, never a
 * confusing failure partway through a build.
 */

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitExecFn = (args: string[], cwd: string) => Promise<ExecResult>;

const defaultExec: GitExecFn = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      if (!err) return resolve({ code: 0, ...out });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve({ code: typeof code === 'number' ? code : 1, ...out });
    });
  });

/** §9.0's precondition — checked once, before any branch or commit operation. */
export function assertGitRepo(repoPath: string): void {
  if (!existsSync(repoPath)) throw new TerminalError(`dsRepo.path "${repoPath}" does not exist.`);
  if (!existsSync(join(repoPath, '.git'))) {
    throw new TerminalError(
      `dsRepo.path "${repoPath}" is not a git repository (no .git directory) — Workflow B stops here rather than attempting a branch or commit against a plain folder (docs/ARCHITECTURE.md §9.0, §19.1). ` +
        `Initialise it as a git repository (and set a remote/base branch once one is chosen) before running component work.`,
    );
  }
}

export interface GitDeps {
  repoPath: string;
  exec?: GitExecFn;
}

async function run(deps: GitDeps, args: string[]): Promise<ExecResult> {
  const exec = deps.exec ?? defaultExec;
  return exec(args, deps.repoPath);
}

export async function currentBranch(deps: GitDeps): Promise<string> {
  const res = await run(deps, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (res.code !== 0) throw new TerminalError(`git rev-parse --abbrev-ref HEAD failed in ${deps.repoPath}: ${res.stderr}`);
  return res.stdout.trim();
}

/** Creates (or reuses) a branch from `baseBranch` — idempotent: an existing branch of the same name is checked out, never recreated. */
export async function ensureBranch(deps: GitDeps, branchName: string, baseBranch: string | null): Promise<void> {
  assertGitRepo(deps.repoPath);
  const existsRes = await run(deps, ['rev-parse', '--verify', '--quiet', branchName]);
  if (existsRes.code === 0) {
    const checkout = await run(deps, ['checkout', branchName]);
    if (checkout.code !== 0) throw new TerminalError(`git checkout ${branchName} failed in ${deps.repoPath}: ${checkout.stderr}`);
    return;
  }
  const args = baseBranch ? ['checkout', '-b', branchName, baseBranch] : ['checkout', '-b', branchName];
  const res = await run(deps, args);
  if (res.code !== 0) throw new TerminalError(`git checkout -b ${branchName} failed in ${deps.repoPath}: ${res.stderr}`);
}

export async function stageAndCommit(deps: GitDeps, files: string[], message: string): Promise<string> {
  assertGitRepo(deps.repoPath);
  if (files.length === 0) throw new TerminalError('stageAndCommit: no files given — refusing an empty commit.');
  const add = await run(deps, ['add', '--', ...files]);
  if (add.code !== 0) throw new TerminalError(`git add failed in ${deps.repoPath}: ${add.stderr}`);
  const commit = await run(deps, ['commit', '-m', message]);
  if (commit.code !== 0) throw new TerminalError(`git commit failed in ${deps.repoPath}: ${commit.stderr}`);
  const sha = await run(deps, ['rev-parse', 'HEAD']);
  return sha.stdout.trim();
}

export async function pushBranch(deps: GitDeps, remote: string, branchName: string): Promise<void> {
  assertGitRepo(deps.repoPath);
  const res = await run(deps, ['push', remote, branchName]);
  if (res.code !== 0) throw new TerminalError(`git push ${remote} ${branchName} failed in ${deps.repoPath}: ${res.stderr}`);
}

export async function hasUncommittedChanges(deps: GitDeps, files: string[]): Promise<boolean> {
  const res = await run(deps, ['status', '--porcelain', '--', ...files]);
  return res.stdout.trim().length > 0;
}
