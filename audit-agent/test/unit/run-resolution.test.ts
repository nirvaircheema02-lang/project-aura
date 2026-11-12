import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findRunById, findRunsByDisplayName, listProjects, listRuns, readFixPlan, runPaths, writeFixPlan } from '../../src/output/run-store.ts';
import { emptyFixPlan } from '../../src/output/fix-plan.ts';

/**
 * Resolving a run from whatever identifier a reviewer actually has. The stakes: picking the
 * WRONG run here means importing one audit's decisions into another audit's folder, so every
 * ambiguous case must surface as ambiguous rather than resolve to a plausible-looking guess.
 */

let root: string;

function makeRun(project: string, runId: string, displayName: string | null): void {
  const dir = join(root, project, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  // A run predating run.json simply has none — the runId-as-displayName fallback covers it.
  if (displayName !== null) {
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId, displayName, targetUrl: 'https://example.com/x', mode: 'single-page', createdAt: '2026-09-18T00:00:00.000Z' }));
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'run-resolution-'));
  makeRun('proj-a', 'deals-and-ipo-consulting-test', 'Deals and IPO Consulting Test');
  makeRun('proj-a', 'survey-page-audit', 'Survey Page Audit');
  makeRun('proj-b', 'legacy-run', null); // no run.json
  makeRun('proj-b', 'dupe-one', 'Shared Name');
  makeRun('proj-c', 'dupe-two', 'Shared Name');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('listProjects / listRuns', () => {
  it('lists every project directory alphabetically', async () => {
    expect(await listProjects(root)).toEqual(['proj-a', 'proj-b', 'proj-c']);
  });

  it('lists a project\'s runs, and returns [] for a project with no runs dir rather than throwing', async () => {
    expect((await listRuns(root, 'proj-a')).sort()).toEqual(['deals-and-ipo-consulting-test', 'survey-page-audit']);
    expect(await listRuns(root, 'does-not-exist')).toEqual([]);
  });

  it('returns [] for a projects root that does not exist at all', async () => {
    expect(await listProjects(join(root, 'nope'))).toEqual([]);
  });
});

describe('findRunsByDisplayName — exact, case-insensitive, never fuzzy', () => {
  it('resolves a single match and reports the project it lives in', async () => {
    const matches = await findRunsByDisplayName(root, 'Deals and IPO Consulting Test');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ projectName: 'proj-a', runId: 'deals-and-ipo-consulting-test', displayName: 'Deals and IPO Consulting Test' });
  });

  it('matches case-insensitively and ignores surrounding whitespace', async () => {
    expect(await findRunsByDisplayName(root, '  deals AND ipo consulting TEST ')).toHaveLength(1);
  });

  it('does NOT substring- or prefix-match — a shorter name is a different run, never a near-enough one', async () => {
    expect(await findRunsByDisplayName(root, 'Deals')).toHaveLength(0);
    expect(await findRunsByDisplayName(root, 'Deals and IPO')).toHaveLength(0);
    expect(await findRunsByDisplayName(root, 'Deals and IPO Consulting Test 2')).toHaveLength(0);
  });

  it('reports BOTH runs when two share a display name instead of picking one', async () => {
    const matches = await findRunsByDisplayName(root, 'Shared Name');
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.runId).sort()).toEqual(['dupe-one', 'dupe-two']);
  });

  it('reports none for a name nobody used', async () => {
    expect(await findRunsByDisplayName(root, 'Never Audited Anything')).toEqual([]);
  });

  it('still resolves a run that predates run.json, via its runId-as-displayName fallback', async () => {
    const matches = await findRunsByDisplayName(root, 'legacy-run');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ runId: 'legacy-run', displayName: 'legacy-run' });
  });
});

describe('findRunById', () => {
  it('finds a run by id across projects', async () => {
    expect(await findRunById(root, 'survey-page-audit')).toMatchObject({ projectName: 'proj-a', runId: 'survey-page-audit', displayName: 'Survey Page Audit' });
  });

  it('returns null for an unknown id', async () => {
    expect(await findRunById(root, 'no-such-run')).toBeNull();
  });
});

describe('readFixPlan / writeFixPlan — a run with no decisions is a normal state, never an error', () => {
  it('returns an empty plan for a run that has no fix-plan.json', async () => {
    const paths = runPaths(root, 'proj-a', 'survey-page-audit');
    expect(await readFixPlan(paths, 'survey-page-audit')).toEqual(emptyFixPlan('survey-page-audit'));
  });

  it('round-trips a written plan', async () => {
    const paths = runPaths(root, 'proj-a', 'survey-page-audit');
    const plan = { schemaVersion: 1 as const, runId: 'survey-page-audit', updatedAt: '2026-09-18T10:00:00.000Z', entries: [{ findingId: 'f1', decision: 'fix' as const, decidedAt: '2026-09-18T10:00:00.000Z', decidedBy: null, note: null, source: 'html-report' as const }] };
    await writeFixPlan(paths, plan);
    expect(await readFixPlan(paths, 'survey-page-audit')).toEqual(plan);
  });

  it('degrades a malformed fix-plan.json to empty rather than throwing — the CLI is where a bad file is surfaced loudly', async () => {
    const paths = runPaths(root, 'proj-b', 'legacy-run');
    writeFileSync(paths.fixPlanJson, '{ not json at all');
    expect(await readFixPlan(paths, 'legacy-run')).toEqual(emptyFixPlan('legacy-run'));
  });
});
