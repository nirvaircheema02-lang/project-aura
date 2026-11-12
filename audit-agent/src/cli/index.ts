import { existsSync, writeFileSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../config/index.ts';
import { openDb } from '../db/index.ts';
import { loadDsRegistry } from '../ds/d2-registry/index.ts';
import { BrowserPool } from '../t-layer/browser.ts';
import { Politeness } from '../t-layer/politeness.ts';
import { auditPage, PageAuditError } from '../agents/page-graph.ts';
import { buildSiteGraph, resumeSiteAudit, startSiteAudit, type SiteAuditDeps, type SiteAuditState } from '../agents/site-graph.ts';
import { activeRunFor, getRun, heartbeat, HEARTBEAT_INTERVAL_MS, recoverStaleRuns, setRunStatus, type CheckpointName } from '../graph/state.ts';
import { gateOutcome } from '../graph/gates.ts';
import { describeRenderingEngine } from '../graph/run-metadata.ts';
import { COVERAGE_INCOMPLETE_EXIT_CODE, coverageGateReport, coverageProgressLine } from './coverage-gate.ts';
import type { PageResult } from '../skills/s0-result-contract.ts';
import { baselineRunProblem } from '../skills/s7-audit-state-history.ts';
import { buildAuditData, writeAuditData, type AuditData } from '../agents/c2-json-writer/index.ts';
import type { RenderingPolicy } from '../t-layer/browser.ts';
import { writeHtmlReport } from '../agents/c1-html-reporter/index.ts';
import { buildPublishPlan } from '../figma/publish-plan.ts';
import { FIGMA_CONTRACT_VERSION } from '../figma/prompt-contract.ts';
import { buildPageCompositePlan, findPageTiles, type TileCompositePlan } from '../figma/page-composite-plan.ts';
import { buildFigmaOperationPlan } from '../figma/publish-ops.ts';
import { ensureRunDirs, findRunById, findRunsByDisplayName, loadOrCreateProject, projectNameFor, readFixPlan, readRunMeta, resolveRunName, runPaths, safeFileName, writeFixPlan, writeRunMeta, type ProjectFile, type RunPaths } from '../output/run-store.ts';
import { ensureDashboardRunning } from '../dashboard/lifecycle.ts';
import { createAiProvider, DisabledLlmClient, resolveAiMode, type AiProvider } from '../llm/provider.ts';
import { resolveResumeProvider } from './resume-provider.ts';
import { initTracing, spansForRun } from '../tracing/index.ts';
import { escalateTimedOutGates, pendingGates } from '../graph/gate-timeout.ts';
import { decideCheckpoint } from '../graph/state.ts';
import { countByDecision, mergeFixPlans, parseFixPlan, partitionByKnownFindings, type FixPlan } from '../output/fix-plan.ts';

/**
 * CLI entry points. ARCHITECTURE.md §0: `mode` is explicit and is the sole
 * routing source of truth — it is fixed by WHICH COMMAND you run and is never
 * inferred from the URL's shape.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
/**
 * Where runs are stored (the database and projects/). Defaults to the repo; the
 * override exists so an end-to-end test can run the real CLI without writing a
 * test run into the real audit history.
 */
const DATA_ROOT = process.env.AUDIT_AGENT_DATA_DIR ?? REPO_ROOT;

const program = new Command();
program.name('audit-agent').description('Ken Research AI Design System Audit Agent');

program
  .command('audit-page')
  .argument('<url>', 'exact page URL to audit')
  .option('--run-name <name>', 'human-readable run name — preserved verbatim as the display name (Figma file name, friendly report filenames); a filesystem-safe run id is auto-derived from it unless --run-id overrides')
  .option('--run-id <id>', 'explicit run id (folder/slug only — overrides the id auto-derived from --run-name, never affects the display name)')
  .option('--baseline-run <runId>', 're-audit baseline: diff against this COMPLETED run of the same page instead of the page\'s most recent other run (default behaviour is unchanged without it)')
  .option('--no-baseline', 're-audit baseline: compare against NO earlier run — for a page\'s first canonical audit (default behaviour is unchanged without it; mutually exclusive with --baseline-run)')
  .option('--no-dashboard', 'do not start or reuse the local dashboard')
  .description('Audit ONE page (mode: single-page — A1–A4 are never invoked)')
  .action(async (url: string, options: { runName?: string; runId?: string; baselineRun?: string; baseline: boolean; dashboard: boolean }) => {
    if (options.baseline === false && options.baselineRun) {
      console.error('--no-baseline and --baseline-run are mutually exclusive.');
      process.exitCode = 1;
      return;
    }
    const config = loadConfig();
    // Decision Log #31: no-api unless AI_MODE / aiMode explicitly asks for the model path.
    const provider = providerOrExit(config);
    if (!provider) return;
    // Run naming (locked contract): the display name is preserved verbatim wherever a human
    // reads it (Figma file name, friendly report filenames, the confirm block below) — it is
    // NEVER replaced by its own slug. The slug (runId) is only for the folder/DB/Figma-node
    // safety this display name itself isn't safe for. See src/output/run-store.ts.
    const { displayName, runId: derivedRunId } = resolveRunName(url, options.runName);
    const runId = options.runId ?? derivedRunId;
    const projectsRoot = join(DATA_ROOT, 'projects');
    const paths = runPaths(projectsRoot, projectNameFor(url), runId);

    const db = openDb(join(DATA_ROOT, 'audit-agent.db'));
    // Refuse BEFORE touching the run directory: reusing an id would overwrite a finished
    // run's data.json and reports with this run's report while the DB still describes the old one.
    const existing = getRun(db, runId);
    if (existing) {
      console.error(`Run ${runId} already exists (${existing.status}) — choose another --run-id.`);
      process.exitCode = 1;
      db.close();
      return;
    }
    // A chosen baseline is validated BEFORE the run directory is touched: a bad one must stop here,
    // not after this run's folder (possibly a re-run in place) has been rewritten with a failure report.
    if (options.baselineRun) {
      const baseline = getRun(db, options.baselineRun);
      const problem =
        options.baselineRun === runId
          ? 'a run cannot be its own baseline'
          : baselineRunProblem(db, options.baselineRun) ?? (baseline && projectNameFor(baseline.url) !== projectNameFor(url) ? `baseline run ${options.baselineRun} belongs to another project (${projectNameFor(baseline.url)})` : null);
      if (problem) {
        console.error(`Invalid --baseline-run: ${problem}.`);
        process.exitCode = 1;
        db.close();
        return;
      }
    }
    initTracing(db); // §2.6 — every node attempt becomes a span in this run's database
    reportRecoveredRuns(db);
    const active = activeRunFor(db, url, 'single-page');
    if (active) {
      console.error(`An audit of ${url} is already RUNNING (${active}). If none is actually running, clear it with:  ${cmd(`run-fail ${active}`)}`);
      process.exitCode = 1;
      db.close();
      return;
    }
    await ensureRunDirs(paths);
    const project = await loadOrCreateProject(paths, { targetUrl: url, mode: 'single-page', figmaTeamPlanKey: config.figmaTeamPlanKey });
    await writeRunMeta(paths, { runId, displayName, targetUrl: url, mode: 'single-page', createdAt: new Date().toISOString() });

    // Confirm before running (printed, never a manual approval gate) — resolved project
    // folder, run display name, run id, and exact run output folder, exactly as requested.
    console.log(`Project folder: ${paths.projectDir}`);
    console.log(`Run name:       ${displayName}`);
    console.log(`Run ID:         ${runId}`);
    console.log(`Run folder:     ${paths.runDir}`);

    const startedAt = new Date().toISOString();
    let rendering: RenderingPolicy | null = null;
    const failureReport = (reason: string): AuditData =>
      buildAuditData({ runId, auditId: `audit-${runId}`, mode: 'single-page', startedAt, targetUrl: url, pages: [], failedPages: [{ url, reason }], renderingPolicy: rendering, aiMode: provider.mode });

    const pool = new BrowserPool({
      channel: config.browserChannel,
      userAgentProduct: config.politeness.userAgentProduct,
      contactEmail: config.politeness.contactEmail,
    });
    const guard = guardRun(db, runId, pool, (signal) => writeFileSync(paths.dataJson, JSON.stringify(failureReport(`interrupted (${signal})`), null, 2)));

    let result: PageResult | null = null;
    let failure: { nodeId: string; message: string } | null = null;
    try {
      // Setup failures (Design System unreadable, browser won't launch) are failures OF THIS
      // RUN too — they belong in its report, not in an uncaught stack trace.
      const registry = await loadDsRegistry(config.designSystemPath);
      await pool.start();
      rendering = pool.renderingPolicy();
      console.log(`Run ${runId} · single-page · ${url}`);
      console.log(`Engine ${describeRenderingEngine(rendering)} · AI mode ${provider.description} · Design System ${registry.version.dsRegistryVersion.slice(0, 12)}`);
      result = await auditPage(
        url,
        {
          db,
          registry,
          aiMode: provider.mode,
          llm: provider.llm,
          config,
          pool,
          politeness: new Politeness(config.politeness.minNavigationIntervalMs),
          evidenceRoot: paths.screenshotsDir,
        },
        { runId, baselineRunId: options.baselineRun, noBaseline: options.baseline === false, onCoverageProgress: (progress) => console.log(coverageProgressLine(progress)) },
      );
    } catch (err) {
      // A failed run still produces a report that SAYS it failed — never a missing
      // data.json that the dashboard would show as "no data yet".
      const message = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
      failure = { nodeId: err instanceof PageAuditError ? err.nodeId : 'capture', message };
      if (!guard.interrupted && getRun(db, runId)?.status === 'RUNNING') setRunStatus(db, runId, 'FAILED');
    } finally {
      guard.release();
      await pool.stop().catch(() => {});
    }
    // An interrupt already wrote the report that says so and is exiting 130 — the browser
    // closing under the audit is its consequence, not a second failure to report over it.
    if (guard.interrupted) return;

    try {
      const data = result
        ? buildAuditData({ runId, auditId: `audit-${runId}`, mode: 'single-page', startedAt, targetUrl: url, pages: [result], failedPages: [], renderingPolicy: rendering, aiMode: provider.mode })
        : failureReport(`failed at ${failure?.nodeId ?? 'capture'}: ${failure?.message ?? 'unknown error'}`);
      // Write canonical data first; Figma plans and standalone HTML read the same result.
      // Excel export is disabled by project preference.
      await writeAuditData(paths.dataJson, data);
      const figmaResult = await writeFigmaArtifacts(paths, data, project, displayName);
      await writeHtmlReport(paths, projectNameFor(url), data);
      const friendlyNames = await writeFriendlyNamedCopies(paths, displayName);

      const s = data.websiteSummary;
      if (failure) {
        console.error(`\nRun ${runId} FAILED at ${failure.nodeId}: ${failure.message}`);
        console.error(`Inspect the execution trace with:  ${cmd(`trace ${runId}`)}`);
        process.exitCode = 1;
      } else {
        console.log(
          `\n${s.componentsChecked} components checked · compliance ${s.compliancePercent ?? 'n/a'}% ` +
            `(${s.match} match / ${s.deviation} deviation / ${s.incorrect} incorrect · ${s.dsCandidate} DS candidate · ` +
            `${s.needsReview} needs review · ${s.unverified} unverified) · ${s.escalationsQueued} awaiting review`,
        );
      }
      printCoverageGate(data, Boolean(failure));
      console.log(modelCallLine(provider));
      console.log(figmaStatusLine(paths.figmaOpsJson, figmaResult));
      console.log(`HTML:      ${paths.reportHtml}  (standalone — open directly, no server needed)`);
      console.log(`           also saved as: ${friendlyNames.html}`);
      console.log(`Data:      ${paths.dataJson}  (canonical)`);

      if (options.dashboard) reportDashboard(await ensureDashboardRunning({ port: config.dashboardPort, projectsRoot, repoRoot: REPO_ROOT }), `/projects/${projectNameFor(url)}/runs/${runId}`);
    } finally {
      db.close();
    }
  });

/**
 * The run's AI provider, or null after printing why it cannot start. Only an
 * explicit AI_MODE=anthropic-api can require a credential; the default no-api
 * mode never looks for one (Decision Log #31).
 */
function providerOrExit(config: ReturnType<typeof loadConfig>): AiProvider | null {
  try {
    return createAiProvider(resolveAiMode(process.env, config.aiMode), config.anthropicModel);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return null;
  }
}

/**
 * P1 — Figma. Writes all three Figma artifacts for a run (plan, per-page composite geometry,
 * and the ordered operation list a live session replays) from data.json alone — no model call,
 * no browser, no re-audit. NONE of these three files is a completed Figma deliverable by
 * themselves; `figma-ops.json`'s ops are what still has to actually be sent to Figma by a live,
 * authenticated session (docs/FIGMA-PUBLISH-RUNBOOK.md) before this run's Figma output is done.
 * Shared by `audit-page`, `audit-site`/`resume` (via `finishSiteRun`), and the standalone
 * `figma-plan <runId>` command — one implementation, never a per-command copy that can drift.
 */
async function writeFigmaArtifacts(
  paths: { screenshotsDir: string; figmaPlanJson: string; figmaCompositePlanJson: string; figmaOpsJson: string },
  data: AuditData,
  project: Pick<ProjectFile, 'figmaFileKey' | 'figmaFileUrl' | 'figmaTeamPlanKey'>,
  displayName?: string,
): Promise<{ opsCount: number; coverageGapsCount: number; missingCompositePlanFor: string[] }> {
  const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
  writeFileSync(paths.figmaPlanJson, JSON.stringify(plan, null, 2));

  const compositePlans: Record<string, TileCompositePlan> = {};
  for (const page of data.pageSummary) {
    const tiles = await findPageTiles(paths.screenshotsDir, page.pageId);
    const composite = await buildPageCompositePlan(tiles);
    if (composite) compositePlans[page.pageId] = composite;
  }
  await writeFile(paths.figmaCompositePlanJson, JSON.stringify(compositePlans, null, 2));

  const opsPlan = buildFigmaOperationPlan(plan, compositePlans, project, { displayName });
  await writeFile(paths.figmaOpsJson, JSON.stringify(opsPlan, null, 2));

  return { opsCount: opsPlan.ops.length, coverageGapsCount: opsPlan.coverageGaps.length, missingCompositePlanFor: opsPlan.missingCompositePlanFor };
}

/** Write a friendly HTML copy; Excel generation and friendly Excel copies are disabled. */
async function writeFriendlyNamedCopies(paths: Pick<RunPaths, 'runDir' | 'reportHtml'>, displayName: string): Promise<{ html: string }> {
  const base = safeFileName(displayName) || 'report';
  const html = join(paths.runDir, `${base}.html`);
  if (existsSync(paths.reportHtml)) await copyFile(paths.reportHtml, html);
  return { html };
}

/** The one status line every run prints for Figma — never implies figma-plan.json/figma-ops.json are a finished publish. */
function figmaStatusLine(figmaOpsJson: string, result: { opsCount: number; coverageGapsCount: number; missingCompositePlanFor: string[] }): string {
  const warnings: string[] = [];
  if (result.coverageGapsCount > 0) warnings.push(`${result.coverageGapsCount} marker(s) in an uncaptured header band — see coverageGaps in figma-ops.json`);
  if (result.missingCompositePlanFor.length > 0) warnings.push(`no tiles for page(s) ${result.missingCompositePlanFor.join(', ')} — their page-audit frame was skipped`);
  return (
    `Figma:     NOT YET PUBLISHED — ${result.opsCount} operation(s) ready in ${figmaOpsJson}${warnings.length ? ` (${warnings.join('; ')})` : ''}\n` +
    `           Next: open a Figma-MCP-authenticated Claude Code session and follow docs/FIGMA-PUBLISH-RUNBOOK.md`
  );
}

/** Proof of the no-api promise in every run's output: how many model calls were attempted. */
function modelCallLine(provider: AiProvider): string {
  return provider.llm instanceof DisabledLlmClient ? `Model API calls: ${provider.llm.attempts} (AI mode no-api)` : `AI mode: ${provider.description}`;
}

/** The exact command to type for a follow-up (`pnpm audit` is pnpm's own security audit — the script is `agent`). */
function cmd(args: string): string {
  return `pnpm run agent ${args}`;
}

function reportDashboard(state: Awaited<ReturnType<typeof ensureDashboardRunning>>, path: string): void {
  if (state.status === 'reused' || state.status === 'started' || state.status === 'restarted') {
    console.log(`Dashboard: ${state.url}${path} (${state.status}${state.status === 'restarted' ? ` — ${state.detail}` : ''})`);
  } else {
    console.warn(`Dashboard unavailable (${state.status}): ${state.detail}`);
  }
}

/** Tells the operator about runs recovered from a dead process, so a FAILED status is never a mystery. */
function reportRecoveredRuns(db: ReturnType<typeof openDb>): void {
  for (const r of recoverStaleRuns(db)) {
    console.warn(`Recovered interrupted run ${r.runId} (${r.url}): its process ${r.ownerPid ?? '(unknown)'} is gone — marked FAILED.`);
  }
}

/**
 * Guards a run for as long as this process owns it: a heartbeat so a crashed
 * process's run is recoverable (Decision Log #27), and Ctrl-C / SIGTERM
 * handling so an interrupted run never stays RUNNING (the §2.5 guard would
 * refuse every later audit of that URL). better-sqlite3 is synchronous, so the
 * status write is safe inside the handler. A paused run (AWAITING_*) is left
 * alone — pausing is not failing.
 *
 * The handler does NOT close the database: the audit's own promise chain is
 * still unwinding when the browser is torn down (a catch block, a last span, a
 * fan-out branch) and would throw on a closed handle — turning a clean exit 130
 * into a stack trace and exit 1. Every write is already committed; process.exit
 * releases the handle.
 */
function guardRun(
  db: ReturnType<typeof openDb>,
  runId: string,
  pool: BrowserPool,
  onInterrupt?: (signal: NodeJS.Signals) => void,
): { release(): void; readonly interrupted: boolean } {
  let interrupted = false;
  const beat = setInterval(() => {
    if (interrupted || !db.open) return;
    try {
      heartbeat(db, runId);
    } catch {
      /* a missed beat only delays recovery — never a reason to crash the audit */
    }
  }, HEARTBEAT_INTERVAL_MS);
  beat.unref();
  const handler = (signal: NodeJS.Signals) => {
    interrupted = true;
    clearInterval(beat);
    const code = signal === 'SIGINT' ? 130 : 143;
    process.exitCode = code;
    try {
      if (getRun(db, runId)?.status === 'RUNNING') setRunStatus(db, runId, 'FAILED');
      onInterrupt?.(signal); // e.g. a report that says the run was interrupted, so the dashboard never shows "no data yet"
    } catch {
      /* best effort — the stale-run recovery on the next start covers anything missed */
    }
    console.error(`\nInterrupted (${signal}) — run ${runId} marked FAILED.`);
    void pool.stop().finally(() => process.exit(code));
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return {
    release() {
      clearInterval(beat);
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    },
    get interrupted() {
      return interrupted;
    },
  };
}

/**
 * Everything a full-site run needs, assembled once and reused by `audit-site` and `resume`.
 * `displayName` is written to run.json ONLY when given (i.e. only by `audit-site` at creation
 * time) — `resume` reconstructs the same deps later without a fresh name and must not overwrite
 * the one already on disk with a fallback.
 */
async function siteDeps(runId: string, url: string, provider: AiProvider, config: ReturnType<typeof loadConfig>, displayName?: string) {
  const projectsRoot = join(DATA_ROOT, 'projects');
  const paths = runPaths(projectsRoot, projectNameFor(url), runId);
  await ensureRunDirs(paths);
  const project = await loadOrCreateProject(paths, { targetUrl: url, mode: 'full-site', figmaTeamPlanKey: config.figmaTeamPlanKey });
  if (displayName) await writeRunMeta(paths, { runId, displayName, targetUrl: url, mode: 'full-site', createdAt: new Date().toISOString() });

  const db = openDb(join(DATA_ROOT, 'audit-agent.db'));
  initTracing(db);
  reportRecoveredRuns(db);
  const registry = await loadDsRegistry(config.designSystemPath);
  const pool = new BrowserPool({
    channel: config.browserChannel,
    userAgentProduct: config.politeness.userAgentProduct,
    contactEmail: config.politeness.contactEmail,
  });
  await pool.start();

  const deps: SiteAuditDeps = {
    db,
    registry,
    aiMode: provider.mode,
    llm: provider.llm,
    config,
    pool,
    politeness: new Politeness(config.politeness.minNavigationIntervalMs),
    evidenceRoot: paths.screenshotsDir,
  };
  return { config, deps, paths, projectsRoot, db, pool, project };
}

/**
 * B7's Coverage Gate as one CLI line — and an INCOMPLETE audit says so loudly (stderr) and exits 3: an audit with
 * anything unaccounted must never read as a clean success (`coverageGateReport`, tested without an audit).
 */
function printCoverageGate(data: AuditData, failed = false): void {
  const report = coverageGateReport(data);
  console.log(report.line);
  for (const line of report.errors) console.error(line);
  if (report.incomplete && !failed && !process.exitCode) process.exitCode = COVERAGE_INCOMPLETE_EXIT_CODE;
}

/** Writes canonical data, Figma plans and HTML for a finished site run. Excel is disabled. */
async function finishSiteRun(state: SiteAuditState, paths: ReturnType<typeof runPaths>, projectsRoot: string, url: string, runId: string, dashboardPort: number, project: ProjectFile, displayName: string) {
  if (!state.data) throw new Error('site run completed without a master result');
  await writeAuditData(paths.dataJson, state.data);
  const figmaResult = await writeFigmaArtifacts(paths, state.data, project, displayName);
  await writeHtmlReport(paths, projectNameFor(url), state.data);
  const friendlyNames = await writeFriendlyNamedCopies(paths, displayName);
  console.log(
    `\n${state.data.websiteSummary.pagesAudited} pages audited (${state.data.websiteSummary.pagesFailed} failed) · ` +
      `compliance ${state.data.websiteSummary.compliancePercent ?? 'n/a'}% · ${state.data.websiteSummary.escalationsQueued} awaiting review`,
  );
  for (const cause of state.consolidated?.rootCauses ?? []) console.log(`  root cause: ${cause.title} (${cause.issueSignatures.length} issues)`);
  printCoverageGate(state.data);
  console.log(figmaStatusLine(paths.figmaOpsJson, figmaResult));
  console.log(`HTML:      ${paths.reportHtml}  (standalone — open directly, no server needed)`);
  console.log(`           also saved as: ${friendlyNames.html}`);
  console.log(`Data:      ${paths.dataJson}  (canonical)`);
  reportDashboard(await ensureDashboardRunning({ port: dashboardPort, projectsRoot, repoRoot: REPO_ROOT }), `/projects/${projectNameFor(url)}/runs/${runId}`);
}

program
  .command('audit-site')
  .argument('<url>', 'site root URL')
  .option('--run-name <name>', 'human-readable run name — preserved verbatim as the display name (Figma file name, friendly report filenames); a filesystem-safe run id is auto-derived from it unless --run-id overrides')
  .option('--run-id <id>', 'explicit run id (folder/slug only — overrides the id auto-derived from --run-name, never affects the display name)')
  .option('--max-pages <n>', 'discovery limit', (v: string) => Number(v), 50)
  .description('Audit a whole site (mode: full-site). Pauses at the Scope Gate before auditing anything.')
  .action(async (url: string, options: { runName?: string; runId?: string; maxPages: number }) => {
    const config = loadConfig();
    const provider = providerOrExit(config);
    if (!provider) return;
    const { displayName, runId: derivedRunId } = resolveRunName(url, options.runName);
    const runId = options.runId ?? derivedRunId;
    if (options.runId) {
      const probe = openDb(join(DATA_ROOT, 'audit-agent.db'));
      const existing = getRun(probe, runId);
      probe.close();
      if (existing) {
        console.error(`Run ${runId} already exists (${existing.status}) — choose another --run-id.`);
        process.exitCode = 1;
        return;
      }
    }
    const projectsRootPreview = join(DATA_ROOT, 'projects');
    console.log(`Project folder: ${join(projectsRootPreview, projectNameFor(url))}`);
    console.log(`Run name:       ${displayName}`);
    console.log(`Run ID:         ${runId}`);
    console.log(`Run folder:     ${join(projectsRootPreview, projectNameFor(url), 'runs', runId)}`);
    console.log(`Run ${runId} · full-site · ${url} · AI mode ${provider.description}`);
    const { deps, paths, projectsRoot, db, pool } = await siteDeps(runId, url, provider, config, displayName);
    deps.maxPages = options.maxPages;
    const guard = guardRun(db, runId, pool);
    try {
      const handle = await startSiteAudit(url, deps, runId);
      if (handle.outcome.kind === 'paused') {
        const run = getRun(db, runId)!;
        const scope = JSON.parse(run.scope_json ?? '{}') as { classified?: unknown[]; families?: Array<{ name: string; pages: number }> };
        console.log(`\nScope Gate — nothing has been audited yet.`);
        console.log(`  pages discovered: ${scope.classified?.length ?? 0}`);
        for (const family of scope.families ?? []) console.log(`    ${family.name}: ${family.pages} page(s)`);
        console.log(`\nApprove with:  ${cmd(`gate approve ${runId} scope_confirmation`)}`);
        console.log(`Then run:      ${cmd(`resume ${runId}`)}`);
      } else if (handle.outcome.kind === 'failed') {
        console.error(`Run ${runId} FAILED at ${handle.outcome.at}: ${handle.outcome.error instanceof Error ? handle.outcome.error.message : handle.outcome.error}`);
        console.error(`Inspect the execution trace with:  ${cmd(`trace ${runId}`)}`);
        process.exitCode = 1;
      }
    } finally {
      guard.release();
      await pool.stop().catch(() => {});
      // After an interrupt, fan-out branches may still be unwinding and writing their last
      // spans; the handler is exiting the process, which releases the handle.
      if (!guard.interrupted) db.close();
    }
    void paths;
    void projectsRoot;
  });

program
  .command('resume')
  .argument('<runId>')
  .description('Resume a run paused at a gate (the gate must have been decided first)')
  .action(async (runId: string) => {
    const probe = openDb(join(DATA_ROOT, 'audit-agent.db'));
    const run = getRun(probe, runId);
    probe.close();
    if (!run) {
      console.error(`No run ${runId}.`);
      process.exitCode = 1;
      return;
    }
    // The node to re-enter at is implied by the run's own status — no extra state needed.
    const atNode = run.status === 'AWAITING_SCOPE_CONFIRMATION' ? 'A2' : run.status === 'AWAITING_PUBLISH_CONFIRMATION' ? 'A4' : null;
    if (!atNode) {
      console.error(`Run ${runId} is ${run.status}, which is not a resumable pause.`);
      process.exitCode = 1;
      return;
    }
    // Nothing to resume until a human has decided — checked before any browser starts,
    // and without touching the run (it stays paused, not RUNNING).
    const gateName: CheckpointName = atNode === 'A2' ? 'scope_confirmation' : 'publish_confirmation';
    const decisionDb = openDb(join(DATA_ROOT, 'audit-agent.db'));
    const decided = gateOutcome(decisionDb, runId, gateName);
    decisionDb.close();
    if (decided !== 'APPROVED' && decided !== 'REJECTED') {
      console.error(`The ${gateName} gate for ${runId} has not been decided yet. Approve with:  ${cmd(`gate approve ${runId} ${gateName}`)}`);
      process.exitCode = 1;
      return;
    }

    const config = loadConfig();
    const resolved = resolveResumeProvider(runId, run, atNode, process.env, config);
    if (!resolved.ok) {
      console.error(resolved.message);
      process.exitCode = 1;
      return;
    }
    const provider = resolved.provider;
    const { deps, paths, projectsRoot, db, pool, project } = await siteDeps(runId, run.url, provider, config);
    const guard = guardRun(db, runId, pool);
    try {
      // Rebuild the same graph deterministically from deps — a resumed run does not
      // need the original process's objects, only its persisted state.
      const collector = { pages: [], failed: [] };
      const graph = buildSiteGraph(deps, runId, collector, new Date(run.started_at).toISOString());
      const outcome = await resumeSiteAudit(deps, runId, atNode, { graph, collector, outcome: { kind: 'paused', status: run.status, at: atNode } });
      if (outcome.kind === 'paused') {
        console.log(`Paused again at the ${outcome.status === 'AWAITING_PUBLISH_CONFIRMATION' ? 'Publish' : 'Scope'} Gate.`);
        console.log(`Approve with:  ${cmd(`gate approve ${runId} ${outcome.status === 'AWAITING_PUBLISH_CONFIRMATION' ? 'publish_confirmation' : 'scope_confirmation'}`)}`);
        console.log(`Then run:      ${cmd(`resume ${runId}`)}`);
      } else if (outcome.kind === 'complete') {
        const meta = await readRunMeta(paths, runId); // the display name given at `audit-site` creation time — resume never gets a fresh one
        await finishSiteRun(outcome.result as SiteAuditState, paths, projectsRoot, run.url, runId, config.dashboardPort, project, meta.displayName);
      } else if (outcome.kind === 'aborted') {
        console.log(`Run ${runId} aborted: a gate was rejected.`);
      } else {
        console.error(`Run ${runId} FAILED at ${outcome.at}. Inspect the execution trace with:  ${cmd(`trace ${runId}`)}`);
        process.exitCode = 1;
      }
    } finally {
      guard.release();
      await pool.stop().catch(() => {});
      // After an interrupt, fan-out branches may still be unwinding and writing their last
      // spans; the handler is exiting the process, which releases the handle.
      if (!guard.interrupted) db.close();
    }
  });

program
  .command('run-fail')
  .argument('<runId>')
  .description('Mark a RUNNING run as FAILED by hand — the escape hatch if a run was orphaned in a way recovery cannot see')
  .action((runId: string) => {
    const db = openDb(join(DATA_ROOT, 'audit-agent.db'));
    const run = getRun(db, runId);
    if (!run) console.error(`No run ${runId}.`);
    else if (run.status !== 'RUNNING') console.error(`Run ${runId} is ${run.status}, not RUNNING — nothing to do.`);
    else {
      setRunStatus(db, runId, 'FAILED');
      console.log(`Run ${runId} marked FAILED.`);
    }
    if (!run || run.status !== 'RUNNING') process.exitCode = 1;
    db.close();
  });

program
  .command('gates')
  .description('List gates awaiting a human decision, escalating any that have timed out to a fallback reviewer')
  .action(() => {
    const db = openDb(join(DATA_ROOT, 'audit-agent.db'));
    const timedOut = escalateTimedOutGates(db);
    const pending = pendingGates(db);
    if (pending.length === 0) console.log('No gates awaiting a decision.');
    for (const gate of pending) {
      console.log(`${gate.runId} · ${gate.name}${gate.timedOut ? ' · TIMED OUT — escalated to a fallback reviewer (still pending; never auto-decided)' : ''}`);
    }
    if (timedOut.some((g) => g.escalated)) console.log(`\n${timedOut.filter((g) => g.escalated).length} gate(s) newly escalated.`);
    db.close();
  });

program
  .command('gate')
  .argument('<decision>', 'approve | reject')
  .argument('<runId>')
  .argument('<gate>', 'scope_confirmation | publish_confirmation | failure_threshold')
  .option('--by <who>', 'who decided', process.env.USER ?? 'unknown')
  .description('Record a gate decision for a paused run')
  .action((decision: string, runId: string, gate: string, options: { by: string }) => {
    if (decision !== 'approve' && decision !== 'reject') {
      console.error('decision must be "approve" or "reject"');
      process.exitCode = 1;
      return;
    }
    const names: CheckpointName[] = ['scope_confirmation', 'publish_confirmation', 'failure_threshold'];
    if (!names.includes(gate as CheckpointName)) {
      console.error(`gate must be one of: ${names.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const db = openDb(join(DATA_ROOT, 'audit-agent.db'));
    const recorded = decideCheckpoint(db, runId, gate as CheckpointName, decision === 'approve' ? 'APPROVED' : 'REJECTED', options.by);
    if (recorded) console.log(`${gate} for ${runId}: ${decision === 'approve' ? 'APPROVED' : 'REJECTED'} by ${options.by}`);
    else {
      // Unknown run, a gate that was never opened, or one already decided — nothing changed.
      console.error(`No pending ${gate} gate for ${runId} — nothing was recorded. See pending gates with:  ${cmd('gates')}`);
      process.exitCode = 1;
    }
    db.close();
  });

program
  .command('trace')
  .argument('<runId>')
  .description('Show the execution trace for a run (§2.6 spans)')
  .action((runId: string) => {
    const db = openDb(join(DATA_ROOT, 'audit-agent.db'));
    const spans = spansForRun(db, runId);
    if (spans.length === 0) console.log(`No spans recorded for ${runId}.`);
    for (const span of spans) {
      const ms = span.ended_at === null ? '—' : `${span.ended_at - span.started_at}ms`;
      console.log(`${span.node_id.padEnd(10)} attempt ${span.attempt_number} ${span.status.padEnd(5)} ${ms.padStart(8)}${span.error_detail ? ` · ${span.error_detail}` : ''}`);
    }
    db.close();
  });

program
  .command('figma-plan')
  .argument('<runId>', 'an existing run id')
  .description('Regenerate figma-plan.json, figma-composite-plan.json and figma-ops.json from an existing run\'s data.json — no re-audit, no browser, no model call')
  .action(async (runId: string) => {
    const config = loadConfig();
    const db = openDb(join(DATA_ROOT, 'audit-agent.db'));
    const run = getRun(db, runId);
    db.close();
    if (!run) {
      console.error(`No run ${runId}.`);
      process.exitCode = 1;
      return;
    }
    const projectsRoot = join(DATA_ROOT, 'projects');
    const paths = runPaths(projectsRoot, projectNameFor(run.url), runId);
    if (!existsSync(paths.dataJson)) {
      console.error(`No data.json for run ${runId} at ${paths.dataJson} — this run never finished (or predates C2).`);
      process.exitCode = 1;
      return;
    }
    const project = await loadOrCreateProject(paths, { targetUrl: run.url, mode: run.run_type, figmaTeamPlanKey: config.figmaTeamPlanKey });
    const data = JSON.parse(await readFile(paths.dataJson, 'utf-8')) as AuditData;
    const meta = await readRunMeta(paths, runId); // falls back to runId itself for runs that predate run.json
    const result = await writeFigmaArtifacts(paths, data, project, meta.displayName);
    console.log(`Run ${runId} · ${run.url}`);
    console.log(`Run name:  ${meta.displayName}`);
    console.log(figmaStatusLine(paths.figmaOpsJson, result));
    console.log(`Plan:      ${paths.figmaPlanJson}`);
    console.log(`Composite: ${paths.figmaCompositePlanJson}`);
    console.log(`Ops:       ${paths.figmaOpsJson}`);
  });

program
  .command('dashboard')
  .description('Start or reuse the local audit dashboard (one server for every project and run)')
  .action(async () => {
    const config = loadConfig();
    const projectsRoot = join(DATA_ROOT, 'projects');
    const state = await ensureDashboardRunning({ port: config.dashboardPort, projectsRoot, repoRoot: REPO_ROOT });
    console.log(`${state.status}: ${state.url}`);
    if (state.status === 'failed' || state.status === 'port-taken-by-other') process.exitCode = 1;
  });

/**
 * `find-run` — resolve ONE existing run from whichever identifier a reviewer actually has (its
 * Run ID or its human-readable Run Name), printing one JSON line on an unambiguous match. It
 * never audits, never writes, never guesses between two candidates: ambiguity and not-found are
 * distinct non-zero exits so a caller can tell "pick one of these" from "no such run".
 */
program
  .command('find-run')
  .description('Resolve an existing run by --run-id or --run-name and print its location as one JSON line — read-only, never re-audits')
  .option('--run-id <id>', 'the run id (folder slug)')
  .option('--run-name <name>', 'the human-readable run name, exactly as given at audit time (case-insensitive, never fuzzy)')
  .action(async (opts: { runId?: string; runName?: string }) => {
    const projectsRoot = join(DATA_ROOT, 'projects');
    if (!opts.runId && !opts.runName) {
      console.error('Give --run-id or --run-name.');
      process.exitCode = 1;
      return;
    }
    if (opts.runId && opts.runName) {
      console.error('Give --run-id or --run-name, not both.');
      process.exitCode = 1;
      return;
    }
    const matches = opts.runId
      ? await (async () => {
          const one = await findRunById(projectsRoot, opts.runId!);
          return one ? [one] : [];
        })()
      : await findRunsByDisplayName(projectsRoot, opts.runName!);

    if (matches.length === 0) {
      console.error(`No run matching ${opts.runId ? `--run-id ${opts.runId}` : `--run-name "${opts.runName}"`}.`);
      process.exitCode = 1;
      return;
    }
    if (matches.length > 1) {
      // Never silently pick one — show the candidates and let the reviewer choose by exact Run ID.
      console.error(`Ambiguous: ${matches.length} runs share that name. Re-run with --run-id <id>:`);
      for (const m of matches) console.error(`  ${m.runId}  (${m.projectName})  "${m.displayName}"`);
      process.exitCode = 2;
      return;
    }
    const m = matches[0]!;
    const paths = runPaths(projectsRoot, m.projectName, m.runId);
    const meta = await readRunMeta(paths, m.runId);
    // One JSON line, exit 0 — the pinned machine-readable contract for downstream callers.
    console.log(
      JSON.stringify({
        projectName: m.projectName,
        runId: m.runId,
        displayName: m.displayName,
        targetUrl: 'targetUrl' in meta ? meta.targetUrl : null,
        runDir: m.runDir,
      }),
    );
  });

/**
 * `fix-plan-import <runId> [file]` — validate a reviewer's exported decisions and write them to
 * the run's own `fix-plan.json`. Modeled on `figma-plan <runId>`: load this run's own data.json,
 * derive a file, no re-audit, no browser, no model call.
 *
 * `data.json` is never opened for writing here — the decisions live entirely in the sidecar, so
 * "the audit truth was not edited" is structural, not a convention this command has to honour.
 */
program
  .command('fix-plan-import')
  .argument('<runId>', 'an existing run id')
  .argument('[file]', "path to the exported fix-plan.json (defaults to the run folder's own fix-plan.json)")
  .description("Validate and import a reviewer's fix-plan.json into an existing run — merges by default, never touches data.json")
  .option('--replace', 'wholesale-replace fix-plan.json instead of merging (drops entries not in [file])')
  .option('--dry-run', 'validate and report only, write nothing')
  .option('--ignore-run-id-mismatch', "import even when the file's runId is for a different run")
  .action(async (runId: string, file: string | undefined, opts: { replace?: boolean; dryRun?: boolean; ignoreRunIdMismatch?: boolean }) => {
    const db = openDb(join(DATA_ROOT, 'audit-agent.db'));
    const run = getRun(db, runId);
    db.close();
    if (!run) {
      console.error(`No run ${runId}.`);
      process.exitCode = 1;
      return;
    }
    const projectsRoot = join(DATA_ROOT, 'projects');
    const paths = runPaths(projectsRoot, projectNameFor(run.url), runId);
    if (!existsSync(paths.dataJson)) {
      console.error(`No data.json for run ${runId} at ${paths.dataJson} — this run never finished (or predates C2).`);
      process.exitCode = 1;
      return;
    }

    // One existence check, once, at invocation — never a watcher, never a poll loop.
    const source = file ?? paths.fixPlanJson;
    if (!existsSync(source)) {
      console.error(
        file
          ? `No such file: ${source}`
          : `No file argument given and no fix-plan.json found in the run folder (${paths.fixPlanJson}) — provide a path, or move your export there.`,
      );
      process.exitCode = 1;
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(source, 'utf-8'));
    } catch (err) {
      console.error(`Could not read/parse ${source}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    // Being at the canonical path is never itself sufficient to be trusted — a file the reviewer
    // already dropped into the right folder still goes through the full schema check.
    const parsed = parseFixPlan(raw);
    if (!parsed.ok) {
      console.error(`Invalid fix plan at ${source}:\n${parsed.issues}`);
      process.exitCode = 1;
      return;
    }
    const incoming = parsed.plan;

    if (incoming.runId !== runId && !opts.ignoreRunIdMismatch) {
      console.error(`Refusing: the file's runId is "${incoming.runId}" but this run is "${runId}". Re-export from the right run, or pass --ignore-run-id-mismatch.`);
      process.exitCode = 1;
      return;
    }

    const data = JSON.parse(await readFile(paths.dataJson, 'utf-8')) as AuditData;
    const knownIds = new Set(data.findings.map((f) => f.identity.findingId));
    const { known, unknown } = partitionByKnownFindings(incoming.entries, knownIds);
    if (incoming.entries.length > 0 && known.length === 0) {
      console.error(`Refusing: none of the ${incoming.entries.length} findingId(s) in ${source} exist in this run's data.json — this looks like an import aimed at a different run.`);
      process.exitCode = 1;
      return;
    }

    const existing = await readFixPlan(paths, runId);
    const accepted: FixPlan = { schemaVersion: 1, runId, updatedAt: new Date().toISOString(), entries: known };
    const result = opts.replace ? accepted : mergeFixPlans({ ...existing, runId, updatedAt: accepted.updatedAt }, accepted);

    const counts = countByDecision(result);
    console.log(`Run ${runId} · ${run.url}`);
    console.log(`Source:    ${source}`);
    console.log(`Mode:      ${opts.replace ? 'replace (drops entries not in the file)' : 'merge (existing entries preserved)'}${opts.dryRun ? ' · DRY RUN' : ''}`);
    console.log(`Accepted:  ${known.length} of ${incoming.entries.length} entr(ies)`);
    if (unknown.length > 0) {
      console.log(`Dropped:   ${unknown.length} entr(ies) whose findingId is not in this run's data.json:`);
      for (const e of unknown.slice(0, 10)) console.log(`             ${e.findingId}`);
      if (unknown.length > 10) console.log(`             … and ${unknown.length - 10} more`);
    }
    console.log(`Decisions: ${counts.fix} fix · ${counts.skip} skip · ${counts.keep_for_review} keep for review (${result.entries.length} total)`);

    if (opts.dryRun) {
      console.log('Dry run — nothing written.');
      console.log(`data.json untouched: ${paths.dataJson}`);
      return;
    }
    await writeFixPlan(paths, result);
    console.log(`Fix plan:  ${paths.fixPlanJson}`);
    console.log(`data.json untouched: ${paths.dataJson}`);
  });


await program.parseAsync(process.argv);
