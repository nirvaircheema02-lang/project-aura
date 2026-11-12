import type { CorrectionFeedback } from './types.ts';

/**
 * ONE overall budget for every kind of retry that happens after the preview exists: verification
 * runs, preview-generator corrections AND planner re-plans all draw from this single tracker, so
 * independent retry loops can never multiply into unbounded work.
 */
export interface CorrectionBudgetConfig {
  /** Correction cycles (a cycle = apply corrections, regenerate/re-render, re-verify). Planner re-plans count as cycles. */
  maxCycles: number;
  /** Full verification runs, including the first. */
  maxVerifications: number;
  /** ACTIVE-time allowance for the whole correction phase, in ms, summed over every invocation of the same run and plan; null = no deadline. */
  maxDurationMs: number | null;
}

export const DEFAULT_CORRECTION_BUDGET: CorrectionBudgetConfig = { maxCycles: 2, maxVerifications: 3, maxDurationMs: 15 * 60_000 };

export type BudgetReason = 'cycles' | 'verifications' | 'time';

/** What has been spent so far against a run and plan. This is exactly what is persisted (correction-state.json) at every checkpoint. */
export interface BudgetUsage {
  cycles: number;
  verifications: number;
  /** Active time (see {@link BudgetTracker.active}) summed over all invocations so far. */
  elapsedMs: number;
  /** Verifications already counted in `verifications` that an authorized correction / re-plan has reserved but not yet started. */
  reserved: number;
}

/** An intentional reset of the spent budget, kept so it can never be mistaken for a silent refund. */
export interface BudgetReset {
  at: string;
  reason: string;
  /** What had been spent when it was reset. */
  before: BudgetUsage;
}

export type BudgetCheckpoint = (usage: BudgetUsage) => Promise<void>;

/** How often the active time of a running segment is written to disk, so a hard kill (Ctrl-C, SIGKILL) loses at most this much of it. */
export const DEFAULT_CHECKPOINT_EVERY_MS = 30_000;

/**
 * Three different questions, deliberately not one:
 *  - `canVerify()`  may a verification START? (verification allowance and time; a reservation always may)
 *  - `canCorrect()` may a correction / re-plan START? (cycle cap AND a verification slot left to re-check it: an authorized correction
 *    always gets its verification, so it is reserved together with the cycle)
 *  - `exhausted()`  which limit, if any, stops a new correction (reason order: cycles, verifications, time).
 * Every reservation is counted and handed to the checkpoint BEFORE the expensive step it pays for, so a crash, a pause or a failure
 * inside that step cannot refund it. Time is ACTIVE time: it runs only inside {@link active} segments (verification and correction work,
 * fresh planner passes) and accumulates across invocations; waiting between invocations (a judgment pause, a human gate) is not counted.
 */
export class BudgetTracker {
  readonly config: CorrectionBudgetConfig;
  cycles = 0;
  verifications = 0;
  reserved = 0;
  readonly resets: BudgetReset[];
  private priorMs = 0;
  private segmentStart: number | null = null;
  private depth = 0;
  private readonly clock: () => number;
  private readonly checkpointEveryMs: number;
  private checkpoint: BudgetCheckpoint | null = null;
  /** Checkpoints run one after another (never two writes of the state file at once). */
  private queue: Promise<void> = Promise.resolve();
  private ticking = false;

  constructor(config: CorrectionBudgetConfig = DEFAULT_CORRECTION_BUDGET, clock: () => number = () => performance.now(), restored: { usage?: Partial<BudgetUsage>; resets?: BudgetReset[] } = {}, opts: { checkpointEveryMs?: number } = {}) {
    this.config = config;
    this.clock = clock;
    this.checkpointEveryMs = opts.checkpointEveryMs ?? DEFAULT_CHECKPOINT_EVERY_MS;
    this.cycles = restored.usage?.cycles ?? 0;
    this.verifications = restored.usage?.verifications ?? 0;
    this.reserved = restored.usage?.reserved ?? 0;
    this.priorMs = restored.usage?.elapsedMs ?? 0;
    this.resets = [...(restored.resets ?? [])];
  }

  /** Where every reservation, every closed active segment and (periodically) a running one is written. */
  bind(checkpoint: BudgetCheckpoint): void { this.checkpoint = checkpoint; }

  /** Writes the usage as it is when the write runs (never an older figure), strictly after any write still in flight. */
  private persist(): Promise<void> {
    const run = this.queue.then(() => this.checkpoint?.(this.usage()));
    this.queue = run.then(() => undefined, () => undefined);
    return run.then(() => undefined);
  }

  elapsedMs(): number { return this.priorMs + (this.segmentStart === null ? 0 : Math.max(0, this.clock() - this.segmentStart)); }

  usage(): BudgetUsage { return { cycles: this.cycles, verifications: this.verifications, elapsedMs: Math.round(this.elapsedMs()), reserved: this.reserved }; }

  /** True once the active-time allowance is spent; a capture in flight stops early on it. */
  timeUp(): boolean { return this.config.maxDurationMs !== null && this.elapsedMs() >= this.config.maxDurationMs; }

  /** Why a NEW verification may not start, or null. A reserved one (granted with a correction) may always start. */
  verifyBlock(): BudgetReason | null {
    if (this.reserved > 0) return null;
    if (this.verifications >= this.config.maxVerifications) return 'verifications';
    return this.timeUp() ? 'time' : null;
  }

  canVerify(): boolean { return this.verifyBlock() === null; }

  /** The reason no further correction may start, or null. A verification already in flight is never cut short. */
  exhausted(): BudgetReason | null {
    if (this.cycles >= this.config.maxCycles) return 'cycles';
    if (this.verifications >= this.config.maxVerifications) return 'verifications';
    return this.timeUp() ? 'time' : null;
  }

  canCorrect(): boolean { return this.exhausted() === null; }

  /** Spend one verification (or consume the one reserved with a correction) and persist it before the caller starts the work. */
  async reserveVerification(): Promise<void> {
    if (this.reserved > 0) this.reserved--;
    else {
      const why = this.verifyBlock();
      if (why) throw new Error(`correction budget: no verification may start (${why}); the caller must check canVerify() first`);
      this.verifications++;
    }
    await this.persist();
  }

  /** Spend one cycle AND the verification that re-checks it, persisted together before the correction / re-plan starts. */
  async reserveCorrection(): Promise<void> {
    const why = this.exhausted();
    if (why) throw new Error(`correction budget: no correction may start (${why}); the caller must check canCorrect() first`);
    this.cycles++;
    this.verifications++;
    this.reserved++;
    await this.persist();
  }

  /**
   * Runs `fn` as active work: its time counts, and the usage is checkpointed when it ends — also when it throws or pauses (a judgment pause
   * is a thrown error), so a failure cannot erase the time it took — and every `checkpointEveryMs` while it runs, so a hard kill (Ctrl-C,
   * SIGKILL) cannot erase it either. The original error is never masked by a failing checkpoint, and a periodic checkpoint that fails is
   * simply retried by the next tick or by the closing one.
   */
  async active<T>(fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (this.depth++ === 0) {
      this.segmentStart = this.clock();
      if (this.checkpoint && this.checkpointEveryMs > 0) {
        timer = setInterval(() => {
          if (this.ticking) return; // a slow write is not started again on top of itself
          this.ticking = true;
          this.persist().catch(() => {}).finally(() => { this.ticking = false; });
        }, this.checkpointEveryMs);
        (timer as { unref?: () => void }).unref?.();
      }
    }
    let failed = false;
    try {
      return await fn();
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      if (timer) clearInterval(timer);
      if (--this.depth === 0) {
        this.priorMs = this.elapsedMs();
        this.segmentStart = null;
        const saved = this.persist();
        await (failed ? saved.catch(() => {}) : saved);
      }
    }
  }
}

export type StopReason = 'passed' | 'blocked' | 'no-progress' | 'budget-exhausted' | 'planner-needed';

export interface LoopCycle {
  cycle: number;
  feedbackIds: string[];
  applied: string[];
  blockedIds: string[];
  durationMs: number;
}

export interface LoopResult<V, S> {
  /** The last verification — the one that decides. When the budget allowed no verification at all it is the `previous` evidence the caller handed in, or null when there was none: the caller then reports every required check as unverified. */
  final: V | null;
  state: S;
  stopReason: StopReason;
  /** Why the budget stopped it, when it did. */
  budgetReason: BudgetReason | null;
  cycles: LoopCycle[];
  /** Feedback still open at the end (never dropped to make the loop terminate); with no verification allowed, what is open in `previous`. */
  open: CorrectionFeedback[];
  /** The subset that needs the planner (the caller decides whether budget remains for it). */
  plannerFeedback: CorrectionFeedback[];
  verifications: number;
}

export interface LoopArgs<V, S> {
  initial: S;
  /** Run the full verification for this state (regenerate + render + measure). */
  verify: (state: S) => Promise<V>;
  feedback: (v: V) => CorrectionFeedback[];
  /** Apply the AUTOMATIC corrections (state guards, dropped components/edits…) and return the next state. The original baseline is never an argument here: it cannot be changed. */
  correct: (state: S, actionable: CorrectionFeedback[]) => Promise<{ state: S; applied: string[] }>;
  budget: BudgetTracker;
  /** Evidence from an earlier verification of the SAME state, kept and returned (never re-measured) when the budget allows no verification now. */
  previous?: V | null;
  log?: (line: string) => void;
}

/**
 * verify → feedback → correct → re-verify, until one of: required checks pass, a concrete blocker, no
 * progress, or the budget is exhausted. It never lowers an acceptance criterion, never edits the baseline,
 * and never reports a pass it did not measure: whatever is open when it stops is returned in `open`.
 *
 * The budget is consulted BEFORE the expensive step: with no verification left (allowance or time) it performs no verification work,
 * returns `previous` as the retained evidence and stops with `budget-exhausted` — never `passed`. Each verification and each correction
 * cycle (which reserves the verification that re-checks it) is counted and checkpointed before it starts, so a crash cannot refund it.
 */
export async function runCorrectionLoop<V, S>(args: LoopArgs<V, S>): Promise<LoopResult<V, S>> {
  const log = args.log ?? (() => {});
  const { budget } = args;
  let state = args.initial;
  const cycles: LoopCycle[] = [];

  const blocked = budget.verifyBlock();
  if (blocked) {
    log(`correction · no verification allowed (${blocked}): the previous evidence is kept, nothing is re-measured`);
    const kept = args.previous ?? null;
    const fb = kept ? args.feedback(kept) : [];
    return { final: kept, state, stopReason: 'budget-exhausted', budgetReason: blocked, cycles, open: fb, plannerFeedback: fb.filter((f) => f.action?.type === 'replan'), verifications: budget.verifications };
  }

  await budget.reserveVerification();
  let v = await budget.active(() => args.verify(state));
  let previousIds: Set<string> | null = null;

  for (;;) {
    const fb = args.feedback(v);
    const finish = (stopReason: StopReason, budgetReason: BudgetReason | null = null): LoopResult<V, S> => ({
      final: v, state, stopReason, budgetReason, cycles, open: fb, plannerFeedback: fb.filter((f) => f.action?.type === 'replan'), verifications: budget.verifications,
    });
    if (fb.length === 0) return finish('passed');
    const ids = new Set(fb.map((f) => f.id));
    // progress means at least one previously open item is now gone; an unchanged (or merely re-shuffled) set is no progress
    if (previousIds && [...previousIds].every((id) => ids.has(id))) { log(`correction · no progress: the same ${ids.size} item(s) are still open`); return finish('no-progress'); }
    const actionable = fb.filter((f) => f.action && f.action.type !== 'replan');
    if (actionable.length === 0) return finish(fb.some((f) => f.action?.type === 'replan') ? 'planner-needed' : 'blocked');
    const reason = budget.exhausted();
    if (reason) { log(`correction · budget exhausted (${reason})`); return finish('budget-exhausted', reason); }
    previousIds = ids;
    const t0 = Date.now();
    await budget.reserveCorrection();
    log(`correction · cycle ${budget.cycles}/${budget.config.maxCycles}: ${actionable.length} automatic correction(s) for ${fb.length} open item(s)`);
    const r = await budget.active(() => args.correct(state, actionable));
    state = r.state;
    cycles.push({ cycle: budget.cycles, feedbackIds: fb.map((f) => f.id), applied: r.applied, blockedIds: fb.filter((f) => !f.action).map((f) => f.id), durationMs: Date.now() - t0 });
    await budget.reserveVerification(); // consumes the verification reserved with the cycle
    v = await budget.active(() => args.verify(state));
  }
}
