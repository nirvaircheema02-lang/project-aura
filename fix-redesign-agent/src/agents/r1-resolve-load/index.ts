import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countDecisions, parseAuditData, parseFixPlan, partitionFixPlanEntries, resolveAuditRun, type AuditRunRef, type FixPlan, type ResolvedAuditRun } from '../../audit-link/index.ts';
import type { Config } from '../../config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../ds/d2-registry/index.ts';
import { emptyNewComponentPlan, parseNewComponentPlan, type NewComponentPlan } from '../../library/new-component-plan-schema.ts';
import { TerminalError } from '../../retry.ts';
import type { R1Input, R1Output } from '../types.ts';

/**
 * R1 — Resolve & Load (deterministic). ARCHITECTURE.md §5.1/§6.2, §8.6:
 *
 *   find-run (audit-agent's own CLI, cross-process) → read data.json + (fix-plan.json when the
 *   run type needs it) + (new-component-plan.json when present) from the resolved folder →
 *   validate every artifact against its contract → join on findingId → keep only
 *   `decision === 'fix'` → loadDsRegistry
 *
 * Everything here is READ-ONLY toward audit-agent. The sha256 of every source file read is
 * recorded so `run.json` proves which bytes were consumed — and, re-hashed after the run,
 * that they were never written to (the hard proof of §1.2's boundary).
 */

export const DATA_JSON = 'data.json';
export const FIX_PLAN_JSON = 'fix-plan.json';
export const NEW_COMPONENT_PLAN_JSON = 'new-component-plan.json';
export const REPORT_HTML_GLOB_FALLBACK = 'report.html';
export const SCREENSHOTS_DIR = 'screenshots';

export interface R1Deps {
  config: Config;
  /** Defaults to shelling out to audit-agent's `find-run`; tests inject a resolver pointing at a fixture folder. */
  resolveRun?: (ref: AuditRunRef) => Promise<{ run: ResolvedAuditRun; warnings: string[] }>;
  /** Defaults to the vendored D1–D6 loader against `config.designSystemPath`. */
  loadRegistry?: (designSystemPath: string) => Promise<DsRegistry>;
  log?: (line: string) => void;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

export async function runR1(deps: R1Deps, input: R1Input): Promise<R1Output> {
  const log = deps.log ?? (() => {});
  const resolve = deps.resolveRun ?? ((ref: AuditRunRef) => resolveAuditRun(deps.config.auditAgentRepoRoot, ref));
  const loadRegistry = deps.loadRegistry ?? loadDsRegistry;

  // 1. Resolve the run through audit-agent — never by guessing paths.
  const { run, warnings } = await resolve(input.runRef);
  log(`R1 · resolved ${run.displayName} (${run.runId}) · project ${run.projectName}`);

  const dataJsonPath = join(run.runDir, DATA_JSON);
  const fixPlanJsonPath = join(run.runDir, FIX_PLAN_JSON);
  const newComponentPlanJsonPath = join(run.runDir, NEW_COMPONENT_PLAN_JSON);
  const reportHtmlPath = join(run.runDir, REPORT_HTML_GLOB_FALLBACK);
  const screenshotsDir = join(run.runDir, SCREENSHOTS_DIR);

  if (!existsSync(dataJsonPath)) {
    throw new TerminalError(`run ${run.runId} has no ${DATA_JSON} at ${dataJsonPath} — the audit never finished (or predates C2). Nothing to work from.`);
  }

  // §1.3: `components` needs no Fix Plan at all; `redesign`/`combined` need one with ≥1 `fix`.
  const fixPlanRequired = input.runType !== 'components';
  const hasFixPlan = existsSync(fixPlanJsonPath);
  if (fixPlanRequired && !hasFixPlan) {
    throw new TerminalError(
      `run ${run.runId} has no ${FIX_PLAN_JSON} in ${run.runDir}, and run type "${input.runType}" needs one. The reviewer exports it from report.html ` +
        `("Export Fix Plan") and audit-agent's \`fix-plan-import ${run.runId}\` validates it in place. Until then there are no Fix decisions to act on.`,
    );
  }

  // 2. Read + validate every artifact present. Location alone never implies correctness.
  const dataBytes = await readFile(dataJsonPath);
  const data = parseAuditData(JSON.parse(dataBytes.toString('utf-8')), dataJsonPath);

  let fixPlanBytes: Buffer | null = null;
  let fixPlan: FixPlan = { schemaVersion: 1, runId: run.runId, updatedAt: null, entries: [] };
  if (hasFixPlan) {
    fixPlanBytes = await readFile(fixPlanJsonPath);
    fixPlan = parseFixPlan(JSON.parse(fixPlanBytes.toString('utf-8')), fixPlanJsonPath);
    if (fixPlan.runId !== run.runId) {
      throw new TerminalError(`${FIX_PLAN_JSON} at ${fixPlanJsonPath} belongs to run "${fixPlan.runId}", not "${run.runId}" — a different run's export was dropped into this folder. Refusing to proceed from it.`);
    }
  }

  let newComponentPlan: NewComponentPlan | null = null;
  let newComponentPlanBytes: Buffer | null = null;
  if (existsSync(newComponentPlanJsonPath)) {
    newComponentPlanBytes = await readFile(newComponentPlanJsonPath);
    newComponentPlan = parseNewComponentPlan(JSON.parse(newComponentPlanBytes.toString('utf-8')), newComponentPlanJsonPath);
    if (newComponentPlan.runId !== run.runId) {
      warnings.push(`${NEW_COMPONENT_PLAN_JSON} at ${newComponentPlanJsonPath} records runId "${newComponentPlan.runId}", not "${run.runId}" — using it anyway but this looks like it may belong to a different run`);
    }
  }

  const componentPlanRequired = input.runType !== 'redesign';
  if (componentPlanRequired && !newComponentPlan) {
    // §1.4: absent upstream plan is not fatal on its own — the checklist export (§2.2's second
    // source) can supply component work instead. R1 only reports what it found; L1 (build step 6)
    // is where "neither source validated" actually blocks the run.
    warnings.push(`no ${NEW_COMPONENT_PLAN_JSON} found at ${newComponentPlanJsonPath} — component work for run type "${input.runType}" will depend entirely on a checklist selection from a prior redesign run`);
  }
  newComponentPlan ??= hasFixPlan || componentPlanRequired ? emptyNewComponentPlan(run.runId) : null;

  if (data.run.runId !== run.runId) {
    warnings.push(`data.json records runId "${data.run.runId}" but the folder resolved as "${run.runId}" — proceeding on the folder, but check the run`);
  }

  // 3. Join on findingId — the only key. Unknown ids are dropped loudly; all-unknown is refused.
  const knownIds = new Set(data.findings.map((f) => f.identity.findingId));
  const { known, unknownIds, duplicateIds } = partitionFixPlanEntries(fixPlan, knownIds);
  if (fixPlan.entries.length > 0 && known.length === 0) {
    throw new TerminalError(`none of the ${fixPlan.entries.length} findingIds in ${fixPlanJsonPath} exist in ${dataJsonPath} — this looks like another run's fix plan. Refusing.`);
  }
  if (unknownIds.length > 0) warnings.push(`${unknownIds.length} fix-plan entr${unknownIds.length === 1 ? 'y' : 'ies'} reference findingIds not in data.json and were dropped: ${unknownIds.map(shortId).join(', ')}`);
  if (duplicateIds.length > 0) warnings.push(`${duplicateIds.length} findingId${duplicateIds.length === 1 ? '' : 's'} appeared more than once in the fix plan; the last entry won: ${duplicateIds.map(shortId).join(', ')}`);

  const decisionCounts = countDecisions(known, data.findings.length);
  const fixEntries = known.filter((e) => e.decision === 'fix');
  if (fixPlanRequired && fixEntries.length === 0) {
    throw new TerminalError(
      `no findings are marked "fix" in ${fixPlanJsonPath} (skip ${decisionCounts.skip} · keep_for_review ${decisionCounts.keep_for_review} · undecided ${decisionCounts.undecided}). Nothing to redesign.`,
    );
  }
  const byId = new Map(data.findings.map((f) => [f.identity.findingId, f] as const));
  const fixFindings = fixEntries.map((e) => byId.get(e.findingId)!);

  // 4. The URL R2 will navigate to is the one the audit actually captured.
  const targetUrl = data.run.targetUrl;
  if (run.targetUrl && run.targetUrl !== targetUrl) warnings.push(`find-run reports targetUrl ${run.targetUrl} but data.json recorded ${targetUrl}; using data.json's`);

  // 5. The Design System registry — one snapshot for the whole run (D2's own rule).
  log(`R1 · loading Design System registry from ${deps.config.designSystemPath}`);
  const registry = await loadRegistry(deps.config.designSystemPath);
  log(`R1 · ${fixFindings.length} finding${fixFindings.length === 1 ? '' : 's'} marked fix of ${data.findings.length} · DS ${registry.version.dsRegistryVersion.slice(0, 12)}…`);

  return {
    sourceRun: {
      auditAgentRepoRoot: deps.config.auditAgentRepoRoot,
      projectName: run.projectName,
      runId: run.runId,
      displayName: run.displayName,
      targetUrl,
      runDir: run.runDir,
      dataJsonPath,
      dataJsonSha256: sha256(dataBytes),
      fixPlanJsonPath: hasFixPlan ? fixPlanJsonPath : null,
      fixPlanSha256: fixPlanBytes ? sha256(fixPlanBytes) : null,
      newComponentPlanJsonPath: newComponentPlanBytes ? newComponentPlanJsonPath : null,
      newComponentPlanSha256: newComponentPlanBytes ? sha256(newComponentPlanBytes) : null,
      reportHtmlPath: existsSync(reportHtmlPath) ? reportHtmlPath : null,
      screenshotsDir,
    },
    audit: { schemaVersion: data.schemaVersion, run: data.run, findingCount: data.findings.length },
    targetUrl,
    findings: data.findings,
    fixPlan,
    fixEntries,
    fixFindings,
    decisionCounts,
    droppedUnknownFindingIds: unknownIds,
    newComponentPlan,
    registry,
    warnings,
  };
}

/** Re-hashes every source file read — call after a run to prove audit-agent's artifacts were untouched. */
export async function sourceFilesUnchanged(sourceRun: R1Output['sourceRun']): Promise<{ dataJson: boolean; fixPlanJson: boolean; newComponentPlanJson: boolean }> {
  const checkNullable = async (path: string | null, expected: string | null) => {
    if (path === null || expected === null) return true;
    return sha256(await readFile(path)) === expected;
  };
  return {
    dataJson: sha256(await readFile(sourceRun.dataJsonPath)) === sourceRun.dataJsonSha256,
    fixPlanJson: await checkNullable(sourceRun.fixPlanJsonPath, sourceRun.fixPlanSha256),
    newComponentPlanJson: await checkNullable(sourceRun.newComponentPlanJsonPath, sourceRun.newComponentPlanSha256),
  };
}
