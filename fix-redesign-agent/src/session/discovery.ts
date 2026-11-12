import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAuditRun, type AuditRunRef, type ResolvedAuditRun } from '../audit-link/index.ts';
import { listRedesignRuns, readRedesignRunMeta, redesignPaths } from '../output/redesign-store.ts';

/**
 * S0 — session startup (ARCHITECTURE.md §5.1). Resolves the ONE normal-input reference
 * `<name>` to either a brand-new audit run to load (R1 runs next) or an existing redesign
 * run to resume (skips straight to its recorded checkpoint). Every outcome but a single
 * exact match asks — never guesses (Decision Log #20).
 */

export type OpenResolution =
  | { kind: 'new-run'; runRef: AuditRunRef; how: string }
  | { kind: 'resume'; projectSlug: string; redesignRunId: string; runDir: string; how: string }
  | { kind: 'ambiguous'; candidates: string[]; message: string }
  | { kind: 'not-found'; message: string };

export interface DiscoveryDeps {
  auditAgentRepoRoot: string;
  /** This repo's own `projects/` root. */
  projectsRoot: string;
  /** Defaults to shelling out to audit-agent's `find-run`; tests inject a fixture resolver. */
  resolveRun?: (ref: AuditRunRef) => Promise<{ run: ResolvedAuditRun; warnings: string[] }>;
}

async function tryFindRun(deps: DiscoveryDeps, ref: AuditRunRef): Promise<ResolvedAuditRun | { ambiguous: string[] } | null> {
  const resolve = deps.resolveRun ?? ((r: AuditRunRef) => resolveAuditRun(deps.auditAgentRepoRoot, r));
  try {
    const { run } = await resolve(ref);
    return run;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // resolveAuditRun's own TERMINAL message embeds audit-agent's candidate list verbatim
    // when find-run exited 2 (ambiguous) — surface those lines rather than re-deriving them.
    // Exit 1 ("no match at all") uses the SAME message template with no candidate list, so
    // only a message that actually PRINTED one is genuinely ambiguous — one that didn't is a
    // plain per-form miss (`null`), which the caller must be free to try the next form for.
    // Collapsing that case into a fake single-item "ambiguous" result (as this used to do)
    // made §5.1's project-name fallback effectively unreachable: a typed project name almost
    // always fails the Run Name lookup with no candidate list, and step 2 in
    // `resolveStartReference` returns immediately on ANY ambiguous-shaped result — so it would
    // report "matches more than one audit run by name" instead of ever reaching step 3.
    if (/could not resolve .* to exactly one run/.test(message)) {
      const candidateLines = message
        .split('\n')
        .filter((line) => /^\s{2}\S/.test(line))
        .map((line) => line.trim());
      if (candidateLines.length > 0) return { ambiguous: candidateLines };
      return null;
    }
    // Anything else — a bad `auditAgentRepoRoot`, a missing `find-run` command, a spawn
    // failure — is a genuine CONFIGURATION/environment problem, not "this particular
    // reference wasn't found." It fails identically for every other reference form too, so
    // swallowing it here and silently trying the next form would waste time and end in a
    // misleading generic "did not resolve" instead of surfacing the real, actionable error.
    throw err;
  }
}

/**
 * "A project name (no specific run)" (§5.1) — audit-agent's CLI has no dedicated query for
 * this, so it is read directly off the filesystem via its own documented, stable layout
 * (`projects/<projectName>/runs/<runId>/run.json`), read-only. The SAME recorded exception
 * to Decision Log #3 that cross-run evidence (#23) already uses: a filesystem read over a
 * documented layout when no live query command exists for it, never a re-implementation of
 * audit-agent's OWN write logic.
 */
async function findProjectRuns(auditAgentRepoRoot: string, projectNameGiven: string): Promise<Array<{ runId: string; displayName: string; targetUrl: string | null }>> {
  const projectsDir = join(auditAgentRepoRoot, 'projects');
  if (!existsSync(projectsDir)) return [];
  const dirs = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory());
  const match = dirs.find((d) => d.name.toLowerCase() === projectNameGiven.trim().toLowerCase());
  if (!match) return [];
  const runsDir = join(projectsDir, match.name, 'runs');
  if (!existsSync(runsDir)) return [];
  const runDirs = (await readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory());
  const out: Array<{ runId: string; displayName: string; targetUrl: string | null }> = [];
  for (const rd of runDirs) {
    const runJsonPath = join(runsDir, rd.name, 'run.json');
    try {
      const meta = JSON.parse(await readFile(runJsonPath, 'utf-8')) as { displayName?: string; targetUrl?: string };
      out.push({ runId: rd.name, displayName: meta.displayName ?? rd.name, targetUrl: meta.targetUrl ?? null });
    } catch {
      // A run predating run.json (audit-agent's own documented fallback: displayName defaults to the runId).
      out.push({ runId: rd.name, displayName: rd.name, targetUrl: null });
    }
  }
  return out;
}

/** This repo's own redesign run id, searched across every project (§5.1's "several projects share it → ask"). */
async function findOwnRedesignRun(projectsRoot: string, redesignRunIdGiven: string): Promise<Array<{ projectSlug: string; redesignRunId: string; runDir: string }>> {
  const all = await listRedesignRuns(projectsRoot);
  return all.filter((r) => r.redesignRunId === redesignRunIdGiven).map((r) => ({ projectSlug: r.projectSlug, redesignRunId: r.redesignRunId, runDir: r.runDir }));
}

interface MarkerResult {
  kind: 'own-run' | 'audit-run' | 'audit-project' | 'own-project';
  dir: string;
}

/** §5.1's marker-file classification for a folder path or `file://` link. */
async function classifyByMarkers(dirPath: string): Promise<MarkerResult | null> {
  if (!existsSync(dirPath)) return null;
  const runJsonPath = join(dirPath, 'run.json');
  if (existsSync(runJsonPath)) {
    try {
      const meta = JSON.parse(await readFile(runJsonPath, 'utf-8')) as Record<string, unknown>;
      if (typeof meta.redesignRunId === 'string') return { kind: 'own-run', dir: dirPath };
      if (typeof meta.runId === 'string' && existsSync(join(dirPath, 'data.json'))) return { kind: 'audit-run', dir: dirPath };
    } catch {
      /* fall through to other markers */
    }
  }
  const projectJsonPath = join(dirPath, 'project.json');
  if (existsSync(projectJsonPath)) {
    if (existsSync(join(dirPath, 'redesigns'))) return { kind: 'own-project', dir: dirPath };
    if (existsSync(join(dirPath, 'runs'))) return { kind: 'audit-project', dir: dirPath };
  }
  return null;
}

function looksLikePath(name: string): boolean {
  return name.startsWith('/') || name.startsWith('./') || name.startsWith('../') || name.startsWith('file://') || name.includes('/');
}

function toFsPath(name: string): string {
  return name.startsWith('file://') ? fileURLToPath(name) : name;
}

/** An audit dashboard URL of the documented shape `…/projects/<p>/runs/<r>` (§5.1's last row). */
function dashboardRunId(name: string): string | null {
  const m = name.match(/\/projects\/[^/]+\/runs\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1] as string) : null;
}

export async function resolveStartReference(name: string, deps: DiscoveryDeps): Promise<OpenResolution> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { kind: 'not-found', message: 'An empty reference was given — nothing to resolve.' };

  // 1. Audit Run ID.
  const byId = await tryFindRun(deps, { runId: trimmed });
  if (byId && !('ambiguous' in byId)) return { kind: 'new-run', runRef: { runId: trimmed }, how: `resolved as an audit Run ID ("${trimmed}")` };

  // 2. Audit Run Name (exact, case-insensitive — find-run's own contract).
  const byName = await tryFindRun(deps, { runName: trimmed });
  if (byName) {
    if ('ambiguous' in byName) return { kind: 'ambiguous', candidates: byName.ambiguous, message: `"${trimmed}" matches more than one audit run by name.` };
    return { kind: 'new-run', runRef: { runName: trimmed }, how: `resolved as an audit Run Name ("${trimmed}")` };
  }

  // 3. A project name (no specific run) — filesystem read over audit-agent's documented layout.
  const projectRuns = await findProjectRuns(deps.auditAgentRepoRoot, trimmed);
  if (projectRuns.length === 1) {
    const only = projectRuns[0]!;
    return { kind: 'new-run', runRef: { runId: only.runId }, how: `resolved as the one run in audit project "${trimmed}" (${only.displayName})` };
  }
  if (projectRuns.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: projectRuns.map((r) => `${r.runId} — "${r.displayName}"${r.targetUrl ? ` (${r.targetUrl})` : ''}`),
      message: `Audit project "${trimmed}" has ${projectRuns.length} runs — pick one by exact Run ID or Run Name.`,
    };
  }

  // 4. This repo's own redesign run id.
  const ownRuns = await findOwnRedesignRun(deps.projectsRoot, trimmed);
  if (ownRuns.length === 1) {
    const only = ownRuns[0]!;
    return { kind: 'resume', projectSlug: only.projectSlug, redesignRunId: only.redesignRunId, runDir: only.runDir, how: `resolved as an existing redesign run ("${trimmed}")` };
  }
  if (ownRuns.length > 1) {
    return { kind: 'ambiguous', candidates: ownRuns.map((r) => `${r.projectSlug} / ${r.redesignRunId}`), message: `Redesign run id "${trimmed}" exists under more than one project.` };
  }

  // 5. A dashboard URL of the documented shape — treat its runId as an audit Run ID (step 1's logic).
  const fromDashboard = dashboardRunId(trimmed);
  if (fromDashboard) {
    const resolved = await tryFindRun(deps, { runId: fromDashboard });
    if (resolved && !('ambiguous' in resolved)) return { kind: 'new-run', runRef: { runId: fromDashboard }, how: `resolved from a dashboard URL as audit Run ID "${fromDashboard}"` };
  }

  // 6. A folder path or file:// link — marker-file classification.
  if (looksLikePath(trimmed)) {
    const fsPath = toFsPath(trimmed);
    const dir = existsSync(fsPath) && !fsPath.match(/\.[a-z0-9]+$/i) ? fsPath : fsPath.split('/').slice(0, -1).join('/') || '/';
    const marker = await classifyByMarkers(existsSync(fsPath) ? fsPath : dir);
    if (marker) {
      if (marker.kind === 'own-run') {
        const meta = JSON.parse(await readFile(join(marker.dir, 'run.json'), 'utf-8')) as { redesignRunId: string };
        const listed = (await listRedesignRuns(deps.projectsRoot)).find((r) => r.redesignRunId === meta.redesignRunId);
        if (listed) return { kind: 'resume', projectSlug: listed.projectSlug, redesignRunId: listed.redesignRunId, runDir: listed.runDir, how: `resolved via run.json at ${marker.dir}` };
      }
      if (marker.kind === 'audit-run') {
        const meta = JSON.parse(await readFile(join(marker.dir, 'run.json'), 'utf-8')) as { runId: string };
        return { kind: 'new-run', runRef: { runId: meta.runId }, how: `resolved via run.json at ${marker.dir}` };
      }
      if (marker.kind === 'audit-project') {
        const projectName = marker.dir.split('/').at(-1) ?? marker.dir;
        return resolveStartReference(projectName, deps);
      }
      if (marker.kind === 'own-project') {
        const project = JSON.parse(await readFile(join(marker.dir, 'project.json'), 'utf-8')) as { redesignRunIds: string[] };
        if (project.redesignRunIds.length === 1) return resolveStartReference(project.redesignRunIds[0] as string, deps);
        if (project.redesignRunIds.length > 1) return { kind: 'ambiguous', candidates: project.redesignRunIds, message: `Project at ${marker.dir} has ${project.redesignRunIds.length} redesign runs — pick one.` };
      }
    }
    return {
      kind: 'not-found',
      message: `"${trimmed}" looks like a path, but no recognised marker was found at ${dir} (expected one of: this repo's run.json, an audit run's data.json+run.json, an audit project's project.json+runs/, or this repo's project.json+redesigns/).`,
    };
  }

  return { kind: 'not-found', message: `"${trimmed}" did not resolve as an audit Run ID, an audit Run Name, an audit project, a redesign run id, a dashboard URL, or a folder reference.` };
}

/** Reads the resume target's `session-state.json` / `run.json` path helpers for the caller. */
export function resumePaths(projectsRoot: string, projectSlug: string, redesignRunId: string) {
  return redesignPaths(projectsRoot, projectSlug, redesignRunId);
}

export async function readResumeMeta(projectsRoot: string, projectSlug: string, redesignRunId: string) {
  const paths = redesignPaths(projectsRoot, projectSlug, redesignRunId);
  return readRedesignRunMeta(paths);
}
