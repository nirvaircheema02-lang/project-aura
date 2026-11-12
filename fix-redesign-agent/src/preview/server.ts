import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PreviewServerRecord } from './types.ts';

/** Installing, building and serving the generated preview app on localhost. Failures throw with the tail of the real output: nothing is swallowed and nothing falls back to static HTML. */

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let out = '';
    const t = setTimeout(() => { out += `\n[timed out after ${timeoutMs}ms]`; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 1, out: out + String(e) }); });
  });
}

const tail = (s: string, n = 40) => s.split('\n').slice(-n).join('\n');

export async function ensureInstalled(previewDir: string, log: (l: string) => void = () => {}): Promise<void> {
  const pkg = await readFile(join(previewDir, 'package.json'), 'utf8');
  const marker = join(previewDir, 'node_modules', '.fra-install-hash');
  const hash = createHash('sha256').update(pkg).digest('hex');
  if (existsSync(marker) && (await readFile(marker, 'utf8')) === hash) return;
  log('R8 · installing preview dependencies (npm install, cached)');
  const r = await run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], previewDir, 300_000);
  if (r.code !== 0) throw new Error(`npm install failed in ${previewDir}:\n${tail(r.out)}`);
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, hash);
}

export async function buildPreview(previewDir: string, log: (l: string) => void = () => {}): Promise<void> {
  log('R8 · building the React preview (tsc + vite build)');
  const r = await run('npm', ['run', 'build'], previewDir, 300_000);
  if (r.code !== 0) throw new Error(`the generated React preview does not build:\n${tail(r.out)}`);
}

export function portForRun(runId: string, basePort: number): number {
  return basePort + (parseInt(createHash('sha256').update(runId).digest('hex').slice(0, 6), 16) % 400);
}

async function isUp(url: string): Promise<boolean> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

export function readServerRecord(path: string): Promise<PreviewServerRecord | null> {
  return readFile(path, 'utf8').then((t) => JSON.parse(t) as PreviewServerRecord).catch(() => null);
}

export async function stopPreviewServer(record: PreviewServerRecord | null): Promise<void> {
  if (record?.pid) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ } }
  if (record) for (let i = 0; i < 20 && (await isUp(record.url)); i++) await new Promise((r) => setTimeout(r, 150));
}

/**
 * Starts `vite preview` for the built app, detached so the URL stays alive after the CLI exits
 * (stop it with `pnpm run agent preview <run> --stop`). An older server for the same run is
 * replaced, because a preview server only knows the files that existed when it started.
 */
export async function startPreviewServer(args: { previewDir: string; runId: string; port: number; recordPath: string; log?: (l: string) => void }): Promise<PreviewServerRecord> {
  const log = args.log ?? (() => {});
  await stopPreviewServer(await readServerRecord(args.recordPath));
  let port = args.port;
  for (let attempt = 0; attempt < 25 && (await isUp(`http://127.0.0.1:${port}/`)); attempt++) port++;
  const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: args.previewDir, detached: true, stdio: 'ignore' });
  child.unref();
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) { if (await isUp(url)) break; await new Promise((r) => setTimeout(r, 150)); }
  if (!(await isUp(url))) throw new Error(`the preview server did not come up on ${url}`);
  const record: PreviewServerRecord = { url, port, pid: child.pid ?? null, startedAt: new Date().toISOString(), source: args.previewDir, command: `npx vite preview --host 127.0.0.1 --port ${port}` };
  await mkdir(dirname(args.recordPath), { recursive: true });
  await writeFile(args.recordPath, JSON.stringify(record, null, 2));
  log(`R8 · React preview serving at ${url}`);
  return record;
}

/** True when the recorded server still answers; used by `serve`/`preview` to decide whether to restart. */
export async function previewServerAlive(record: PreviewServerRecord | null): Promise<boolean> {
  return !!record && (await isUp(record.url));
}
