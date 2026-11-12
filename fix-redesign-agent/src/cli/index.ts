import { ensureScrollEffects } from '../preview/scroll-effects.ts';
import { restoreCaptureSession } from '../agents/capture-snapshot.ts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { NODE_STATUS, runB1, runC2, runRV, runL1, runL2, runL2b, runL3, runL4, runL5, runR1, runR2, runR3, runR4, runR5, runR6, runR7, runR8, unimplementedNodes } from '../agents/index.ts';
import type { R1Output } from '../agents/types.ts';
import { resolveAuditRun, type AuditRunRef } from '../audit-link/index.ts';
import { loadConfig } from '../config/index.ts';
import type { GitDeps } from '../git/local-repo.ts';
import { findOtherRunDataJsonPaths } from '../manifest/cross-run.ts';
import { listRedesignRuns, readJsonFileOrNull, readRedesignRunMeta, redesignPaths, writeJsonFile, type RedesignPaths, type ScopeRecord } from '../output/redesign-store.ts';
import { readBaseline } from '../fidelity/capture.ts';
import type { CorrectionBudgetConfig } from '../fidelity/loop.ts';
import { basisHashOf, openCorrectionBudget } from '../preview/correction-state.ts';
import { readResolution } from '../resolution/store.ts';
import { RedesignPipelineError, runRedesignPipeline, loadResolvedSectionIds, type PipelineContext, type PipelineNodes, type PipelineResult } from '../pipeline.ts';
import { recordDecision } from '../session/decisions.ts';
import { resolveStartReference } from '../session/discovery.ts';
import { computeGateFingerprint } from '../session/gate-fingerprints.ts';
import { deriveSectionCandidates } from '../session/scope.ts';
import { GATES, type DesignMode, type Gate, type GateOutcome, type RunType } from '../session/types.ts';
import { createLlmClient, hasApiCredential } from '../llm/provider.ts';
import { validateJudgmentSubmission } from '../llm/claude-session-client.ts';
import { listJudgmentBundles, onlyPendingBundle, readJudgmentBundle, writeJudgmentResult } from '../judgment/store.ts';
import { Politeness } from '../t-layer/politeness.ts';
import { BrowserPool } from '../t-layer/browser.ts';
import { startStaticServer } from '../serve/static-server.ts';
import type { PickSignature } from '../mapping/reuse.ts';
import type { MappingEntry } from '../mapping/types.ts';
import type { TargetedEdit } from '../llm/schemas/r-nodes.ts';
import type { BehaviorFile } from '../preview/behavior.ts';
import { buildPreview, ensureInstalled, portForRun, previewServerAlive, readServerRecord, startPreviewServer, stopPreviewServer } from '../preview/server.ts';
import { checkG2Approval } from '../preview/g2-guard.ts';
import { cliVerificationLines, statusHeadline, statusOf } from '../preview/status.ts';
import type { PreviewVerification } from '../preview/types.ts';
import { readSpans } from '../tracing/index.ts';

/**
 * CLI entry points — ARCHITECTURE.md §5.1's two-line normal input, plus every reference form
 * it is a variant of, all resolved through `session/discovery.ts`'s S0.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DATA_ROOT = process.env.FIX_REDESIGN_AGENT_DATA_DIR ?? REPO_ROOT;
const PROJECTS_ROOT = join(DATA_ROOT, 'projects');

const program = new Command();
program.name('fix-redesign-agent').description('Redesign Agent — applies an audit run\'s authorized changes to the live page and, optionally, builds the resulting Design System components');

function refFrom(options: { runId?: string; runName?: string }): AuditRunRef {
  if (options.runId && options.runName) throw new Error('Give EITHER --run-id OR --run-name, not both.');
  if (options.runId) return { runId: options.runId };
  if (options.runName) return { runName: options.runName };
  throw new Error('Give --run-id <id> or --run-name "<name>" (the audit run whose Fix Plan is validated).');
}

function short(id: string): string {
  return `${id.slice(0, 8)}…`;
}

export function printR1Summary(r1: R1Output, out: (line: string) => void = console.log): void {
  const s = r1.sourceRun;
  out(`Source run:    ${s.displayName} (${s.runId}) · project ${s.projectName}`);
  out(`Run folder:    ${s.runDir}`);
  out(`Target URL:    ${r1.targetUrl}`);
  out(`data.json:     ${r1.audit.findingCount} findings · sha256 ${s.dataJsonSha256.slice(0, 12)}…`);
  const c = r1.decisionCounts;
  out(`fix-plan.json: fix ${c.fix} · skip ${c.skip} · keep_for_review ${c.keep_for_review} · undecided ${c.undecided}${r1.droppedUnknownFindingIds.length ? ` · ${r1.droppedUnknownFindingIds.length} unknown id(s) dropped` : ''}`);
  out(`new-component-plan.json: ${r1.newComponentPlan ? `${r1.newComponentPlan.entries.length} entr(y/ies)` : 'not found'}`);
  out(`DS registry:   ${r1.registry.version.dsRegistryVersion.slice(0, 12)}… (${r1.registry.components.totalTsxFiles} tsx files, ${r1.registry.tokens.sourceTokens.length} tokens)`);
  out(`Fix findings (${r1.fixFindings.length}):`);
  for (const f of r1.fixFindings) {
    const target = f.component.dsComponent ? `→ ${f.component.dsComponent}${f.component.dsVariant ? ` · ${f.component.dsVariant}` : ''}` : '→ (no DS match)';
    out(`  ${short(f.identity.findingId)} ${f.classification} ${f.quality.severity} · ${f.location.section} · ${f.component.productionType} "${f.component.productionLabel}" ${target} · ${f.comparison.mismatches.length} mismatch(es)`);
  }
  for (const w of r1.warnings) out(`Warning: ${w}`);
}

/** The ONE post-preview budget (preview corrections + planner re-plans + re-verifications), from the `fidelity` config. */
function correctionBudgetOf(config: ReturnType<typeof loadConfig>): CorrectionBudgetConfig {
  return { maxCycles: config.fidelity.maxCorrectionCycles, maxVerifications: config.fidelity.maxVerifications, maxDurationMs: config.fidelity.maxDurationMinutes * 60_000 };
}

function buildNodes(config: ReturnType<typeof loadConfig>, log: (line: string) => void, auditAgentRepoRoot: string): { nodes: PipelineNodes; pool: BrowserPool; politeness: Politeness } {
  const pool = new BrowserPool({ channel: config.browserChannel, userAgentProduct: config.politeness.userAgentProduct, ...(config.politeness.contactEmail ? { contactEmail: config.politeness.contactEmail } : {}) });
  const politeness = new Politeness(config.politeness.minNavigationIntervalMs);
  const llm = (paths: RedesignPaths, redesignRunId: string) => createLlmClient(config, { paths, redesignRunId });

  const dsRepoPath = config.dsRepo?.path ?? '';
  const git: GitDeps = { repoPath: dsRepoPath };

  const nodes: PipelineNodes = {
    r1: (input) => runR1({ config, log }, input),
    r2: (r1, paths) => runR2({ pool, politeness, paths, log }, r1),
    restore: (r1, paths) => restoreCaptureSession({ pool, log }, r1, paths),
    scrollEffects: async (r1, paths) => {
      if (existsSync(paths.scrollEffectsJson)) return;
      await politeness.beforeNavigation(r1.targetUrl);
      const context = await pool.newIsolatedContext();
      try {
        await ensureScrollEffects({ path: paths.scrollEffectsJson, context, url: r1.targetUrl, log });
      } finally {
        await context.close().catch(() => {});
      }
    },
    c2: (r1, session, paths, redesignRunId) => runC2({ llm: llm(paths, redesignRunId), config, log, picks: { read: async () => (await readJsonFileOrNull<Record<string, PickSignature | null>>(paths.c2PicksJson)) ?? {}, write: (p) => writeJsonFile(paths.c2PicksJson, p) } }, { r1, session }),
    r3: (input, paths, redesignRunId) => runR3({ llm: llm(paths, redesignRunId), designSystemPath: config.designSystemPath, log }, input),
    r4: (input, paths) => runR4({ paths, log }, input),
    r5: (input, paths, redesignRunId) => runR5({ llm: llm(paths, redesignRunId), log }, input),
    r6: (input) => runR6({ auditAgentRepoRoot, plausibilityBar: config.plausibilityBar, log }, input),
    r7: (input) => runR7({ log }, input),
    b1: (input) => runB1({ pool, politeness, enabled: config.preview.behaviorProbes, fidelity: config.fidelity, log }, input),
    rv: (input) => runRV({ llm: llm(input.paths, input.redesignRunId), designSystemPath: config.designSystemPath, references: config.references, log }, input),
    r8: (input) => runR8({ designSystemPath: config.designSystemPath, preview: config.preview, fidelity: config.fidelity, log }, input),
    l1: (input) => runL1({ log }, input),
    l2: (spec, registry, paths, redesignRunId) => runL2({ llm: llm(paths, redesignRunId), registry, dsRepoPath, log }, spec),
    l2b: (specs, builds) => runL2b({ dsRepoPath, log }, specs, builds),
    l3: (spec, referenceSelector, referenceAffordances, page, viewport) =>
      runL3({ dsRepoPath, page, viewports: config.viewports.length ? config.viewports : [viewport], capturedViewport: viewport, captureStates: config.captureStates, log }, spec, referenceSelector, referenceAffordances),
    l4: (paths, spec, acceptance) => runL4(paths, spec, acceptance),
    l5: (pkg, redesignRunId, push) => runL5({ git, dsRepoPath, log }, pkg, redesignRunId, push),
  };
  return { nodes, pool, politeness };
}

/** Best-effort only — never fatal (a headless box with no GUI, or an unsupported platform, simply prints the path above and does nothing further). */
function tryOpenLocally(path: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(path)}`, () => {});
}

/**
 * Prints the exact absolute path to each of the two SIBLING deliverables that exists so far —
 * `redesign/` (Workflow A) and `new-component/` (Workflow B) — and opens each's own entry file
 * directly (never a shared wrapper — there isn't one). Required at G2 and G4
 * (docs/ARCHITECTURE.md's packaging spec), and shown at final completion too since that's when
 * it's actually finished. `redesign/`'s entry is whichever export mode actually produced;
 * `new-component/`'s is its own index once at least one component is approved.
 */
async function printDeliverable(result: PipelineResult): Promise<void> {
  const { redesignDeliverableDir, newComponentDir, newComponentIndexHtml } = result.paths;
  const server = await readServerRecord(result.paths.previewServerJson);
  if (server) {
    const alive = await previewServerAlive(server);
    console.log(`React preview: ${server.url}${alive ? '' : '  (server not running — start it with: pnpm run agent preview ' + result.redesignRunId + ')'}`);
    console.log(`Source:        ${result.paths.previewAppDir}  (npm install && npm run dev)`);
    if (alive) tryOpenLocally(server.url);
  }
  if (result.r8) {
    const v = result.r8.verification;
    for (const line of cliVerificationLines(v, { report: join(result.paths.redesignDeliverableDir, 'PREVIEW.md') })) console.log(line);
    for (const c of v.checks.filter((x) => x.status === 'fail')) console.log(`  FAILED  ${c.name} — ${c.detail}`);
    for (const u of v.unavailable.slice(0, 6)) console.log(`  not reproduced: ${u}`);
    console.log(`Report:        ${join(result.paths.redesignDeliverableDir, 'PREVIEW.md')}`);
  }
  if (existsSync(redesignDeliverableDir)) {
    const entry = existsSync(join(redesignDeliverableDir, 'redesigned-sections.html')) ? join(redesignDeliverableDir, 'redesigned-sections.html') : join(redesignDeliverableDir, 'redesigned-page.html');
    if (existsSync(entry)) console.log(`Static snapshot (reference only — no interactions, not the preview): ${entry}`);
  }
  if (existsSync(newComponentIndexHtml)) {
    console.log(`New component: ${newComponentIndexHtml}`);
    tryOpenLocally(newComponentIndexHtml);
  }
  if (existsSync(newComponentDir)) console.log(`Component package: pnpm run agent serve ${result.redesignRunId} --static`);
}

async function printPipelineResult(result: PipelineResult): Promise<void> {
  if (result.awaitingJudgment) {
    const { nodeId, bundleId, bundlePath } = result.awaitingJudgment;
    console.log(`Awaiting judgment: ${nodeId} needs the Session Agent's judgment (bundle ${bundleId}).`);
    console.log(`Bundle:      ${bundlePath}`);
    console.log(`Run folder:  ${result.paths.runDir}`);
    console.log(`Next: pnpm run agent judgment show ${result.redesignRunId}`);
    console.log(`Then: pnpm run agent judgment submit ${result.redesignRunId} --file <result.json>`);
    return;
  }
  if (result.awaitingGate) {
    console.log(`Awaiting gate ${result.awaitingGate.awaitingGate}: ${result.awaitingGate.reason}`);
    console.log(`Run folder: ${result.paths.runDir}`);
    if (result.awaitingGate.awaitingGate === 'G2' || result.awaitingGate.awaitingGate === 'G4') await printDeliverable(result);
    console.log(`Once you've reviewed it, run: pnpm run agent decide ${result.redesignRunId} --gate ${result.awaitingGate.awaitingGate} --outcome <outcome>`);
    return;
  }
  console.log(`Run outcome:   ${result.runOutcome}${result.iterations.length ? ` · page verdict ${result.outcome} after ${result.iterations.length} iteration(s)` : ''}`);
  console.log(`Run folder:    ${result.paths.runDir}`);
  if (result.r7) console.log(`Review:        ${result.r7.reviewIndexHtml}`);
  await printDeliverable(result);
}

/**
 * Reconstructs `ctx`/`input` from a run's OWN recorded `run.json` and re-invokes the
 * orchestrator from its last checkpoint — shared by the `resume` command and, per requirement
 * #3 ("one Claude Code instruction can keep processing pending judgment bundles until the next
 * human gate"), by `judgment submit`'s automatic continuation after a valid submission.
 */
async function resumeRun(redesignRunId: string, options: { resetBudget?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const runs = await listRedesignRuns(PROJECTS_ROOT);
  const found = runs.find((r) => r.redesignRunId === redesignRunId);
  if (!found || !found.meta) {
    console.error(`No redesign run ${redesignRunId} under ${PROJECTS_ROOT} (or it has no run.json yet — nothing to resume).`);
    process.exitCode = 1;
    return;
  }
  const meta = found.meta;
  const missing = unimplementedNodes();
  if (missing.length > 0) {
    console.error(`Cannot resume — nodes not implemented: ${missing.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  const log = (line: string) => console.log(`  ${line}`);
  const { nodes, pool } = buildNodes(config, log, config.auditAgentRepoRoot);
  const paths = redesignPaths(PROJECTS_ROOT, found.projectSlug, redesignRunId);
  const ctx: PipelineContext = {
    projectsRoot: PROJECTS_ROOT,
    log,
    redesignRunId,
    anthropicModel: config.anthropicModel,
    runType: meta.runType,
    mode: meta.mode ?? 'full-page',
    resolvedSectionIds: await loadResolvedSectionIds(paths),
    auditAgentRepoRoot: config.auditAgentRepoRoot,
    dsRepoPath: config.dsRepo?.path ?? null,
    dsRepoRemote: config.dsRepo?.remote ?? null,
    dsRepoBaseBranch: config.dsRepo?.baseBranch ?? null,
    maxIterations: config.maxIterations,
    correctionBudget: correctionBudgetOf(config),
    ...(options.resetBudget ? { resetBudget: true } : {}),
  };
  await pool.start();
  try {
    const result = await runRedesignPipeline(ctx, nodes, { runRef: { runId: meta.sourceRun.runId }, runType: meta.runType });
    await printPipelineResult(result);
  } finally {
    await pool.stop();
  }
}

program
  .command('open')
  .argument('<name>', 'Run ID, Run Name, project name, redesign run id, folder path, file:// link, or dashboard URL')
  .description('Resolve a reference (§5.1) — a new audit run to load, or an existing redesign run to resume')
  .action(async (name: string) => {
    const config = loadConfig();
    const resolution = await resolveStartReference(name, { auditAgentRepoRoot: config.auditAgentRepoRoot, projectsRoot: PROJECTS_ROOT });
    if (resolution.kind === 'new-run') {
      console.log(`Resolved: new audit run reference — ${resolution.how}`);
      console.log(`Run with: pnpm run agent redesign ${'runId' in resolution.runRef ? `--run-id ${resolution.runRef.runId}` : `--run-name "${resolution.runRef.runName}"`} --mode <full-page|selected-sections>`);
    } else if (resolution.kind === 'resume') {
      console.log(`Resolved: existing redesign run — ${resolution.how}`);
      const meta = await readRedesignRunMeta(redesignPaths(PROJECTS_ROOT, resolution.projectSlug, resolution.redesignRunId));
      console.log(`Status: ${meta?.runOutcome ?? '(no run.json yet)'} · run folder: ${resolution.runDir}`);
    } else if (resolution.kind === 'ambiguous') {
      console.log(resolution.message);
      for (const c of resolution.candidates) console.log(`  ${c}`);
      process.exitCode = 2;
    } else {
      console.log(resolution.message);
      process.exitCode = 1;
    }
  });

program
  .command('redesign')
  .option('--run-id <id>', 'the audit run id (folder slug), as audit-agent knows it')
  .option('--run-name <name>', 'the audit run\'s display name — exact, case-insensitive match')
  .option('--mode <mode>', 'full-page | selected-sections — required (with the Run ID or Run Name it is the whole startup input; --dry-run alone may omit it)')
  .option('--run-type <type>', 'redesign only, for now — component work (combined | components) is deferred to a separate Component Agent', 'redesign')
  .option('--dry-run', 'run R1 only. Writes nothing, needs no model credential.')
  .option('--max-iterations <n>', 'cap on the R3→R4→R5 loop (default: config maxIterations)', (v: string) => Number(v))
  .description('Apply the authorized Fix findings of an existing audit run to the live page (redesign-only scope — no component work)')
  .action(async (options: { runId?: string; runName?: string; mode?: string; runType: string; dryRun?: boolean; maxIterations?: number }) => {
    const config = loadConfig();
    const runRef = refFrom(options);
    const log = (line: string) => console.log(`  ${line}`);
    const runType = options.runType as RunType;

    if (runType !== 'redesign') {
      console.error(`--run-type ${runType} is not available right now — this agent is redesign-only scope for now (2026-09-28). Component work (new-component-plan.json → Design System components) is deferred to a separate Component Agent, not yet built; the underlying code is preserved but not reachable from this command. Run with --run-type redesign (the default).`);
      process.exitCode = 1;
      return;
    }

    if (options.dryRun) {
      const r1 = await runR1({ config, log }, { runRef, runType });
      printR1Summary(r1);
      const missing = unimplementedNodes();
      console.log(`Dry run — nothing written.${missing.length ? ` Not yet implemented: ${missing.join(', ')}.` : ' Every node is implemented.'}`);
      if (config.judgmentProvider === 'claude-session') {
        console.log('Judgment provider: claude-session (default) — C2/R3/R5/L2/L3 need no ANTHROPIC_API_KEY. This run must be started inside an authenticated Claude Code session: when a judgment node is reached, the run checkpoints with a pending bundle and the Session Agent answers it via `judgment show` / `judgment submit`.');
      } else {
        console.log(`Judgment provider: anthropic-api — needs a credential: ${hasApiCredential() ? 'found (ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN set).' : 'MISSING — set ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN, or set judgmentProvider to "claude-session" to avoid needing one.'}`);
      }
      return;
    }

    if (options.mode !== 'full-page' && options.mode !== 'selected-sections') {
      console.error(`--mode is required and must be "full-page" or "selected-sections" (got ${options.mode ? `"${options.mode}"` : 'nothing'}). Run ID/Run Name + Mode is the whole startup input; everything else is resolved automatically.`);
      process.exitCode = 1;
      return;
    }
    const mode = options.mode as DesignMode;

    const missing = unimplementedNodes();
    if (missing.length > 0) {
      console.error(`Cannot run the full pipeline yet — nodes not implemented: ${missing.join(', ')}. Run with --dry-run to resolve + load the run now.`);
      process.exitCode = 1;
      return;
    }

    const { nodes, pool } = buildNodes(config, log, config.auditAgentRepoRoot);
    const ctx: PipelineContext = {
      projectsRoot: PROJECTS_ROOT,
      log,
      anthropicModel: config.anthropicModel,
      runType,
      mode,
      auditAgentRepoRoot: config.auditAgentRepoRoot,
      dsRepoPath: config.dsRepo?.path ?? null,
      dsRepoRemote: config.dsRepo?.remote ?? null,
      dsRepoBaseBranch: config.dsRepo?.baseBranch ?? null,
      maxIterations: options.maxIterations ?? config.maxIterations,
      correctionBudget: correctionBudgetOf(config),
    };
    await pool.start();
    try {
      const result = await runRedesignPipeline(ctx, nodes, { runRef, runType });
      await printPipelineResult(result);
    } finally {
      await pool.stop();
    }
  });

program
  .command('decide')
  .argument('<redesignRunId>')
  .requiredOption('--gate <gate>', `one of: ${GATES.join(', ')}`)
  .requiredOption('--outcome <outcome>')
  .option('--unit <unitId>', 'the component id, for G4/G5')
  .option('--sections <ids>', 'G1 only, Selected Sections mode: comma-separated section ids to include — validated against this run\'s OWN current candidates (re-derived from fix-plan.json + data.json, read-only, no production access), never invented. Also covers G1\'s acknowledgement half in the same decision.')
  .option('--by <name>', 'who decided', 'reviewer')
  .option('--note <text>', 'free-text note or constraint')
  .option('--accept-preview-failures', 'G2 approve only: approve although the React preview\'s pre-G2 verification has failed checks (they are recorded in the decision note)')
  .description('Record a gate decision — the next `redesign`/`open` invocation continues from here')
  .action(async (redesignRunId: string, options: { gate: string; outcome: string; unit?: string; sections?: string; by: string; note?: string; acceptPreviewFailures?: boolean }) => {
    const runs = await listRedesignRuns(PROJECTS_ROOT);
    const found = runs.find((r) => r.redesignRunId === redesignRunId);
    if (!found) {
      console.error(`No redesign run ${redesignRunId} under ${PROJECTS_ROOT}.`);
      process.exitCode = 1;
      return;
    }
    if (!GATES.includes(options.gate as Gate)) {
      console.error(`Unknown gate "${options.gate}" — expected one of: ${GATES.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const paths = redesignPaths(PROJECTS_ROOT, found.projectSlug, redesignRunId);
    const config = loadConfig();
    const gate = options.gate as Gate;
    if (gate === 'G4' && !options.unit) {
      console.error(`--unit <componentId> is required for gate G4 (§11.3's fingerprint is per component).`);
      process.exitCode = 1;
      return;
    }
    if (gate === 'G1' && options.sections) {
      if (!found.meta) {
        console.error(`No run.json yet for ${redesignRunId} — run \`redesign\` at least once first.`);
        process.exitCode = 1;
        return;
      }
      if (found.meta.mode !== 'selected-sections') {
        console.error(`--sections only applies to Selected Sections mode; this run's mode is "${found.meta.mode}".`);
        process.exitCode = 1;
        return;
      }
      // R1 only reads LOCAL files (audit-link's find-run shell-out + data.json/fix-plan.json on
      // disk) and loads the DS registry — no browser, no network, no production access — so the
      // run's CURRENT candidates can be re-derived offline, never assumed from memory.
      const r1 = await runR1({ config, log: () => {} }, { runRef: { runId: found.meta.sourceRun.runId }, runType: found.meta.runType });
      const candidates = deriveSectionCandidates(r1.fixFindings);
      const contentCandidates = candidates.filter((c) => !c.isGlobal);
      const validIds = new Set(contentCandidates.map((c) => c.sectionId));
      const given = options.sections.split(',').map((s) => s.trim()).filter(Boolean);
      const invalid = given.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        console.error(`Unknown section id(s): ${invalid.join(', ')}. Valid non-global candidates: ${[...validIds].join(', ') || '(none)'}`);
        process.exitCode = 1;
        return;
      }
      const record: ScopeRecord = {
        mode: 'selected-sections',
        sectionIds: given,
        excludedSectionIds: candidates.filter((c) => c.isGlobal).map((c) => c.sectionId),
        candidateSectionIds: contentCandidates.map((c) => c.sectionId),
        resolvedAt: new Date().toISOString(),
      };
      await writeJsonFile(paths.scopeJson, record);
      console.log(`Recorded section scope: ${given.join(', ') || '(none)'} (excluded as global: ${record.excludedSectionIds.join(', ') || '(none)'})`);
    }
    let decisionNote = options.note ?? null;
    if (gate === 'G2' && options.outcome === 'approve') {
      const v = await readJsonFileOrNull<PreviewVerification>(paths.previewVerificationJson);
      const guard = checkG2Approval(v, { acceptPreviewFailures: !!options.acceptPreviewFailures, note: decisionNote, verificationPath: paths.previewVerificationJson, redesignRunId });
      if (!guard.ok) {
        for (const line of guard.lines) console.error(line);
        process.exitCode = 1;
        return;
      }
      decisionNote = guard.note;
    }
    // §11.3: every approval's fingerprint covers exactly what it approved, recomputed from the
    // SAME on-disk artifacts `pipeline.ts` reads when checking reuse (see gate-fingerprints.ts)
    // — never a bare {gate, unit, timestamp} tuple, which can never match real content and would
    // make every recorded approval permanently unreusable.
    const fingerprint = await computeGateFingerprint(gate, paths, { dsRepoPath: config.dsRepo?.path ?? null, dsRepoRemote: config.dsRepo?.remote ?? null, dsRepoBaseBranch: config.dsRepo?.baseBranch ?? null, upstreamPlanPath: found.meta?.sourceRun.newComponentPlanJsonPath ?? null }, options.unit ?? null);
    if (fingerprint === null && gate !== 'G0') {
      console.error(`Cannot record ${gate} yet — its artifacts aren't on disk under ${paths.runDir}. Run \`redesign\` at least once first so it actually reaches this gate.`);
      process.exitCode = 1;
      return;
    }
    await recordDecision(paths.decisionsJson, redesignRunId, { gate, outcome: options.outcome as GateOutcome, fingerprint, unitId: options.unit ?? null, by: options.by, at: new Date().toISOString(), note: decisionNote });
    console.log(`Recorded ${options.gate}${options.unit ? ` (${options.unit})` : ''} = ${options.outcome} for ${redesignRunId}.`);
    console.log(`Continue with: pnpm run agent redesign --run-id <id> --mode <mode> (same options as before)`);
  });

program
  .command('resolve-run')
  .option('--run-id <id>', 'the audit run id')
  .option('--run-name <name>', 'the audit run\'s display name')
  .description('Resolve a Run ID / Run Name through audit-agent\'s own find-run and print the resolved run as JSON (the linkage check, nothing else)')
  .action(async (options: { runId?: string; runName?: string }) => {
    const config = loadConfig();
    const { run, warnings } = await resolveAuditRun(config.auditAgentRepoRoot, refFrom(options));
    console.log(JSON.stringify({ ...run, warnings }, null, 2));
  });

program
  .command('cross-run-paths')
  .option('--run-id <id>', 'exclude this audit run id from the listing')
  .description('List other audit runs\' data.json paths under auditAgentRepoRoot (the cross-run evidence source, read-only) — a diagnostic command')
  .action((options: { runId?: string }) => {
    const config = loadConfig();
    for (const p of findOtherRunDataJsonPaths(config.auditAgentRepoRoot, options.runId ?? '')) console.log(p);
  });

program
  .command('list')
  .description('List redesign runs under this repo\'s projects/ tree')
  .action(async () => {
    const runs = await listRedesignRuns(PROJECTS_ROOT);
    if (runs.length === 0) {
      console.log(`No redesign runs under ${PROJECTS_ROOT}.`);
      return;
    }
    for (const r of runs) {
      const m = r.meta;
      console.log(`${r.projectSlug} / ${r.redesignRunId} · ${m ? `${m.runOutcome} · ${m.runType} · ${m.iterations} iteration(s) · source ${m.sourceRun.runId}` : '(no run.json)'}`);
    }
  });

program
  .command('trace')
  .argument('<redesignRunId>', 'a redesign run id (see `list`)')
  .description('Print the node/iteration spans recorded for a redesign run')
  .action(async (redesignRunId: string) => {
    const run = (await listRedesignRuns(PROJECTS_ROOT)).find((r) => r.redesignRunId === redesignRunId);
    if (!run) {
      console.error(`No redesign run ${redesignRunId} under ${PROJECTS_ROOT}.`);
      process.exitCode = 1;
      return;
    }
    const spans = readSpans(join(run.runDir, 'trace.jsonl'));
    if (spans.length === 0) console.log('(no spans recorded)');
    for (const s of spans) {
      console.log(`${new Date(s.startedAt).toISOString()} ${s.nodeId.padEnd(4)} #${s.attempt} ${s.status.padEnd(5)} ${s.endedAt - s.startedAt}ms${s.model ? ` · ${s.model}` : ''}${s.errorDetail ? ` · ${s.errorDetail}` : ''}`);
    }
  });

program
  .command('resume')
  .argument('<redesignRunId>', 'a redesign run id (see `list`)')
  .option('--reset-budget', 'start the spent post-preview correction budget (verifications, correction cycles, active time) over for this same plan. Never implied: a plain resume keeps it. Recorded in context/correction-state.json and preview/correction-log.json.')
  .description('Resume a checkpointed run — a judgment pause (claude-session mode) or a run whose gate has just been decided — from its last checkpoint')
  .action(async (redesignRunId: string, options: { resetBudget?: boolean }) => {
    await resumeRun(redesignRunId, options);
  });

async function findRunPaths(redesignRunId: string): Promise<RedesignPaths | null> {
  const found = (await listRedesignRuns(PROJECTS_ROOT)).find((r) => r.redesignRunId === redesignRunId);
  return found ? redesignPaths(PROJECTS_ROOT, found.projectSlug, redesignRunId) : null;
}

const judgmentCmd = program.command('judgment').description('Manage claude-session mode\'s pending judgment bundles (C2/R3/R5/L2/L3, §judgmentProvider)');

judgmentCmd
  .command('status')
  .argument('<redesignRunId>', 'a redesign run id (see `list`)')
  .description('List every judgment bundle written for a run and whether each has been submitted')
  .action(async (redesignRunId: string) => {
    const paths = await findRunPaths(redesignRunId);
    if (!paths) {
      console.error(`No redesign run ${redesignRunId} under ${PROJECTS_ROOT}.`);
      process.exitCode = 1;
      return;
    }
    const rows = await listJudgmentBundles(paths);
    if (rows.length === 0) {
      console.log(`No judgment bundles for ${redesignRunId} yet.`);
      return;
    }
    for (const r of rows) console.log(`${r.bundleId} · ${r.nodeId} · ${r.createdAt} · ${r.submitted ? 'submitted' : 'PENDING'}`);
  });

judgmentCmd
  .command('show')
  .argument('<redesignRunId>', 'a redesign run id (see `list`)')
  .argument('[bundleId]', 'which bundle (auto-selected when exactly one is pending)')
  .description('Print a pending judgment bundle in full: instructions, prompt, referenced image paths (inspect these), and the expected JSON schema')
  .action(async (redesignRunId: string, bundleId?: string) => {
    const paths = await findRunPaths(redesignRunId);
    if (!paths) {
      console.error(`No redesign run ${redesignRunId} under ${PROJECTS_ROOT}.`);
      process.exitCode = 1;
      return;
    }
    const rows = await listJudgmentBundles(paths);
    const id = bundleId ?? onlyPendingBundle(rows)?.bundleId;
    if (!id) {
      const pending = rows.filter((r) => !r.submitted);
      console.error(
        pending.length === 0
          ? `No pending judgment bundles for ${redesignRunId}.`
          : `${pending.length} bundles are pending — pass one explicitly:\n${pending.map((b) => `  ${b.bundleId} (${b.nodeId})`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }
    const bundle = await readJudgmentBundle(paths, id);
    if (!bundle) {
      console.error(`No bundle "${id}" for ${redesignRunId}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Node:         ${bundle.nodeId}`);
    console.log(`Bundle:       ${bundle.bundleId}`);
    console.log(`Created:      ${bundle.createdAt}`);
    console.log(`\n--- Instructions (system) ---\n${bundle.instructions}`);
    console.log(`\n--- Prompt ---\n${bundle.prompt}`);
    if (bundle.images.length > 0) {
      console.log(`\n--- Referenced screenshots (inspect these before answering — do not guess) ---`);
      for (const img of bundle.images) console.log(`  ${img.path ?? '(no path recorded — image unavailable)'} — ${img.caption}`);
    }
    console.log(`\n--- Expected JSON Schema (your answer must satisfy this) ---\n${JSON.stringify(bundle.jsonSchema, null, 2)}`);
    console.log(`\nSubmit with: pnpm run agent judgment submit ${redesignRunId} --file <result.json> --bundle ${bundle.bundleId}`);
  });

judgmentCmd
  .command('submit')
  .argument('<redesignRunId>', 'a redesign run id (see `list`)')
  .requiredOption('--file <path>', 'path to the judgment result JSON — validated against the node\'s real Zod schema before it is accepted')
  .option('--bundle <id>', 'which pending bundle this answers (auto-detected when exactly one is pending)')
  .description('Submit a Session Agent judgment for a pending bundle, then resume the pipeline automatically')
  .action(async (redesignRunId: string, options: { file: string; bundle?: string }) => {
    const paths = await findRunPaths(redesignRunId);
    if (!paths) {
      console.error(`No redesign run ${redesignRunId} under ${PROJECTS_ROOT}.`);
      process.exitCode = 1;
      return;
    }
    const rows = await listJudgmentBundles(paths);
    const bundleId = options.bundle ?? onlyPendingBundle(rows)?.bundleId;
    if (!bundleId) {
      const pending = rows.filter((r) => !r.submitted);
      console.error(
        pending.length === 0
          ? `No pending judgment bundles for ${redesignRunId}.`
          : `${pending.length} bundles are pending — pass --bundle <id>:\n${pending.map((b) => `  ${b.bundleId} (${b.nodeId})`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }
    const bundle = await readJudgmentBundle(paths, bundleId);
    if (!bundle) {
      console.error(`No bundle "${bundleId}" for ${redesignRunId}.`);
      process.exitCode = 1;
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(await readFile(options.file, 'utf8'));
    } catch (err) {
      console.error(`Could not read/parse ${options.file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    const validated = validateJudgmentSubmission(bundle.nodeId, data);
    if (!validated.ok) {
      console.error(`Submission for ${bundle.nodeId} (bundle ${bundleId}) does not match its schema — ${validated.issues}`);
      process.exitCode = 1;
      return;
    }
    await writeJudgmentResult(paths, bundleId, bundle.nodeId, validated.data);
    console.log(`Recorded judgment for ${bundle.nodeId} (bundle ${bundleId}). Resuming ${redesignRunId}...`);
    await resumeRun(redesignRunId);
  });

async function ensurePreviewRunning(paths: RedesignPaths, redesignRunId: string): Promise<{ url: string; started: boolean }> {
  const config = loadConfig();
  const rec = await readServerRecord(paths.previewServerJson);
  if (rec && (await previewServerAlive(rec))) return { url: rec.url, started: false };
  if (!existsSync(paths.previewAppDir)) throw new Error(`No React preview exists for ${redesignRunId} yet (${paths.previewAppDir}). It is generated by node R8 before G2; run \`pnpm run agent resume ${redesignRunId}\` or \`preview ${redesignRunId} --regenerate\`.`);
  if (!existsSync(join(paths.previewAppDir, 'dist'))) { await ensureInstalled(paths.previewAppDir, console.log); await buildPreview(paths.previewAppDir, console.log); }
  const started = await startPreviewServer({ previewDir: paths.previewAppDir, runId: redesignRunId, port: portForRun(redesignRunId, config.preview.basePort), recordPath: paths.previewServerJson, log: (l) => console.log(`  ${l}`) });
  return { url: started.url, started: true };
}

program
  .command('preview')
  .argument('<redesignRunId>', 'a redesign run id (see `list`)')
  .option('--regenerate', 're-generate, rebuild, serve and re-verify the React preview from this run folder\'s own saved evidence (no production access except the one read-only behaviour comparison already on file). It draws from the SAME correction budget as `resume` (verifications, cycles, active time): with the allowance spent it does no verification work and reports the retained evidence as incomplete.')
  .option('--reset-budget', 'with --regenerate: start the spent correction budget over for this same plan first. Never implied by --regenerate; recorded in context/correction-state.json and preview/correction-log.json.')
  .option('--stop', 'stop the preview server for this run')
  .description('The React preview of a run — the default deliverable: runnable source in <run>/preview-app and a localhost URL. Starts the server if it is not running.')
  .action(async (redesignRunId: string, options: { regenerate?: boolean; stop?: boolean; resetBudget?: boolean }) => {
    const found = (await listRedesignRuns(PROJECTS_ROOT)).find((r) => r.redesignRunId === redesignRunId);
    if (!found || !found.meta) {
      console.error(`No redesign run ${redesignRunId} under ${PROJECTS_ROOT}.`);
      process.exitCode = 1;
      return;
    }
    const paths = redesignPaths(PROJECTS_ROOT, found.projectSlug, redesignRunId);
    if (options.stop) {
      await stopPreviewServer(await readServerRecord(paths.previewServerJson));
      console.log(`Stopped the preview server for ${redesignRunId}.`);
      return;
    }
    if (options.regenerate) {
      const config = loadConfig();
      const meta = found.meta;
      const mode = (meta.mode ?? 'full-page') as DesignMode;
      const sectionIds = (await loadResolvedSectionIds(paths)) ?? [];
      const mapping = await readJsonFileOrNull<{ entries: MappingEntry[] }>(paths.mappingJson);
      const edits = (await readJsonFileOrNull<TargetedEdit[]>(paths.appliedEditsJson)) ?? [];
      const unaddressed = (await readJsonFileOrNull<Array<{ findingId: string; reason: string }>>(paths.plannerGapsJson)) ?? [];
      if (!mapping) { console.error(`${paths.mappingJson} is missing — this run never reached R8, so there is no saved evidence to regenerate from. Resume the run instead.`); process.exitCode = 1; return; }
      const behavior = await readJsonFileOrNull<BehaviorFile>(paths.behaviorJson);
      const r1 = await runR1({ config, log: () => {} }, { runRef: { runId: meta.sourceRun.runId }, runType: meta.runType });
      const { pool } = buildNodes(config, (l) => console.log(`  ${l}`), config.auditAgentRepoRoot);
      await pool.start();
      try {
        const context = await pool.newIsolatedContext();
        try {
          // The same inputs the pipeline gives R8: the resolved targets, the immutable baseline of the original, and the SAME budget the pipeline draws from:
          // restored from context/correction-state.json when it belongs to exactly this plan (never reset by regenerating), persisted before each reservation.
          // Corrections decided earlier are reused only for exactly this plan; a re-plan needs the planner, so it is reported, not run, here.
          const resolution = await readResolution(paths.resolvedTargetsJson);
          const baseline = await readBaseline(paths.designBaselineJson);
          const basis = basisHashOf({ edits, resolution, baselineSha256: baseline?.baselineSha256 ?? null });
          const store = await openCorrectionBudget({ path: paths.correctionStateJson, basisHash: basis, kind: 'applied', config: correctionBudgetOf(config), log: (l) => console.log(`  ${l}`), ...(options.resetBudget ? { resetBudget: true } : {}) });
          const state = store.state;
          const r8 = await runR8({ designSystemPath: config.designSystemPath, preview: config.preview, fidelity: config.fidelity, log: (l) => console.log(`  ${l}`) }, { r1, context, entries: mapping.entries, edits, unaddressed, paths, redesignRunId, mode, sectionIds, behavior, resolution, baseline, budget: store.budget, corrections: { stateGuards: state.stateGuards, droppedEdits: state.droppedEdits, droppedIslands: state.droppedIslands } });
          const current = store.state; // not the state read before R8: reservations have rewritten it since
          store.set({ ...current, stateGuards: r8.correction?.corrections.stateGuards ?? current.stateGuards, droppedEdits: r8.correction?.corrections.droppedEdits ?? current.droppedEdits, droppedIslands: r8.correction?.corrections.droppedIslands ?? current.droppedIslands });
          await store.save();
          console.log(`React preview: ${r8.url} · verification ${statusHeadline(statusOf(r8.verification))} · design/state fidelity ${r8.fidelity ? r8.fidelity.verdict.toUpperCase() : 'NOT VERIFIED'}${r8.correction?.plannerFeedback.length ? ` · ${r8.correction.plannerFeedback.length} item(s) need the planner (resume the run to re-plan)` : ''} · report ${join(paths.redesignDeliverableDir, 'PREVIEW.md')}`);
        } finally { await context.close(); }
      } finally { await pool.stop(); }
      return;
    }
    const { url, started } = await ensurePreviewRunning(paths, redesignRunId);
    console.log(`React preview: ${url}${started ? '  (server started)' : ''}`);
    console.log(`Source:        ${paths.previewAppDir}  (npm install && npm run dev)`);
    const v = await readJsonFileOrNull<PreviewVerification>(paths.previewVerificationJson);
    if (v) for (const line of cliVerificationLines(v, { report: join(paths.redesignDeliverableDir, 'PREVIEW.md') })) console.log(line);
    if (v) console.log(`Report:        ${join(paths.redesignDeliverableDir, 'PREVIEW.md')}`);
    tryOpenLocally(url);
  });

program
  .command('serve')
  .argument('<redesignRunId>', 'a redesign run id (see `list`)')
  .option('--static', 'serve the static snapshot and component package instead (reference only; the React preview is the deliverable)')
  .option('--port <n>', 'preferred port for --static (falls back to the next free one)', (v: string) => Number(v), 4173)
  .description('Serve the run\'s deliverable over real http://localhost links. Default: the React preview. With --static: the static HTML snapshot and the new-component package, blocking until Ctrl+C.')
  .action(async (redesignRunId: string, options: { port: number; static?: boolean }) => {
    const paths = await findRunPaths(redesignRunId);
    if (!paths) {
      console.error(`No redesign run ${redesignRunId} under ${PROJECTS_ROOT}.`);
      process.exitCode = 1;
      return;
    }
    if (!options.static) {
      const { url } = await ensurePreviewRunning(paths, redesignRunId);
      console.log(`React preview: ${url}`);
      tryOpenLocally(url);
      return;
    }
    const roots = [
      ...(existsSync(paths.redesignDeliverableDir) ? [{ prefix: '/redesign', dir: paths.redesignDeliverableDir }] : []),
      ...(existsSync(paths.newComponentDir) ? [{ prefix: '/new-component', dir: paths.newComponentDir }] : []),
    ];
    if (roots.length === 0) {
      console.error(`Neither redesign/ nor new-component/ exists yet for ${redesignRunId} — nothing to serve.`);
      process.exitCode = 1;
      return;
    }
    const server = await startStaticServer(roots, options.port);
    console.log(`Serving the STATIC snapshot of ${redesignRunId} at ${server.origin} (reference only — no interactions) — Ctrl+C to stop.`);
    if (existsSync(paths.redesignDeliverableDir)) {
      const entryName = existsSync(join(paths.redesignDeliverableDir, 'redesigned-sections.html')) ? 'redesigned-sections.html' : 'redesigned-page.html';
      console.log(`Redesign:      ${server.origin}/redesign/${entryName}`);
    }
    if (existsSync(paths.newComponentIndexHtml)) console.log(`New component: ${server.origin}/new-component/index.html`);
    await new Promise<void>((resolvePromise) => {
      process.on('SIGINT', () => {
        void server.close().then(() => resolvePromise());
      });
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof RedesignPipelineError) {
    console.error(`Redesign failed at ${err.message}${err.class ? ` [${err.class}]` : ''}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
});
