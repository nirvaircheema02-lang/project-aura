import { relative } from 'node:path';
import { sha256OfFile } from '../../session/fingerprint.ts';
import { assertGitRepo, pushBranch, stageAndCommit, type GitDeps } from '../../git/local-repo.ts';
import { TerminalError } from '../../retry.ts';
import type { AssembledPackage, PublishResult } from '../../library/types.ts';

/**
 * L5 — Publish (deterministic, gated, §9.4/§11.5). Commits EXACTLY the approved package,
 * locally, always. Pushes and opens a PR only when explicitly authorized — never on its own
 * initiative — and re-verifies every file's blob hash against what was approved immediately
 * before doing either: any mismatch is a refusal naming what changed, not a silent push of
 * something slightly different from what was shown at the gate.
 */

export const L5_STATUS = 'implemented' as const;

export interface L5PushAuthorization {
  approved: boolean;
  remote: string | null;
  approvedFingerprint: Array<{ path: string; blobSha256: string }>;
}

export interface L5Deps {
  git: GitDeps;
  dsRepoPath: string;
  openPullRequest?: (branch: string, remote: string, title: string, body: string) => Promise<string | null>;
  log?: (line: string) => void;
}

export async function runL5(deps: L5Deps, pkg: AssembledPackage, redesignRunId: string, push: L5PushAuthorization): Promise<PublishResult> {
  const log = deps.log ?? (() => {});
  assertGitRepo(deps.dsRepoPath);

  if (pkg.files.length === 0) {
    return { committed: false, commitSha: null, pushed: false, pushedRemote: null, prUrl: null, reason: 'nothing in the approved package — no component was approved' };
  }

  const relPaths = pkg.files.map((f) => relative(deps.dsRepoPath, f.path));
  const commitSha = await stageAndCommit(deps.git, relPaths, `fix-redesign-agent: ${pkg.approvedComponentIds.length} component(s) from ${redesignRunId}\n\n${pkg.approvedComponentIds.join(', ')}`);
  log(`L5 · committed ${relPaths.length} file(s) as ${commitSha.slice(0, 10)}`);

  if (!push.approved) {
    return { committed: true, commitSha, pushed: false, pushedRemote: null, prUrl: null, reason: 'design-only approval — push not requested' };
  }
  if (!push.remote) {
    return { committed: true, commitSha, pushed: false, pushedRemote: null, prUrl: null, reason: 'push approved, but no remote is configured (dsRepo.remote) — §19.1 decision pending' };
  }

  // Re-verify every file's blob hash against what was approved — any drift refuses, names what changed.
  const mismatches: string[] = [];
  for (const f of pkg.files) {
    const current = await sha256OfFile(f.path);
    const approved = push.approvedFingerprint.find((a) => a.path === f.path);
    if (!approved || approved.blobSha256 !== current) mismatches.push(relative(deps.dsRepoPath, f.path));
  }
  if (mismatches.length > 0) {
    throw new TerminalError(`L5: publish refused — ${mismatches.length} file(s) changed since approval: ${mismatches.join(', ')}. Re-approve the current content before publishing.`);
  }

  await pushBranch(deps.git, push.remote, pkg.branch);
  log(`L5 · pushed ${pkg.branch} to ${push.remote}`);

  let prUrl: string | null = null;
  if (deps.openPullRequest) {
    prUrl = await deps.openPullRequest(pkg.branch, push.remote, `fix-redesign-agent: ${pkg.approvedComponentIds.length} component(s)`, `Components: ${pkg.approvedComponentIds.join(', ')}\nRedesign run: ${redesignRunId}`);
  }

  return { committed: true, commitSha, pushed: true, pushedRemote: push.remote, prUrl, reason: null };
}
