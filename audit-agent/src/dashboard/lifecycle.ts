import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SERVICE_ID } from './server.ts';
import { dashboardBuildId } from './build-id.ts';

/**
 * Decision Log #20 — the locked launch model: ONE long-running local server,
 * started automatically when an audit runs and reused if it is already up.
 * A human never has to remember to launch it, and a second audit never
 * spawns a second server.
 *
 * "Already up" is verified by identity, not by a bare port check: if
 * something else owns the port, that is reported rather than silently
 * assumed to be ours.
 */

export type DashboardState =
  | { status: 'reused'; url: string }
  | { status: 'started'; url: string; pid: number | undefined }
  | { status: 'restarted'; url: string; pid: number | undefined; detail: string }
  | { status: 'port-taken-by-other'; url: string; detail: string }
  | { status: 'failed'; url: string; detail: string };

interface Health {
  service?: string;
  build?: string;
  projectsRoot?: string;
  pid?: number;
}

async function readHealth(port: number, timeoutMs: number): Promise<Health | 'other' | 'closed'> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return 'other';
    const body = (await response.json()) as Health;
    return body.service === SERVICE_ID ? body : 'other';
  } catch {
    return 'closed';
  }
}

export async function probeDashboard(port: number, timeoutMs = 1_000): Promise<'ours' | 'other' | 'closed'> {
  const health = await readHealth(port, timeoutMs);
  return typeof health === 'string' ? health : 'ours';
}

export async function ensureDashboardRunning(options: {
  port: number;
  projectsRoot: string;
  repoRoot: string;
  waitMs?: number;
}): Promise<DashboardState> {
  const url = `http://localhost:${options.port}`;
  const initial = await readHealth(options.port, 1_000);
  if (initial === 'other') {
    return { status: 'port-taken-by-other', url, detail: `port ${options.port} is serving something that is not the audit dashboard` };
  }
  let restartReason: string | null = null;
  if (initial !== 'closed') {
    const build = dashboardBuildId(options.repoRoot);
    // Reuse only OUR CURRENT server for THIS projects root — a server from older code would
    // render this run with stale rules, and one serving another root would 404 its runs.
    if (initial.build === build && initial.projectsRoot === options.projectsRoot) return { status: 'reused', url };
    restartReason = initial.build !== build ? `the running dashboard was built from older code (${initial.build ?? 'unknown'} → ${build})` : `the running dashboard serves ${initial.projectsRoot}`;
    if (typeof initial.pid !== 'number') return { status: 'failed', url, detail: `${restartReason}, and it did not report its pid — stop it and retry` };
    try {
      process.kill(initial.pid, 'SIGTERM');
    } catch (err) {
      return { status: 'failed', url, detail: `${restartReason}; could not stop it (${err instanceof Error ? err.message : String(err)})` };
    }
    const gone = Date.now() + 5_000;
    while (Date.now() < gone && (await probeDashboard(options.port, 300)) !== 'closed') await new Promise((r) => setTimeout(r, 100));
  }

  // Detached so the dashboard outlives the audit process — it is a long-running
  // server for every run, not a child of one run.
  const child = spawn(process.execPath, ['--experimental-strip-types', join(options.repoRoot, 'src/dashboard/server.ts')], {
    cwd: options.repoRoot,
    env: { ...process.env, AUDIT_AGENT_PROJECTS_ROOT: options.projectsRoot, AUDIT_AGENT_DASHBOARD_PORT: String(options.port) },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + (options.waitMs ?? 10_000);
  while (Date.now() < deadline) {
    if ((await probeDashboard(options.port)) === 'ours') {
      return restartReason ? { status: 'restarted', url, pid: child.pid, detail: restartReason } : { status: 'started', url, pid: child.pid };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { status: 'failed', url, detail: 'dashboard did not become healthy before the timeout' };
}
