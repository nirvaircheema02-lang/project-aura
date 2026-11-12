import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DesignMode, RunOutcomeState, RunType, UnitState } from '../session/types.ts';

/**
 * This repo's OWN output tree (ARCHITECTURE.md §13) — new code, not vendored, though it
 * mirrors audit-agent's `RunPaths` / `RunMeta` idiom on purpose so anyone who knows one
 * knows the other:
 *
 *   projects/<project-slug>/redesigns/<sourceRunId>-<runType>-<UTC stamp>/
 *
 * `<project-slug>` is the SAME slug audit-agent used for the source run (its
 * `projectName`), so the two trees line up by name — but this tree lives HERE. Nothing is
 * ever written into audit-agent's `projects/`; the link back is the `sourceRun` field in
 * `run.json`, never co-location. Page artifacts stay at the run root exactly as v1.0 laid
 * them out (Decision Log #27) — `context/`, `review/` and `library/` are additions, not a move.
 */

export interface RedesignPaths {
  projectDir: string;
  redesignsDir: string;
  runDir: string;

  // ── continuity (§5.3, §13) ────────────────────────────────────────────────────────────
  projectJson: string;
  runMetaJson: string;
  sessionStateJson: string;
  decisionsJson: string;
  handoffMd: string;
  traceJsonl: string;

  // ── React Preview (§8c): the default deliverable — runnable source + a localhost URL ───
  /** The generated Vite + React app (runnable source). */
  previewAppDir: string;
  /** Hand-authored React for behaviour the generator cannot derive; registered in design-decisions.json. */
  previewOverridesDir: string;
  /** Generation facts and the pre-G2 verification. */
  previewDir: string;
  previewGenerationJson: string;
  previewVerificationJson: string;
  /** The design & state fidelity report (original baseline vs the rendered preview). */
  fidelityReportJson: string;
  /** Every correction cycle: feedback, the corrections applied, and why the loop stopped. */
  correctionLogJson: string;
  /** Where the running preview's URL/pid are recorded. */
  previewServerJson: string;

  // ── context (§6, §13) ──────────────────────────────────────────────────────────────────
  contextDir: string;
  contextJson: string;
  mappingJson: string;
  conflictsJson: string;
  captureJson: string;
  scopeJson: string;
  /** This run's earlier C2 model picks, so a resume does not ask the same mapping judgment again. */
  c2PicksJson: string;
  /** The stamped, pre-edit page + mapping saved once after C2 so a resume does not re-capture the live site. */
  captureSnapshotJson: string;
  captureSnapshotHtml: string;
  /** The ORIGINAL page's probed behaviour (pre-edit, read-only), the baseline the preview is compared to. */
  behaviorJson: string;
  /** Scroll-linked movement of the original page (read-only recording), replayed by the preview. */
  scrollEffectsJson: string;
  /** The edits R4 applied and that stay in force, so the preview can be regenerated from the run folder alone. */
  appliedEditsJson: string;
  plannerGapsJson: string;
  /** Design Review Resolver output: per-finding decisions and section overrides. */
  designDecisionsJson: string;
  /** The Resolver's derived design targets (RV): the ONE record R3, R4, R5 and R8 all consume. Audit data is never edited. */
  resolvedTargetsJson: string;
  /** The ORIGINAL page's design/state/composition baseline (pre-edit, write-once, hash-bound). */
  designBaselineJson: string;
  /** What happened in the post-preview correction loop, so a resume reproduces the same constraints. */
  correctionStateJson: string;

  // ── page workflow (§8, §13) ────────────────────────────────────────────────────────────
  originalHtml: string;
  redesignHtml: string;
  redesignContentHtml: string;
  sectionsDir: string;
  beforePng: string;
  afterPng: string;
  beforeTilesDir: string;
  afterTilesDir: string;
  componentsDir: string;
  redesignPlanJson: string;
  validationResultsJson: string;
  exportValidationJson: string;
  changeListMd: string;

  // ── claude-session judgment (judgmentProvider, §13a) ──────────────────────────────────
  judgmentsDir: string;

  // ── review (§8.6/R6, §10a, §13) ────────────────────────────────────────────────────────
  reviewDir: string;
  componentManifestJson: string;
  componentReviewHtml: string;
  componentSelectionJson: string;
  reviewIndexHtml: string;

  // ── library / Workflow B (§9, §13) ─────────────────────────────────────────────────────
  libraryDir: string;
  newComponentPlanJson: string;
  componentPlanResolvedJson: string;
  resolutionJson: string;
  specsDir: string;
  buildJson: string;
  acceptanceJson: string;
  previewsDir: string;
  inContextHtml: string;
  packageJson: string;
  packageValidationJson: string;
  publishJson: string;

  // ── clean, user-facing deliverables — TWO SIBLING folders directly under the run root, never
  // nested inside one another and never wrapped in a shared parent: `redesign/` (Workflow A,
  // driven by fix-plan.json) and `new-component/` (Workflow B, driven by new-component-plan.json
  // and/or the checklist export). Never internal JSON/traces/tiles — those stay where they are. ──
  redesignDeliverableDir: string;
  redesignDeliverableSectionsDir: string;
  newComponentDir: string;
  newComponentIndexHtml: string;
  newComponentInContextHtml: string;
}

export function sectionFragmentPath(paths: Pick<RedesignPaths, 'sectionsDir'>, sectionId: string): string {
  return join(paths.sectionsDir, `${sectionId}.html`);
}
export function componentCropPath(paths: Pick<RedesignPaths, 'componentsDir'>, elementStamp: string, when: 'before' | 'after'): string {
  return join(paths.componentsDir, `${elementStamp}-${when}.png`);
}
export function componentSpecPath(paths: Pick<RedesignPaths, 'specsDir'>, componentId: string): string {
  return join(paths.specsDir, `${componentId}.json`);
}
export function componentPreviewHtmlPath(paths: Pick<RedesignPaths, 'previewsDir'>, componentId: string): string {
  return join(paths.previewsDir, `${componentId}.html`);
}
export function componentPreviewPngPath(paths: Pick<RedesignPaths, 'previewsDir'>, componentId: string, variantLabel: string): string {
  return join(paths.previewsDir, `${componentId}-${variantLabel}.png`);
}
/** Where `ClaudeSessionLlmClient` writes a pending judgment bundle for the Session Agent to read (`judgment show`). */
export function judgmentBundlePath(paths: Pick<RedesignPaths, 'judgmentsDir'>, bundleId: string): string {
  return join(paths.judgmentsDir, `${bundleId}.bundle.json`);
}
/** Where `judgment submit` writes the Session Agent's validated result, and what `ClaudeSessionLlmClient` reads back on resume. */
export function judgmentResultPath(paths: Pick<RedesignPaths, 'judgmentsDir'>, bundleId: string): string {
  return join(paths.judgmentsDir, `${bundleId}.result.json`);
}
/** The deliverable-side copy of a section fragment (`src/output/deliverable.ts`) — distinct from the internal `sectionFragmentPath`. */
export function redesignDeliverableSectionPath(paths: Pick<RedesignPaths, 'redesignDeliverableSectionsDir'>, sectionId: string): string {
  return join(paths.redesignDeliverableSectionsDir, `${sectionId}.html`);
}
/** One folder per approved component in the deliverable package, holding its copied source files and preview — `new-component/<ComponentName>/`. */
export function newComponentDeliverableDir(paths: Pick<RedesignPaths, 'newComponentDir'>, componentDirName: string): string {
  return join(paths.newComponentDir, componentDirName);
}

export function redesignPaths(projectsRoot: string, projectSlug: string, redesignRunId: string): RedesignPaths {
  const projectDir = join(projectsRoot, projectSlug);
  const redesignsDir = join(projectDir, 'redesigns');
  const runDir = join(redesignsDir, redesignRunId);
  const contextDir = join(runDir, 'context');
  const sectionsDir = join(runDir, 'sections');
  const componentsDir = join(runDir, 'components');
  const reviewDir = join(runDir, 'review');
  const libraryDir = join(runDir, 'library');
  const judgmentsDir = join(runDir, 'judgments');
  // Direct siblings of one another under runDir — no shared wrapper folder.
  const redesignDeliverableDir = join(runDir, 'redesign');
  const newComponentDir = join(runDir, 'new-component');
  return {
    projectDir,
    redesignsDir,
    runDir,

    previewAppDir: join(runDir, 'preview-app'),
    previewOverridesDir: join(runDir, 'preview-overrides'),
    previewDir: join(runDir, 'preview'),
    previewGenerationJson: join(runDir, 'preview', 'generation.json'),
    previewVerificationJson: join(runDir, 'preview', 'verification.json'),
    fidelityReportJson: join(runDir, 'preview', 'fidelity.json'),
    correctionLogJson: join(runDir, 'preview', 'correction-log.json'),
    previewServerJson: join(redesignDeliverableDir, 'server.json'),
    projectJson: join(projectDir, 'project.json'),
    runMetaJson: join(runDir, 'run.json'),
    sessionStateJson: join(runDir, 'session-state.json'),
    decisionsJson: join(runDir, 'decisions.json'),
    handoffMd: join(runDir, 'handoff.md'),
    traceJsonl: join(runDir, 'trace.jsonl'),

    contextDir,
    contextJson: join(contextDir, 'context.json'),
    mappingJson: join(contextDir, 'mapping.json'),
    conflictsJson: join(contextDir, 'conflicts.json'),
    captureJson: join(contextDir, 'capture.json'),
    scopeJson: join(contextDir, 'scope.json'),
    c2PicksJson: join(contextDir, 'c2-picks.json'),
    captureSnapshotJson: join(contextDir, 'capture-snapshot.json'),
    captureSnapshotHtml: join(contextDir, 'capture-snapshot.html'),
    behaviorJson: join(contextDir, 'behavior.json'),
    scrollEffectsJson: join(contextDir, 'scroll-effects.json'),
    appliedEditsJson: join(contextDir, 'applied-edits.json'),
    plannerGapsJson: join(contextDir, 'planner-gaps.json'),
    designDecisionsJson: join(contextDir, 'design-decisions.json'),
    resolvedTargetsJson: join(contextDir, 'resolved-targets.json'),
    designBaselineJson: join(contextDir, 'design-baseline.json'),
    correctionStateJson: join(contextDir, 'correction-state.json'),

    originalHtml: join(runDir, 'original.html'),
    redesignHtml: join(runDir, 'redesign.html'),
    redesignContentHtml: join(runDir, 'redesign-content.html'),
    sectionsDir,
    beforePng: join(runDir, 'before.png'),
    afterPng: join(runDir, 'after.png'),
    beforeTilesDir: join(runDir, 'before-tiles'),
    afterTilesDir: join(runDir, 'after-tiles'),
    componentsDir,
    redesignPlanJson: join(runDir, 'redesign-plan.json'),
    validationResultsJson: join(runDir, 'validation-results.json'),
    exportValidationJson: join(runDir, 'export-validation.json'),
    changeListMd: join(runDir, 'change-list.md'),

    judgmentsDir,

    reviewDir,
    componentManifestJson: join(reviewDir, 'component-manifest.json'),
    componentReviewHtml: join(reviewDir, 'component-review.html'),
    componentSelectionJson: join(reviewDir, 'component-selection.json'),
    reviewIndexHtml: join(reviewDir, 'review-index.html'),

    libraryDir,
    newComponentPlanJson: join(libraryDir, 'new-component-plan-copy.json'),
    componentPlanResolvedJson: join(libraryDir, 'component-plan.resolved.json'),
    resolutionJson: join(libraryDir, 'resolution.json'),
    specsDir: join(libraryDir, 'specs'),
    buildJson: join(libraryDir, 'build.json'),
    acceptanceJson: join(libraryDir, 'acceptance.json'),
    previewsDir: join(libraryDir, 'previews'),
    inContextHtml: join(libraryDir, 'in-context', 'redesign-with-components.html'),
    packageJson: join(libraryDir, 'package.json'),
    packageValidationJson: join(libraryDir, 'package-validation.json'),
    publishJson: join(libraryDir, 'publish.json'),

    redesignDeliverableDir,
    redesignDeliverableSectionsDir: join(redesignDeliverableDir, 'sections'),
    newComponentDir,
    newComponentIndexHtml: join(newComponentDir, 'index.html'),
    newComponentInContextHtml: join(newComponentDir, 'in-context.html'),
  };
}

/** `<sourceRunId>-<runType>-<UTC yyyymmdd-hhmmss>` (§1.3) — sortable, the run type and source both readable from the folder name. */
export function redesignRunIdFor(sourceRunId: string, runType: RunType, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const safe = sourceRunId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
  return `${safe}-${runType}-${stamp}`;
}

/** Explicit, traceable linkage back to the audit run this redesign was built from (§1.2). `fixPlanJsonPath` is null for a `components`-only run, which needs no Fix Plan. */
export interface SourceRunRef {
  auditAgentRepoRoot: string;
  projectName: string;
  runId: string;
  displayName: string;
  targetUrl: string;
  runDir: string;
  dataJsonPath: string;
  dataJsonSha256: string;
  fixPlanJsonPath: string | null;
  fixPlanSha256: string | null;
  /** The upstream New Component Plan, when one exists for this run (§2.2). */
  newComponentPlanJsonPath: string | null;
  newComponentPlanSha256: string | null;
  reportHtmlPath: string | null;
  screenshotsDir: string;
}

export interface ScopeRecord {
  mode: DesignMode;
  sectionIds: string[];
  excludedSectionIds: string[];
  /** The candidate set (every content section id containing an authorized finding) this scope was resolved from — re-derived on `open` and compared to detect a changed candidate set (§5.2a). */
  candidateSectionIds: string[];
  resolvedAt: string;
}

export interface RedesignRunMeta {
  schemaVersion: 2;
  redesignRunId: string;
  runType: RunType;
  mode: DesignMode | null;
  createdAt: string;
  finishedAt: string | null;
  /** The aggregate run status (§7.7) — a SEPARATE axis from the page verdict, which lives in validation-results.json. */
  runOutcome: RunOutcomeState;
  sourceRun: SourceRunRef;
  iterations: number;
  fixFindingCount: number;
  componentCount: number;
  /** Per unit (one Fix finding in A, one component in B) — §7.7's aggregation input, never conflated with `runOutcome` itself. */
  unitStates: Record<string, UnitState>;
  failedAt: string | null;
  error: string | null;
}

export async function ensureRedesignDirs(paths: RedesignPaths): Promise<void> {
  await mkdir(paths.contextDir, { recursive: true });
  await mkdir(paths.beforeTilesDir, { recursive: true });
  await mkdir(paths.afterTilesDir, { recursive: true });
  await mkdir(paths.componentsDir, { recursive: true });
  await mkdir(paths.sectionsDir, { recursive: true });
  await mkdir(paths.reviewDir, { recursive: true });
  await mkdir(paths.judgmentsDir, { recursive: true });
}

export async function ensureLibraryDirs(paths: RedesignPaths): Promise<void> {
  await mkdir(paths.specsDir, { recursive: true });
  await mkdir(paths.previewsDir, { recursive: true });
  await mkdir(dirname(paths.inContextHtml), { recursive: true });
}

/** `redesign/` — Workflow A's clean deliverable (`src/output/deliverable.ts`), a sibling of `new-component/`, created whenever Workflow A's exports are ready (Selected Sections additionally uses `redesignDeliverableSectionsDir`). */
export async function ensureRedesignDeliverableDirs(paths: RedesignPaths): Promise<void> {
  await mkdir(paths.redesignDeliverableSectionsDir, { recursive: true });
}

/** `new-component/` — Workflow B's clean deliverable, a sibling of `redesign/`, created once at least one component is approved (§11.4's approved-only rule applies here too: never a rejected/pending build). */
export async function ensureNewComponentDir(paths: RedesignPaths): Promise<void> {
  await mkdir(paths.newComponentDir, { recursive: true });
}

export async function writeRedesignRunMeta(paths: Pick<RedesignPaths, 'runMetaJson'>, meta: RedesignRunMeta): Promise<void> {
  await mkdir(dirname(paths.runMetaJson), { recursive: true });
  await writeFile(paths.runMetaJson, JSON.stringify(meta, null, 2));
}

/** Null (never a throw) for a folder that has no meta yet — a crashed-before-first-write run is still listable. */
export async function readRedesignRunMeta(paths: Pick<RedesignPaths, 'runMetaJson'>): Promise<RedesignRunMeta | null> {
  try {
    return JSON.parse(await readFile(paths.runMetaJson, 'utf-8')) as RedesignRunMeta;
  } catch {
    return null;
  }
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

export async function readJsonFileOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

// ── This repo's own project association (§5.3) ────────────────────────────────────────────

export interface ProjectRecord {
  schemaVersion: 1;
  projectSlug: string;
  auditAgentRepoRoot: string;
  auditProjectName: string;
  auditProjectDir: string;
  /** Every redesign run id created for this project, newest last. */
  redesignRunIds: string[];
}

export async function readProjectRecord(paths: Pick<RedesignPaths, 'projectJson'>): Promise<ProjectRecord | null> {
  return readJsonFileOrNull<ProjectRecord>(paths.projectJson);
}

export async function upsertProjectRecord(paths: Pick<RedesignPaths, 'projectJson'>, init: { auditAgentRepoRoot: string; auditProjectName: string; auditProjectDir: string; projectSlug: string; addRedesignRunId?: string }): Promise<ProjectRecord> {
  const existing = await readProjectRecord(paths);
  const record: ProjectRecord = existing ?? {
    schemaVersion: 1,
    projectSlug: init.projectSlug,
    auditAgentRepoRoot: init.auditAgentRepoRoot,
    auditProjectName: init.auditProjectName,
    auditProjectDir: init.auditProjectDir,
    redesignRunIds: [],
  };
  if (init.addRedesignRunId && !record.redesignRunIds.includes(init.addRedesignRunId)) {
    record.redesignRunIds = [...record.redesignRunIds, init.addRedesignRunId];
  }
  await writeJsonFile(paths.projectJson, record);
  return record;
}

export interface RedesignRunListing {
  projectSlug: string;
  redesignRunId: string;
  runDir: string;
  meta: RedesignRunMeta | null;
}

/** Every redesign run under `projectsRoot`, newest folder name last within each project. */
export async function listRedesignRuns(projectsRoot: string): Promise<RedesignRunListing[]> {
  if (!existsSync(projectsRoot)) return [];
  const out: RedesignRunListing[] = [];
  for (const project of (await readdir(projectsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const redesignsDir = join(projectsRoot, project, 'redesigns');
    if (!existsSync(redesignsDir)) continue;
    for (const run of (await readdir(redesignsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      const paths = redesignPaths(projectsRoot, project, run);
      out.push({ projectSlug: project, redesignRunId: run, runDir: paths.runDir, meta: await readRedesignRunMeta(paths) });
    }
  }
  return out;
}

/** Every redesign run recorded for one audit run id, newest last — the basis for §1.4's "reuse a prior selection" and §9.2's "a named prior run" reference lookup. */
export async function listRedesignRunsForSourceRun(projectsRoot: string, sourceRunId: string): Promise<RedesignRunListing[]> {
  const all = await listRedesignRuns(projectsRoot);
  return all.filter((r) => r.meta?.sourceRun.runId === sourceRunId);
}
