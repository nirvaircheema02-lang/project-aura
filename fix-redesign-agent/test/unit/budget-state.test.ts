import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorrectionBudgetConfig } from '../../src/fidelity/loop.ts';
import { CorrectionStateSchema, emptyCorrectionState, openCorrectionBudget, readCorrectionState, writeCorrectionState } from '../../src/preview/correction-state.ts';

/**
 * ONE helper restores and persists the budget for `resume` AND `preview --regenerate` (and the planner re-plan loop): the same run and plan
 * keep their counters and their active time; a different basis starts over (logged); only an explicit reset zeroes them, and records that it did.
 */

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fra-budget-state-')); path = join(dir, 'context', 'correction-state.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config: CorrectionBudgetConfig = { maxCycles: 2, maxVerifications: 3, maxDurationMs: 1000 };
const fixedNow = () => new Date('2026-10-12T10:00:00.000Z');
function clockOf() { let t = 1_000; return { now: () => t, advance: (ms: number) => { t += ms; } }; }
const open = (over: Partial<Parameters<typeof openCorrectionBudget>[0]> = {}) => openCorrectionBudget({ path, basisHash: 'basis-1', config, now: fixedNow, ...over });

describe('openCorrectionBudget — restore', () => {
  it('starts empty when nothing is stored', async () => {
    const s = await open();
    expect(s.budget.usage()).toEqual({ cycles: 0, verifications: 0, elapsedMs: 0, reserved: 0 });
    expect(s.state.basisHash).toBe('basis-1');
  });

  it('restores counters and active time stored for the SAME basis', async () => {
    await writeCorrectionState(path, { ...emptyCorrectionState('basis-1'), cyclesUsed: 1, verificationsUsed: 2, elapsedMs: 640, reservedVerifications: 1, stateGuards: ['f1|color'] });
    const s = await open();
    expect(s.budget.usage()).toEqual({ cycles: 1, verifications: 2, elapsedMs: 640, reserved: 1 });
    expect(s.state.stateGuards).toEqual(['f1|color']);
  });

  it('a state file written before elapsedMs / reservedVerifications / budgetResets existed parses with zeros', async () => {
    const { elapsedMs: _e, reservedVerifications: _r, budgetResets: _b, ...legacy } = { ...emptyCorrectionState('basis-1'), cyclesUsed: 1, verificationsUsed: 2 };
    const parsed = CorrectionStateSchema.parse(legacy);
    expect(parsed).toMatchObject({ elapsedMs: 0, reservedVerifications: 0, budgetResets: [], cyclesUsed: 1, verificationsUsed: 2 });
  });

  it('DISCARDS a state bound to a different basis, with the existing log line, and starts the budget over', async () => {
    await writeCorrectionState(path, { ...emptyCorrectionState('other-basis'), cyclesUsed: 2, verificationsUsed: 3, elapsedMs: 900, plannerPasses: [['c']] });
    const lines: string[] = [];
    const s = await open({ log: (l) => lines.push(l) });
    expect(s.budget.usage()).toEqual({ cycles: 0, verifications: 0, elapsedMs: 0, reserved: 0 });
    expect(s.state.plannerPasses).toEqual([]);
    expect(lines.join('\n')).toMatch(/the plan, the resolved targets or the baseline changed since the stored corrections were decided: they are discarded and the budget starts over/);
  });

  it('does NOT silently refund when the stored file is unreadable: it refuses (fail closed) and names --reset-budget (see budget-review-fixes.test.ts)', async () => {
    await writeCorrectionState(path, emptyCorrectionState('basis-1'));
    writeFileSync(path, '{ not json');
    await expect(open()).rejects.toThrow(/cannot be read[\s\S]*--reset-budget/);
  });
});

describe('openCorrectionBudget — persist', () => {
  it('every reservation reaches the file before the work it pays for', async () => {
    const s = await open();
    await s.budget.reserveVerification();
    expect((await readCorrectionState(path))?.verificationsUsed).toBe(1);
    await s.budget.reserveCorrection();
    expect(await readCorrectionState(path)).toMatchObject({ cyclesUsed: 1, verificationsUsed: 2, reservedVerifications: 1 });
  });

  it('a second invocation (resume, then regenerate) continues from the first — counters are preserved, never reset or decreased', async () => {
    const first = await open();
    await first.budget.reserveVerification();
    await first.budget.reserveCorrection();
    await first.budget.reserveVerification(); // the recheck consumes the reservation
    expect(first.budget.usage()).toMatchObject({ cycles: 1, verifications: 2, reserved: 0 });

    const regenerate = await open(); // the same helper the CLI uses for `preview --regenerate`
    expect(regenerate.budget.usage()).toMatchObject({ cycles: 1, verifications: 2, reserved: 0 });
    await regenerate.budget.reserveVerification();
    expect((await readCorrectionState(path))?.verificationsUsed).toBe(3);

    const resume = await open();
    expect(resume.budget.verifications).toBe(3);
    expect(resume.budget.canVerify()).toBe(false);
  });

  it('never writes a counter below what is already on disk for the same basis', async () => {
    const stale = await open(); // an in-memory tracker that has seen nothing
    await writeCorrectionState(path, { ...emptyCorrectionState('basis-1'), cyclesUsed: 2, verificationsUsed: 3, elapsedMs: 800 });
    await stale.save();
    expect(await readCorrectionState(path)).toMatchObject({ cyclesUsed: 2, verificationsUsed: 3, elapsedMs: 800 });
  });

  it('save keeps the corrections and usage together in ONE file write and leaves no temp file behind', async () => {
    const s = await open();
    s.set({ ...s.state, stateGuards: ['f1|color'], plannerPasses: [['keep 12px']] });
    await s.budget.reserveVerification();
    expect(await readCorrectionState(path)).toMatchObject({ stateGuards: ['f1|color'], plannerPasses: [['keep 12px']], verificationsUsed: 1 });
    expect(readdirSync(join(dir, 'context'))).toEqual(['correction-state.json']);
  });

  it('the time allowance does not restart across invocations, and waiting between them is not counted', async () => {
    const c1 = clockOf();
    const first = await open({ clock: c1.now });
    await first.budget.active(async () => { c1.advance(600); });
    expect((await readCorrectionState(path))?.elapsedMs).toBe(600);

    const c2 = clockOf(); // a different process; a judgment pause / human gate of any length lies between the invocations
    const second = await open({ clock: c2.now });
    expect(second.budget.elapsedMs()).toBe(600);
    expect(second.budget.canVerify()).toBe(true);
    await second.budget.active(async () => { c2.advance(400); });
    expect(second.budget.timeUp()).toBe(true);
    expect((await readCorrectionState(path))?.elapsedMs).toBe(1000);

    const third = await open({ clock: clockOf().now });
    expect(third.budget.canVerify()).toBe(false); // a new process does not get a fresh 15 minutes
  });

  it('a failure or pause in the middle of a segment does not erase the usage', async () => {
    const c = clockOf();
    const s = await open({ clock: c.now });
    await s.budget.reserveVerification();
    await expect(s.budget.active(async () => { c.advance(250); throw new Error('awaiting judgment'); })).rejects.toThrow('awaiting judgment');
    expect(await readCorrectionState(path)).toMatchObject({ verificationsUsed: 1, elapsedMs: 250 });
  });
});

describe('openCorrectionBudget — resume and regenerate find the SAME state', () => {
  // the pipeline binds the state to the plan BEFORE any planner re-plan; `preview --regenerate` only has the edits R8 was last given
  const seed = () => writeCorrectionState(path, { ...emptyCorrectionState('plan-before-replans'), appliedBasisHash: 'edits-after-replans', cyclesUsed: 1, verificationsUsed: 2, elapsedMs: 300, plannerPasses: [['keep 12px']] });

  it('regenerate (kind: applied) restores the state the pipeline stored after a re-plan, instead of silently starting a second budget', async () => {
    await seed();
    const lines: string[] = [];
    const s = await open({ basisHash: 'edits-after-replans', kind: 'applied', log: (l) => lines.push(l) });
    expect(s.budget.usage()).toMatchObject({ cycles: 1, verifications: 2, elapsedMs: 300 });
    expect(s.state.basisHash).toBe('plan-before-replans'); // the state stays bound to the plan; regenerate does not rebind it
    expect(s.state.plannerPasses).toEqual([['keep 12px']]);
    expect(lines).toEqual([]);
    await s.budget.reserveVerification();
    expect(await readCorrectionState(path)).toMatchObject({ basisHash: 'plan-before-replans', verificationsUsed: 3, plannerPasses: [['keep 12px']] });
  });

  it('the pipeline (kind: plan) still finds it by the plan basis, and a plan basis is NOT matched by an applied-edits hash', async () => {
    await seed();
    expect((await open({ basisHash: 'plan-before-replans' })).budget.verifications).toBe(2);
    const lines: string[] = [];
    const other = await open({ basisHash: 'edits-after-replans', log: (l) => lines.push(l) }); // kind defaults to plan
    expect(other.budget.verifications).toBe(0);
    expect(lines.join('\n')).toMatch(/discarded/);
  });

  it('a regenerate whose edits differ from the stored ones still DISCARDS the state (materially changed inputs)', async () => {
    await seed();
    const lines: string[] = [];
    const s = await open({ basisHash: 'some-other-edits', kind: 'applied', log: (l) => lines.push(l) });
    expect(s.budget.usage()).toEqual({ cycles: 0, verifications: 0, elapsedMs: 0, reserved: 0 });
    expect(s.state.appliedBasisHash).toBe('some-other-edits');
    expect(lines.join('\n')).toMatch(/discarded and the budget starts over/);
  });
});

describe('openCorrectionBudget — the one explicit reset', () => {
  const seed = () => writeCorrectionState(path, { ...emptyCorrectionState('basis-1'), cyclesUsed: 2, verificationsUsed: 3, elapsedMs: 900, reservedVerifications: 0, stateGuards: ['f1|color'], plannerPasses: [['c']] });

  it('is never implicit: opening again (regenerate or resume) keeps the spent budget', async () => {
    await seed();
    const s = await open();
    expect(s.budget.usage()).toMatchObject({ cycles: 2, verifications: 3, elapsedMs: 900 });
    expect((await readCorrectionState(path))?.budgetResets).toEqual([]);
  });

  it('with the explicit flag it zeroes the usage, keeps the decided corrections, and RECORDS what was reset (file, log line, tracker)', async () => {
    await seed();
    const lines: string[] = [];
    const s = await open({ resetBudget: true, log: (l) => lines.push(l) });
    expect(s.budget.usage()).toEqual({ cycles: 0, verifications: 0, elapsedMs: 0, reserved: 0 });
    expect(s.state.stateGuards).toEqual(['f1|color']);
    expect(s.state.plannerPasses).toEqual([['c']]);
    const stored = await readCorrectionState(path);
    expect(stored).toMatchObject({ cyclesUsed: 0, verificationsUsed: 0, elapsedMs: 0 });
    expect(stored?.budgetResets).toEqual([{ at: '2026-10-12T10:00:00.000Z', reason: 'explicit reset (--reset-budget)', before: { cycles: 2, verifications: 3, elapsedMs: 900, reserved: 0 } }]);
    expect(s.budget.resets).toEqual(stored?.budgetResets);
    expect(lines.join('\n')).toMatch(/budget RESET on request.*cycles 2\/2.*verifications 3\/3/);
  });

  it('stays reset for later invocations (the old usage is not resurrected) and the history is kept', async () => {
    await seed();
    await open({ resetBudget: true });
    const later = await open();
    expect(later.budget.usage()).toMatchObject({ cycles: 0, verifications: 0 });
    expect(later.budget.resets).toHaveLength(1);
    await later.budget.reserveVerification();
    expect(existsSync(path) && (JSON.parse(readFileSync(path, 'utf8')) as { verificationsUsed: number }).verificationsUsed).toBe(1);
  });

  it('records nothing when there is nothing to reset (a first run, or a discarded state)', async () => {
    const s = await open({ resetBudget: true });
    expect(s.budget.resets).toEqual([]);
    expect((await readCorrectionState(path))?.budgetResets ?? []).toEqual([]);
  });
});
