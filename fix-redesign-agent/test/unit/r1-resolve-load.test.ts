import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runR1, sourceFilesUnchanged } from '../../src/agents/r1-resolve-load/index.ts';
import { ConfigSchema, type Config } from '../../src/config/schema.ts';
import { TerminalError } from '../../src/retry.ts';
import { fakeRegistry, fixtureResolver, makeFixPlanEntry, writeFixtureAuditRun, type FixtureRun } from '../helpers/fixture-audit-run.ts';

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

let root: string;
let run: FixtureRun;
let config: Config;
let loadedRegistryFrom: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-r1-'));
  run = writeFixtureAuditRun(root);
  config = ConfigSchema.parse({ auditAgentRepoRoot: root, designSystemPath: '/fake/design-system' });
  loadedRegistryFrom = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = () => ({
  config,
  resolveRun: fixtureResolver(run),
  loadRegistry: async (p: string) => {
    loadedRegistryFrom.push(p);
    return fakeRegistry();
  },
});

describe('R1 Resolve & Load', () => {
  it('joins fix-plan decisions to data.json findings by findingId and keeps ONLY decision === "fix"', async () => {
    const before = { data: sha(run.dataJsonPath), plan: sha(run.fixPlanJsonPath) };
    const out = await runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' });

    expect(out.fixFindings.map((f) => f.identity.findingId)).toEqual(['a'.repeat(32), 'c'.repeat(32)]);
    expect(out.fixEntries.every((e) => e.decision === 'fix')).toBe(true);
    expect(out.findings).toHaveLength(3); // the complete original set is still there, untouched
    expect(out.decisionCounts).toEqual({ fix: 2, skip: 1, keep_for_review: 0, undecided: 0 });
    expect(out.targetUrl).toBe(run.targetUrl);
    expect(out.sourceRun).toMatchObject({ auditAgentRepoRoot: root, projectName: run.projectName, runId: run.runId, displayName: 'Fixture Run', runDir: run.runDir, dataJsonPath: run.dataJsonPath, fixPlanJsonPath: run.fixPlanJsonPath, dataJsonSha256: before.data, fixPlanSha256: before.plan });
    expect(out.registry.version.dsRegistryVersion).toBe('f'.repeat(64));
    expect(loadedRegistryFrom).toEqual(['/fake/design-system']);
    expect(out.warnings).toEqual([]);
    expect(out.droppedUnknownFindingIds).toEqual([]);

    // The hard proof: audit-agent's files are byte-for-byte what they were.
    expect(sha(run.dataJsonPath)).toBe(before.data);
    expect(sha(run.fixPlanJsonPath)).toBe(before.plan);
    expect(await sourceFilesUnchanged(out.sourceRun)).toEqual({ dataJson: true, fixPlanJson: true, newComponentPlanJson: true });
  });

  it('refuses a run with no fix-plan.json, pointing at the Part 1 export + import path', async () => {
    unlinkSync(run.fixPlanJsonPath);
    const err = await runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/has no fix-plan\.json/);
    expect((err as Error).message).toMatch(/fix-plan-import fixture-run/);
    expect(loadedRegistryFrom).toEqual([]); // fails before any expensive work
  });

  it('refuses a fix plan that belongs to another run', async () => {
    writeFileSync(run.fixPlanJsonPath, JSON.stringify({ schemaVersion: 1, runId: 'some-other-run', updatedAt: null, entries: [makeFixPlanEntry('a'.repeat(32))] }));
    await expect(runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' })).rejects.toThrow(/belongs to run "some-other-run", not "fixture-run"/);
  });

  it('refuses a plan whose findingIds are ALL unknown (a wrong-run file), drops PARTIALLY unknown ids with a warning', async () => {
    writeFileSync(run.fixPlanJsonPath, JSON.stringify({ schemaVersion: 1, runId: run.runId, updatedAt: null, entries: [makeFixPlanEntry('1'.repeat(32)), makeFixPlanEntry('2'.repeat(32))] }));
    await expect(runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' })).rejects.toThrow(/none of the 2 findingIds/);

    writeFileSync(run.fixPlanJsonPath, JSON.stringify({ schemaVersion: 1, runId: run.runId, updatedAt: null, entries: [makeFixPlanEntry('1'.repeat(32)), makeFixPlanEntry('a'.repeat(32))] }));
    const out = await runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' });
    expect(out.fixFindings.map((f) => f.identity.findingId)).toEqual(['a'.repeat(32)]);
    expect(out.droppedUnknownFindingIds).toEqual(['1'.repeat(32)]);
    expect(out.warnings.join('\n')).toMatch(/1 fix-plan entry reference.*dropped/);
  });

  it('refuses when nothing is marked fix — with the other counts shown', async () => {
    writeFileSync(run.fixPlanJsonPath, JSON.stringify({ schemaVersion: 1, runId: run.runId, updatedAt: null, entries: [makeFixPlanEntry('a'.repeat(32), 'skip'), makeFixPlanEntry('b'.repeat(32), 'keep_for_review')] }));
    await expect(runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' })).rejects.toThrow(/no findings are marked "fix".*skip 1 · keep_for_review 1 · undecided 1/);
  });

  it('a repeated findingId keeps the last decision and reports the duplicate', async () => {
    writeFileSync(run.fixPlanJsonPath, JSON.stringify({ schemaVersion: 1, runId: run.runId, updatedAt: null, entries: [makeFixPlanEntry('a'.repeat(32), 'skip'), makeFixPlanEntry('a'.repeat(32), 'fix')] }));
    const out = await runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' });
    expect(out.fixFindings).toHaveLength(1);
    expect(out.warnings.join('\n')).toMatch(/appeared more than once/);
  });

  it('a malformed fix-plan.json is TERMINAL with the field named — never best-effort parsed', async () => {
    writeFileSync(run.fixPlanJsonPath, JSON.stringify({ schemaVersion: 1, runId: run.runId, updatedAt: null, entries: [{ findingId: 'a'.repeat(32), decision: 'maybe' }] }));
    await expect(runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' })).rejects.toThrow(/entries\.0\.decision/);
  });

  it('a missing data.json is TERMINAL', async () => {
    unlinkSync(run.dataJsonPath);
    await expect(runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' })).rejects.toThrow(/has no data\.json/);
  });

  it('§1.3: a "components" run needs no fix-plan.json at all', async () => {
    unlinkSync(run.fixPlanJsonPath);
    const out = await runR1(deps(), { runRef: { runId: run.runId }, runType: 'components' });
    expect(out.fixEntries).toEqual([]);
    expect(out.fixFindings).toEqual([]);
    expect(out.sourceRun.fixPlanJsonPath).toBeNull();
    expect(out.sourceRun.fixPlanSha256).toBeNull();
  });

  it('§2.2: loads and validates an upstream new-component-plan.json when present, and reports on the source it read', async () => {
    const path = join(run.runDir, 'new-component-plan.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, runId: run.runId, updatedAt: '2026-09-17T10:00:00.000Z', entries: [{ findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' }] }));
    const out = await runR1(deps(), { runRef: { runId: run.runId }, runType: 'redesign' });
    expect(out.newComponentPlan?.entries).toHaveLength(1);
    expect(out.newComponentPlan?.entries[0]!.classification).toBe('DS_CANDIDATE');
    expect(out.sourceRun.newComponentPlanJsonPath).toBe(path);
    expect(out.sourceRun.newComponentPlanSha256).not.toBeNull();
  });
});
