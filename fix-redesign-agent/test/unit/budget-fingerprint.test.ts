import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRedesignDirs, redesignPaths, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { computeG2Fingerprint } from '../../src/session/gate-fingerprints.ts';

/**
 * Spending budget is not a result: a `resume` after G2 re-runs R8, which spends a verification and so changes the correction log's counters, but
 * finds the same thing. If the counters decided whether an approval stands, every resume would invalidate the approval it follows.
 */

let root: string;
let paths: RedesignPaths;
const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fra-budget-fp-'));
  paths = redesignPaths(root, 'p', 'r-redesign-1');
  await ensureRedesignDirs(paths);
  writeFileSync(paths.redesignContentHtml, '<html>same</html>');
  writeFileSync(paths.validationResultsJson, '[]');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const log = (over: Record<string, unknown> = {}) => ({ stopReason: 'passed', cycles: [], required: { satisfied: true, open: [] }, verifications: 1, budget: { used: { cycles: 0, verifications: 1, elapsedMs: 900, reserved: 0 }, max: { maxCycles: 2, maxVerifications: 3, maxDurationMs: 900000 }, resets: [] }, ...over });

describe('computeG2Fingerprint and the correction budget', () => {
  it('a re-run that only spends more budget (counters, active time) keeps the approval valid', async () => {
    put(paths.correctionLogJson, log());
    const first = await computeG2Fingerprint(paths);
    put(paths.correctionLogJson, log({ verifications: 2, budget: { used: { cycles: 0, verifications: 2, elapsedMs: 41_000, reserved: 0 }, max: { maxCycles: 2, maxVerifications: 3, maxDurationMs: 900000 }, resets: [{ at: 'x', reason: 'explicit reset (--reset-budget)', before: { cycles: 1, verifications: 3, elapsedMs: 5, reserved: 0 } }] } }));
    expect(await computeG2Fingerprint(paths)).toBe(first);
  });

  it('a budget STOP that adds an open required item does invalidate it (that is a changed result)', async () => {
    put(paths.correctionLogJson, log());
    const first = await computeG2Fingerprint(paths);
    put(paths.correctionLogJson, log({ stopReason: 'budget-exhausted', required: { satisfied: false, open: ['verification budget exhausted: no new verification was allowed'] } }));
    expect(await computeG2Fingerprint(paths)).not.toBe(first);
  });
});
