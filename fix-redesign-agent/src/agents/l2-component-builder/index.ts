import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { readComponentSource } from '../../ds/catalog.ts';
import type { DsRegistry } from '../../ds/d2-registry/index.ts';
import type { LlmClient, LlmImage } from '../../llm/client.ts';
import { ComponentBuildSchema } from '../../llm/schemas/l-nodes.ts';
import type { ComponentSpec, L2Output } from '../../library/types.ts';

/**
 * §9.4/§security: a write-set path is checked by STRING equality against the spec's declared
 * write set, but `fs.writeFile` itself follows symlinks — if the resolved absolute path (or
 * any of its intermediate directories) is, or resolves through, a symlink planted by an
 * earlier build, a compromised branch checkout, or anything else, the write could land
 * anywhere on disk while the string comparison still reports a clean match. Resolves the
 * REAL path of the nearest existing ancestor directory and refuses unless it's still inside
 * the real DS repo root; also refuses if the target itself already exists as a symlink.
 */
async function assertSafeToWrite(dsRepoPath: string, absPath: string): Promise<string | null> {
  if (existsSync(absPath)) {
    const st = await lstat(absPath);
    if (st.isSymbolicLink()) return `"${absPath}" already exists as a symlink — refusing to write through it`;
  }
  const realRoot = await realpath(dsRepoPath);
  let dir = dirname(absPath);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return `no existing ancestor directory found for "${absPath}" under the DS repo root`;
    dir = parent;
  }
  const realDir = await realpath(dir);
  const rel = relative(realRoot, realDir);
  if (rel === '..' || rel.startsWith(`..${'/'}`) || isAbsolute(rel)) {
    return `"${absPath}"'s containing directory resolves (via a symlink) to "${realDir}", outside the DS repo root "${realRoot}"`;
  }
  return null;
}

/**
 * L2 — Component Builder (ai, §9.4). The spec becomes code in the DS's own stack, on the
 * local branch L1's caller already checked out. Writes are checked against the spec's OWN
 * declared write set BEFORE anything touches disk (§9.4/§7.6): a build proposing even one
 * file outside it fails wholesale, never a partial write — the batch continues regardless.
 */

export const L2_STATUS = 'implemented' as const;

export interface L2Deps {
  llm: LlmClient;
  registry: DsRegistry;
  dsRepoPath: string;
  log?: (line: string) => void;
}

const SYSTEM_PROMPT = `You are the Component Builder of a Design System component pipeline.
You are given one component spec and, for style reference, an EXISTING component's real source from the same Design System — copy its conventions: token-only Tailwind classes (no hardcoded hex/px), the same TypeScript prop-typing style, the same file structure (component + a .stories.tsx).
Rules:
- Every file path you return MUST be one of the write-set paths given to you, exactly. Never propose a path outside that list.
- Use ONLY tokens/utility classes that exist in the Design System — never invent a class or a raw color value.
- For an "update" resolution, only ADD to the existing file's own variant/prop model — never remove or rename an existing variant.
- For a "new" resolution, follow the anatomy and variant axes given, matching the reference image.`;

export async function runL2(deps: L2Deps, spec: ComponentSpec): Promise<L2Output> {
  const log = deps.log ?? (() => {});
  const exampleFile = deps.registry.components.componentFiles.find((f) => f.startsWith('atoms/')) ?? deps.registry.components.componentFiles[0];
  const example = exampleFile ? await readComponentSource(deps.registry, exampleFile).catch(() => null) : null;
  const updateTargetSource = spec.updateTarget ? await readComponentSource(deps.registry, spec.updateTarget.dsFile).catch(() => null) : null;

  const images: LlmImage[] = [];
  if (spec.reference.cropPath) {
    try {
      images.push({ png: await readFile(spec.reference.cropPath), caption: `Reference (${spec.reference.source}): what this component should look like`, path: spec.reference.cropPath });
    } catch {
      /* reference crop unreadable — proceed without an image, the prompt still names it */
    }
  }

  const prompt = [
    `Component: ${spec.name} (${spec.category}), resolution=${spec.resolution}`,
    `Anatomy: ${spec.anatomy}`,
    `Scope: ${spec.scope}${spec.scopeEvidenceMissing ? ' (reviewer-asserted, no cross-run evidence)' : ''}`,
    `Write set (the ONLY paths you may return): ${spec.writeSet.join(', ')}`,
    `States observed: ${spec.statesObserved.join(', ')} · to be designed: ${spec.statesToDesign.join(', ')}`,
    spec.constraints.length ? `Constraints: ${spec.constraints.join('; ')}` : '',
    spec.updateTarget ? `Updating existing component ${spec.updateTarget.dsComponent} (${spec.updateTarget.dsFile}) — additive only:\n${updateTargetSource ?? '(source unreadable)'}` : '',
    example ? `Style reference (an existing DS component, copy its conventions):\n${example.slice(0, 6000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await deps.llm.structured({ nodeId: 'L2', system: SYSTEM_PROMPT, prompt, images, schema: ComponentBuildSchema, effort: 'high' });

  const writeSet = new Set(spec.writeSet);
  const violating = res.data.files.filter((f) => !writeSet.has(f.path)).map((f) => f.path);
  if (violating.length > 0) {
    log(`L2 · ${spec.componentId} · REJECTED — ${violating.length} file(s) outside the declared write set: ${violating.join(', ')}`);
    return { componentId: spec.componentId, filesWritten: [], writeSetRespected: false, violatingPaths: violating, usage: res.usage };
  }

  // Pre-flight, before anything is written: a write-set path that string-matches but resolves
  // (via a symlink) outside the DS repo is rejected exactly like a declared-set violation —
  // never a partial write.
  const unsafe: string[] = [];
  for (const f of res.data.files) {
    const reason = await assertSafeToWrite(deps.dsRepoPath, join(deps.dsRepoPath, f.path));
    if (reason) unsafe.push(`${f.path} (${reason})`);
  }
  if (unsafe.length > 0) {
    log(`L2 · ${spec.componentId} · REJECTED — ${unsafe.length} file(s) unsafe to write: ${unsafe.join(', ')}`);
    return { componentId: spec.componentId, filesWritten: [], writeSetRespected: false, violatingPaths: unsafe, usage: res.usage };
  }

  const filesWritten: string[] = [];
  for (const f of res.data.files) {
    const abs = join(deps.dsRepoPath, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content);
    filesWritten.push(relative(deps.dsRepoPath, abs));
  }
  log(`L2 · ${spec.componentId} · wrote ${filesWritten.length} file(s)`);

  return { componentId: spec.componentId, filesWritten, writeSetRespected: true, violatingPaths: [], usage: res.usage };
}
