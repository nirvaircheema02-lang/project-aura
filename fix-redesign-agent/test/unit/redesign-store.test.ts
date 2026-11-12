import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRedesignDirs, listRedesignRuns, readRedesignRunMeta, redesignPaths, redesignRunIdFor, writeRedesignRunMeta, type RedesignRunMeta } from '../../src/output/redesign-store.ts';
import type { RunOutcomeState } from '../../src/session/types.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-store-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const meta = (redesignRunId: string, runOutcome: RunOutcomeState = 'completed'): RedesignRunMeta => ({
  schemaVersion: 2,
  redesignRunId,
  runType: 'redesign',
  mode: 'full-page',
  createdAt: '2026-09-18T10:00:00.000Z',
  finishedAt: null,
  runOutcome,
  sourceRun: {
    auditAgentRepoRoot: '/aa',
    projectName: 'p',
    runId: 'r',
    displayName: 'R',
    targetUrl: 'https://x',
    runDir: '/aa/projects/p/runs/r',
    dataJsonPath: '/aa/projects/p/runs/r/data.json',
    dataJsonSha256: 'd',
    fixPlanJsonPath: '/aa/projects/p/runs/r/fix-plan.json',
    fixPlanSha256: 'f',
    newComponentPlanJsonPath: null,
    newComponentPlanSha256: null,
    reportHtmlPath: null,
    screenshotsDir: '/aa/projects/p/runs/r/screenshots',
  },
  iterations: 1,
  fixFindingCount: 2,
  componentCount: 0,
  unitStates: {},
  failedAt: null,
  error: null,
});

describe('redesign output tree (§13)', () => {
  it('lays every artifact out under projects/<slug>/redesigns/<id>/', () => {
    const p = redesignPaths('/root/projects', 'www.kenresearch.com-survey', 'survey-page-audit-redesign-20260918-100000');
    expect(p.runDir).toBe('/root/projects/www.kenresearch.com-survey/redesigns/survey-page-audit-redesign-20260918-100000');
    expect(p.redesignHtml).toBe(`${p.runDir}/redesign.html`);
    expect(p.runMetaJson).toBe(`${p.runDir}/run.json`);
    expect(p.traceJsonl).toBe(`${p.runDir}/trace.jsonl`);
    expect(p.beforeTilesDir).toBe(`${p.runDir}/before-tiles`);
    expect(p.reviewIndexHtml).toBe(`${p.runDir}/review/review-index.html`);
    expect(p.componentManifestJson).toBe(`${p.runDir}/review/component-manifest.json`);
    expect(p.packageJson).toBe(`${p.runDir}/library/package.json`);
  });

  it('derives a sortable id from the source run id, the run type and a UTC stamp', () => {
    expect(redesignRunIdFor('survey-page-audit', 'redesign', new Date('2026-09-18T10:05:09Z'))).toBe('survey-page-audit-redesign-20260918-100509');
    expect(redesignRunIdFor('survey-page-audit', 'combined', new Date('2026-09-18T10:05:09Z'))).toBe('survey-page-audit-combined-20260918-100509');
    expect(redesignRunIdFor('Weird Run/ID', 'components', new Date('2026-01-02T03:04:05Z'))).toBe('weird-run-id-components-20260102-030405');
  });

  it('writes/reads run meta; a folder without meta reads as null and still lists', async () => {
    const a = redesignPaths(root, 'p', 'r-redesign-1');
    const b = redesignPaths(root, 'p', 'r-redesign-2');
    await ensureRedesignDirs(a);
    await ensureRedesignDirs(b);
    await writeRedesignRunMeta(a, meta('r-redesign-1', 'completed'));
    expect((await readRedesignRunMeta(a))!.runOutcome).toBe('completed');
    expect(await readRedesignRunMeta(b)).toBeNull();
    const listed = await listRedesignRuns(root);
    expect(listed.map((l) => [l.projectSlug, l.redesignRunId, l.meta?.runOutcome ?? null])).toEqual([
      ['p', 'r-redesign-1', 'completed'],
      ['p', 'r-redesign-2', null],
    ]);
    expect(await listRedesignRuns(join(root, 'nope'))).toEqual([]);
  });

  it('lists only runs whose meta.sourceRun.runId matches, for §1.4 prior-selection reuse', async () => {
    const a = redesignPaths(root, 'p', 'r-redesign-1');
    const b = redesignPaths(root, 'p', 'other-redesign-1');
    await ensureRedesignDirs(a);
    await ensureRedesignDirs(b);
    await writeRedesignRunMeta(a, { ...meta('r-redesign-1'), sourceRun: { ...meta('r-redesign-1').sourceRun, runId: 'r' } });
    await writeRedesignRunMeta(b, { ...meta('other-redesign-1'), sourceRun: { ...meta('other-redesign-1').sourceRun, runId: 'other' } });
    const { listRedesignRunsForSourceRun } = await import('../../src/output/redesign-store.ts');
    const matches = await listRedesignRunsForSourceRun(root, 'r');
    expect(matches.map((m) => m.redesignRunId)).toEqual(['r-redesign-1']);
  });
});
