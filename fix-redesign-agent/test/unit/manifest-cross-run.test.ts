import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import { findCrossRunSightings, findOtherRunDataJsonPaths, type CrossRunMatchInput } from '../../src/manifest/cross-run.ts';
import { CROSS_RUN_BASIS } from '../../src/manifest/schema.ts';
import { makeFinding, writeFixtureAuditRun } from '../helpers/fixture-audit-run.ts';

/**
 * §6/Decision Log #23 — cross-run evidence read strongest-basis-first: ds-match > signals >
 * label > type-only (CROSS_RUN_BASIS in src/manifest/schema.ts). Fixture runs built with the
 * shared writeFixtureAuditRun() helper, mirroring the real projects/<p>/runs/<r>/data.json layout.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-cross-run-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function withComponent(finding: Finding, component: Partial<Finding['component']>): Finding {
  return { ...finding, component: { ...finding.component, ...component } };
}
function withSignals(finding: Finding, signals: string[]): Finding {
  return { ...finding, review: { status: 'NEEDS_REVIEW', reason: 'x', node: 'n', signals, possibleMatches: [], observed: [] } };
}

const TARGET: CrossRunMatchInput = {
  productionType: 'button',
  dsComponent: 'Button',
  dsVariant: 'primary · md · light',
  classes: ['btn-primary', 'btn-lg'],
  normalizedLabel: 'sign up',
};

describe('findOtherRunDataJsonPaths', () => {
  it('lists every OTHER run\'s data.json across projects, excluding the given run id', () => {
    const runA = writeFixtureAuditRun(root, { projectName: 'proj-a', runId: 'run-a' });
    const runB = writeFixtureAuditRun(root, { projectName: 'proj-b', runId: 'run-b' });
    const paths = findOtherRunDataJsonPaths(root, 'run-a');
    expect(paths).toEqual([runB.dataJsonPath]);
    expect(paths).not.toContain(runA.dataJsonPath);
  });

  it('excludes nothing when the given run id does not exist among the runs found', () => {
    const runA = writeFixtureAuditRun(root, { projectName: 'proj-a', runId: 'run-a' });
    const runB = writeFixtureAuditRun(root, { projectName: 'proj-b', runId: 'run-b' });
    const paths = findOtherRunDataJsonPaths(root, 'run-nonexistent');
    expect(new Set(paths)).toEqual(new Set([runA.dataJsonPath, runB.dataJsonPath]));
  });

  it('returns [] when the auditAgentRepoRoot has no projects/ directory at all', () => {
    expect(findOtherRunDataJsonPaths(join(root, 'never-created'), 'run-a')).toEqual([]);
  });
});

describe('findCrossRunSightings — strongest-basis-first, per CROSS_RUN_BASIS order', () => {
  it('CROSS_RUN_BASIS is exactly ds-match > signals > label > type-only', () => {
    expect(CROSS_RUN_BASIS).toEqual(['ds-match', 'signals', 'label', 'type-only']);
  });

  it('a run with ds-match, signals AND label candidates reports ds-match (rank 0) as the basis, but lists every matched finding', async () => {
    const dsMatchFinding = withComponent(makeFinding({ findingId: 'a'.repeat(32) }), { dsComponent: 'Button', dsVariant: 'primary · md · light' });
    const signalsFinding = withSignals(withComponent(makeFinding({ findingId: 'b'.repeat(32) }), { productionType: 'button', dsComponent: 'OtherComp' }), ['class=btn-primary', 'class=btn-lg']);
    const labelFinding = withComponent(makeFinding({ findingId: 'c'.repeat(32), label: 'Sign Up' }), { productionType: 'button', dsComponent: null });
    const run = writeFixtureAuditRun(root, { projectName: 'proj-multi', runId: 'run-multi', findings: [dsMatchFinding, signalsFinding, labelFinding] });

    const sightings = await findCrossRunSightings([run.dataJsonPath], TARGET);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]).toMatchObject({ runId: 'run-multi', basis: 'ds-match', score: 1 });
    expect(new Set(sightings[0]!.findingIds)).toEqual(new Set(['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]));
  });

  it('with no ds-match, signals (rank 1) outranks label (rank 2) within the same run', async () => {
    const signalsFinding = withSignals(withComponent(makeFinding({ findingId: 'b'.repeat(32) }), { productionType: 'button', dsComponent: 'OtherComp' }), ['class=btn-primary', 'class=btn-lg']);
    const labelFinding = withComponent(makeFinding({ findingId: 'c'.repeat(32), label: 'Sign Up' }), { productionType: 'button', dsComponent: null });
    const run = writeFixtureAuditRun(root, { projectName: 'proj-sl', runId: 'run-signals-label', findings: [signalsFinding, labelFinding] });

    const sightings = await findCrossRunSightings([run.dataJsonPath], TARGET);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]).toMatchObject({ runId: 'run-signals-label', basis: 'signals' });
    expect(sightings[0]!.findingIds).toHaveLength(2);
  });

  it('a same-productionType finding with no class/label match reports type-only (rank 3), and a different-productionType finding is excluded entirely', async () => {
    const typeOnlyFinding = withComponent(makeFinding({ findingId: 'd'.repeat(32), label: 'Something Else' }), { productionType: 'button', dsComponent: null });
    const noMatchFinding = withComponent(makeFinding({ findingId: 'e'.repeat(32) }), { productionType: 'card', dsComponent: null });
    const run = writeFixtureAuditRun(root, { projectName: 'proj-type-only', runId: 'run-type-only', findings: [typeOnlyFinding, noMatchFinding] });

    const sightings = await findCrossRunSightings([run.dataJsonPath], TARGET);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]).toMatchObject({ runId: 'run-type-only', basis: 'type-only', score: 0.3, findingIds: ['d'.repeat(32)] });
  });

  it('a run where nothing matches contributes no sighting at all (never a zero-score placeholder)', async () => {
    const noMatchFinding = withComponent(makeFinding({ findingId: 'f'.repeat(32) }), { productionType: 'card', dsComponent: null });
    const run = writeFixtureAuditRun(root, { projectName: 'proj-none', runId: 'run-none', findings: [noMatchFinding] });

    expect(await findCrossRunSightings([run.dataJsonPath], TARGET)).toEqual([]);
  });

  it('an unreadable/invalid other-run data.json is skipped, never fatal', async () => {
    const good = writeFixtureAuditRun(root, { projectName: 'proj-good', runId: 'run-good', findings: [withComponent(makeFinding({ findingId: 'a'.repeat(32) }), { dsComponent: 'Button', dsVariant: 'primary · md · light' })] });
    const sightings = await findCrossRunSightings([join(root, 'does-not-exist', 'data.json'), good.dataJsonPath], TARGET);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]!.runId).toBe('run-good');
  });
});
