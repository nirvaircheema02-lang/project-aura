import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/index.ts';
import { createRun } from '../../src/graph/state.ts';
import { projectNameFor, runPaths } from '../../src/output/run-store.ts';
import type { FixPlan, FixPlanEntry } from '../../src/output/fix-plan.ts';

/**
 * `fix-plan-import` as a real child process, against a real run folder and a real SQLite row.
 *
 * The load-bearing assertion in this file is the `data.json` hash: the entire point of the
 * sidecar design is that a reviewer's decisions can never edit audit truth, and the only honest
 * proof of that is comparing the file's bytes before and after every import path — including the
 * ones that fail.
 */

// EVERY test in this file spawns the real CLI as a child process. Under full-suite parallelism
// a spawn easily outlasts vitest's 5s default, so the budget is set once for the file rather
// than annotated onto twenty individual tests (cli-e2e.test.ts sets its own per-test for the
// same reason — these are process timings, not logic timings).
vi.setConfig({ testTimeout: 120_000 });

const REPO = join(import.meta.dirname, '..', '..');
const URL_UNDER_TEST = 'https://www.kenresearch.com/consulting/fix-plan-cli-test';
const RUN_ID = 'fix-plan-cli-test';
const KNOWN_IDS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];

let dataDir: string;
let paths: ReturnType<typeof runPaths>;
let dataJsonHash: string;

function runCli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/cli/index.ts', ...args], {
      cwd: REPO,
      env: { ...process.env, AUDIT_AGENT_DATA_DIR: dataDir, AI_MODE: 'no-api' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function entry(findingId: string, decision: FixPlanEntry['decision'] = 'fix'): FixPlanEntry {
  return { findingId, decision, decidedAt: '2026-09-18T10:00:00.000Z', decidedBy: null, note: null, source: 'html-report' };
}
function planFile(name: string, plan: unknown): string {
  const p = join(dataDir, name);
  writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}
function plan(entries: FixPlanEntry[], runId = RUN_ID): FixPlan {
  return { schemaVersion: 1, runId, updatedAt: null, entries };
}
function readPlanOnDisk(): FixPlan {
  return JSON.parse(readFileSync(paths.fixPlanJson, 'utf-8')) as FixPlan;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'fix-plan-cli-'));
  const db = openDb(join(dataDir, 'audit-agent.db'));
  createRun(db, { run_id: RUN_ID, run_type: 'single-page', url: URL_UNDER_TEST, ds_registry_version: 'ds-hash', policy_version: 'policy-1' });
  db.close();

  paths = runPaths(join(dataDir, 'projects'), projectNameFor(URL_UNDER_TEST), RUN_ID);
  mkdirSync(paths.runDir, { recursive: true });
  // Only the one field the importer cross-references: findings[].identity.findingId.
  writeFileSync(
    paths.dataJson,
    JSON.stringify({ run: { runId: RUN_ID }, findings: KNOWN_IDS.map((findingId) => ({ identity: { findingId } })) }, null, 2),
  );
  dataJsonHash = hashOf(paths.dataJson);
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => {
  if (existsSync(paths.fixPlanJson)) rmSync(paths.fixPlanJson);
});

describe('fix-plan-import — happy path', () => {
  it('imports a valid plan, writes it to the run folder, and reports counts by decision', async () => {
    const file = planFile('ok.json', plan([entry(KNOWN_IDS[0]!, 'fix'), entry(KNOWN_IDS[1]!, 'skip'), entry(KNOWN_IDS[2]!, 'keep_for_review')]));
    const { code, stdout } = await runCli(['fix-plan-import', RUN_ID, file]);
    expect(code).toBe(0);
    expect(stdout).toContain('Accepted:  3 of 3 entr(ies)');
    expect(stdout).toContain('1 fix · 1 skip · 1 keep for review (3 total)');
    expect(readPlanOnDisk().entries).toHaveLength(3);
    // The CLI stamps updatedAt at write time; a browser export leaves it null.
    expect(readPlanOnDisk().updatedAt).toEqual(expect.any(String));
  });

  it('defaults to the run folder\'s own fix-plan.json when no [file] is given', async () => {
    writeFileSync(paths.fixPlanJson, JSON.stringify(plan([entry(KNOWN_IDS[0]!)])));
    const { code, stdout } = await runCli(['fix-plan-import', RUN_ID]);
    expect(code).toBe(0);
    expect(stdout).toContain(paths.fixPlanJson);
    expect(stdout).toContain('Accepted:  1 of 1 entr(ies)');
  });

  it('fails clearly when no [file] is given and the run folder has no fix-plan.json', async () => {
    const { code, stderr } = await runCli(['fix-plan-import', RUN_ID]);
    expect(code).toBe(1);
    expect(stderr).toContain('no fix-plan.json found in the run folder');
  });
});

describe('fix-plan-import — merge vs replace', () => {
  it('merges by default: entries already on disk that the file never mentions are preserved', async () => {
    writeFileSync(paths.fixPlanJson, JSON.stringify(plan([entry(KNOWN_IDS[0]!, 'fix'), entry(KNOWN_IDS[1]!, 'skip')])));
    const file = planFile('merge.json', plan([entry(KNOWN_IDS[2]!, 'keep_for_review')]));
    const { code } = await runCli(['fix-plan-import', RUN_ID, file]);
    expect(code).toBe(0);
    expect(readPlanOnDisk().entries.map((e) => e.findingId).sort()).toEqual([...KNOWN_IDS].sort());
  });

  it('re-deciding a finding takes the incoming value on merge', async () => {
    writeFileSync(paths.fixPlanJson, JSON.stringify(plan([entry(KNOWN_IDS[0]!, 'skip')])));
    const file = planFile('redecide.json', plan([entry(KNOWN_IDS[0]!, 'fix')]));
    await runCli(['fix-plan-import', RUN_ID, file]);
    expect(readPlanOnDisk().entries).toEqual([expect.objectContaining({ findingId: KNOWN_IDS[0], decision: 'fix' })]);
  });

  it('--replace DROPS entries not in the file — the only way to retract a decision', async () => {
    writeFileSync(paths.fixPlanJson, JSON.stringify(plan([entry(KNOWN_IDS[0]!), entry(KNOWN_IDS[1]!)])));
    const file = planFile('replace.json', plan([entry(KNOWN_IDS[2]!, 'skip')]));
    const { code, stdout } = await runCli(['fix-plan-import', RUN_ID, file, '--replace']);
    expect(code).toBe(0);
    expect(stdout).toContain('replace (drops entries not in the file)');
    expect(readPlanOnDisk().entries).toEqual([expect.objectContaining({ findingId: KNOWN_IDS[2], decision: 'skip' })]);
  });
});

describe('fix-plan-import — refusals and warnings', () => {
  it('refuses a runId mismatch rather than importing into the wrong run', async () => {
    const file = planFile('wrong-run.json', plan([entry(KNOWN_IDS[0]!)], 'some-other-run'));
    const { code, stderr } = await runCli(['fix-plan-import', RUN_ID, file]);
    expect(code).toBe(1);
    expect(stderr).toContain('Refusing: the file\'s runId is "some-other-run"');
    expect(existsSync(paths.fixPlanJson)).toBe(false);
  });

  it('--ignore-run-id-mismatch overrides that refusal', async () => {
    const file = planFile('wrong-run-ok.json', plan([entry(KNOWN_IDS[0]!)], 'some-other-run'));
    const { code } = await runCli(['fix-plan-import', RUN_ID, file, '--ignore-run-id-mismatch']);
    expect(code).toBe(0);
    // Normalized onto THIS run — an imported plan never keeps a foreign runId.
    expect(readPlanOnDisk().runId).toBe(RUN_ID);
  });

  it('refuses an all-unknown-findingId file as a likely wrong-run import', async () => {
    const file = planFile('all-unknown.json', plan([entry('f'.repeat(32)), entry('e'.repeat(32))]));
    const { code, stderr } = await runCli(['fix-plan-import', RUN_ID, file]);
    expect(code).toBe(1);
    expect(stderr).toContain('none of the 2 findingId(s)');
    expect(existsSync(paths.fixPlanJson)).toBe(false);
  });

  it('reports and DROPS partially-unknown ids while importing the known ones', async () => {
    const file = planFile('partial.json', plan([entry(KNOWN_IDS[0]!), entry('d'.repeat(32))]));
    const { code, stdout } = await runCli(['fix-plan-import', RUN_ID, file]);
    expect(code).toBe(0);
    expect(stdout).toContain('Accepted:  1 of 2 entr(ies)');
    expect(stdout).toContain('Dropped:   1 entr(ies)');
    expect(readPlanOnDisk().entries.map((e) => e.findingId)).toEqual([KNOWN_IDS[0]]);
  });

  it('refuses a schema-invalid file with a field-specific message', async () => {
    const file = planFile('bad-enum.json', { schemaVersion: 1, runId: RUN_ID, updatedAt: null, entries: [{ ...entry(KNOWN_IDS[0]!), decision: 'maybe' }] });
    const { code, stderr } = await runCli(['fix-plan-import', RUN_ID, file]);
    expect(code).toBe(1);
    expect(stderr).toContain('entries.0.decision');
    expect(existsSync(paths.fixPlanJson)).toBe(false);
  });

  it('refuses unparseable JSON', async () => {
    const p = join(dataDir, 'broken.json');
    writeFileSync(p, '{ not json');
    const { code, stderr } = await runCli(['fix-plan-import', RUN_ID, p]);
    expect(code).toBe(1);
    expect(stderr).toContain('Could not read/parse');
  });

  it('refuses an unknown runId', async () => {
    const file = planFile('unknown-run.json', plan([entry(KNOWN_IDS[0]!)], 'no-such-run'));
    const { code, stderr } = await runCli(['fix-plan-import', 'no-such-run', file]);
    expect(code).toBe(1);
    expect(stderr).toContain('No run no-such-run.');
  });
});

describe('fix-plan-import — --dry-run', () => {
  it('validates and reports but writes nothing', async () => {
    const file = planFile('dry.json', plan([entry(KNOWN_IDS[0]!), entry(KNOWN_IDS[1]!, 'skip')]));
    const { code, stdout } = await runCli(['fix-plan-import', RUN_ID, file, '--dry-run']);
    expect(code).toBe(0);
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain('Dry run — nothing written.');
    expect(existsSync(paths.fixPlanJson)).toBe(false);
  });

  it('leaves an EXISTING fix-plan.json untouched', async () => {
    writeFileSync(paths.fixPlanJson, JSON.stringify(plan([entry(KNOWN_IDS[0]!, 'skip')])));
    const before = hashOf(paths.fixPlanJson);
    const file = planFile('dry2.json', plan([entry(KNOWN_IDS[1]!, 'fix')]));
    await runCli(['fix-plan-import', RUN_ID, file, '--dry-run']);
    expect(hashOf(paths.fixPlanJson)).toBe(before);
  });
});

describe('fix-plan-import — data.json is never mutated', () => {
  it('is byte-for-byte identical after every import path, successful and refused alike', async () => {
    const files = [
      planFile('h1.json', plan([entry(KNOWN_IDS[0]!), entry(KNOWN_IDS[1]!, 'skip')])),
      planFile('h2.json', plan([entry(KNOWN_IDS[2]!, 'keep_for_review')])),
      planFile('h3.json', plan([entry(KNOWN_IDS[0]!)], 'wrong-run')),
      planFile('h4.json', plan([entry('9'.repeat(32))])),
    ];
    await runCli(['fix-plan-import', RUN_ID, files[0]!]);
    await runCli(['fix-plan-import', RUN_ID, files[1]!]);
    await runCli(['fix-plan-import', RUN_ID, files[2]!]); // refused
    await runCli(['fix-plan-import', RUN_ID, files[3]!]); // refused
    await runCli(['fix-plan-import', RUN_ID, files[0]!, '--replace']);
    await runCli(['fix-plan-import', RUN_ID, files[0]!, '--dry-run']);
    expect(hashOf(paths.dataJson)).toBe(dataJsonHash);
  });

  it('prints the untouched data.json path as part of its own summary', async () => {
    const file = planFile('proof.json', plan([entry(KNOWN_IDS[0]!)]));
    const { stdout } = await runCli(['fix-plan-import', RUN_ID, file]);
    expect(stdout).toContain(`data.json untouched: ${paths.dataJson}`);
  });
});

describe('find-run — resolving a run by id or name', () => {
  it('resolves by --run-id and prints one JSON line on exit 0', async () => {
    const { code, stdout } = await runCli(['find-run', '--run-id', RUN_ID]);
    expect(code).toBe(0);
    const line = stdout.trim().split('\n').at(-1)!;
    expect(JSON.parse(line)).toMatchObject({ runId: RUN_ID, runDir: paths.runDir });
  });

  it('exits 1 with no match', async () => {
    const { code, stderr } = await runCli(['find-run', '--run-id', 'nope']);
    expect(code).toBe(1);
    expect(stderr).toContain('No run matching');
  });

  it('refuses both identifiers at once, and neither', async () => {
    expect((await runCli(['find-run', '--run-id', RUN_ID, '--run-name', 'x'])).code).toBe(1);
    expect((await runCli(['find-run'])).code).toBe(1);
  });
});
