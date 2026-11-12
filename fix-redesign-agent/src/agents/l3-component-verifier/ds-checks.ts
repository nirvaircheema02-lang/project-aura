import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * L3's deterministic half (§9.4): the DS repo's OWN `typecheck`/`lint`/`verify` scripts,
 * run for real via `pnpm`, exactly as a developer would run them. "Story build" is scoped to
 * a static presence check — actually invoking Storybook's build pipeline is out of this
 * system's reach without the DS's own bundler running, a stated limitation (see L3's own
 * `index.ts` docblock), not a silently faked pass.
 */

export interface DsCheckResult {
  ok: boolean;
  detail: string;
}

export type DsExecFn = (cmd: string, args: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultExec: DsExecFn = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      if (!err) return resolve({ code: 0, ...out });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve({ code: typeof code === 'number' ? code : 1, ...out });
    });
  });

async function runScript(coreV2Dir: string, script: string, exec: DsExecFn): Promise<DsCheckResult> {
  const res = await exec('pnpm', ['run', script], coreV2Dir);
  return { ok: res.code === 0, detail: res.code === 0 ? 'ok' : (res.stderr || res.stdout).split('\n').slice(0, 20).join('\n') };
}

export async function runDsChecks(dsRepoPath: string, exec: DsExecFn = defaultExec): Promise<{ typecheck: DsCheckResult; lint: DsCheckResult; verify: DsCheckResult; storyBuildPresence: DsCheckResult }> {
  const coreV2Dir = join(dsRepoPath, 'core-v2');
  const [typecheck, lint, verify] = await Promise.all([runScript(coreV2Dir, 'typecheck', exec), runScript(coreV2Dir, 'lint', exec), runScript(coreV2Dir, 'verify', exec)]);
  return { typecheck, lint, verify, storyBuildPresence: { ok: true, detail: 'checked per-file by the caller' } };
}

export function storiesFilePresent(dsRepoPath: string, storiesRelPath: string): DsCheckResult {
  const abs = join(dsRepoPath, 'core-v2/src', storiesRelPath);
  if (!existsSync(abs)) return { ok: false, detail: `no stories file at ${storiesRelPath}` };
  return { ok: true, detail: 'present' };
}
