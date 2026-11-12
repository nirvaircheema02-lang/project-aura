import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runL5 } from '../../src/agents/l5-publish/index.ts';
import { sha256OfFile } from '../../src/session/fingerprint.ts';
import type { GitExecFn } from '../../src/git/local-repo.ts';
import { TerminalError } from '../../src/retry.ts';
import type { AssembledPackage } from '../../src/library/types.ts';

/**
 * L5 against REAL local git repos (`git init` + repo-local identity), no mocking of git
 * itself — the safety property under test (§11.4's pre-push blob-hash re-verification) is
 * exactly the kind of thing a fake git object could accidentally make look safe.
 */

function countingExec(): { exec: GitExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExecFn = (args, cwd) =>
    new Promise((resolve) => {
      calls.push(args);
      execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
        if (!err) return resolve({ code: 0, ...out });
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        resolve({ code: typeof code === 'number' ? code : 1, ...out });
      });
    });
  return { exec, calls };
}

function run(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${res.stderr}`);
}

/** A real `git init`-ed repo, repo-local identity configured, checked out onto `branch`. */
function initGitRepo(dir: string, branch: string): void {
  mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q'], dir);
  run('git', ['config', 'user.email', 'fixture@example.com'], dir);
  run('git', ['config', 'user.name', 'Fixture'], dir);
  run('git', ['checkout', '-q', '-b', branch], dir);
}

function initBareRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q', '--bare'], dir);
}

function remoteHasBranch(bareDir: string, branch: string): boolean {
  const res = spawnSync('git', ['--git-dir', bareDir, 'rev-parse', '--verify', '--quiet', branch], { encoding: 'utf-8' });
  return res.status === 0;
}

let root: string;
let dsRepoPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-l5-'));
  dsRepoPath = join(root, 'ds-repo');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runL5 — assertGitRepo precondition (§9.0)', () => {
  it('refuses cleanly when dsRepoPath is not a git repository, before touching git at all', async () => {
    mkdirSync(dsRepoPath, { recursive: true }); // a plain folder, never `git init`-ed
    const { exec, calls } = countingExec();
    const pkg: AssembledPackage = { approvedComponentIds: [], files: [], branch: 'fra/x' };

    const err = await runL5({ git: { repoPath: dsRepoPath, exec }, dsRepoPath }, pkg, 'run-1', { approved: false, remote: null, approvedFingerprint: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/not a git repository/);
    expect(calls).toEqual([]);
  });
});

describe('runL5 — an empty approved package', () => {
  it('returns committed:false with a reason, and never calls git', async () => {
    initGitRepo(dsRepoPath, 'fra/empty');
    const { exec, calls } = countingExec();
    const pkg: AssembledPackage = { approvedComponentIds: [], files: [], branch: 'fra/empty' };

    const result = await runL5({ git: { repoPath: dsRepoPath, exec }, dsRepoPath }, pkg, 'run-1', { approved: true, remote: 'origin', approvedFingerprint: [] });

    expect(result).toEqual({ committed: false, commitSha: null, pushed: false, pushedRemote: null, prUrl: null, reason: 'nothing in the approved package — no component was approved' });
    expect(calls).toEqual([]);
  });
});

async function buildPackage(branch: string): Promise<{ pkg: AssembledPackage; absFilePath: string }> {
  const absFilePath = join(dsRepoPath, 'core-v2/src/molecules/Card.tsx');
  mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
  writeFileSync(absFilePath, 'export const Card = () => null;\n');
  const blobSha256 = await sha256OfFile(absFilePath);
  return { pkg: { approvedComponentIds: ['card-abcd1234'], files: [{ path: absFilePath, blobSha256 }], branch }, absFilePath };
}

describe('runL5 — push authorization gating', () => {
  it('push.approved:false commits locally but never pushes', async () => {
    initGitRepo(dsRepoPath, 'fra/design-only');
    const { pkg } = await buildPackage('fra/design-only');
    const { exec, calls } = countingExec();

    const result = await runL5({ git: { repoPath: dsRepoPath, exec }, dsRepoPath }, pkg, 'run-1', { approved: false, remote: null, approvedFingerprint: [] });

    expect(result.committed).toBe(true);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.pushed).toBe(false);
    expect(result.pushedRemote).toBeNull();
    expect(result.reason).toMatch(/design-only approval/);
    expect(calls.some((a) => a[0] === 'push')).toBe(false);
  });

  it('push.approved:true with push.remote:null commits but refuses to push, naming the pending §19.1 decision', async () => {
    initGitRepo(dsRepoPath, 'fra/no-remote');
    const { pkg } = await buildPackage('fra/no-remote');
    const { exec, calls } = countingExec();

    const result = await runL5({ git: { repoPath: dsRepoPath, exec }, dsRepoPath }, pkg, 'run-1', { approved: true, remote: null, approvedFingerprint: [] });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.reason).toMatch(/no remote is configured/);
    expect(result.reason).toMatch(/§19\.1/);
    expect(calls.some((a) => a[0] === 'push')).toBe(false);
  });

  it('push.approved:true with a real remote pushes the exact approved commit to it, and opens a PR only when a callback is given', async () => {
    initGitRepo(dsRepoPath, 'fra/comp-1');
    const bareOrigin = join(root, 'origin.git');
    initBareRepo(bareOrigin);
    const { pkg, absFilePath } = await buildPackage('fra/comp-1');
    const { exec } = countingExec();

    const prCalls: Array<{ branch: string; remote: string; title: string; body: string }> = [];
    const result = await runL5(
      { git: { repoPath: dsRepoPath, exec }, dsRepoPath, openPullRequest: async (branch, remote, title, body) => (prCalls.push({ branch, remote, title, body }), 'https://example.invalid/pr/1') },
      pkg,
      'run-1',
      { approved: true, remote: bareOrigin, approvedFingerprint: [{ path: absFilePath, blobSha256: await sha256OfFile(absFilePath) }] },
    );

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.pushedRemote).toBe(bareOrigin);
    expect(result.prUrl).toBe('https://example.invalid/pr/1');
    expect(remoteHasBranch(bareOrigin, 'fra/comp-1')).toBe(true);
    expect(prCalls).toEqual([{ branch: 'fra/comp-1', remote: bareOrigin, title: expect.stringContaining('1 component(s)'), body: expect.stringContaining('run-1') }]);
  });

  it('omitting openPullRequest still pushes, but prUrl stays null (opening a PR is optional)', async () => {
    initGitRepo(dsRepoPath, 'fra/comp-2');
    const bareOrigin = join(root, 'origin.git');
    initBareRepo(bareOrigin);
    const { pkg, absFilePath } = await buildPackage('fra/comp-2');
    const { exec } = countingExec();

    const result = await runL5({ git: { repoPath: dsRepoPath, exec }, dsRepoPath }, pkg, 'run-1', { approved: true, remote: bareOrigin, approvedFingerprint: [{ path: absFilePath, blobSha256: await sha256OfFile(absFilePath) }] });

    expect(result.pushed).toBe(true);
    expect(result.prUrl).toBeNull();
  });
});

describe('runL5 — pre-push blob-hash re-verification (§11.4, the core safety property)', () => {
  it('throws a TerminalError naming the changed file, and NEVER pushes it, when a file is mutated on disk after its approval fingerprint was computed', async () => {
    initGitRepo(dsRepoPath, 'fra/tampered');
    const bareOrigin = join(root, 'origin.git');
    initBareRepo(bareOrigin);
    const { pkg, absFilePath } = await buildPackage('fra/tampered');

    // The fingerprint a human approved at G5, over the ORIGINAL content.
    const approvedFingerprint = [{ path: absFilePath, blobSha256: await sha256OfFile(absFilePath) }];

    // The file changes on disk AFTER that approval was computed — e.g. a later, unrelated
    // build touched it — before `runL5` is ever invoked.
    writeFileSync(absFilePath, 'export const Card = () => "TAMPERED";\n');

    const { exec, calls } = countingExec();
    const err = await runL5({ git: { repoPath: dsRepoPath, exec }, dsRepoPath }, pkg, 'run-1', { approved: true, remote: bareOrigin, approvedFingerprint }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/publish refused/);
    expect((err as Error).message).toContain('core-v2/src/molecules/Card.tsx'); // names the changed file, relative to dsRepoPath
    expect((err as Error).message).toMatch(/Re-approve the current content/);

    // The safety boundary is the PUSH, not the local commit (stageAndCommit already ran on
    // whatever was on disk) — what must never happen is the mismatched content reaching the
    // remote. It does not: the bare origin has no ref for this branch at all.
    expect(calls.some((a) => a[0] === 'push')).toBe(false);
    expect(remoteHasBranch(bareOrigin, 'fra/tampered')).toBe(false);
  });

  it('does NOT throw and pushes normally when the approved fingerprint still matches the current file content', async () => {
    initGitRepo(dsRepoPath, 'fra/untampered');
    const bareOrigin = join(root, 'origin.git');
    initBareRepo(bareOrigin);
    const { pkg, absFilePath } = await buildPackage('fra/untampered');
    const approvedFingerprint = [{ path: absFilePath, blobSha256: await sha256OfFile(absFilePath) }];
    const { exec } = countingExec();

    const result = await runL5({ git: { repoPath: dsRepoPath, exec }, dsRepoPath }, pkg, 'run-1', { approved: true, remote: bareOrigin, approvedFingerprint });

    expect(result.pushed).toBe(true);
    expect(remoteHasBranch(bareOrigin, 'fra/untampered')).toBe(true);
  });
});
