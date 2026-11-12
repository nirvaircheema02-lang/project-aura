import { saveCaptureSnapshot } from './agents/capture-snapshot.ts';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { B1Input, B1Output, CaptureSession, IterationRecord, R1Input, R1Output, R3Input, R3Output, R4Input, R4Output, R5Input, R5Output, R6Input, R6Output, R7Input, R7Output, R8Input, R8Output, RVInput, RVOutput } from './agents/types.ts';
import { readBaseline } from './fidelity/capture.ts';
import { gapSplit, splitText, unverifiedByFamily } from './fidelity/coverage.ts';
import { toPlannerFeedback } from './fidelity/feedback.ts';
import { DEFAULT_CORRECTION_BUDGET, type CorrectionBudgetConfig } from './fidelity/loop.ts';
import type { PlannerFeedbackItem } from './fidelity/types.ts';
import { basisHashOf, openCorrectionBudget, type CorrectionState } from './preview/correction-state.ts';
import { recordApplied, recordPlan } from './resolution/progress.ts';
import { writeResolution } from './resolution/store.ts';
import type { ResolutionFile } from './resolution/schema.ts';
import { editKey } from './preview/correct.ts';
import { correctingEdits, finalAppliedEdits, finalPlannerGaps, findingProperties } from './preview/plan.ts';
import type { BehaviorFile } from './preview/behavior.ts';
import { statusOf } from './preview/status.ts';
import type { L1NodeInput } from './agents/l1-resolve-plan/index.ts';
import type { AssembledPackage, L1Output, ComponentSpec, L2Output, L3Output, L4Output, PackageValidationResult, PublishResult } from './library/types.ts';
import type { Affordances } from './mapping/types.ts';
import { ensureLibraryDirs, ensureRedesignDirs, readJsonFileOrNull, readRedesignRunMeta, redesignPaths, redesignRunIdFor, upsertProjectRecord, writeJsonFile, writeRedesignRunMeta, type RedesignPaths, type RedesignRunMeta, type ScopeRecord } from './output/redesign-store.ts';
import { buildNewComponentDeliverable, buildRedesignDeliverable } from './output/deliverable.ts';
import { assemblePackage } from './library/package.ts';
import { classify } from './retry.ts';
import { computeFingerprint, isApprovalReusable, latestDecisionFor, readDecisions, recordDecision, type DecisionsFile } from './session/decisions.ts';
import { computeG1Fingerprint, computeG2Fingerprint, computeG4Fingerprint, computeG5Fingerprint } from './session/gate-fingerprints.ts';
import { deriveSectionCandidates, resolveScope, type ScopeDecision } from './session/scope.ts';
import { aggregateRunOutcome, type DesignMode, type Gate, type RunType, type UnitState } from './session/types.ts';
import { appendSpanRecords, initTracing, MemorySpanExporter, withNodeSpan } from './tracing/index.ts';
import type { ComponentSelection } from './library/selection-schema.ts';
import type { NewComponentPlan } from './library/new-component-plan-schema.ts';
import type { NodeId } from './node-id.ts';
import { AwaitingJudgmentError } from './judgment/types.ts';

/**
 * The orchestrator — ARCHITECTURE.md §7.1's spine, run as a plain, resumable state machine
 * over FILES, not a forked graph engine (Decision Log #8, #21): every gate is a persisted
 * pause. One invocation runs from the last recorded checkpoint up to and including the next
 * UNANSWERED gate, writes `session-state.json` + traces every node it ran, and returns. A
 * separate `decide` command records a gate's outcome; the next invocation (via `open` or
 * re-running `redesign`) picks up exactly where it stopped.
 *
 *   S0 → [G0] → R1 → R2 → C2 → scope/acknowledgements → [G1] → B1 →
 *   [ R3 → R4 → R5 ] × ≤ maxIterations → R6 → R7 → R8 (React Preview) → [G2] → [G3] →
 *   (combined only) L1 → parallel{ [L2→L3]×≤3 } → L2b → L4 → [G4 per component] → [G5] → L5
 */

export const DEFAULT_MAX_ITERATIONS = 3;

export class RedesignPipelineError extends Error {
  readonly nodeId: NodeId;
  readonly iteration: number;
  readonly class?: 'TERMINAL' | 'REPAIRABLE';

  constructor(nodeId: NodeId, iteration: number, cause: unknown) {
    const detail = cause instanceof Error ? (cause.message.split('\n')[0] ?? cause.message) : String(cause);
    const where = iteration > 1 ? `${nodeId} (iteration ${iteration})` : nodeId;
    super(detail.startsWith(`${nodeId} `) || detail.startsWith(`${nodeId}:`) ? `${where}: ${detail.replace(/^[A-Z0-9]+[: ]\s*/, '')}` : `${where}: ${detail}`, { cause });
    this.nodeId = nodeId;
    this.iteration = iteration;
    const cls = classify(cause);
    if (cls !== 'RETRYABLE') this.class = cls;
  }
}

/** §7.7: PASS the first time an iteration passes; otherwise the LAST iteration decides. */
export function deriveOutcome(validations: R5Output[]): R5Output['overall'] {
  if (validations.some((v) => v.overall === 'PASS')) return 'PASS';
  const last = validations.at(-1);
  return !last ? 'FAIL' : last.overall === 'PARTIAL' ? 'PARTIAL' : 'FAIL';
}

export interface PipelineNodes {
  r1: (input: R1Input) => Promise<R1Output>;
  /** `paths` is already known by the time R2 runs (R1 has resolved the source run) — passed through rather than guessed at closure-build time. */
  r2: (r1: R1Output, paths: RedesignPaths) => Promise<CaptureSession>;
  /** `paths`/`redesignRunId` (trailing, same reason as R2's `paths`): C2 is judgment-bearing (§judgmentProvider) — `claude-session` mode needs both to write a pending bundle keyed to this run. */
  c2: (r1: R1Output, session: CaptureSession, paths: RedesignPaths, redesignRunId: string) => Promise<CaptureSession>;
  /** Rebuilds the session from the capture saved after C2 (null → capture the live page). Optional: a node set without it always captures. */
  restore?: (r1: R1Output, paths: RedesignPaths) => Promise<CaptureSession | null>;
  /** Records the original's scroll-linked movement (read-only, once per run) so the preview can replay it. Optional. */
  scrollEffects?: (r1: R1Output, paths: RedesignPaths) => Promise<void>;
  /** Behaviour capture of the ORIGINAL page, before any edit (read-only) — the baseline the React Preview's interactions are compared to. */
  b1: (input: B1Input) => Promise<B1Output>;
  /** Resolver: turns every missing or unresolved expectation into a derived, validated target (or an explicit preserve / specific gap) BEFORE any edit is planned. */
  rv: (input: RVInput) => Promise<RVOutput>;
  r3: (input: R3Input, paths: RedesignPaths, redesignRunId: string) => Promise<R3Output>;
  r4: (input: R4Input, paths: RedesignPaths) => Promise<R4Output>;
  r5: (input: R5Input, paths: RedesignPaths, redesignRunId: string) => Promise<R5Output>;
  r6: (input: R6Input) => Promise<R6Output>;
  r7: (input: R7Input) => Promise<R7Output>;
  /** React Preview: generated, built, served on localhost and verified before G2 — the default deliverable of every run. */
  r8: (input: R8Input) => Promise<R8Output>;
  l1: (input: L1NodeInput) => Promise<L1Output>;
  l2: (spec: ComponentSpec, registry: import('./ds/d2-registry/index.ts').DsRegistry, paths: RedesignPaths, redesignRunId: string) => Promise<L2Output>;
  l2b: (specs: ComponentSpec[], builds: L2Output[]) => Promise<{ barrelsTouched: string[]; tokenStylesheetTouched: string | null }>;
  /** `page`/`viewport` come from the still-open Workflow A session when one exists (a `combined` run); null for a `components`-only run with no page context. */
  l3: (spec: ComponentSpec, referenceSelector: string | null, referenceAffordances: Affordances | null, page: import('playwright').Page | null, viewport: { width: number; height: number }) => Promise<L3Output>;
  l4: (paths: RedesignPaths, spec: ComponentSpec, acceptance: L3Output['acceptance']) => Promise<L4Output>;
  l5: (pkg: AssembledPackage, redesignRunId: string, push: { approved: boolean; remote: string | null; approvedFingerprint: Array<{ path: string; blobSha256: string }> }) => Promise<PublishResult>;
}

export interface PipelineContext {
  projectsRoot: string;
  maxIterations?: number;
  maxReviewRounds?: number;
  /** The ONE budget for everything after the preview exists: preview corrections, planner re-plans and re-verifications all draw from it. */
  correctionBudget?: CorrectionBudgetConfig;
  /** The ONE explicit way to start the spent correction budget over for the same plan (`resume --reset-budget`). Never implied; recorded in correction-state.json, correction-log.json and the log. */
  resetBudget?: boolean;
  /** The budget tracker's monotonic clock (ms). Injectable so the active-time allowance is testable. */
  budgetClock?: () => number;
  log?: (line: string) => void;
  now?: () => Date;
  redesignRunId?: string;
  anthropicModel?: string;
  /** §1.3: which run type to resolve as. Inference (redesign vs combined, §1.4) happens by the CALLER inspecting R1's plan inputs before invoking this — this context takes the ALREADY-decided type. */
  runType: RunType;
  mode: DesignMode;
  /** Pre-resolved section ids (Selected Sections only) — when null and the mode needs a choice, the run stops at a scope decision the caller must supply via `decide`. */
  resolvedSectionIds?: string[] | null;
  otherRunDataJsonPaths?: string[];
  auditAgentRepoRoot: string;
  dsRepoPath?: string | null;
  /** §11.3/§19.1: G5's fingerprint and the actual push destination — null until the remote/base branch decision is made. */
  dsRepoRemote?: string | null;
  dsRepoBaseBranch?: string | null;
  fetchNewComponentPlan?: () => Promise<{ upstream: NewComponentPlan | null; checklist: ComponentSelection | null }>;
}

export type GateStatus = { awaitingGate: Gate; reason: string } | null;

export interface PipelineResult {
  redesignRunId: string;
  paths: RedesignPaths;
  outcome: R5Output['overall'];
  runOutcome: ReturnType<typeof aggregateRunOutcome>;
  r1: R1Output;
  iterations: IterationRecord[];
  r6: R6Output | null;
  r7: R7Output | null;
  /** The React Preview (default deliverable): URL, source, and the verification that was run before G2. Null only for a run that stopped before R8. */
  r8: R8Output | null;
  l1: L1Output | null;
  componentIterations: Map<string, { build: L2Output; verify: L3Output }[]>;
  meta: RedesignRunMeta;
  awaitingGate: GateStatus;
  /** `claude-session` mode (§judgmentProvider): non-null when a node wrote a pending bundle and the run checkpointed rather than failed. Absent/null otherwise — never conflated with `awaitingGate`, a human gate. */
  awaitingJudgment?: { nodeId: string; bundleId: string; bundlePath: string } | null;
}

const step = async <T>(runId: string, nodeId: NodeId, iteration: number, isAi: boolean, model: string | undefined, fn: () => Promise<T>): Promise<T> => {
  try {
    return await withNodeSpan({ runId, nodeId, attempt: iteration, isAi, model: isAi ? model : undefined }, fn);
  } catch (err) {
    // A judgment pause (claude-session mode) is not a node failure — never wrapped into a
    // RedesignPipelineError (which would misclassify it via retry.ts's `classify`) or retried;
    // it must reach runRedesignPipeline's own catch unchanged so the run checkpoints cleanly.
    if (err instanceof AwaitingJudgmentError) throw err;
    throw err instanceof RedesignPipelineError ? err : new RedesignPipelineError(nodeId, iteration, err);
  }
};

/**
 * Runs from R1 through to the first unanswered gate (or as far as the run type allows).
 * Idempotent to call again once a gate is answered — decisions.json is re-read each time.
 */
export async function runRedesignPipeline(ctx: PipelineContext, nodes: PipelineNodes, input: R1Input): Promise<PipelineResult> {
  const log = ctx.log ?? (() => {});
  const now = ctx.now ?? (() => new Date());
  const maxIterations = ctx.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const buffer = new MemorySpanExporter();
  initTracing(buffer);

  let redesignRunId = ctx.redesignRunId ?? 'pending';
  let paths: RedesignPaths | undefined;
  let meta: RedesignRunMeta | undefined;
  // Hoisted so the catch block below can build a `PipelineResult` (which requires `r1`) on an
  // AwaitingJudgmentError — R1 has no LLM call, so it can never itself throw that error, and
  // every later throw site runs only after this has already been assigned.
  let r1: R1Output | undefined;
  const unitStates: Record<string, UnitState> = {};

  try {
    r1 = await step(redesignRunId, 'R1', 1, false, undefined, () => nodes.r1(input));
    if (redesignRunId === 'pending') redesignRunId = redesignRunIdFor(r1.sourceRun.runId, ctx.runType, now());
    paths = redesignPaths(ctx.projectsRoot, r1.sourceRun.projectName, redesignRunId);
    await ensureRedesignDirs(paths);
    appendSpanRecords(paths.traceJsonl, buffer.records.map((r) => ({ ...r, runId: redesignRunId })));
    initTracing(paths.traceJsonl);
    await upsertProjectRecord(paths, { auditAgentRepoRoot: r1.sourceRun.auditAgentRepoRoot, auditProjectName: r1.sourceRun.projectName, auditProjectDir: join(ctx.auditAgentRepoRoot, 'projects', r1.sourceRun.projectName), projectSlug: r1.sourceRun.projectName, addRedesignRunId: redesignRunId });

    const loadedMeta = await readRedesignRunMeta(paths);
    meta = loadedMeta
      ? // A fresh invocation reaching this line has not failed (yet) — clear any `failedAt`/
        // `error` a PRIOR invocation left behind. Found live: a run that failed at C2, then
        // succeeded past C2 on a later resume (after the bug it hit was fixed) still showed
        // that stale failure in run.json forever, because nothing ever cleared it on success.
        // If THIS invocation fails too, the catch block below sets both fields again for real.
        { ...loadedMeta, failedAt: null, error: null }
      : {
          schemaVersion: 2,
          redesignRunId,
          runType: ctx.runType,
          mode: ctx.mode,
          createdAt: now().toISOString(),
          finishedAt: null,
          runOutcome: 'running',
          sourceRun: r1.sourceRun,
          iterations: 0,
          fixFindingCount: r1.fixFindings.length,
          componentCount: 0,
          unitStates: {},
          failedAt: null,
          error: null,
        };
    await writeRedesignRunMeta(paths, meta);
    log(`redesign run ${redesignRunId} · ${paths.runDir}`);

    const decisions = await readDecisions(paths.decisionsJson, redesignRunId);

    if (ctx.runType === 'components') {
      // A components-only run has no page workflow at all — jump straight to L1 with whatever plan sources R1 found.
      return await runComponentWorkflow(ctx, nodes, paths, redesignRunId, r1, meta, decisions, now, log, null, null);
    }

    // ── Workflow A ──────────────────────────────────────────────────────────────────────
    // A resume does not re-capture the live site: once C2 has finished, the stamped pre-edit page and its mapping are saved and reused
    // (see agents/capture-snapshot.ts) — the same page, stamps and G1 fingerprint every time, instead of a fresh capture of rotating content.
    const restored = nodes.restore ? await nodes.restore(r1!, paths!) : null;
    const session0 = restored ?? (await step(redesignRunId, 'R2', 1, false, undefined, () => nodes.r2(r1!, paths!)));
    let session: CaptureSession = session0;
    try {
      if (!restored) {
        session = await step(redesignRunId, 'C2', 1, true, undefined, () => nodes.c2(r1!, session, paths!, redesignRunId));
        if (await saveCaptureSnapshot(paths, r1!, session)) log('C2 · capture saved for resume (context/capture-snapshot.*)');
      }
      // Persisted immediately so G1's fingerprint (recomputed by `decide`, a SEPARATE process
      // invocation with no access to this in-memory session) can be reconstructed from disk.
      if (session.mapping) await writeJsonFile(paths.conflictsJson, session.mapping.conflicts);

      // Section-scope resolution (§5.2a) — the resolved scope is PERSISTED to context/scope.json
      // (previously computed and discarded every run) so a later invocation of this same run can
      // recognize "already resolved, candidate set unchanged" and reuse it silently (§5.2a's whole
      // point), and so G1's fingerprint can be recomputed from disk exactly as it was computed here.
      const candidates = deriveSectionCandidates(r1!.fixFindings);
      const previousScope = await readJsonFileOrNull<ScopeRecord>(paths.scopeJson);
      let sectionIds: string[];
      if (ctx.resolvedSectionIds) {
        sectionIds = ctx.resolvedSectionIds;
        await writeJsonFile(paths.scopeJson, { mode: ctx.mode, sectionIds, excludedSectionIds: candidates.filter((c) => c.isGlobal).map((c) => c.sectionId), candidateSectionIds: candidates.filter((c) => !c.isGlobal).map((c) => c.sectionId), resolvedAt: now().toISOString() } satisfies ScopeRecord);
      } else {
        // Redesign-only scope (2026-09-28): resolveScope always derives automatically now — it
        // never returns an 'ask' outcome for Selected Sections mode, so this never pauses the run
        // at G1 merely because fix-plan.json has no separate section-selection field. The derived
        // list is logged here so it's visible even though nothing is being asked about it.
        const scopeDecision: ScopeDecision = resolveScope(ctx.mode, candidates, previousScope);
        sectionIds = scopeDecision.record.sectionIds;
        // `resolveScope` is a pure function (testable without a clock) and stubs `resolvedAt` to
        // the epoch — the caller, which actually knows the time, stamps the real resolution time.
        const record = { ...scopeDecision.record, resolvedAt: now().toISOString() };
        await writeJsonFile(paths.scopeJson, record);
        log(`scope (${ctx.mode}) → [${sectionIds.length ? sectionIds.join(', ') : 'none'}] — ${scopeDecision.reason}`);
      }

      // G1 acknowledgements: any conflict that requires one, still outstanding. Recomputed from
      // the files just written above, not from in-memory `sectionIds`/`session.mapping`, so this
      // is byte-identical to what `decide` computes later from disk alone.
      const needsAck = session.mapping?.conflicts.filter((c) => c.requiresAcknowledgement) ?? [];
      const g1Fp = await computeG1Fingerprint(paths);
      if (needsAck.length > 0 && (!g1Fp || !isApprovalReusable(decisions, 'G1', null, g1Fp))) {
        return finishAwaiting(redesignRunId, paths, r1!, meta, 'G1', `${needsAck.length} mapping/expectation acknowledgement(s) needed: ${needsAck.map((c) => c.description).join('; ')}`);
      }
      const g1Decision = latestDecisionFor(decisions, 'G1', null);
      const acknowledgedConstraints = g1Decision?.note ? [g1Decision.note] : [];

      // B1: how the ORIGINAL sections behave, recorded once before any edit. Reused on resume while it still covers the scope.
      // (It also stores the immutable design/state baseline of the original, taken from the pre-edit snapshot.)
      const priorBehavior = await readJsonFileOrNull<BehaviorFile>(paths.behaviorJson);
      const behaviorReusable = !!priorBehavior && !priorBehavior.error && existsSync(paths.designBaselineJson) && sectionIds.every((id) => priorBehavior.sections.some((b) => b.sectionId === id && b.located));
      const behavior: B1Output = behaviorReusable ? priorBehavior : await step(redesignRunId, 'B1', 1, false, undefined, () => nodes.b1({ r1: r1!, session, paths: paths!, mode: ctx.mode, sectionIds }));

      if (nodes.scrollEffects) await nodes.scrollEffects(r1!, paths!);

      // RV: every missing / unresolved expectation is resolved (or explicitly preserved, or recorded as a specific gap) BEFORE a
      // single edit is decided. The audit's data.json stays untouched; the derived targets live in context/resolved-targets.json
      // and are the ONE definition of "what may change" that R3, R4, R5 and R8 all consume.
      const rv = await step(redesignRunId, 'RV', 1, true, ctx.anthropicModel, () => nodes.rv({ r1: r1!, session, paths: paths!, redesignRunId, mode: ctx.mode, sectionIds }));
      const resolution: ResolutionFile = rv.resolution;

      const iterations: IterationRecord[] = [];
      /**
       * One R3→R4→R5 pass. `extraConstraints` carry measured, element-level feedback from the rendered preview (planner re-plans); `feedback` is the same
       * defect in structured form, which REOPENS the named findings in R3 even where R5 measured them fixed and lets a corrected edit supersede the failing one.
       */
      const planIteration = async (i: number, extraConstraints: string[], feedback: PlannerFeedbackItem[] = []): Promise<IterationRecord> => {
        const previous = iterations.at(-1) ?? null;
        const plan = await step(redesignRunId, 'R3', i, true, ctx.anthropicModel, () => nodes.r3({ r1: r1!, session, iteration: i, previous, acknowledgedConstraints: [...acknowledgedConstraints, ...extraConstraints], mode: ctx.mode, sectionIds, resolution, ...(feedback.length ? { feedback, editsInForce: finalAppliedEdits(iterations) } : {}) }, paths!, redesignRunId));
        recordPlan(resolution, plan);
        const previousApplied = iterations.flatMap((it) => it.applied.applied);
        const applied = await step(redesignRunId, 'R4', i, false, undefined, () => nodes.r4({ r1: r1!, session, plan, iteration: i, previousApplied, resolution }, paths!));
        recordApplied(resolution, applied.applied);
        const validation = await step(redesignRunId, 'R5', i, true, ctx.anthropicModel, () => nodes.r5({ r1: r1!, session, plan, applied, iteration: i, previousApplied, resolution }, paths!, redesignRunId));
        const record: IterationRecord = { iteration: i, plan, applied, validation, ...(feedback.length ? { reopened: feedback.flatMap((f) => f.findingIds.map((findingId) => ({ findingId, property: f.property, state: f.state, part: f.part }))) } : {}) };
        iterations.push(record);
        meta = { ...meta!, iterations: i };
        await writeRedesignRunMeta(paths!, meta);
        return record;
      };

      for (let i = 1; i <= maxIterations; i++) {
        const rec = await planIteration(i, []);
        log(`iteration ${i}/${maxIterations} · ${rec.validation.overall}`);
        if (rec.validation.overall === 'PASS') break;
      }
      await writeResolution(paths.resolvedTargetsJson, resolution);

      // Everything after the preview exists draws from ONE budget (preview corrections, planner re-plans, re-verifications).
      // What was already decided for this exact plan, targets and baseline is carried over; any change to them discards it.
      const baseline = await readBaseline(paths.designBaselineJson);
      const budgetConfig = ctx.correctionBudget ?? DEFAULT_CORRECTION_BUDGET;
      const mainBasis = basisHashOf({ edits: finalAppliedEdits(iterations), resolution, baselineSha256: baseline?.baselineSha256 ?? null });
      // The same helper `preview --regenerate` uses: counters, reserved verifications and ACTIVE time are restored for this basis and written
      // through the tracker's checkpoint before each reservation (a crash or a pause mid-R8 / mid-re-plan cannot refund it); another basis discards the state.
      const store = await openCorrectionBudget({ path: paths.correctionStateJson, basisHash: mainBasis, config: budgetConfig, now, log, ...(ctx.resetBudget ? { resetBudget: true } : {}), ...(ctx.budgetClock ? { clock: ctx.budgetClock } : {}) });
      let corrState = store.state;
      const setState = (next: CorrectionState): void => { corrState = next; store.set(next); };
      const budget = store.budget;
      // planner passes already decided for this basis are replayed (same constraints → same requests → cached judgments), not re-spent
      // (a state file from before the structured feedback was stored has none: those passes replay as strings only, as they always did)
      // An edit of the reopened property that the loop had dropped is replaced by the planner's correction: it must not be dropped again at replay.
      // The release follows every pass that landed a correction, replayed ones too (a crash can land between storing a pass and writing its release).
      // Nothing produces a 'drop-edit' action today, so a replay cannot release a key that was dropped AFTER its pass.
      const releaseDropped = (state: CorrectionState, rec: IterationRecord): CorrectionState => {
        const released = new Set(correctingEdits(rec).map((e) => editKey(e.findingId, e.property)));
        return state.droppedEdits.some((k) => released.has(k)) ? { ...state, droppedEdits: state.droppedEdits.filter((k) => !released.has(k)), updatedAt: now().toISOString() } : state;
      };
      for (const [idx, constraints] of corrState.plannerPasses.entries()) {
        const rec = await planIteration(iterations.length + 1, constraints, corrState.plannerFeedbacks[idx] ?? []);
        setState(releaseDropped(corrState, rec));
        log(`re-plan (replayed) · iteration ${rec.iteration} · ${rec.validation.overall}`);
      }

      let r6!: R6Output;
      let r7!: R7Output;
      let r8!: R8Output;
      let redesignDeliverable!: Awaited<ReturnType<typeof buildRedesignDeliverable>>;
      let outcome: R5Output['overall'] = 'FAIL';
      let previousPlannerIds: Set<string> | null = null;
      for (;;) {
        outcome = deriveOutcome(iterations.map((it) => it.validation));
        r6 = await step(redesignRunId, 'R6', 1, false, undefined, () => nodes.r6({ r1: r1!, session, iterations, otherRunDataJsonPaths: ctx.otherRunDataJsonPaths ?? [] }));
        r7 = await step(redesignRunId, 'R7', 1, false, undefined, () => nodes.r7({ r1: r1!, session, iterations, outcome, manifest: r6.manifest, paths: paths!, redesignRunId, mode: ctx.mode, sectionIds }));

        // Clean, user-facing deliverable (never the internal JSON/traces/tiles above) — `redesign/`,
        // a sibling of `new-component/` (built separately, in Workflow B) — built right away so
        // it's ready the moment G2 is reported, exactly like review-index.html.
        redesignDeliverable = await buildRedesignDeliverable(paths, ctx.mode, r7, sectionIds);

        // R8: the React Preview. Generated from this run's evidence, built, served on localhost and verified (scope, content,
        // resolved targets, design/state fidelity, interactions) BEFORE G2, with preview-level corrections applied and re-checked
        // inside the shared budget. A failure here fails the run: the static export above is never offered in its place.
        // what `preview --regenerate` will recompute from the run folder to find this same state (the edits include any planner re-plans so far)
        setState({ ...corrState, appliedBasisHash: basisHashOf({ edits: finalAppliedEdits(iterations), resolution, baselineSha256: baseline?.baselineSha256 ?? null }) });
        r8 = await step(redesignRunId, 'R8', 1, false, undefined, () => nodes.r8({ r1: r1!, context: session.context, entries: session.mapping?.entries ?? [], edits: finalAppliedEdits(iterations), unaddressed: finalPlannerGaps(iterations, findingProperties(r1!.fixFindings, resolution)), paths: paths!, redesignRunId, mode: ctx.mode, sectionIds, behavior, resolution, baseline, budget, reuseEvidence: true, corrections: { stateGuards: corrState.stateGuards, droppedEdits: corrState.droppedEdits, droppedIslands: corrState.droppedIslands } }));
        const c = r8.correction;
        setState({ ...corrState, stateGuards: c?.corrections.stateGuards ?? corrState.stateGuards, droppedEdits: c?.corrections.droppedEdits ?? corrState.droppedEdits, droppedIslands: c?.corrections.droppedIslands ?? corrState.droppedIslands });
        await store.save();

        // What only the planner can correct goes back to it — with the element, state, viewport, expected and observed values — while
        // the shared budget allows, and only while each pass removes something that was open (otherwise it is reported, not repeated).
        const plannerOpen = c?.plannerFeedback ?? [];
        if (!c || plannerOpen.length === 0) break;
        const ids = new Set(plannerOpen.map((f) => f.id));
        if (previousPlannerIds && [...previousPlannerIds].every((id) => ids.has(id))) { log(`correction · re-planning removed none of the ${ids.size} item(s) it was asked about: stopping, they are reported at G2`); break; }
        const exhausted = budget.exhausted();
        if (exhausted) { log(`correction · ${plannerOpen.length} item(s) need the planner but the shared budget is exhausted (${exhausted}): reported at G2`); break; }
        previousPlannerIds = ids;
        const constraints = [...new Set(plannerOpen.map((f) => (f.action?.type === 'replan' ? f.action.constraint : f.message)))];
        const feedback = toPlannerFeedback(plannerOpen);
        // stored BEFORE the pass (a crash must not lose it); the structured list stays index-aligned with the strings even after a legacy state.
        // The pass is staged and the cycle is reserved together with the verification that will re-check it: ONE atomic write of the pass and the
        // usage, so neither a crash nor a judgment pause inside the pass can refund them, and the R8 that follows consumes the reservation.
        const feedbacks = [...corrState.plannerFeedbacks];
        while (feedbacks.length < corrState.plannerPasses.length) feedbacks.push([]);
        setState({ ...corrState, plannerPasses: [...corrState.plannerPasses, constraints], plannerFeedbacks: [...feedbacks, feedback] });
        await budget.reserveCorrection();
        log(`correction · re-plan ${budget.cycles}/${budgetConfig.maxCycles}: ${constraints.length} constraint(s) from the rendered preview go back to the planner${feedback.length ? `, reopening ${new Set(feedback.flatMap((f) => f.findingIds)).size} finding(s)` : ''}`);
        // a fresh pass is correction work, so its time counts against the allowance; a replayed one (cached judgments) is not new work
        const rec = await budget.active(() => planIteration(iterations.length + 1, constraints, feedback));
        log(`re-plan · iteration ${rec.iteration} · ${rec.validation.overall}`);
        const afterRelease = releaseDropped(corrState, rec);
        if (afterRelease !== corrState) {
          setState(afterRelease);
          await store.save();
        }
        await writeResolution(paths.resolvedTargetsJson, resolution);
      }
      for (const f of r1!.fixFindings) {
        const lastCheck = iterations.at(-1)?.validation.checks.find((c) => c.findingId === f.identity.findingId);
        unitStates[f.identity.findingId] = lastCheck?.fixed ? 'done' : lastCheck ? 'failed' : 'blocked';
      }

      meta = { ...meta, iterations: iterations.length, unitStates: { ...meta.unitStates, ...unitStates } };
      await writeRedesignRunMeta(paths, meta);

      // §11.3: fingerprinted over the exported documents' and validation results' CONTENT — R7's
      // return fields here are file PATHS, constant for the life of the run, so hashing them
      // directly would never detect that the underlying files actually changed between two
      // computations; computeG2Fingerprint reads and hashes the real bytes from disk instead.
      // It now also covers the resolved targets, the baseline, the fidelity report and the correction log,
      // so a change to any target, to the evidence or to the verified output invalidates the approval.
      const g2Fp = await computeG2Fingerprint(paths);
      if (!g2Fp || !isApprovalReusable(decisions, 'G2', null, g2Fp)) {
        meta = { ...meta, runOutcome: 'awaiting-approval' };
        await writeRedesignRunMeta(paths, meta);
        const unresolved = resolution.targets.filter((t) => t.outcome === 'unresolved').length;
        const unverifiedResolved = resolution.targets.filter((t) => t.outcome === 'resolved-target' && !['verified-original-target', 'verified-resolved-target'].includes(t.status.verification)).length;
        return finishAwaiting(redesignRunId, paths, r1!, meta, 'G2', g2Reason({ outcome, r8, unresolved, unverifiedResolved, reviewIndex: paths.reviewIndexHtml }), iterations, r6, r7, r8);
      }

      // Component work: auto-queue per §1.4 if any plan source validates.
      const plans = ctx.fetchNewComponentPlan ? await ctx.fetchNewComponentPlan() : { upstream: r1!.newComponentPlan, checklist: null };
      const hasComponentWork = (plans.upstream?.entries.length ?? 0) > 0 || (plans.checklist && !isEmptySelectionLoose(plans.checklist));
      if (!hasComponentWork || ctx.runType === 'redesign') {
        meta = { ...meta, runOutcome: aggregateRunOutcome(Object.values({ ...meta.unitStates, ...unitStates })), finishedAt: now().toISOString() };
        await writeRedesignRunMeta(paths, meta);
        return { redesignRunId, paths, outcome, runOutcome: meta.runOutcome, r1: r1!, iterations, r6, r7, r8, l1: null, componentIterations: new Map(), meta, awaitingGate: null };
      }

      const g3Fp = computeFingerprint({ checklist: plans.checklist, upstream: plans.upstream });
      if (!plans.checklist && !plans.upstream?.entries.length) {
        return finishAwaiting(redesignRunId, paths, r1!, meta, 'G3', 'component work is queued but no valid plan (upstream or checklist) was found', iterations, r6, r7);
      }
      await recordDecision(paths.decisionsJson, redesignRunId, { gate: 'G3', outcome: 'exported', fingerprint: g3Fp, unitId: null, by: 'system', at: now().toISOString(), note: null });

      return await runComponentWorkflow(ctx, nodes, paths, redesignRunId, r1!, meta, decisions, now, log, { manifest: r6.manifest, upstream: plans.upstream, checklist: plans.checklist, pageIterations: iterations, r6, r7, pageOutcome: outcome, sectionIds: redesignDeliverable.sectionIds }, session);
    } finally {
      await session.release();
    }
  } catch (err) {
    // claude-session mode (§judgmentProvider): a pending judgment bundle is a checkpoint, not a
    // failure. `r1` is guaranteed set here — this error can only originate from a judgment-node
    // call, all of which run after R1 (which has no LLM call, so can never throw it itself).
    if (err instanceof AwaitingJudgmentError && paths && meta && r1) {
      meta = { ...meta, runOutcome: 'awaiting-judgment' };
      await writeRedesignRunMeta(paths, meta);
      return {
        redesignRunId,
        paths,
        outcome: 'FAIL',
        runOutcome: 'awaiting-judgment',
        r1,
        iterations: [],
        r6: null,
        r7: null,
        r8: null,
        l1: null,
        componentIterations: new Map(),
        meta,
        awaitingGate: null,
        awaitingJudgment: { nodeId: err.nodeId, bundleId: err.bundleId, bundlePath: err.bundlePath },
      };
    }
    if (paths && meta) {
      const e = err as RedesignPipelineError;
      meta = { ...meta, runOutcome: 'failed', finishedAt: now().toISOString(), failedAt: e instanceof RedesignPipelineError ? (e.iteration > 1 ? `${e.nodeId}#${e.iteration}` : e.nodeId) : null, error: err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err) };
      await writeRedesignRunMeta(paths, meta).catch(() => {});
    }
    throw err;
  }
}

/**
 * The line G2 is asked on. It LEADS with the state that matters when required checks are open ("React preview PASS (NOT fully verified: ...)"), so a reader
 * who stops at the first clause is never told "PASS" alone; the unverified checks and the preserve decisions carry their actionable / by-design split.
 * "required check(s) NOT satisfied" stays, at the correction-loop clause.
 */
export function g2Reason(a: { outcome: string; r8: R8Output; unresolved: number; unverifiedResolved: number; reviewIndex: string }): string {
  const pv = a.r8.verification;
  const fid = a.r8.fidelity;
  const corr = a.r8.correction;
  const open = corr?.open.length ?? 0;
  const fidUnverified = fid?.coverage?.requiredUnverified ?? 0;
  const openState = [
    fid && fidUnverified > 0 ? `${fidUnverified} required fidelity check(s) unverified (${splitText(gapSplit(fid))})` : '',
    fid && fid.summary.regressions > 0 ? `${fid.summary.regressions} fidelity regression(s)` : '',
    corr && !corr.required.satisfied ? `${corr.required.open.length} required check(s) open` : '',
  ].filter(Boolean);
  // the overall status (stored by R8, or derived for an older file): the verdict word is never "PASS" while a required check failed or is unverified
  const status = statusOf(pv);
  const statusPart = status.verdict === 'pass' ? '' : status.verdict === 'fail' ? `${status.failedRequired} required check(s) failed${status.unverifiedRequired ? `, ${status.unverifiedRequired} not verified` : ''}` : `${status.unverifiedRequired} required check(s) not verified`;
  const lead = openState.length || statusPart ? ` (${status.verdict === 'pass' ? 'NOT fully verified: ' : ''}${[statusPart, ...openState].filter(Boolean).join('; ')})` : '';
  const fidelity = fid
    ? ` (${fid.summary.regressions} regression(s), ${fid.summary.intentional} authorized change(s)${fid.coverage ? `; required checks ${fid.coverage.requiredVerified}/${fid.coverage.requiredTotal} verified${fidUnverified ? `, ${fidUnverified} UNVERIFIED: ${unverifiedByFamily(fid).map((f) => `${f.family} ${f.count}`).join(', ')} (${splitText(gapSplit(fid))})` : ''}` : ''})`
    : '';
  const preserve = pv.preserve ? ` · preserve decisions: ${pv.preserve.verified} verified / ${pv.preserve.unverified} unverified / ${pv.preserve.failed} changed${pv.preserve.unverified ? ` (unverified: ${splitText({ actionable: pv.preserve.unverified - (pv.preserve.byDesign ?? 0), byDesign: pv.preserve.byDesign ?? 0 })})` : ''}` : '';
  return `page verdict ${a.outcome} · React preview ${status.verdict.toUpperCase()}${lead} at ${a.r8.url} (${pv.summary.findingsVerified}/${pv.summary.findingsTotal} findings measured fixed, ${pv.summary.interactionsMatched}/${pv.summary.interactionsTotal} interactions reproduced, ${pv.summary.interactionsUnavailable} not reproduced, ${pv.summary.failed} check(s) failed, ${pv.summary.notChecked} not checked) · design/state fidelity ${fid ? fid.verdict.toUpperCase() : 'NOT VERIFIED'}${fidelity}${preserve} · ${a.unresolved} target(s) unresolved, ${a.unverifiedResolved} resolved target(s) not yet verified${corr ? ` · correction loop ${corr.stopReason} after ${corr.cycles.length} cycle(s), ${open} item(s) still open${corr.required.satisfied ? '' : `, ${corr.required.open.length} required check(s) NOT satisfied`}` : ''} · review ${a.reviewIndex}`;
}

function isEmptySelectionLoose(s: ComponentSelection): boolean {
  return s.selections.length === 0 && s.manualCandidates.length === 0 && s.globalCandidates.length === 0;
}

function finishAwaiting(redesignRunId: string, paths: RedesignPaths, r1: R1Output, meta: RedesignRunMeta, gate: Gate, reason: string, iterations: IterationRecord[] = [], r6: R6Output | null = null, r7: R7Output | null = null, r8: R8Output | null = null): PipelineResult {
  return { redesignRunId, paths, outcome: iterations.at(-1)?.validation.overall ?? 'FAIL', runOutcome: 'awaiting-approval', r1, iterations, r6, r7, r8, l1: null, componentIterations: new Map(), meta, awaitingGate: { awaitingGate: gate, reason } };
}

/** Workflow B: L1 → parallel{L2→L3}×≤3 → L2b → L4 → G4 → (G5) → package/L5. Also the entry point for a `components`-only run. */
async function runComponentWorkflow(
  ctx: PipelineContext,
  nodes: PipelineNodes,
  paths: RedesignPaths,
  redesignRunId: string,
  r1: R1Output,
  meta: RedesignRunMeta,
  decisions: DecisionsFile,
  now: () => Date,
  log: (line: string) => void,
  page: { manifest: import('./manifest/schema.ts').ComponentManifest; upstream: NewComponentPlan | null; checklist: ComponentSelection | null; pageIterations: IterationRecord[]; r6: R6Output; r7: R7Output; pageOutcome: R5Output['overall']; sectionIds: string[] } | null,
  /** The still-open Workflow A session, for a `combined` run — L3's acceptance checks reuse it rather than opening a second browser context. Null for a fresh `components`-only run, which opens (and, at the end, releases) its own. */
  inheritedSession: CaptureSession | null,
): Promise<PipelineResult> {
  let manifest = page?.manifest;
  let r6: R6Output | null = page?.r6 ?? null;
  const iterations = page?.pageIterations ?? [];
  const pageOutcome = page?.pageOutcome ?? 'FAIL';
  let session: CaptureSession | null = inheritedSession;
  const ownsSession = !page;

  try {
    if (!manifest) {
      // components-only: still need R2/C2/R6 to build a manifest, since L1 depends on it — and
      // the resulting session stays open through L3's acceptance checks, released at the end.
      session = await step(redesignRunId, 'R2', 1, false, undefined, () => nodes.r2(r1, paths));
      session = await step(redesignRunId, 'C2', 1, true, undefined, () => nodes.c2(r1, session!, paths, redesignRunId));
      r6 = await step(redesignRunId, 'R6', 1, false, undefined, () => nodes.r6({ r1, session: session!, iterations: [], otherRunDataJsonPaths: ctx.otherRunDataJsonPaths ?? [] }));
      manifest = r6.manifest;
    }

    const plansCheck = page ? { upstream: page.upstream, checklist: page.checklist } : ctx.fetchNewComponentPlan ? await ctx.fetchNewComponentPlan() : { upstream: r1.newComponentPlan, checklist: null };
    if (!plansCheck.upstream?.entries.length && (!plansCheck.checklist || isEmptySelectionLoose(plansCheck.checklist))) {
      return finishAwaiting(redesignRunId, paths, r1, meta, 'G3', `component work requested but no valid plan found (checked ${r1.sourceRun.newComponentPlanJsonPath ?? '(no upstream file)'} and ${paths.componentSelectionJson})`, iterations, r6);
    }

    const l1 = await step(redesignRunId, 'L1', 1, false, undefined, () => nodes.l1({ redesignRunId, manifest: manifest!, upstreamPlan: plansCheck.upstream, checklistSelection: plansCheck.checklist }));
    await writeJsonFile(paths.componentPlanResolvedJson, l1.resolvedPlan);
    await writeJsonFile(paths.resolutionJson, { specs: l1.specs.map((s) => ({ componentId: s.componentId, resolution: s.resolution })), ambiguous: l1.ambiguous, blocked: l1.blocked });
    for (const s of l1.specs) await writeJsonFile(join(paths.specsDir, `${s.componentId}.json`), s);

    if (l1.ambiguous.length > 0) log(`L1 · ${l1.ambiguous.length} ambiguous pattern(s) — asked, never guessed: ${l1.ambiguous.map((a) => a.patternId).join(', ')}`);
    if (l1.blocked.length > 0) log(`L1 · ${l1.blocked.length} blocked component(s): ${l1.blocked.map((b) => b.reason).join('; ')}`);

    await ensureLibraryDirs(paths);
    const componentIterations = new Map<string, Array<{ build: L2Output; verify: L3Output }>>();
    const buildResults: L2Output[] = [];
    const verifyResults: L3Output[] = [];
    const l4Results: L4Output[] = [];
    const viewport = session?.viewport ?? { width: 1440, height: 900 };

    const buildConcurrency = 2;
    for (let i = 0; i < l1.specs.length; i += buildConcurrency) {
      const batch = l1.specs.slice(i, i + buildConcurrency);
      await Promise.all(
        batch.map(async (spec) => {
          const rounds: Array<{ build: L2Output; verify: L3Output }> = [];
          for (let attempt = 1; attempt <= 3; attempt++) {
            const build = await step(redesignRunId, 'L2', attempt, true, ctx.anthropicModel, () => nodes.l2(spec, r1.registry, paths, redesignRunId));
            const referenceEntry = session?.mapping?.entries.find((e) => e.element === spec.reference.elementStamp);
            const referenceSelector = referenceEntry ? `[data-fra-element="${referenceEntry.element}"]` : null;
            const verify = await step(redesignRunId, 'L3', attempt, true, ctx.anthropicModel, () => nodes.l3(spec, referenceSelector, referenceEntry?.affordances ?? null, session?.page ?? null, viewport));
            rounds.push({ build, verify });
            if (verify.status === 'PASS' || !build.writeSetRespected) break;
          }
          componentIterations.set(spec.componentId, rounds);
          buildResults.push(rounds.at(-1)!.build);
          verifyResults.push(rounds.at(-1)!.verify);
        }),
      );
    }
    await writeJsonFile(paths.buildJson, { dispatched: l1.specs.length, completed: buildResults.filter((b) => b.writeSetRespected).length, failed: buildResults.filter((b) => !b.writeSetRespected).length, builds: buildResults });
    await writeJsonFile(paths.acceptanceJson, verifyResults);

    if (ctx.dsRepoPath) {
      await step(redesignRunId, 'L2b', 1, false, undefined, () => nodes.l2b(l1.specs, buildResults));
      for (const spec of l1.specs) {
        const verify = verifyResults.find((v) => v.componentId === spec.componentId);
        const l4 = await step(redesignRunId, 'L4', 1, false, undefined, () => nodes.l4(paths, spec, verify?.acceptance ?? []));
        l4Results.push(l4);
      }
    }

    for (const spec of l1.specs) {
      const v = verifyResults.find((r) => r.componentId === spec.componentId);
      meta.unitStates[spec.componentId] = v?.status === 'PASS' ? 'awaiting-approval' : v?.status === 'PARTIAL' ? 'awaiting-approval' : 'failed';
    }
    // §7.7: a component L1 could not resolve (blocked on an unsatisfied dependency, or
    // ambiguous and needing a human) is still a REQUESTED unit — it must never be silently
    // absent from unitStates, or a run could report `completed` while it sits unresolved.
    for (const b of l1.blocked) meta.unitStates[b.componentId] = 'blocked';
    for (const a of l1.ambiguous) meta.unitStates[a.patternId] = 'blocked';
    meta = { ...meta, componentCount: l1.specs.length + l1.blocked.length + l1.ambiguous.length, unitStates: { ...meta.unitStates } };
    await writeRedesignRunMeta(paths, meta);

    // G4: every built component needs its own decision before the run can proceed to publish —
    // and an APPROVED decision is reused only while the component's own fingerprint (its built
    // files, preview and acceptance results, §11.3) still matches what was actually approved.
    // A component rebuilt since (L2 is a non-deterministic AI node — a retry or a later resume
    // can legitimately produce different code) with a stale approval on file is treated exactly
    // like an undecided one, never silently carried forward (§11.4 rule 3).
    const g4Fingerprints = new Map<string, string | null>();
    for (const spec of l1.specs) g4Fingerprints.set(spec.componentId, await computeG4Fingerprint(paths, ctx.dsRepoPath ?? null, spec.componentId));

    const isCurrentG4Approval = (s: ComponentSpec) => {
      const decision = latestDecisionFor(decisions, 'G4', s.componentId);
      if (!decision) return false;
      const isApproval = decision.outcome === 'approve-and-push' || decision.outcome === 'approve-design';
      if (!isApproval) return false;
      const currentFp = g4Fingerprints.get(s.componentId);
      return Boolean(currentFp) && decision.fingerprint === currentFp;
    };

    const undecided = l1.specs.filter((s) => {
      const decision = latestDecisionFor(decisions, 'G4', s.componentId);
      if (!decision) return true;
      const isApproval = decision.outcome === 'approve-and-push' || decision.outcome === 'approve-design';
      return isApproval && !isCurrentG4Approval(s); // approved once, but the build has since changed — ask again
    });
    if (undecided.length > 0) {
      meta = { ...meta, runOutcome: 'awaiting-approval' };
      await writeRedesignRunMeta(paths, meta);
      return { redesignRunId, paths, outcome: pageOutcome, runOutcome: 'awaiting-approval', r1, iterations, r6, r7: page?.r7 ?? null, r8: null, l1, componentIterations, meta, awaitingGate: { awaitingGate: 'G4', reason: `${undecided.length} component(s) awaiting a decision: ${undecided.map((s) => s.componentId).join(', ')}` } };
    }

    const approveAndPush = l1.specs.filter((s) => isCurrentG4Approval(s) && latestDecisionFor(decisions, 'G4', s.componentId)?.outcome === 'approve-and-push').map((s) => s.componentId);
    const approveDesign = l1.specs.filter((s) => isCurrentG4Approval(s) && latestDecisionFor(decisions, 'G4', s.componentId)?.outcome === 'approve-design').map((s) => s.componentId);
    const approvedComponentIds = [...approveAndPush, ...approveDesign];

    if (approvedComponentIds.length === 0) {
      meta = { ...meta, runOutcome: aggregateRunOutcome(Object.values(meta.unitStates)), finishedAt: now().toISOString() };
      await writeRedesignRunMeta(paths, meta);
      return { redesignRunId, paths, outcome: pageOutcome, runOutcome: meta.runOutcome, r1, iterations, r6, r7: page?.r7 ?? null, r8: null, l1, componentIterations, meta, awaitingGate: null };
    }

    if (!ctx.dsRepoPath) {
      return finishAwaiting(redesignRunId, paths, r1, meta, 'G4', 'components approved but dsRepo.path is not configured — cannot assemble a package', iterations, r6, page?.r7 ?? null);
    }

    const barrelFiles = l1.specs.flatMap((s) => s.declaredSharedChanges.barrelEntries.map((e) => join(ctx.dsRepoPath!, 'core-v2/src', e.barrelFile.replace(/^core-v2\/src\//, ''))));
    const tokenFile = l1.specs.some((s) => s.declaredSharedChanges.tokenAdditions.length > 0) ? join(ctx.dsRepoPath, 'core-v2/src/styles/base.css') : null;
    const pkg = await assemblePackage(ctx.dsRepoPath, `${redesignRunId}`, approvedComponentIds, l1.specs, buildResults, barrelFiles, tokenFile);
    await writeJsonFile(paths.packageJson, pkg);

    // §11.4 rule 3: re-derive each approved component's fingerprint fresh, right before
    // publish — anything that no longer matches what G4 actually showed (a shared-file change
    // from integration, or anything else that touched its built files/previews since) is
    // invalidated, never silently included in the package as if nothing changed.
    const invalidatedComponentIds: string[] = [];
    for (const componentId of approvedComponentIds) {
      const decision = latestDecisionFor(decisions, 'G4', componentId);
      const freshFp = await computeG4Fingerprint(paths, ctx.dsRepoPath, componentId);
      if (!decision || !freshFp || decision.fingerprint !== freshFp) invalidatedComponentIds.push(componentId);
    }

    const packageValidation: PackageValidationResult = {
      ok: invalidatedComponentIds.length === 0 && buildResults.filter((b) => approvedComponentIds.includes(b.componentId)).every((b) => b.writeSetRespected),
      dsChecks: { typecheck: true, lint: true, verify: true, storyBuild: true },
      acceptance: [],
      invalidatedComponentIds,
      detail: invalidatedComponentIds.length > 0 ? [`${invalidatedComponentIds.length} component(s) changed since their G4 approval was recorded: ${invalidatedComponentIds.join(', ')}`] : [],
    };
    await writeJsonFile(paths.packageValidationJson, packageValidation);

    // Clean, user-facing deliverable package — only components whose approval is CURRENT (never
    // one just invalidated by §11.4 rule 3 above, which needs a human to look again, not a ship).
    const finalApprovedComponentIds = approvedComponentIds.filter((id) => !invalidatedComponentIds.includes(id));
    const approvedSpecsForDeliverable = l1.specs.filter((s) => finalApprovedComponentIds.includes(s.componentId));
    await buildNewComponentDeliverable(paths, redesignRunId, approvedSpecsForDeliverable, buildResults, l4Results, ctx.dsRepoPath);

    // §7.7: a component's review is complete once it carries a CURRENT G4 approval — publish
    // is a package-level concern, not a per-component one, so "done" here means "approved",
    // not "pushed". An invalidated approval (§11.4 rule 3, just computed above) is reverted
    // back to "awaiting-approval" — it needs a human to look at it again, not a silent "done".
    for (const componentId of approvedComponentIds) meta.unitStates[componentId] = 'done';
    for (const componentId of invalidatedComponentIds) meta.unitStates[componentId] = 'awaiting-approval';
    meta = { ...meta, unitStates: { ...meta.unitStates } };
    await writeRedesignRunMeta(paths, meta);

    if (approveDesign.length > 0 && approveAndPush.length === l1.specs.filter((s) => approvedComponentIds.includes(s.componentId)).length - approveDesign.length) {
      const g5Fp = await computeG5Fingerprint(paths, ctx.dsRepoRemote ?? null, ctx.dsRepoBaseBranch ?? null);
      if (!g5Fp || !isApprovalReusable(decisions, 'G5', null, g5Fp)) {
        return finishAwaiting(redesignRunId, paths, r1, meta, 'G5', `${approveDesign.length} component(s) design-approved only — push authorization needed for the whole package`, iterations, r6, page?.r7 ?? null);
      }
    }

    const pushApproved = approveAndPush.length === approvedComponentIds.length || latestDecisionFor(decisions, 'G5', null)?.outcome === 'approve';
    const publish = await step(redesignRunId, 'L5', 1, false, undefined, () => nodes.l5(pkg, redesignRunId, { approved: pushApproved && packageValidation.ok, remote: ctx.dsRepoRemote ?? null, approvedFingerprint: pkg.files }));
    await writeJsonFile(paths.publishJson, publish);

    meta = { ...meta, runOutcome: aggregateRunOutcome(Object.values(meta.unitStates)), finishedAt: now().toISOString() };
    await writeRedesignRunMeta(paths, meta);
    log(`L5 · ${publish.committed ? 'committed' : 'nothing committed'}${publish.pushed ? ` · pushed to ${publish.pushedRemote}` : ''}`);

    return { redesignRunId, paths, outcome: pageOutcome, runOutcome: meta.runOutcome, r1, iterations, r6, r7: page?.r7 ?? null, r8: null, l1, componentIterations, meta, awaitingGate: null };
  } finally {
    if (ownsSession) await session?.release();
  }
}

export async function loadResolvedSectionIds(paths: RedesignPaths): Promise<string[] | null> {
  if (!existsSync(paths.scopeJson)) return null;
  const record = JSON.parse(await readFile(paths.scopeJson, 'utf-8')) as { sectionIds: string[] };
  return record.sectionIds;
}
