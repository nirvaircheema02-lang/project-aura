import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovedRegistrySchema } from './types.ts';
import type { ApprovedProject, ApprovedRegistry, ProjectResolution, ServerStatus } from './types.ts';
import { hashProjectSource } from './project-hash.ts';

/**
 * The approved reference-project allowlist: loading, and resolving a project reference to its source folder.
 *
 * Identity is the exact project name plus the exact source folder (by realpath). Nothing here matches by
 * prefix, slug or similarity, and nothing substitutes a different folder when the approved one is absent.
 * A localhost server is an inspection convenience: its state is reported, never used to decide anything.
 */

export function defaultRegistryPath(): string {
  return fileURLToPath(new URL('../../references/approved-projects.json', import.meta.url));
}

export async function loadApprovedRegistry(path: string = defaultRegistryPath()): Promise<{ registry: ApprovedRegistry; sha256: string }> {
  const raw = await readFile(path);
  const sha256 = createHash('sha256').update(raw).digest('hex');

  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error(`approved-project registry ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ApprovedRegistrySchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
    throw new Error(`approved-project registry ${path} is invalid: ${issues}`);
  }
  const registry = parsed.data;

  if (!isAbsolute(registry.referenceProjectsRoot)) {
    throw new Error(`approved-project registry ${path} is invalid: referenceProjectsRoot must be an absolute path, got "${registry.referenceProjectsRoot}"`);
  }
  const seen = new Set<string>();
  registry.projects.forEach((project, i) => {
    const at = `projects.${i}`;
    if (seen.has(project.name)) throw new Error(`approved-project registry ${path} is invalid: ${at}.name "${project.name}" is listed more than once`);
    seen.add(project.name);
    if (!isSafeRelative(project.relativeDir)) {
      throw new Error(`approved-project registry ${path} is invalid: ${at}.relativeDir "${project.relativeDir}" must be a relative path that stays inside referenceProjectsRoot`);
    }
    if (basename(normalize(project.relativeDir)) !== project.name) {
      throw new Error(`approved-project registry ${path} is invalid: ${at}.relativeDir "${project.relativeDir}" must end in the project name "${project.name}"`);
    }
    if (project.inspectionUrl !== null && !isLoopbackHttpUrl(project.inspectionUrl)) {
      throw new Error(`approved-project registry ${path} is invalid: ${at}.inspectionUrl "${project.inspectionUrl}" must be an http(s) URL on localhost, 127.0.0.1 or [::1]`);
    }
    const patternIds = new Set<string>();
    project.patterns.forEach((pattern, j) => {
      if (patternIds.has(pattern.id)) throw new Error(`approved-project registry ${path} is invalid: ${at}.patterns.${j}.id "${pattern.id}" is used twice in "${project.name}"`);
      patternIds.add(pattern.id);
      if (!isSafeRelative(pattern.source.file)) {
        throw new Error(`approved-project registry ${path} is invalid: ${at}.patterns.${j}.source.file "${pattern.source.file}" must be a relative path inside the project`);
      }
    });
  });
  return { registry, sha256 };
}

/** Relative, no empty result, and never climbing out of its base. */
export function isSafeRelative(p: string): boolean {
  if (p.length === 0 || isAbsolute(p)) return false;
  const normalized = normalize(p);
  return normalized !== '.' && !normalized.split(sep).includes('..');
}

function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}

export interface ResolveOptions {
  /** Overrides `registry.referenceProjectsRoot` (tests, or a config override). */
  root?: string | undefined;
  /** Probe the project's localhost inspection URL. Reported only; never changes `status`. */
  checkServer?: boolean | undefined;
  fetchImpl?: typeof fetch | undefined;
  serverTimeoutMs?: number | undefined;
}

export class ReferenceRejectedError extends Error {
  readonly resolution: ProjectResolution;
  constructor(resolution: ProjectResolution) {
    super(`reference project "${resolution.name}" cannot be used (${resolution.status}): ${resolution.reason}`);
    this.name = 'ReferenceRejectedError';
    this.resolution = resolution;
  }
}

export type AvailableProjectResolution = ProjectResolution & { status: 'approved-available'; sourcePath: string; projectHash: string; kind: ApprovedProject['kind'] };

function approvedList(registry: ApprovedRegistry): string {
  return registry.projects.map((p) => p.name).join(', ');
}

export function rejectedResolution(name: string, reason: string): ProjectResolution {
  return { name, status: 'rejected', reason, sourcePath: null, projectHash: null, fileCount: 0, kind: null, inspectionUrl: null, serverStatus: 'not-checked' };
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

interface LocatedProject {
  project: ApprovedProject;
  /** Lexical location `<root>/<relativeDir>`. */
  dir: string;
  /** Present only when the approved folder exists AND really lives at the approved location. */
  realDir: string | null;
  /** Set when the folder exists but its realpath is somewhere else (a symlink or a symlinked parent redirecting it). */
  redirectedTo: string | null;
}

async function locate(project: ApprovedProject, root: string): Promise<LocatedProject> {
  const dir = resolve(root, project.relativeDir);
  const found = await realpathOrNull(dir);
  if (found === null || !(await isDirectory(found))) return { project, dir, realDir: null, redirectedTo: null };
  const realRoot = (await realpathOrNull(root)) ?? resolve(root);
  const expected = join(realRoot, normalize(project.relativeDir));
  if (found !== expected) return { project, dir, realDir: null, redirectedTo: found };
  return { project, dir, realDir: found, redirectedTo: null };
}

function looksLikePath(reference: string): boolean {
  return reference.includes('/') || reference.includes('\\') || reference.startsWith('.') || isAbsolute(reference);
}

async function probeServer(url: string | null, fetchImpl: typeof fetch, timeoutMs: number): Promise<ServerStatus> {
  if (url === null || !isLoopbackHttpUrl(url)) return 'not-checked';
  const attempt = async (method: 'HEAD' | 'GET'): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, redirect: 'manual', signal: controller.signal });
      await res.body?.cancel().catch(() => undefined);
      return (res.status >= 200 && res.status < 400) || res.type === 'opaqueredirect';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  return (await attempt('HEAD')) || (await attempt('GET')) ? 'reachable' : 'unreachable';
}

/**
 * `reference` is an exact project name, or a folder path (absolute, or relative to the current directory).
 * A path is accepted only when its realpath IS the realpath of an approved project's folder.
 */
export async function resolveProject(registry: ApprovedRegistry, reference: string, opts: ResolveOptions = {}): Promise<ProjectResolution> {
  const root = opts.root ?? registry.referenceProjectsRoot;
  const approved = approvedList(registry);

  let located: LocatedProject | null = null;
  const byName = registry.projects.find((p) => p.name === reference);
  if (byName !== undefined) {
    located = await locate(byName, root);
  } else if (!looksLikePath(reference)) {
    return rejectedResolution(reference, `"${reference}" is not an approved reference project name. Approved projects (exact, case-sensitive names): ${approved}. A similarly named folder is never substituted.`);
  } else {
    const asked = resolve(reference);
    const askedReal = await realpathOrNull(asked);
    const all = await Promise.all(registry.projects.map((p) => locate(p, root)));
    // An existing path must resolve to an approved folder. The only other path accepted is the approved
    // location itself while it is missing or redirected, so that case reports "source missing", not "rejected".
    located =
      (askedReal !== null ? all.find((l) => l.realDir !== null && l.realDir === askedReal) : undefined) ?? all.find((l) => l.realDir === null && l.dir === asked) ?? null;
    if (located === null) {
      return rejectedResolution(reference, `"${reference}" is not the source folder of an approved reference project. Approved projects (exact folders under ${root}): ${approved}. Copies, symlinks to other folders and similarly named folders are rejected.`);
    }
  }

  const { project, dir, realDir, redirectedTo } = located;
  const base = { name: project.name, kind: project.kind, inspectionUrl: project.inspectionUrl };
  if (realDir === null) {
    const why =
      redirectedTo !== null
        ? `the approved folder ${dir} resolves to ${redirectedTo}, which is not the approved location; it is not used and nothing is substituted`
        : `the approved folder ${dir} does not exist; nothing is substituted`;
    return { ...base, status: 'approved-source-missing', reason: `"${project.name}" is approved but its source is unavailable: ${why}.`, sourcePath: null, projectHash: null, fileCount: 0, serverStatus: 'not-checked' };
  }

  const { hash, fileCount } = await hashProjectSource(realDir);
  const serverStatus: ServerStatus = opts.checkServer === true ? await probeServer(project.inspectionUrl, opts.fetchImpl ?? fetch, opts.serverTimeoutMs ?? 1500) : 'not-checked';
  return {
    ...base,
    status: 'approved-available',
    reason: `"${project.name}" is an approved reference project; source ${realDir} (${fileCount} source files hashed).`,
    sourcePath: realDir,
    projectHash: hash,
    fileCount,
    serverStatus,
  };
}

export async function requireApprovedProject(registry: ApprovedRegistry, reference: string, opts: ResolveOptions = {}): Promise<AvailableProjectResolution> {
  const resolution = await resolveProject(registry, reference, opts);
  if (resolution.status !== 'approved-available' || resolution.sourcePath === null || resolution.projectHash === null || resolution.kind === null) {
    throw new ReferenceRejectedError(resolution);
  }
  return resolution as AvailableProjectResolution;
}
