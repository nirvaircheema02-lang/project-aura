import { describe, expect, it } from 'vitest';
import { BudgetTracker, runCorrectionLoop, type BudgetUsage, type LoopArgs } from '../../src/fidelity/loop.ts';
import type { CorrectionFeedback } from '../../src/fidelity/types.ts';

/**
 * The correction loop honours the budget BEFORE the expensive step, not after: with the verification allowance (or the time) gone it
 * performs zero verification work, returns the previous evidence it was handed, and never calls that a pass.
 */

const cfg = (over: Partial<{ maxCycles: number; maxVerifications: number; maxDurationMs: number | null }> = {}) => ({ maxCycles: 2, maxVerifications: 3, maxDurationMs: null as number | null, ...over });

const open = (id: string, correctable = true): CorrectionFeedback => ({
  id, kind: 'state-regression', sectionId: 's', viewport: 'desktop', elementKey: 'e', elementLabel: 'Card', state: 'hover', property: 'color', expected: 'a', observed: 'b', findingIds: ['f1'],
  message: `Card ${id}`, responsible: correctable ? 'preview-generator' : 'none',
  action: correctable ? { type: 'state-guard', findingId: 'f1', property: 'color' } : null, blockedReason: correctable ? null : 'no representation',
});

interface Ev { open: string[] }
const feedbackOf = (v: Ev): CorrectionFeedback[] => v.open.map((id) => open(id));

/** A loop whose i-th verification returns `script[i]` (the last repeats). Counts every verification and correction it is asked for. */
function harness(script: Ev[], budget: BudgetTracker, extra: Partial<LoopArgs<Ev, number>> = {}) {
  const calls = { verify: 0, correct: 0 };
  const args: LoopArgs<Ev, number> = {
    initial: 0, budget,
    verify: async () => { calls.verify++; return script[Math.min(calls.verify - 1, script.length - 1)]!; },
    feedback: feedbackOf,
    correct: async (s) => { calls.correct++; return { state: s + 1, applied: ['state-guard f1/color'] }; },
    ...extra,
  };
  return { args, calls };
}

describe('runCorrectionLoop — the budget is checked before the first verification', () => {
  it('at 3/3 verifications another call performs ZERO verification work and is not a pass', async () => {
    const b = new BudgetTracker(cfg());
    b.verifications = 3;
    const h = harness([{ open: [] }], b);
    const r = await runCorrectionLoop(h.args);
    expect(h.calls).toEqual({ verify: 0, correct: 0 });
    expect(r.stopReason).toBe('budget-exhausted');
    expect(r.budgetReason).toBe('verifications');
    expect(r.final).toBeNull();
    expect(r.verifications).toBe(3); // not 4
    expect(b.verifications).toBe(3);
    expect(r.cycles).toEqual([]);
  });

  it('with the active time already spent it performs zero verification work (reason: time)', async () => {
    const b = new BudgetTracker(cfg({ maxDurationMs: 1000 }), () => 0, { usage: { elapsedMs: 1000 } });
    const h = harness([{ open: [] }], b);
    const r = await runCorrectionLoop(h.args);
    expect(h.calls.verify).toBe(0);
    expect(r.stopReason).toBe('budget-exhausted');
    expect(r.budgetReason).toBe('time');
  });

  it('hands back the previous evidence it was given and what remains open in it — and a previous that had passed is still not a "passed" stop', async () => {
    const b = new BudgetTracker(cfg());
    b.verifications = 3;
    const withOpen = await runCorrectionLoop(harness([{ open: [] }], b, { previous: { open: ['d1', 'd2'] } }).args);
    expect(withOpen.final).toEqual({ open: ['d1', 'd2'] });
    expect(withOpen.open.map((o) => o.id)).toEqual(['d1', 'd2']);
    expect(withOpen.stopReason).toBe('budget-exhausted');

    const previousPassed = await runCorrectionLoop(harness([{ open: [] }], b, { previous: { open: [] } }).args);
    expect(previousPassed.stopReason).toBe('budget-exhausted'); // nothing was verified now
    expect(previousPassed.final).toEqual({ open: [] });
    expect(previousPassed.open).toEqual([]);
  });

  it('a cycle cap that is spent does not block the FIRST verification (it is not the verification allowance)', async () => {
    const b = new BudgetTracker(cfg());
    b.cycles = 2;
    const h = harness([{ open: ['d1'] }], b);
    const r = await runCorrectionLoop(h.args);
    expect(h.calls.verify).toBe(1);
    expect(r.stopReason).toBe('budget-exhausted');
    expect(r.budgetReason).toBe('cycles');
    expect(r.final).toEqual({ open: ['d1'] });
    expect(r.open.map((o) => o.id)).toEqual(['d1']); // retained, not dropped
  });

  it('a normal first verification still runs and passes', async () => {
    const b = new BudgetTracker(cfg());
    const h = harness([{ open: [] }], b);
    const r = await runCorrectionLoop(h.args);
    expect(h.calls).toEqual({ verify: 1, correct: 0 });
    expect(r.stopReason).toBe('passed');
    expect(r.final).toEqual({ open: [] });
    expect(r.verifications).toBe(1);
  });

  it('an allowed correction and its re-verification still run (cycle 1, verification 2)', async () => {
    const b = new BudgetTracker(cfg());
    const h = harness([{ open: ['d1'] }, { open: [] }], b);
    const r = await runCorrectionLoop(h.args);
    expect(h.calls).toEqual({ verify: 2, correct: 1 });
    expect(r.stopReason).toBe('passed');
    expect(r.cycles).toHaveLength(1);
    expect(b.usage()).toMatchObject({ cycles: 1, verifications: 2, reserved: 0 });
  });

  it('no correction starts when its re-verification could not be afforded (verification 2 of 2 already spent), and the open item is retained', async () => {
    const b = new BudgetTracker(cfg({ maxVerifications: 1 }));
    const h = harness([{ open: ['d1'] }], b);
    const r = await runCorrectionLoop(h.args);
    expect(h.calls).toEqual({ verify: 1, correct: 0 });
    expect(r.stopReason).toBe('budget-exhausted');
    expect(r.budgetReason).toBe('verifications');
    expect(r.open.map((o) => o.id)).toEqual(['d1']);
  });

  it('an authorized correction gets its re-verification even when the deadline passed during the correction; the NEXT correction is then refused', async () => {
    let t = 0;
    const b = new BudgetTracker(cfg({ maxDurationMs: 1000, maxVerifications: 9, maxCycles: 9 }), () => t);
    const h = harness([{ open: ['d1'] }, { open: ['d2'] }], b, { correct: async (s) => { t += 5000; return { state: s + 1, applied: ['x'] }; } });
    const r = await runCorrectionLoop(h.args);
    expect(h.calls.verify).toBe(2); // the recheck of the authorized correction ran
    expect(r.stopReason).toBe('budget-exhausted');
    expect(r.budgetReason).toBe('time');
    expect(r.open.map((o) => o.id)).toEqual(['d2']);
  });

  it('keeps the no-progress stop: the same item still open after a correction ends the loop, the budget untouched beyond what it used', async () => {
    const b = new BudgetTracker(cfg({ maxCycles: 5, maxVerifications: 9 }));
    const h = harness([{ open: ['d1'] }], b);
    const r = await runCorrectionLoop(h.args);
    expect(r.stopReason).toBe('no-progress');
    expect(h.calls.verify).toBe(2);
  });
});

describe('runCorrectionLoop — consumed work is persisted before it is done, and a failure cannot refund it', () => {
  it('the verification is counted and checkpointed BEFORE verify starts', async () => {
    const b = new BudgetTracker(cfg());
    const seen: BudgetUsage[] = [];
    b.bind(async (u) => { seen.push(u); });
    let atStart: BudgetUsage | undefined;
    const h = harness([{ open: [] }], b, { verify: async () => { atStart = seen.at(-1); return { open: [] }; } });
    await runCorrectionLoop(h.args);
    expect(atStart).toMatchObject({ verifications: 1 });
  });

  it('a verification that throws leaves its reservation spent and its active time recorded', async () => {
    let t = 0;
    const b = new BudgetTracker(cfg({ maxDurationMs: 60_000 }), () => t);
    const seen: BudgetUsage[] = [];
    b.bind(async (u) => { seen.push(u); });
    const h = harness([{ open: [] }], b, { verify: async () => { t += 400; throw new Error('chromium crashed'); } });
    await expect(runCorrectionLoop(h.args)).rejects.toThrow('chromium crashed');
    expect(b.usage()).toMatchObject({ verifications: 1, elapsedMs: 400 });
    expect(seen.at(-1)).toMatchObject({ verifications: 1, elapsedMs: 400 });
  });

  it('a correction cycle is checkpointed with its re-verification before the correction runs', async () => {
    const b = new BudgetTracker(cfg());
    const seen: BudgetUsage[] = [];
    b.bind(async (u) => { seen.push(u); });
    let atCorrect: BudgetUsage | undefined;
    const h = harness([{ open: ['d1'] }, { open: [] }], b, { correct: async (s) => { atCorrect = seen.at(-1); return { state: s + 1, applied: ['x'] }; } });
    await runCorrectionLoop(h.args);
    expect(atCorrect).toMatchObject({ cycles: 1, verifications: 2 });
  });
});
