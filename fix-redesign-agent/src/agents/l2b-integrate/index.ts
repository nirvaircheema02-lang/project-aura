import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ComponentSpec, L2Output } from '../../library/types.ts';
import { TerminalError } from '../../retry.ts';

/**
 * L2b — Integrate (deterministic, serial, §7.4/§9.4). The fan-in after the parallel L2/L3
 * builds join: applies every DECLARED shared-file change in a fixed order (by componentId,
 * never build-completion order, so the result is deterministic regardless of which build
 * happened to finish first). Nothing here is model-written.
 *
 * `dsRepo.path` is assumed to be the SAME directory `designSystemPath` already points at
 * (`.../design-system`) — a recorded assumption, not an asserted fact (§19.1 leaves the DS
 * repository's exact shape genuinely open). The safelist generator script's location is
 * fixed relative to it regardless: `design-system/../scripts/gen-ds-safelist.mjs`, per the
 * real, verified workspace layout (`core-v2/package.json`'s own `gen:safelist` script).
 */

export const L2B_STATUS = 'implemented' as const;

export interface L2bDeps {
  dsRepoPath: string;
  log?: (line: string) => void;
  exec?: (cmd: string, args: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const defaultExec: L2bDeps['exec'] = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      if (!err) return resolve({ code: 0, ...out });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve({ code: typeof code === 'number' ? code : 1, ...out });
    });
  });

const UNLAYERED_ROOT_MARKER = ':root {'; // base.css's own unlayered override block (D3's verified precedence note)

export async function appendBarrelEntries(dsRepoPath: string, entries: Array<{ barrelFile: string; exportLine: string }>): Promise<string[]> {
  const touched: string[] = [];
  const byFile = new Map<string, Set<string>>();
  for (const e of [...entries].sort((a, b) => a.exportLine.localeCompare(b.exportLine))) {
    const set = byFile.get(e.barrelFile) ?? new Set<string>();
    set.add(e.exportLine);
    byFile.set(e.barrelFile, set);
  }
  for (const [barrelFile, lines] of byFile) {
    const abs = join(dsRepoPath, 'core-v2/src', barrelFile.replace(/^core-v2\/src\//, ''));
    let content = existsSync(abs) ? await readFile(abs, 'utf-8') : '';
    for (const line of [...lines].sort()) {
      if (!content.includes(line.trim())) content = `${content.trimEnd()}\n${line}\n`;
    }
    await writeFile(abs, content);
    touched.push(abs);
  }
  return touched;
}

export async function appendTokenAdditions(dsRepoPath: string, additions: Array<{ name: string; value: string }>): Promise<string | null> {
  if (additions.length === 0) return null;
  const baseCssPath = join(dsRepoPath, 'core-v2/src/styles/base.css');
  if (!existsSync(baseCssPath)) throw new TerminalError(`L2b: base.css not found at ${baseCssPath} — cannot apply token additions.`);
  let content = await readFile(baseCssPath, 'utf-8');
  const markerIndex = content.indexOf(UNLAYERED_ROOT_MARKER);
  if (markerIndex === -1) throw new TerminalError(`L2b: base.css has no unlayered ":root {" block at ${baseCssPath} — refusing to guess where to add token declarations (would risk breaking the deliberately-unlayered precedence, §7.4).`);
  const insertAt = markerIndex + UNLAYERED_ROOT_MARKER.length;
  // De-dup against the `:root { }` block's OWN text only — scanning the whole file would
  // silently skip a genuinely-new token whenever its name happens to appear anywhere else
  // (a themed override block, a comment, …), never actually declaring it in the root block.
  const rootBlockCloseIndex = content.indexOf('}', insertAt);
  const rootBlockText = rootBlockCloseIndex === -1 ? content.slice(insertAt) : content.slice(insertAt, rootBlockCloseIndex);
  const dedup = [...new Map(additions.map((a) => [a.name, a] as const)).values()].sort((a, b) => a.name.localeCompare(b.name));
  const declarations = dedup.filter((a) => !rootBlockText.includes(`${a.name}:`)).map((a) => `  ${a.name}: ${a.value};`).join('\n');
  if (declarations) {
    content = `${content.slice(0, insertAt)}\n${declarations}${content.slice(insertAt)}`;
    await writeFile(baseCssPath, content);
  }
  return baseCssPath;
}

export async function regenerateSafelist(dsRepoPath: string, exec: L2bDeps['exec'] = defaultExec): Promise<{ ran: boolean; detail: string }> {
  const scriptPath = join(dsRepoPath, '..', 'scripts', 'gen-ds-safelist.mjs');
  if (!existsSync(scriptPath)) return { ran: false, detail: `safelist script not found at ${scriptPath} — skipped, not fatal` };
  const res = await exec!('node', [scriptPath], dirname(scriptPath));
  if (res.code !== 0) throw new TerminalError(`L2b: safelist regeneration failed (${scriptPath}): ${res.stderr || res.stdout}`);
  return { ran: true, detail: res.stdout.trim() };
}

export interface L2bResult {
  barrelsTouched: string[];
  tokenStylesheetTouched: string | null;
  safelistRegenerated: boolean;
  detail: string[];
}

/** Integrates only the SUCCESSFULLY built specs (write-set respected) — a failed build's declared changes are never applied. */
export async function runL2b(deps: L2bDeps, specs: ComponentSpec[], buildResults: L2Output[]): Promise<L2bResult> {
  const log = deps.log ?? (() => {});
  const succeeded = new Set(buildResults.filter((r) => r.writeSetRespected).map((r) => r.componentId));
  const ordered = [...specs].filter((s) => succeeded.has(s.componentId)).sort((a, b) => a.componentId.localeCompare(b.componentId));

  const barrelsTouched = await appendBarrelEntries(deps.dsRepoPath, ordered.flatMap((s) => s.declaredSharedChanges.barrelEntries));
  const tokenStylesheetTouched = await appendTokenAdditions(deps.dsRepoPath, ordered.flatMap((s) => s.declaredSharedChanges.tokenAdditions));
  const safelist = await regenerateSafelist(deps.dsRepoPath, deps.exec);

  log(`L2b · integrated ${ordered.length} component(s) · ${barrelsTouched.length} barrel(s) · token stylesheet ${tokenStylesheetTouched ? 'updated' : 'unchanged'} · safelist ${safelist.ran ? 'regenerated' : 'skipped'}`);
  return { barrelsTouched, tokenStylesheetTouched, safelistRegenerated: safelist.ran, detail: [safelist.detail] };
}
