import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emptyFixPlan, parseFixPlan, type FixPlan } from './fix-plan.ts';

/**
 * Project → Runs storage (ARCHITECTURE.md §6). Every audit target is a
 * project; every execution or re-audit is a run inside it. `project.json`
 * persists the project's Figma destination so future runs update the SAME
 * Figma file instead of creating a new one.
 *
 *   projects/<project>/project.json
 *   projects/<project>/runs/<run_id>/{report.xlsx,data.json,screenshots/,history/}
 */

export interface ProjectFile {
  targetUrl: string;
  mode: 'full-site' | 'single-page';
  figmaFileKey: string | null;
  figmaFileUrl: string | null;
  figmaTeamPlanKey: string | null;
  figmaProjectId: string | null;
  /** Node ids returned by Figma, so a republish mutates in place rather than duplicating (§2.5 rule 5). */
  figmaNodes: { pages: Record<string, string>; frames: Record<string, string>; markers: Record<string, string>; imageHashes: Record<string, string> };
  createdAt: string;
}

export interface RunPaths {
  projectDir: string;
  projectFile: string;
  runDir: string;
  dataJson: string;
  reportXlsx: string;
  /**
   * C3's deterministic publish plan (see figma/publish-plan.ts), persisted for every run
   * regardless of AI mode or whether a Figma write ever happens — the plan itself needs no
   * model call. NOT a completed Figma deliverable on its own — see `figmaOpsJson` below and
   * docs/FIGMA-PUBLISH-RUNBOOK.md for what still has to actually happen (OUT-4: there remains
   * no CLI command that writes to Figma itself — Figma's write API needs a live, authenticated
   * session, not a headless process; `pnpm figma-plan <runId>` regenerates this file and the two
   * below from an existing run without re-auditing).
   */
  figmaPlanJson: string;
  /**
   * Per-page composite geometry (figma/page-composite-plan.ts, Decision Log #32): the measured
   * repeated-header height and the exact crop/placement blocks a live Figma publish should use
   * to assemble the full-page capture without repeating the header or leaving a blank/oversized
   * single raster. Computed from the ALREADY-CAPTURED page-tile-N.png files — no recapture.
   */
  figmaCompositePlanJson: string;
  /**
   * The ordered Figma write (figma/publish-ops.ts): every operation a live, Figma-MCP-
   * authenticated session needs to replay to actually publish — image crops, marker
   * component sets (with `clipsContent: false` baked in), clamped marker positions, the
   * Legend+numbered-list panel. This is NOT a completed Figma deliverable by itself — it is
   * the plan a live session mechanically executes; see docs/FIGMA-PUBLISH-RUNBOOK.md.
   */
  figmaOpsJson: string;
  /**
   * A self-contained, single-file HTML rendering of this run's data.json — every evidence
   * screenshot embedded as a data: URI so the file opens standalone (no dashboard server, no
   * external asset folder) and survives being copied or shared on its own.
   */
  reportHtml: string;
  /**
   * Only written when reportHtml would be excessively large to share as one file: the same
   * report with evidence as real files instead of embedded data, zipped together. report.html
   * remains the preferred output — this is a fallback, not a replacement.
   */
  reportPackageZip: string;
  screenshotsDir: string;
  historyDir: string;
  /**
   * `{ runId, displayName, targetUrl, mode, createdAt }` — the run's human-readable name,
   * preserved byte-for-byte as given (never replaced by its own slug), so a later
   * `figma-plan <runId>` regeneration or Figma file name still uses it without asking again.
   * Runs created before this file existed simply don't have one — every reader falls back to
   * the runId itself as the display name (see `readRunMeta`), never an error.
   */
  runMetaJson: string;
  /**
   * The reviewer's Fix/Skip/Keep-for-Review decisions (`src/output/fix-plan.ts`) — a SIDECAR,
   * never a `data.json` change. Written either by `fix-plan-import` or by the reviewer moving
   * their browser export here directly; absent until someone actually decides something, which
   * every reader treats as "zero decisions", never an error (see `readFixPlan`).
   */
  fixPlanJson: string;
}

export interface RunMeta {
  runId: string;
  /** Preserved exactly as the user gave it — never slugified, never replaced. */
  displayName: string;
  targetUrl: string;
  mode: ProjectFile['mode'];
  createdAt: string;
}

/** Lowercase, spaces/underscores to hyphens, strips anything else unsafe for a folder/DB/Figma-node name. */
function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A readable run name derived from the URL when the user gives none — e.g.
 * "https://www.kenresearch.com/brand-perception-survey" -> "Brand Perception Survey". This is
 * URL-only by necessity: the run's directories (and therefore its name) must exist BEFORE B1
 * ever captures the page, so no page title is available yet to derive from at this point.
 */
function readableNameFromUrl(targetUrl: string): string {
  const u = new URL(targetUrl);
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return u.hostname; // no path to derive a title from — hostname as-is, never title-cased
  const words = segments[segments.length - 1]!.replace(/[-_]+/g, ' ').trim();
  if (words.length === 0) return u.hostname;
  return words
    .split(' ')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Resolves the two names a run needs from the ONE thing the user actually supplies ("run
 * name"). `providedName` becomes `displayName` verbatim (trimmed only) — it is NEVER replaced
 * by its own slug anywhere downstream (Figma file name, friendly report filenames, every
 * "run name" the CLI prints). `runId` is a filesystem/DB/Figma-node-safe slug derived FROM the
 * display name, used for the folder, `--run-id`, and anywhere a raw display name isn't safe.
 * With no `providedName`, both are derived from the URL (see `readableNameFromUrl`).
 */
export function resolveRunName(targetUrl: string, providedName?: string | null): { displayName: string; runId: string } {
  const displayName = providedName && providedName.trim().length > 0 ? providedName.trim() : readableNameFromUrl(targetUrl);
  const runId = slugify(displayName) || `run-${Date.now()}`;
  return { displayName, runId };
}

/**
 * Strips characters that are unsafe in a filename -- NOT a slug: spaces, case, and hyphens are
 * all preserved on purpose, matching the approved "Brand Perception survey page.html"
 * convention. Only the characters genuinely invalid on common filesystems are removed;
 * whitespace is collapsed and trimmed, nothing else changes.
 */
export function safeFileName(name: string): string {
  const invalidChars = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);
  let out = '';
  for (const ch of name) {
    if (invalidChars.has(ch)) continue;
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) continue; // control characters
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** A filesystem-safe project name derived from the audit target. */
export function projectNameFor(targetUrl: string): string {
  const url = new URL(targetUrl);
  return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

export function runPaths(projectsRoot: string, projectName: string, runId: string): RunPaths {
  const projectDir = join(projectsRoot, projectName);
  const runDir = join(projectDir, 'runs', runId);
  return {
    projectDir,
    projectFile: join(projectDir, 'project.json'),
    runDir,
    dataJson: join(runDir, 'data.json'),
    reportXlsx: join(runDir, 'report.xlsx'),
    figmaPlanJson: join(runDir, 'figma-plan.json'),
    figmaCompositePlanJson: join(runDir, 'figma-composite-plan.json'),
    figmaOpsJson: join(runDir, 'figma-ops.json'),
    reportHtml: join(runDir, 'report.html'),
    reportPackageZip: join(runDir, 'report-package.zip'),
    screenshotsDir: join(runDir, 'screenshots'),
    historyDir: join(runDir, 'history'),
    runMetaJson: join(runDir, 'run.json'),
    fixPlanJson: join(runDir, 'fix-plan.json'),
  };
}

export async function ensureRunDirs(paths: RunPaths): Promise<void> {
  await mkdir(paths.screenshotsDir, { recursive: true });
  await mkdir(paths.historyDir, { recursive: true });
}

export async function loadOrCreateProject(paths: RunPaths, init: { targetUrl: string; mode: ProjectFile['mode']; figmaTeamPlanKey: string | null }): Promise<ProjectFile> {
  if (existsSync(paths.projectFile)) {
    return JSON.parse(await readFile(paths.projectFile, 'utf-8')) as ProjectFile;
  }
  const project: ProjectFile = {
    targetUrl: init.targetUrl,
    mode: init.mode,
    figmaFileKey: null,
    figmaFileUrl: null,
    figmaTeamPlanKey: init.figmaTeamPlanKey,
    figmaProjectId: null,
    figmaNodes: { pages: {}, frames: {}, markers: {}, imageHashes: {} },
    createdAt: new Date().toISOString(),
  };
  await mkdir(paths.projectDir, { recursive: true });
  await writeFile(paths.projectFile, JSON.stringify(project, null, 2));
  return project;
}

export async function saveProject(paths: RunPaths, project: ProjectFile): Promise<void> {
  await mkdir(paths.projectDir, { recursive: true });
  await writeFile(paths.projectFile, JSON.stringify(project, null, 2));
}

/** Persists the run's display name alongside its data — written once, right after `ensureRunDirs`, before the audit itself starts. */
export async function writeRunMeta(paths: Pick<RunPaths, 'runMetaJson'>, meta: RunMeta): Promise<void> {
  await mkdir(dirname(paths.runMetaJson), { recursive: true }); // safe even when ensureRunDirs already created it
  await writeFile(paths.runMetaJson, JSON.stringify(meta, null, 2));
}

/** Reads a run's display name back, falling back to the runId itself for runs created before `run.json` existed — never an error, never a blank name. */
export async function readRunMeta(paths: Pick<RunPaths, 'runMetaJson'>, fallbackRunId: string): Promise<RunMeta | { runId: string; displayName: string }> {
  try {
    return JSON.parse(await readFile(paths.runMetaJson, 'utf-8')) as RunMeta;
  } catch {
    return { runId: fallbackRunId, displayName: fallbackRunId };
  }
}

/** Persists a validated fix plan — same mkdir-then-write idiom as `writeRunMeta`. */
export async function writeFixPlan(paths: Pick<RunPaths, 'fixPlanJson'>, plan: FixPlan): Promise<void> {
  await mkdir(dirname(paths.fixPlanJson), { recursive: true });
  await writeFile(paths.fixPlanJson, JSON.stringify(plan, null, 2));
}

/**
 * Reads a run's decisions back. A run with no `fix-plan.json` — every run that predates this
 * feature, and every run nobody has reviewed yet — returns a valid EMPTY plan, never an error:
 * zero decisions is a legitimate state, not a failure. Same try-catch-fallback idiom as
 * `readRunMeta`. A file that exists but is malformed also degrades to empty rather than
 * throwing; the CLI's `fix-plan-import` is where a bad file is surfaced loudly instead.
 */
export async function readFixPlan(paths: Pick<RunPaths, 'fixPlanJson'>, fallbackRunId: string): Promise<FixPlan> {
  try {
    const parsed = parseFixPlan(JSON.parse(await readFile(paths.fixPlanJson, 'utf-8')));
    return parsed.ok ? parsed.plan : emptyFixPlan(fallbackRunId);
  } catch {
    return emptyFixPlan(fallbackRunId);
  }
}

/** Every project directory under the projects root, alphabetically. */
export async function listProjects(projectsRoot: string): Promise<string[]> {
  if (!existsSync(projectsRoot)) return [];
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Every run id in a project, newest first by directory mtime — run ids are opaque, so time is the honest ordering. */
export async function listRuns(projectsRoot: string, project: string): Promise<string[]> {
  const runsDir = join(projectsRoot, project, 'runs');
  if (!existsSync(runsDir)) return [];
  const entries = await readdir(runsDir, { withFileTypes: true });
  const runs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const withTime = await Promise.all(runs.map(async (r) => ({ r, t: (await stat(join(runsDir, r))).mtimeMs })));
  return withTime.sort((a, b) => b.t - a.t).map((x) => x.r);
}

export interface ResolvedRun {
  projectName: string;
  runId: string;
  displayName: string;
  runDir: string;
}

/**
 * Finds runs by the human-readable name a reviewer actually has ("Deals and IPO Consulting
 * Test"), scanning every project's `run.json`. Matching is case-insensitive but EXACT — never
 * substring or fuzzy: two runs whose names merely share a prefix are different runs, and
 * quietly picking one would silently import decisions into the wrong audit.
 *
 * Returns every match rather than picking one. Zero matches and two matches are both legitimate
 * outcomes the caller must handle by asking the reviewer, never by guessing.
 */
export async function findRunsByDisplayName(projectsRoot: string, displayName: string): Promise<ResolvedRun[]> {
  const needle = displayName.trim().toLowerCase();
  const matches: ResolvedRun[] = [];
  for (const projectName of await listProjects(projectsRoot)) {
    for (const runId of await listRuns(projectsRoot, projectName)) {
      const paths = runPaths(projectsRoot, projectName, runId);
      // Runs predating run.json fall back to runId-as-displayName, exactly like readRunMeta.
      const meta = await readRunMeta(paths, runId);
      if (meta.displayName.trim().toLowerCase() === needle) {
        matches.push({ projectName, runId, displayName: meta.displayName, runDir: paths.runDir });
      }
    }
  }
  return matches;
}

/** Locates a run by its id across every project — the id path of the same resolution `findRunsByDisplayName` does by name. */
export async function findRunById(projectsRoot: string, runId: string): Promise<ResolvedRun | null> {
  for (const projectName of await listProjects(projectsRoot)) {
    if (!(await listRuns(projectsRoot, projectName)).includes(runId)) continue;
    const paths = runPaths(projectsRoot, projectName, runId);
    const meta = await readRunMeta(paths, runId);
    return { projectName, runId, displayName: meta.displayName, runDir: paths.runDir };
  }
  return null;
}
