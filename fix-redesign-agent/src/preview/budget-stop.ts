import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CorrectionSummary, R8Input, R8Output } from '../agents/types.ts';
import { fidelitySummaryOf } from '../fidelity/coverage.ts';
import type { BudgetReason, BudgetTracker } from '../fidelity/loop.ts';
import type { FidelityReport } from '../fidelity/types.ts';
import type { RedesignPaths } from '../output/redesign-store.ts';
import { setVerification, writeResolution } from '../resolution/store.ts';
import type { ResolutionFile } from '../resolution/schema.ts';
import { fingerprintOf, sha256Hex } from '../session/fingerprint.ts';
import { renderFindingAccounting, renderPreviewMd } from './report.ts';
import { sourceHashOf, type GeneratedPreview } from './scaffold.ts';
import { previewServerAlive, readServerRecord, type startPreviewServer } from './server.ts';
import { BUDGET_GAP_FAMILY, applyOverallStatus, disclosedOf, requiredGapsOf } from './status.ts';
import type { PreviewVerification, RequiredGap } from './types.ts';
import { writePreviewStatus } from './verify.ts';

/**
 * R8 when the correction budget allows NO verification (the allowance or the active time is spent — typically a `resume` or
 * `preview --regenerate` of a plan whose budget is already used up). It does no verification work: it does not regenerate, build, serve or
 * measure anything. What it does is stay honest:
 *  - the previous evidence of THIS plan (verification.json, fidelity.json, correction-log.json, generation.json) is retained as measured, when it
 *    is still valid: recorded for the same edits/targets/baseline AND the same scope (mode, sections, design decisions, hand-authored overrides)
 *    (the `evidence-basis.json` sidecar R8 writes last) and the preview source on disk still hashes to what was verified;
 *  - an open required item is added — "verification budget exhausted: no new verification was allowed" — so the overall status is INCOMPLETE (FAIL
 *    if the retained evidence has a failed required check), never PASS, however clean the retained evidence was: a verification that was
 *    asked for and not allowed is not a verification;
 *  - with no valid evidence, every required check is unverified and the status is INCOMPLETE, saying why nothing is kept; the stale evidence files
 *    of another plan are set aside (`*.superseded.json`), never left beside a verification that says nothing was verified.
 * The preview server is left exactly as it is (running or not); nothing is started. Writing the same result twice is idempotent.
 *
 * The one thing that precedes the budget check is REUSE ({@link reuseRetainedEvidence}): a plain resume of a plan whose earlier verification was measured
 * for identical inputs by the identical engine is not a new verification, so it costs nothing and is not an incomplete result either.
 */

export { BUDGET_GAP_FAMILY };
const SIDECAR = 'evidence-basis.json';

export function budgetStopLine(reason: BudgetReason, budget: BudgetTracker, keptNote: string): string {
  const u = budget.usage();
  const spent = reason === 'time'
    ? `${Math.round(u.elapsedMs / 60_000)} of ${Math.round((budget.config.maxDurationMs ?? 0) / 60_000)} min of active time used`
    : reason === 'verifications'
      ? `${u.verifications} of ${budget.config.maxVerifications} verifications used`
      : `${u.cycles} of ${budget.config.maxCycles} correction cycles used`;
  return `verification budget exhausted: no new verification was allowed (${reason}: ${spent}); ${keptNote}. A deliberate re-run needs --reset-budget`;
}

/**
 * What a stamp binds the evidence to. `basisHash`: the edits, the resolved targets and the baseline. `scopeHash`: everything else that decides what
 * is generated and measured (mode, sections, design decisions, hand-authored overrides, the planner's recorded gaps, the mapping, the captured behaviour,
 * the original snapshot). `engineHash`: the code, template, design system and settings that produced and measured it — checked only for REUSE (a stop
 * keeps older measurements, flagged incomplete, however they were made; a reuse presents them as current).
 */
export interface EvidenceStamp { basisHash: string; scopeHash: string; engineHash: string }

const hashOrNull = async (path: string): Promise<string | null> => (existsSync(path) ? sha256Hex(await readFile(path)) : null);

async function walkFiles(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Path + content of every file below `dir`; null when there is none. */
async function treeHashOrNull(dir: string): Promise<string | null> {
  const files = await walkFiles(dir);
  if (files.length === 0) return null;
  const h = createHash('sha256');
  for (const f of files) { h.update(relative(dir, f)); h.update(await readFile(f)); }
  return h.digest('hex');
}

export async function scopeHashOf(input: Pick<R8Input, 'mode' | 'sectionIds' | 'unaddressed' | 'entries' | 'behavior' | 'paths'>): Promise<string> {
  const { paths } = input;
  return fingerprintOf({
    mode: input.mode,
    sectionIds: [...input.sectionIds].sort(),
    unaddressed: input.unaddressed.map((u) => `${u.findingId}|${u.reason}`).sort(),
    entries: fingerprintOf(input.entries),
    behavior: input.behavior ? fingerprintOf(input.behavior) : null,
    originalHtml: await hashOrNull(paths.originalHtml),
    designDecisions: await hashOrNull(paths.designDecisionsJson),
    overrides: await treeHashOrNull(paths.previewOverridesDir),
  });
}

/** The root of this tool (`src` and `templates` live below it). */
const ENGINE_ROOT = join(import.meta.dirname, '..', '..');

/**
 * Whatever else could change a regenerated or re-measured preview without changing its inputs: this tool's own code and the preview template,
 * the design system source it imports (path, size, mtime) and the settings that shape generation and sampling. Any difference means the old
 * measurement is no longer "what this engine would find", so it is not reused.
 */
export async function engineHashOf(a: { designSystemPath: string; preview: unknown; fidelity?: unknown }): Promise<string> {
  const h = createHash('sha256');
  for (const root of [join(ENGINE_ROOT, 'src'), join(ENGINE_ROOT, 'templates', 'react-preview')]) {
    for (const f of await walkFiles(root)) { h.update(relative(ENGINE_ROOT, f)); h.update(await readFile(f)); }
  }
  for (const root of [join(a.designSystemPath, 'core-v2', 'src'), join(a.designSystemPath, 'tokens')]) {
    for (const f of await walkFiles(root)) { const s = await stat(f); h.update(`${relative(a.designSystemPath, f)}|${s.size}|${Math.round(s.mtimeMs)};`); }
  }
  h.update(JSON.stringify({ preview: a.preview, fidelity: a.fidelity ?? null }));
  return h.digest('hex');
}

/**
 * Stamps the evidence files just written with the plan and scope they were measured for and the hash of the preview source they describe — taken AFTER
 * the last write into preview-app (pv-status.json is part of that hash). Written LAST: a crash before it leaves the previous stamp, never a wrong one.
 */
export async function stampEvidence(paths: Pick<RedesignPaths, 'previewDir' | 'previewAppDir'>, stamp: EvidenceStamp): Promise<void> {
  const sourceHash = await sourceHashOf(paths.previewAppDir);
  await mkdir(paths.previewDir, { recursive: true });
  await writeFile(join(paths.previewDir, SIDECAR), JSON.stringify({ ...stamp, sourceHash }, null, 2));
}

interface Retained {
  verification: PreviewVerification;
  fidelity: FidelityReport;
  correction: CorrectionSummary;
  generation: GeneratedPreview;
  url: string;
  port: number;
  stamp: EvidenceStamp;
}

const readJson = async <T>(path: string): Promise<T | null> => {
  try { return existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as T) : null; } catch { return null; }
};

/**
 * The previous verification of exactly this plan and scope, or the reason it cannot be kept. Never a partial or mismatched set.
 * `engineHash` is given only by a REUSE: it must also have been measured by this engine.
 */
export async function readRetainedEvidence(paths: RedesignPaths, current: Pick<EvidenceStamp, 'basisHash' | 'scopeHash'>, opts: { engineHash?: string } = {}): Promise<{ kept: Retained } | { kept: null; why: string }> {
  const stamp = await readJson<Partial<EvidenceStamp> & { sourceHash?: string }>(join(paths.previewDir, SIDECAR));
  if (!stamp?.basisHash) return { kept: null, why: 'no previous verification of this plan is on disk' };
  if (stamp.basisHash !== current.basisHash) return { kept: null, why: 'the previous verification was recorded for a different plan, set of targets or baseline' };
  if (stamp.scopeHash !== current.scopeHash) return { kept: null, why: 'the previous verification was recorded for a different scope (mode, sections, design decisions, overrides or captured inputs)' };
  if (opts.engineHash !== undefined && stamp.engineHash !== opts.engineHash) return { kept: null, why: 'the generator, verifier, design system or settings changed since it was measured' };
  const verification = await readJson<PreviewVerification>(paths.previewVerificationJson);
  const fidelity = await readJson<FidelityReport>(paths.fidelityReportJson);
  const correction = await readJson<CorrectionSummary>(paths.correctionLogJson);
  const gen = await readJson<{ generation?: GeneratedPreview; url?: string; port?: number }>(paths.previewGenerationJson);
  if (!verification || !Array.isArray(verification.checks) || !fidelity || !correction?.required || !gen?.generation || !gen.url || typeof gen.port !== 'number') return { kept: null, why: 'the previous verification files are missing or unreadable' };
  let sourceNow: string | null = null;
  try { sourceNow = await sourceHashOf(paths.previewAppDir); } catch { sourceNow = null; }
  if (sourceNow === null || sourceNow !== stamp.sourceHash) return { kept: null, why: 'the preview source changed (or is gone) since it was verified' };
  return { kept: { verification, fidelity, correction, generation: gen.generation, url: gen.url, port: gen.port, stamp: { basisHash: stamp.basisHash, scopeHash: stamp.scopeHash, engineHash: stamp.engineHash ?? '' } } };
}

/** Moves evidence files of ANOTHER plan out of the way (`x.json` → `x.superseded.json`): never left standing beside a verification that says nothing was verified, never destroyed. */
async function setAside(files: readonly string[]): Promise<void> {
  for (const f of files) if (existsSync(f)) await rename(f, f.replace(/\.json$/, '.superseded.json'));
}

/** Written once a verification, retained or reused, is the one the run goes on with: the reports a reader opens, from the verification alone. */
async function writeReports(input: R8Input, verification: PreviewVerification, generation: GeneratedPreview, fidelity: FidelityReport | null, correction: CorrectionSummary): Promise<void> {
  const { paths } = input;
  const acct = renderFindingAccounting(verification);
  await mkdir(paths.redesignDeliverableDir, { recursive: true });
  await writeFile(join(paths.redesignDeliverableDir, 'finding-accounting.md'), acct.md);
  await writeFile(join(paths.redesignDeliverableDir, 'finding-accounting.json'), JSON.stringify(acct.json, null, 2));
  await writeFile(join(paths.redesignDeliverableDir, 'PREVIEW.md'), renderPreviewMd({ runId: input.redesignRunId, v: verification, g: generation, source: paths.previewAppDir, fidelity, correction }));
}

export interface BudgetStopArgs {
  input: R8Input;
  budget: BudgetTracker;
  reason: BudgetReason;
  stamp: EvidenceStamp;
  /** Used only when no server record exists to point at. */
  fallbackPort: number;
  log: (line: string) => void;
}

export async function budgetStoppedOutput(a: BudgetStopArgs): Promise<R8Output> {
  const { input, budget, reason, log } = a;
  const { paths } = input;
  const resolution = input.resolution ?? null;
  const read = await readRetainedEvidence(paths, a.stamp);
  const record = await readServerRecord(paths.previewServerJson);
  // the server is left as it is: reachable if it was running, never started here - and said so, so the URL is not mistaken for a promise
  const alive = record ? await previewServerAlive(record) : false;
  const serverNote = alive ? '' : '. The preview server is not running and was not started';

  let verification: PreviewVerification;
  let fidelity: FidelityReport | null;
  let base: CorrectionSummary | null;
  let generation: GeneratedPreview;
  let url: string;
  let port: number;
  let line: string;

  if (read.kept) {
    const k = read.kept;
    ({ verification, fidelity, generation, url, port } = k);
    base = k.correction;
    line = budgetStopLine(reason, budget, `the previous verification of this plan is kept as measured, and nothing was re-measured${serverNote}`);
    // resolved-targets.json must say what the retained verification measured (a fresh resolution object starts at not-run)
    for (const r of verification.targetResults ?? []) if (resolution) setVerification(resolution, (t) => t.id === r.targetId, r.verification, r.detail);
    log(`R8 · ${line}`);
  } else {
    line = budgetStopLine(reason, budget, `nothing is kept (${read.why}) and every required check is unverified${serverNote}`);
    log(`R8 · ${line}`);
    // the evidence of another plan stays out of the way: fidelity.json / generation.json / the stamp would otherwise sit (and be fingerprinted) beside a verification that says nothing was verified
    await setAside([paths.fidelityReportJson, paths.previewGenerationJson, join(paths.previewDir, SIDECAR)]);
    url = record?.url ?? `http://localhost:${a.fallbackPort}/`;
    port = record?.port ?? a.fallbackPort;
    generation = { sectionIds: input.sectionIds, generatedSections: [], overriddenSections: [], sourceHash: '', assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 };
    fidelity = null;
    base = null;
    verification = {
      schemaVersion: 1, generatedAt: new Date().toISOString(), url, mode: input.mode, expectedSectionIds: input.sectionIds, renderedSectionIds: [], checks: [], findings: [], interactions: [],
      unavailable: [], simulated: [], summary: { passed: 0, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'incomplete',
    };
    if (resolution) setVerification(resolution, (t) => t.outcome !== 'unresolved', 'not-run', 'not measured: the correction budget allowed no verification');
  }

  if (resolution) await writeResolution(paths.resolvedTargetsJson, resolution);
  const gaps: RequiredGap[] = [...requiredGapsOf(verification, fidelity, resolution, 'no verification was allowed'), { kind: 'unverified', family: BUDGET_GAP_FAMILY, count: 1, text: line }];
  applyOverallStatus(verification, gaps, disclosedOf(verification, fidelity));
  const open = gaps.map((g) => g.text);
  if (fidelity) verification.fidelity = fidelitySummaryOf(fidelity, open);
  const used = budget.usage();
  const correction: CorrectionSummary = {
    stopReason: 'budget-exhausted', budgetReason: reason, cycles: base?.cycles ?? [], open: base?.open ?? [], plannerFeedback: base?.plannerFeedback ?? [],
    corrections: base?.corrections ?? input.corrections ?? { stateGuards: [], droppedEdits: [], droppedIslands: [] }, verifications: budget.verifications,
    required: { ...(base?.required ?? {}), satisfied: false, open },
    budget: { used, max: budget.config, resets: [...budget.resets], retained: !!read.kept },
  };

  await mkdir(paths.previewDir, { recursive: true });
  await writeFile(paths.previewVerificationJson, JSON.stringify(verification, null, 2));
  await writeFile(paths.correctionLogJson, JSON.stringify(correction, null, 2));
  // the preview serves the scope it was asked for, not "0 sections", when nothing was measured
  if (existsSync(paths.previewAppDir)) await writePreviewStatus(paths.previewAppDir, input.redesignRunId, input.mode, verification, verification.renderedSectionIds.length ? undefined : input.sectionIds);
  await writeReports(input, verification, generation, fidelity, correction);
  // pv-status.json was rewritten: the kept evidence stays valid for the next invocation, and still says which engine measured it
  if (read.kept) await stampEvidence(paths, { ...a.stamp, engineHash: read.kept.stamp.engineHash });
  return { url, port, previewDir: paths.previewAppDir, sourceHash: generation.sourceHash, verificationJson: paths.previewVerificationJson, verification, generation, fidelity, correction };
}

export interface ReuseArgs {
  input: R8Input;
  budget: BudgetTracker;
  stamp: EvidenceStamp;
  fallbackPort: number;
  serve: typeof startPreviewServer;
  log: (line: string) => void;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set([...a, ...b]).size === a.length;

/**
 * A plain resume or judgment-submit continuation re-enters R8 with nothing changed. That is not a new verification and must not spend one (after three
 * invocations the budget would otherwise stop every later one, turn an approved G2 INCOMPLETE and fall back to "awaiting G2").
 * The earlier verification is reused exactly as measured - nothing is re-measured, no open item is added, a PASS stays a PASS and an INCOMPLETE or FAIL
 * stays what it was - ONLY when ALL of this holds, otherwise `null` and R8 goes on to the budget check as before:
 *  - it was recorded for these edits/targets/baseline, this scope (mode, sections, design decisions, overrides, planner gaps, mapping, behaviour capture,
 *    original snapshot) and measured by this very engine (code, template, design system source, settings): the stamp says so;
 *  - the preview source on disk still hashes to what was verified and its build is still there;
 *  - the corrections now in force are the ones it was produced with;
 *  - it is a completed verification, not itself a budget stop, and no intentional `--reset-budget` happened since (a reset asks for a fresh verification).
 * The recorded server is started again from the build when it is not running (no install, no build, no measurement).
 */
export async function reuseRetainedEvidence(a: ReuseArgs): Promise<R8Output | null> {
  const { input, budget, log } = a;
  const { paths } = input;
  const declined = (why: string): null => { log(`R8 · the earlier verification is not reused: ${why}`); return null; };
  const read = await readRetainedEvidence(paths, a.stamp, { engineHash: a.stamp.engineHash });
  if (!read.kept) return declined(read.why);
  const k = read.kept;
  if (k.correction.stopReason === 'budget-exhausted') return declined('it was itself a budget stop');
  if ((k.correction.budget?.resets.length ?? 0) !== budget.resets.length) return declined('the budget was reset on purpose since, which asks for a new verification');
  const now = input.corrections ?? { stateGuards: [], droppedEdits: [], droppedIslands: [] };
  const then = k.correction.corrections;
  if (!sameSet(now.stateGuards, then.stateGuards) || !sameSet(now.droppedEdits, then.droppedEdits) || !sameSet(now.droppedIslands, then.droppedIslands)) return declined('the corrections in force differ from the ones it was produced with');
  if (!existsSync(join(paths.previewAppDir, 'dist'))) return declined('the built preview is gone');

  let record = await readServerRecord(paths.previewServerJson);
  if (!(await previewServerAlive(record))) record = await a.serve({ previewDir: paths.previewAppDir, runId: input.redesignRunId, port: a.fallbackPort, recordPath: paths.previewServerJson, log });
  const { url, port } = record!;

  const { verification, fidelity, generation } = k;
  const resolution = input.resolution ?? null;
  // resolved-targets.json must say what the reused verification measured (a fresh resolution object starts at not-run)
  for (const r of verification.targetResults ?? []) if (resolution) setVerification(resolution, (t) => t.id === r.targetId, r.verification, r.detail);
  if (resolution) await writeResolution(paths.resolvedTargetsJson, resolution);
  if (verification.url !== url) { verification.url = url; await writeFile(paths.previewVerificationJson, JSON.stringify(verification, null, 2)); }
  const correction: CorrectionSummary = { ...k.correction, verifications: budget.verifications, budget: { used: budget.usage(), max: budget.config, resets: [...budget.resets], reused: true } };
  await writeFile(paths.correctionLogJson, JSON.stringify(correction, null, 2));
  await writeReports(input, verification, generation, fidelity, correction);
  log(`R8 · nothing changed since the preview was last verified: that verification is reused as measured (${verification.verdict.toUpperCase()}), no verification was spent (${budget.verifications} of ${budget.config.maxVerifications} used)`);
  return { url, port, previewDir: paths.previewAppDir, sourceHash: generation.sourceHash, verificationJson: paths.previewVerificationJson, verification, generation, fidelity, correction };
}
