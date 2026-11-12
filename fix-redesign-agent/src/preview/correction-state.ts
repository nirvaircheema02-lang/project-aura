import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { BudgetTracker, type BudgetReset, type BudgetUsage, type CorrectionBudgetConfig } from '../fidelity/loop.ts';
import type { PlannerFeedbackItem } from '../fidelity/types.ts';
import type { TargetedEdit } from '../llm/schemas/r-nodes.ts';
import { StateSchema, type ResolutionFile } from '../resolution/schema.ts';
import { fingerprintOf } from '../session/fingerprint.ts';

/**
 * The corrections decided so far, kept across invocations so a resumed run neither forgets them nor multiplies the budget.
 * It is bound to a BASIS — the edits being replayed, the resolved targets and the baseline — and discarded the moment any
 * of them changes: a correction decided for one plan must never silently shape another.
 */

export const CORRECTION_STATE_VERSION = 1;

const BudgetUsageSchema = z.object({ cycles: z.number().int().min(0), verifications: z.number().int().min(0), elapsedMs: z.number().min(0), reserved: z.number().int().min(0) }) satisfies z.ZodType<BudgetUsage>;
const BudgetResetSchema = z.object({ at: z.string(), reason: z.string(), before: BudgetUsageSchema }) satisfies z.ZodType<BudgetReset>;

const PlannerFeedbackItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['target-not-met', 'default-regression', 'preserve-broken']),
  findingIds: z.array(z.string()).min(1),
  targetId: z.string().nullable(),
  property: z.string(),
  part: z.string().nullable(),
  state: StateSchema,
  viewport: z.enum(['desktop', 'mobile', 'any']),
  expected: z.string().nullable(),
  observed: z.string().nullable(),
  elementLabel: z.string(),
  sectionId: z.string(),
  constraint: z.string(),
}) satisfies z.ZodType<PlannerFeedbackItem>;

export const CorrectionStateSchema = z.object({
  schemaVersion: z.literal(CORRECTION_STATE_VERSION),
  basisHash: z.string(),
  /**
   * The basis of the edits R8 was LAST given (after any planner re-plans), which is what `preview --regenerate` can recompute from the run folder alone:
   * `basisHash` is that of the plan before the re-plans and cannot be recomputed there. Additive: absent = null.
   */
  appliedBasisHash: z.string().nullable().default(null),
  stateGuards: z.array(z.string()),
  droppedEdits: z.array(z.string()),
  droppedIslands: z.array(z.string()),
  /** One entry per planner re-plan already decided for this basis: the measured, element-level constraints it was given. A resumed run replays them (same requests, same cached judgments) instead of spending the budget again. */
  plannerPasses: z.array(z.array(z.string())),
  /** The structured form of the same passes (index-aligned with `plannerPasses`): what R3 needs to REOPEN the finding on a replay. Additive: a file written before it existed parses to `[]`, and its passes replay as strings only. */
  plannerFeedbacks: z.array(z.array(PlannerFeedbackItemSchema)).default([]),
  /** Budget already spent against this basis (planner re-plans and preview corrections draw from ONE budget). */
  cyclesUsed: z.number().int().min(0),
  verificationsUsed: z.number().int().min(0),
  /** ACTIVE time spent against this basis over every invocation (verification/correction work and fresh planner passes; waiting between invocations is not counted). Additive: a file from before it existed parses as 0. */
  elapsedMs: z.number().min(0).default(0),
  /** Verifications already counted in `verificationsUsed` that an authorized correction or re-plan reserved for its re-check and that have not started yet. Additive, default 0. */
  reservedVerifications: z.number().int().min(0).default(0),
  /** Every intentional reset of the spent budget for this basis, with what had been spent (the ONLY way usage ever goes down). Additive, default none. */
  budgetResets: z.array(BudgetResetSchema).default([]),
  updatedAt: z.string(),
});
export type CorrectionState = z.infer<typeof CorrectionStateSchema>;

export function emptyCorrectionState(basisHash: string, now: Date = new Date()): CorrectionState {
  return { schemaVersion: CORRECTION_STATE_VERSION, basisHash, appliedBasisHash: null, stateGuards: [], droppedEdits: [], droppedIslands: [], plannerPasses: [], plannerFeedbacks: [], cyclesUsed: 0, verificationsUsed: 0, elapsedMs: 0, reservedVerifications: 0, budgetResets: [], updatedAt: now.toISOString() };
}

/** What the corrections apply to. Timestamps and statuses are excluded: they change without changing the plan. */
export function basisHashOf(args: { edits: TargetedEdit[]; resolution: ResolutionFile | null; baselineSha256: string | null }): string {
  return fingerprintOf({
    edits: args.edits.map((e) => ({ f: e.findingId, s: e.selector, k: e.kind, p: e.property, v: e.value, r: e.removeValue, c: e.dsComponent, d: e.dsVariant })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    targets: (args.resolution?.targets ?? []).map((t) => ({ id: t.id, o: t.outcome, v: t.target?.value ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
    baseline: args.baselineSha256,
  });
}

/** What is stored: nothing, a good state, or a file that exists but cannot be trusted (`damaged` says why). */
export type StoredState = { state: CorrectionState; damaged: null } | { state: null; damaged: string | null };

export async function inspectCorrectionState(path: string): Promise<StoredState> {
  if (!existsSync(path)) return { state: null, damaged: null };
  try {
    const parsed = CorrectionStateSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? { state: parsed.data, damaged: null } : { state: null, damaged: `it does not match the state schema (${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ')})` };
  } catch (e) {
    return { state: null, damaged: `it is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** An unreadable or mismatched file yields null. Only for merging a write with what is on disk: OPENING the budget never starts from it (see {@link openCorrectionBudget}). */
export async function readCorrectionState(path: string): Promise<CorrectionState | null> {
  return (await inspectCorrectionState(path)).state;
}

let tmpCounter = 0;

/** Written to a temp file and renamed, so a crash mid-write can never leave a truncated file (which reads as "no state" and would refund the whole budget). */
export async function writeCorrectionState(path: string, state: CorrectionState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(CorrectionStateSchema.parse(state), null, 2));
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const usageOf = (s: CorrectionState): BudgetUsage => ({ cycles: s.cyclesUsed, verifications: s.verificationsUsed, elapsedMs: s.elapsedMs, reserved: s.reservedVerifications });

export interface OpenBudgetArgs {
  path: string;
  basisHash: string;
  /**
   * What `basisHash` is: the plan before any re-plan (the pipeline, default), or the edits R8 was last given (`preview --regenerate`, which only has the
   * saved run folder). Either must match the SAME stored state, or resume and regenerate would silently keep two separate budgets.
   */
  kind?: 'plan' | 'applied';
  config: CorrectionBudgetConfig;
  /** The ONE explicit way to start the spent budget over for the same plan (`--reset-budget`). Never implied by resume, regenerate or a re-run. */
  resetBudget?: boolean;
  now?: () => Date;
  /** The tracker's clock (monotonic ms); injectable so the time allowance is testable. */
  clock?: () => number;
  log?: (line: string) => void;
}

/**
 * The corrections decided so far together with the budget spent against them — the ONE place `resume` (the pipeline, including its planner
 * re-plans) and `preview --regenerate` get their tracker from and persist it to, so they can never disagree.
 *
 *  - Same basis: counters, reserved verifications and active time are restored. A different basis (edited plan, other targets, new
 *    baseline) discards the state and the budget starts over (logged); an unreadable file is not trusted either, and says so.
 *  - Every reservation and every closed active segment is written through the tracker's checkpoint before the work it pays for, together
 *    with the corrections known at that moment, in one atomic file write.
 *  - Writes never lower a counter below what the file already holds for the same basis (`max`), so a stale or concurrent writer cannot refund work.
 *  - Usage goes down only through `resetBudget`, which records what it reset (file, log line, tracker) and keeps the decided corrections.
 *
 * Time: only active segments count (the tracker's `active`); the wait between invocations — a judgment pause, a human gate, a closed laptop — never does.
 */
export class CorrectionStore {
  state: CorrectionState;
  readonly budget: BudgetTracker;
  private readonly path: string;
  private readonly now: () => Date;

  constructor(path: string, state: CorrectionState, budget: BudgetTracker, now: () => Date) {
    this.path = path;
    this.state = state;
    this.budget = budget;
    this.now = now;
    budget.bind(() => this.save().then(() => undefined));
  }

  /** Replaces the in-memory state (corrections decided, planner passes stored); it is written by the next `save()` or reservation, in the same write as the usage. */
  set(next: CorrectionState): void { this.state = next; }

  private saving: Promise<unknown> = Promise.resolve();

  /** Writes the corrections and the CURRENT usage (never below what the file holds for this basis) in one atomic write; returns what was stored. Writes never overlap. */
  save(): Promise<CorrectionState> {
    const run = this.saving.then(() => this.write());
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async write(): Promise<CorrectionState> {
    const disk = await readCorrectionState(this.path);
    const same = disk && disk.basisHash === this.state.basisHash ? disk : null;
    const u = this.budget.usage();
    const resets = (same?.budgetResets.length ?? 0) > this.budget.resets.length ? same!.budgetResets : this.budget.resets;
    const next: CorrectionState = {
      ...this.state,
      cyclesUsed: Math.max(u.cycles, this.state.cyclesUsed, same?.cyclesUsed ?? 0),
      verificationsUsed: Math.max(u.verifications, this.state.verificationsUsed, same?.verificationsUsed ?? 0),
      elapsedMs: Math.max(u.elapsedMs, this.state.elapsedMs, same?.elapsedMs ?? 0),
      reservedVerifications: u.reserved,
      budgetResets: [...resets],
      updatedAt: this.now().toISOString(),
    };
    await writeCorrectionState(this.path, next);
    this.state = next;
    return next;
  }
}

export async function openCorrectionBudget(args: OpenBudgetArgs): Promise<CorrectionStore> {
  const log = args.log ?? (() => {});
  const now = args.now ?? (() => new Date());
  const { state: stored, damaged } = await inspectCorrectionState(args.path);
  // A file that exists but cannot be read says nothing about what was spent. Treating it as "nothing spent" would refund the whole budget
  // (and the stored planner passes) without anyone asking: fail closed, and leave the file untouched. The explicit reset is the way out.
  if (damaged !== null && !args.resetBudget) throw new Error(`the stored correction state ${args.path} cannot be read (${damaged}), so the budget already spent for this run cannot be told and is NOT assumed to be zero. Restore the file, or start the budget over on purpose with --reset-budget (\`resume <id> --reset-budget\` / \`preview <id> --regenerate --reset-budget\`)`);
  const sameBasis = stored !== null && (stored.basisHash === args.basisHash || (args.kind === 'applied' && stored.appliedBasisHash === args.basisHash));
  if (stored && !sameBasis) log('correction · the plan, the resolved targets or the baseline changed since the stored corrections were decided: they are discarded and the budget starts over');
  let state = sameBasis ? stored : { ...emptyCorrectionState(args.basisHash, now()), ...(args.kind === 'applied' ? { appliedBasisHash: args.basisHash } : {}) };
  const spent = usageOf(state);
  if (args.resetBudget && (damaged !== null || spent.cycles > 0 || spent.verifications > 0 || spent.elapsedMs > 0)) {
    const reset: BudgetReset = { at: now().toISOString(), reason: damaged !== null ? 'explicit reset (--reset-budget) of an unreadable correction state: what had been spent is not known' : 'explicit reset (--reset-budget)', before: spent };
    state = { ...state, cyclesUsed: 0, verificationsUsed: 0, elapsedMs: 0, reservedVerifications: 0, budgetResets: [...state.budgetResets, reset], updatedAt: now().toISOString() };
    // written at once and unconditionally: the max-merge of later saves must not resurrect the usage that was just reset
    await writeCorrectionState(args.path, state);
    log(damaged !== null
      ? `correction · budget RESET on request (--reset-budget): the stored state was unreadable, so what had been spent is not known; the budget starts over`
      : `correction · budget RESET on request (--reset-budget): cycles ${spent.cycles}/${args.config.maxCycles}, verifications ${spent.verifications}/${args.config.maxVerifications}, ${Math.round(spent.elapsedMs / 1000)}s of active time were spent; the decided corrections are kept`);
  }
  const budget = new BudgetTracker(args.config, args.clock, { usage: usageOf(state), resets: state.budgetResets });
  return new CorrectionStore(args.path, state, budget, now);
}
