import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertGitRepo, currentBranch, ensureBranch, hasUncommittedChanges, pushBranch, stageAndCommit, type GitDeps } from '../../src/git/local-repo.ts';
import { TerminalError } from '../../src/retry.ts';

/**
 * Exercises local-repo.ts against a REAL git binary and real repos — `git --version`
 * confirmed present on this environment's PATH (2.50.1), so no GitExecFn mocking needed.
 */

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

let repoPath: string;
let deps: GitDeps;

beforeEach(async () => {
  repoPath = mkdtempSync(join(tmpdir(), 'fra-git-'));
  await git(repoPath, ['init', '-b', 'main']);
  // repo-local identity only — never touch global git config.
  await git(repoPath, ['config', 'user.email', 'test@example.com']);
  await git(repoPath, ['config', 'user.name', 'Test']);
  deps = { repoPath };
});
afterEach(() => rmSync(repoPath, { recursive: true, force: true }));

describe('assertGitRepo', () => {
  it('throws TerminalError naming the exact reason for a non-existent path', () => {
    const missing = join(tmpdir(), 'fra-git-does-not-exist-xyz');
    expect(() => assertGitRepo(missing)).toThrow(TerminalError);
    try {
      assertGitRepo(missing);
      expect.unreachable();
    } catch (err) {
      expect((err as TerminalError).message).toContain(`dsRepo.path "${missing}" does not exist.`);
    }
  });

  it('throws TerminalError naming the exact reason for a path with no .git directory', () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'fra-git-plain-'));
    try {
      expect(() => assertGitRepo(plainDir)).toThrow(TerminalError);
      try {
        assertGitRepo(plainDir);
        expect.unreachable();
      } catch (err) {
        expect((err as TerminalError).message).toContain(`dsRepo.path "${plainDir}" is not a git repository (no .git directory)`);
      }
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('passes silently for a real git repo', () => {
    expect(() => assertGitRepo(repoPath)).not.toThrow();
  });
});

describe('stageAndCommit', () => {
  it('returns a real commit sha, verifiable with git rev-parse HEAD', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'hello\n');
    const sha = await stageAndCommit(deps, ['a.txt'], 'chore: init');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const headSha = await git(repoPath, ['rev-parse', 'HEAD']);
    expect(sha).toBe(headSha);
  });

  it('refuses an empty commit — no files given', async () => {
    await expect(stageAndCommit(deps, [], 'chore: nothing')).rejects.toThrow(TerminalError);
    await expect(stageAndCommit(deps, [], 'chore: nothing')).rejects.toThrow(/refusing an empty commit/);
  });
});

describe('hasUncommittedChanges', () => {
  it('is false right after a commit, true after touching a tracked file', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'hello\n');
    await stageAndCommit(deps, ['a.txt'], 'chore: init');
    expect(await hasUncommittedChanges(deps, ['a.txt'])).toBe(false);

    appendFileSync(join(repoPath, 'a.txt'), 'more\n');
    expect(await hasUncommittedChanges(deps, ['a.txt'])).toBe(true);
  });
});

describe('ensureBranch', () => {
  it('creates a new branch checked out from baseBranch', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'hello\n');
    await stageAndCommit(deps, ['a.txt'], 'chore: init');

    await ensureBranch(deps, 'feature-1', 'main');
    expect(await currentBranch(deps)).toBe('feature-1');
    // branch was cut from main — same commit
    expect(await git(repoPath, ['rev-parse', 'feature-1'])).toBe(await git(repoPath, ['rev-parse', 'main']));
  });

  it('is idempotent — an existing branch is checked out, never recreated (keeps its own later commits)', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'hello\n');
    await stageAndCommit(deps, ['a.txt'], 'chore: init');
    await ensureBranch(deps, 'feature-1', 'main');

    writeFileSync(join(repoPath, 'b.txt'), 'more\n');
    const secondSha = await stageAndCommit(deps, ['b.txt'], 'feat: add b');

    await git(repoPath, ['checkout', 'main']);
    expect(await currentBranch(deps)).toBe('main');

    // Re-ensuring feature-1 must just check it out, not reset it back to main's commit.
    await ensureBranch(deps, 'feature-1', 'main');
    expect(await currentBranch(deps)).toBe('feature-1');
    expect(await git(repoPath, ['rev-parse', 'HEAD'])).toBe(secondSha);
  });
});

describe('pushBranch', () => {
  it('pushes to a real local bare repo used as the remote — fully offline', async () => {
    const barePath = mkdtempSync(join(tmpdir(), 'fra-git-bare-'));
    rmSync(barePath, { recursive: true, force: true }); // git init --bare wants to create the dir itself
    mkdirSync(barePath);
    try {
      await execFileAsync('git', ['init', '--bare', '-b', 'main', barePath]);
      await git(repoPath, ['remote', 'add', 'origin', barePath]);

      writeFileSync(join(repoPath, 'a.txt'), 'hello\n');
      const sha = await stageAndCommit(deps, ['a.txt'], 'chore: init');
      await ensureBranch(deps, 'feature-1', 'main');

      await pushBranch(deps, 'origin', 'feature-1');

      const remoteSha = await execFileAsync('git', ['--git-dir', barePath, 'rev-parse', 'feature-1']).then((r) => r.stdout.trim());
      expect(remoteSha).toBe(sha);
    } finally {
      rmSync(barePath, { recursive: true, force: true });
    }
  });

  it('a push failure (no such remote) surfaces as TerminalError naming the remote and branch', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'hello\n');
    await stageAndCommit(deps, ['a.txt'], 'chore: init');
    await expect(pushBranch(deps, 'origin', 'main')).rejects.toThrow(TerminalError);
    await expect(pushBranch(deps, 'origin', 'main')).rejects.toThrow(/git push origin main failed/);
  });
});
