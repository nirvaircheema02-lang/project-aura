import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

/**
 * A project's source hash: "which version of the reference project did this pattern come from".
 * sha256 over the sorted list of `<posix relative path>\0<file sha256>\n` of the project's source files.
 * Deterministic: independent of directory order, mtime, absolute location and platform path separator.
 */

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.scss', '.html', '.json', '.md']);
/** Excluded at any depth (a nested `node_modules` or `.next` is just as much a build artefact as a top-level one). */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.next', 'dist', 'build', '.git', '.turbo', 'coverage']);
const EXCLUDED_FILES: ReadonlySet<string> = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.DS_Store']);
const MAX_FILES = 20_000;
const READ_BATCH = 64;

export interface ProjectHash {
  hash: string;
  fileCount: number;
}

function isSourceFile(name: string): boolean {
  if (EXCLUDED_FILES.has(name) || name.endsWith('.tsbuildinfo')) return false;
  return SOURCE_EXTENSIONS.has(extname(name).toLowerCase());
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** `opts.maxFiles` lowers the cap (tests); the default is the 20000-file ceiling. */
export async function hashProjectSource(dir: string, opts: { maxFiles?: number } = {}): Promise<ProjectHash> {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const root = await realpath(dir);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`hashProjectSource: ${dir} is not a directory`);

  // relative posix path -> absolute path of the file whose bytes are hashed
  const files = new Map<string, string>();

  async function walk(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) await walk(abs);
        continue;
      }
      if (!isSourceFile(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        // Followed only when it is a file whose real location is still inside the project; a link out of the
        // project (or to a directory, which could loop) contributes nothing.
        const target = await realpath(abs).catch(() => null);
        if (target === null || !target.startsWith(root + sep)) continue;
        if (!(await stat(target)).isFile()) continue;
        record(abs, target);
        continue;
      }
      if (entry.isFile()) record(abs, abs);
    }
  }

  function record(linkOrFile: string, hashed: string): void {
    if (files.size >= maxFiles) {
      throw new Error(`hashProjectSource: ${dir} has more than ${maxFiles} source files; refusing to hash a truncated set`);
    }
    files.set(relative(root, linkOrFile).split(sep).join('/'), hashed);
  }

  await walk(root);

  const paths = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const fileHashes = new Map<string, string>();
  for (let i = 0; i < paths.length; i += READ_BATCH) {
    const batch = paths.slice(i, i + READ_BATCH);
    const digests = await Promise.all(batch.map(async (p) => sha256(await readFile(files.get(p) as string))));
    batch.forEach((p, j) => fileHashes.set(p, digests[j] as string));
  }

  const overall = createHash('sha256');
  for (const p of paths) overall.update(`${p}\0${fileHashes.get(p)}\n`);
  return { hash: overall.digest('hex'), fileCount: paths.length };
}
