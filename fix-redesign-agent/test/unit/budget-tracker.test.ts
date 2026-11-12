import { describe, expect, it } from 'vitest';
import { BudgetTracker, type BudgetUsage } from '../../src/fidelity/loop.ts';

/**
 * The ONE correction budget as a unit: the questions "may a verification start?" and "may a correction start?" are
 * different questions (a correction needs its own re-verification), time is ACTIVE time summed over invocations, and every
 * reservation is persisted through the checkpoint BEFORE the expensive step it pays for.
 */

const cfg = (over: Partial<{ maxCycles: number; maxVerifications: number; maxDurationMs: number | null }> = {}) => ({ maxCycles: 2, maxVerifications: 3, maxDurationMs: 1000 as number | null, ...over });

function clockOf() {
  let t = 5_000; // an arbitrary, non-zero epoch: nothing may depend on it
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('BudgetTracker — separate questions', () => {
  it('canVerify depends on the verification allowance and the time; canCorrect additionally on the cycle cap', () => {
    const c = clockOf();
    const fresh = new BudgetTracker(cfg(), c.now);
    expect(fresh.canVerify()).toBe(true);
    expect(fresh.canCorrect()).toBe(true);
    expect(fresh.exhausted()).toBeNull();

    const verificationsGone = new BudgetTracker(cfg(), c.now, { usage: { verifications: 3 } });
    expect(verificationsGone.canVerify()).toBe(false);
    expect(verificationsGone.canCorrect()).toBe(false); // a correction needs its re-verification: no slot, no correction
    expect(verificationsGone.exhausted()).toBe('verifications');

    const cyclesGone = new BudgetTracker(cfg(), c.now, { usage: { cycles: 2 } });
    expect(cyclesGone.canVerify()).toBe(true); // the cycle cap is NOT the verification allowance
    expect(cyclesGone.canCorrect()).toBe(false);
    expect(cyclesGone.exhausted()).toBe('cycles');

    const timeGone = new BudgetTracker(cfg(), c.now, { usage: { elapsedMs: 1000 } });
    expect(timeGone.canVerify()).toBe(false);
    expect(timeGone.canCorrect()).toBe(false);
    expect(timeGone.exhausted()).toBe('time');
  });

  it('exhausted() keeps the reason order cycles, verifications, time', () => {
    const c = clockOf();
    expect(new BudgetTracker(cfg(), c.now, { usage: { cycles: 2, verifications: 3, elapsedMs: 5000 } }).exhausted()).toBe('cycles');
    expect(new BudgetTracker(cfg(), c.now, { usage: { verifications: 3, elapsedMs: 5000 } }).exhausted()).toBe('verifications');
    expect(new BudgetTracker(cfg({ maxDurationMs: null }), c.now, { usage: { elapsedMs: 9e9 } }).exhausted()).toBeNull();
  });
});

describe('BudgetTracker — reservations are counted and persisted BEFORE the work', () => {
  it('reserveVerification increments and awaits the checkpoint with the new count', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now);
    const seen: BudgetUsage[] = [];
    b.bind(async (u) => { await Promise.resolve(); seen.push(u); });
    await b.reserveVerification();
    expect(b.verifications).toBe(1);
    expect(seen.at(-1)).toMatchObject({ verifications: 1, cycles: 0 });
  });

  it('reserveCorrection spends a cycle AND the verification that re-checks it; the next reserveVerification consumes that reservation instead of spending another', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now, { usage: { verifications: 1 } });
    await b.reserveCorrection();
    expect(b.usage()).toMatchObject({ cycles: 1, verifications: 2, reserved: 1 });
    await b.reserveVerification();
    expect(b.usage()).toMatchObject({ cycles: 1, verifications: 2, reserved: 0 });
  });

  it('an authorized correction keeps its reserved verification even if the time ran out meanwhile', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now, { usage: { verifications: 1 } });
    await b.reserveCorrection();
    await b.active(async () => { c.advance(5000); });
    expect(b.timeUp()).toBe(true);
    expect(b.canVerify()).toBe(true); // reserved
    await b.reserveVerification();
    expect(b.canVerify()).toBe(false); // and now it is gone
  });

  it('refuses a reservation the budget does not allow (the caller must have checked), without spending anything', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now, { usage: { verifications: 3 } });
    await expect(b.reserveVerification()).rejects.toThrow(/verifications/);
    await expect(b.reserveCorrection()).rejects.toThrow(/verifications/);
    expect(b.usage()).toMatchObject({ verifications: 3, cycles: 0, reserved: 0 });
  });

  it('a checkpoint that cannot be written fails the reservation, but the spent count is not refunded', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now);
    b.bind(async () => { throw new Error('disk full'); });
    await expect(b.reserveVerification()).rejects.toThrow(/disk full/);
    expect(b.verifications).toBe(1);
  });
});

describe('BudgetTracker — time is ACTIVE time, summed across invocations', () => {
  it('counts only the time inside active(); waiting between segments (a judgment pause, a human gate) is not counted', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg({ maxDurationMs: 10_000 }), c.now);
    await b.active(async () => { c.advance(300); });
    c.advance(3_600_000); // an hour at a human gate
    await b.active(async () => { c.advance(200); });
    expect(b.elapsedMs()).toBe(500);
    expect(b.timeUp()).toBe(false);
  });

  it('a new invocation restores the active time already spent: the allowance does not restart', async () => {
    const c1 = clockOf();
    const first = new BudgetTracker(cfg(), c1.now);
    await first.active(async () => { c1.advance(700); });
    const persisted = first.usage();
    expect(persisted.elapsedMs).toBe(700);

    const c2 = clockOf(); // a different process, a different clock origin
    const second = new BudgetTracker(cfg(), c2.now, { usage: persisted });
    expect(second.elapsedMs()).toBe(700);
    expect(second.timeUp()).toBe(false);
    await second.active(async () => { c2.advance(299); });
    expect(second.timeUp()).toBe(false);
    await second.active(async () => { c2.advance(1); });
    expect(second.timeUp()).toBe(true); // 700 + 299 + 1
  });

  it('time inside a running segment already counts toward timeUp() (a verification in flight stops capturing at the deadline)', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now);
    await b.active(async () => {
      expect(b.timeUp()).toBe(false);
      c.advance(1000);
      expect(b.timeUp()).toBe(true);
    });
  });

  it('a segment that throws still records its time (a failure cannot refund it) and rethrows the original error', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now);
    const seen: BudgetUsage[] = [];
    b.bind(async (u) => { seen.push(u); });
    await expect(b.active(async () => { c.advance(400); throw new Error('chromium crashed'); })).rejects.toThrow('chromium crashed');
    expect(b.elapsedMs()).toBe(400);
    expect(seen.at(-1)?.elapsedMs).toBe(400);
  });

  it('a failing checkpoint on the error path does not mask the original error', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now);
    b.bind(async () => { throw new Error('disk full'); });
    await expect(b.active(async () => { throw new Error('chromium crashed'); })).rejects.toThrow('chromium crashed');
  });

  it('nested active() segments are counted once', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg(), c.now);
    await b.active(async () => { c.advance(100); await b.active(async () => { c.advance(100); }); c.advance(100); });
    expect(b.elapsedMs()).toBe(300);
  });

  it('with no deadline, time never stops anything', async () => {
    const c = clockOf();
    const b = new BudgetTracker(cfg({ maxDurationMs: null }), c.now, { usage: { elapsedMs: 9e9 } });
    expect(b.timeUp()).toBe(false);
    expect(b.canVerify()).toBe(true);
  });
});
