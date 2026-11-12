import { compareDesign } from '../../src/fidelity/compare.ts';
import { base as baselineOf, cap as captureOf, sec, sticky } from '../helpers/fidelity-captures.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentSpec, L3Output } from '../../src/library/types.ts';
import type { MappingConflict } from '../../src/mapping/types.ts';
import { ensureLibraryDirs, ensureRedesignDirs, redesignPaths, writeJsonFile, type RedesignPaths, type ScopeRecord } from '../../src/output/redesign-store.ts';
import { computeG1Fingerprint, computeG2Fingerprint, computeG3Fingerprint, computeG4Fingerprint, computeG5Fingerprint, computeGateFingerprint } from '../../src/session/gate-fingerprints.ts';

/**
 * Regression coverage for a real, confirmed bug: `decide` (cli/index.ts) used to compute every
 * gate's stored fingerprint from `{gate, unit, timestamp}` — never from the approved content —
 * so it could never equal the pipeline's own content-based recomputation, and NO G1/G2/G4/G5
 * approval recorded through the only CLI command that records them was ever reusable. These
 * tests prove each gate's fingerprint is (a) null until its real artifacts exist on disk, (b)
 * IDENTICAL across two independent computations over unchanged content, and (c) different once
 * the underlying content actually changes — the exact property `isApprovalReusable` depends on.
 */

let root: string;
let paths: RedesignPaths;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fra-gatefp-'));
  paths = redesignPaths(root, 'p', 'r-redesign-1');
  await ensureRedesignDirs(paths);
  await ensureLibraryDirs(paths);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('computeG1Fingerprint', () => {
  it('null when neither scope.json nor conflicts.json exist yet', async () => {
    expect(await computeG1Fingerprint(paths)).toBeNull();
  });

  it('identical for the same sectionIds/conflicts, different once a conflict changes', async () => {
    const scope: ScopeRecord = { mode: 'selected-sections', sectionIds: ['hero', 'faq'], excludedSectionIds: [], candidateSectionIds: ['hero', 'faq'], resolvedAt: '2026-01-01T00:00:00.000Z' };
    const conflicts: MappingConflict[] = [{ kind: 'expectation-changed', findingIds: ['a'], description: 'DS moved', requiresAcknowledgement: true }];
    await writeJsonFile(paths.scopeJson, scope);
    await writeJsonFile(paths.conflictsJson, conflicts);
    const first = await computeG1Fingerprint(paths);
    expect(first).not.toBeNull();
    expect(await computeG1Fingerprint(paths)).toBe(first);

    await writeJsonFile(paths.conflictsJson, [{ ...conflicts[0], description: 'a different conflict' }]);
    expect(await computeG1Fingerprint(paths)).not.toBe(first);
  });

  it('a conflict not requiring acknowledgement never affects the fingerprint', async () => {
    await writeJsonFile(paths.scopeJson, { mode: 'full-page', sectionIds: ['hero'], excludedSectionIds: [], candidateSectionIds: ['hero'], resolvedAt: '2026-01-01T00:00:00.000Z' } satisfies ScopeRecord);
    await writeJsonFile(paths.conflictsJson, []);
    const withNoConflicts = await computeG1Fingerprint(paths);
    await writeJsonFile(paths.conflictsJson, [{ kind: 'plan-source-disagreement', findingIds: [], description: 'irrelevant', requiresAcknowledgement: false } satisfies MappingConflict]);
    expect(await computeG1Fingerprint(paths)).toBe(withNoConflicts);
  });
});

describe('computeG2Fingerprint', () => {
  it('null until redesign-content.html and validation-results.json both exist', async () => {
    expect(await computeG2Fingerprint(paths)).toBeNull();
    writeFileSync(paths.redesignContentHtml, '<html></html>');
    expect(await computeG2Fingerprint(paths)).toBeNull(); // validation-results.json still missing
  });

  it('identical for unchanged file bytes, different once the export content actually changes', async () => {
    writeFileSync(paths.redesignContentHtml, '<html>v1</html>');
    writeFileSync(paths.validationResultsJson, '[]');
    const first = await computeG2Fingerprint(paths);
    expect(first).not.toBeNull();
    expect(await computeG2Fingerprint(paths)).toBe(first); // same bytes, same fingerprint

    writeFileSync(paths.redesignContentHtml, '<html>v2</html>');
    expect(await computeG2Fingerprint(paths)).not.toBe(first);
  });

  it('a changed section fragment changes the fingerprint even when redesign-content.html itself is untouched', async () => {
    writeFileSync(paths.redesignContentHtml, '<html>same</html>');
    writeFileSync(paths.validationResultsJson, '[]');
    mkdirSync(paths.sectionsDir, { recursive: true });
    writeFileSync(join(paths.sectionsDir, 'hero.html'), 'v1');
    const first = await computeG2Fingerprint(paths);
    writeFileSync(join(paths.sectionsDir, 'hero.html'), 'v2');
    expect(await computeG2Fingerprint(paths)).not.toBe(first);
  });
});

describe('computeG2Fingerprint — design targets, evidence and the verified outcome', () => {
  const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  beforeEach(() => {
    writeFileSync(paths.redesignContentHtml, '<html>same</html>');
    writeFileSync(paths.validationResultsJson, '[]');
    put(paths.previewVerificationJson, { generatedAt: '2026-10-09T10:00:00Z', verdict: 'pass', checks: [{ id: 'a', status: 'pass' }] });
    put(paths.resolvedTargetsJson, { generatedAt: '2026-10-09T10:00:00Z', targets: [{ id: 't1', outcome: 'resolved-target', value: '8px' }] });
    put(paths.designBaselineJson, { capturedAt: '2026-10-09T10:00:00Z', baselineSha256: 'b'.repeat(64) });
    put(paths.fidelityReportJson, { generatedAt: '2026-10-09T10:00:00Z', verdict: 'pass', differences: [] });
    put(paths.correctionLogJson, { stopReason: 'passed', cycles: [{ cycle: 1, durationMs: 1200 }] });
  });

  it('a bare re-run that only changes clocks and durations keeps the approval valid', async () => {
    const first = await computeG2Fingerprint(paths);
    put(paths.previewVerificationJson, { generatedAt: '2026-10-10T08:00:00Z', verdict: 'pass', checks: [{ id: 'a', status: 'pass' }] });
    put(paths.resolvedTargetsJson, { generatedAt: '2026-10-10T08:00:00Z', targets: [{ id: 't1', outcome: 'resolved-target', value: '8px' }] });
    put(paths.fidelityReportJson, { generatedAt: '2026-10-10T08:00:00Z', verdict: 'pass', differences: [] });
    put(paths.correctionLogJson, { stopReason: 'passed', cycles: [{ cycle: 1, durationMs: 9999 }] });
    expect(await computeG2Fingerprint(paths)).toBe(first);
  });

  it.each([
    ['a resolved target changes', (p: RedesignPaths) => put(p.resolvedTargetsJson, { generatedAt: 'x', targets: [{ id: 't1', outcome: 'resolved-target', value: '12px' }] })],
    ['the baseline of the original changes', (p: RedesignPaths) => put(p.designBaselineJson, { capturedAt: 'x', baselineSha256: 'c'.repeat(64) })],
    ['the fidelity comparison finds a regression', (p: RedesignPaths) => put(p.fidelityReportJson, { generatedAt: 'x', verdict: 'fail', differences: [{ id: 'd' }] })],
    ['the correction outcome changes', (p: RedesignPaths) => put(p.correctionLogJson, { stopReason: 'budget-exhausted', cycles: [] })],
    ['a verification check flips', (p: RedesignPaths) => put(p.previewVerificationJson, { generatedAt: 'x', verdict: 'fail', checks: [{ id: 'a', status: 'fail' }] })],
  ])('an approval no longer stands when %s', async (_name, change) => {
    const first = await computeG2Fingerprint(paths);
    change(paths);
    expect(await computeG2Fingerprint(paths)).not.toBe(first);
  });

  it('a REAL fidelity report (with its coverage ledger) hashes the same on a bare re-run, and differently once a required check becomes unverified', async () => {
    const report = (reach: boolean[], at: string) => compareDesign({ baseline: baselineOf([sec({ sectionId: 'ok' }), sec({ sticky: [sticky(reach)] })]), observed: captureOf([sec({ sectionId: 'ok' }), sec({ sticky: [sticky(reach)] })]), exemptions: [], now: () => new Date(at) });
    put(paths.fidelityReportJson, report([true, true, true, true, true], '2026-10-09T10:00:00Z'));
    const first = await computeG2Fingerprint(paths);
    put(paths.fidelityReportJson, report([true, true, true, true, true], '2026-10-11T23:00:00Z'));
    expect(await computeG2Fingerprint(paths)).toBe(first);
    put(paths.fidelityReportJson, report([false, false, false, false, false], '2026-10-09T10:00:00Z'));
    expect(await computeG2Fingerprint(paths)).not.toBe(first);
  });

  it('the new artifacts are optional: an older run without them still fingerprints', async () => {
    const { resolvedTargetsJson: _a, designBaselineJson: _b, fidelityReportJson: _c, correctionLogJson: _d, ...legacy } = paths;
    expect(await computeG2Fingerprint(legacy)).not.toBeNull();
  });
});

describe('computeG3Fingerprint', () => {
  it('null until component-selection.json exists; changes when the selection or the upstream plan changes', async () => {
    expect(await computeG3Fingerprint(paths, null)).toBeNull();
    writeFileSync(paths.componentSelectionJson, '{"selections":[]}');
    const noUpstream = await computeG3Fingerprint(paths, null);
    expect(noUpstream).not.toBeNull();

    const upstreamPath = join(root, 'new-component-plan.json');
    writeFileSync(upstreamPath, '{"entries":[]}');
    const withUpstream = await computeG3Fingerprint(paths, upstreamPath);
    expect(withUpstream).not.toBe(noUpstream);

    writeFileSync(paths.componentSelectionJson, '{"selections":[{"patternId":"x"}]}');
    expect(await computeG3Fingerprint(paths, null)).not.toBe(noUpstream);
  });
});

describe('computeG4Fingerprint', () => {
  const spec = (overrides: Partial<ComponentSpec> = {}): ComponentSpec => ({
    schemaVersion: 1,
    componentId: 'comp-1',
    patternId: 'pattern-1',
    resolution: 'new',
    updateTarget: null,
    name: 'Card',
    category: 'molecules',
    scope: 'page-local',
    scopeEvidenceMissing: false,
    reference: { source: 'live-capture', priorRunId: null, elementStamp: 'e1', cropPath: null },
    anatomy: 'card',
    variantAxes: [],
    tokens: [],
    statesObserved: ['default'],
    statesToDesign: [],
    postFixPrerequisite: null,
    writeSet: ['core-v2/src/molecules/Card.tsx'],
    declaredSharedChanges: { barrelEntries: [], tokenAdditions: [] },
    dependsOn: { findings: [], components: [] },
    constraints: [],
    ...overrides,
  });

  it('null until this component has a spec file on disk', async () => {
    expect(await computeG4Fingerprint(paths, null, 'comp-1')).toBeNull();
  });

  it('changes when the built file content changes, and when acceptance results change — matches a fresh recomputation over unchanged content', async () => {
    const dsRepoPath = join(root, 'ds-repo');
    mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
    writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'), 'v1');
    await writeJsonFile(join(paths.specsDir, 'comp-1.json'), spec());
    await writeJsonFile(paths.acceptanceJson, [{ componentId: 'comp-1', status: 'PASS' } as unknown as L3Output]);

    const first = await computeG4Fingerprint(paths, dsRepoPath, 'comp-1');
    expect(first).not.toBeNull();
    expect(await computeG4Fingerprint(paths, dsRepoPath, 'comp-1')).toBe(first); // identical recomputation over unchanged content

    writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'), 'v2 — rebuilt differently');
    const afterRebuild = await computeG4Fingerprint(paths, dsRepoPath, 'comp-1');
    expect(afterRebuild).not.toBe(first); // §11.4 rule 3: a rebuilt component must not silently keep its old approval's fingerprint

    await writeJsonFile(paths.acceptanceJson, [{ componentId: 'comp-1', status: 'PARTIAL' } as unknown as L3Output]);
    expect(await computeG4Fingerprint(paths, dsRepoPath, 'comp-1')).not.toBe(afterRebuild);
  });

  it('previews under previewsDir contribute to the fingerprint when present', async () => {
    await writeJsonFile(join(paths.specsDir, 'comp-1.json'), spec());
    const noPreview = await computeG4Fingerprint(paths, null, 'comp-1');
    mkdirSync(paths.previewsDir, { recursive: true });
    writeFileSync(join(paths.previewsDir, 'comp-1.html'), '<html>preview v1</html>');
    const withPreview = await computeG4Fingerprint(paths, null, 'comp-1');
    expect(withPreview).not.toBe(noPreview);
    writeFileSync(join(paths.previewsDir, 'comp-1.html'), '<html>preview v2</html>');
    expect(await computeG4Fingerprint(paths, null, 'comp-1')).not.toBe(withPreview);
  });
});

describe('computeG5Fingerprint', () => {
  it('null until package.json exists; changes with package content, remote, or base branch', async () => {
    expect(await computeG5Fingerprint(paths, null, null)).toBeNull();
    await writeJsonFile(paths.packageJson, { files: [{ path: 'a', blobSha256: 'x' }], branch: 'fra/run-1' });
    const base = await computeG5Fingerprint(paths, null, null);
    expect(base).not.toBeNull();
    expect(await computeG5Fingerprint(paths, 'origin', null)).not.toBe(base);
    expect(await computeG5Fingerprint(paths, null, 'main')).not.toBe(base);

    await writeJsonFile(paths.packageJson, { files: [{ path: 'a', blobSha256: 'y' }], branch: 'fra/run-1' });
    expect(await computeG5Fingerprint(paths, null, null)).not.toBe(base);
  });
});

describe('computeGateFingerprint — the dispatch `decide` (cli/index.ts) actually calls', () => {
  const ctx = { dsRepoPath: null, dsRepoRemote: null, dsRepoBaseBranch: null, upstreamPlanPath: null };

  it('G0 always fingerprints to null — it has no fingerprinted content (§11.3)', async () => {
    expect(await computeGateFingerprint('G0', paths, ctx, null)).toBeNull();
  });

  it('G4 without a unitId is null — a per-component gate cannot be fingerprinted without naming the component', async () => {
    expect(await computeGateFingerprint('G4', paths, ctx, null)).toBeNull();
  });

  it('dispatches each gate to content-based hashing, not a bare {gate, unit, timestamp} tuple — the actual regression', async () => {
    // The original bug: computeFingerprint({gate, unit, at: new Date().toISOString()}) produced a
    // DIFFERENT value on every call (the timestamp), so nothing recorded through `decide` could
    // ever be recognized as reusable on a later run. Prove the dispatch used today is stable.
    writeFileSync(paths.redesignContentHtml, '<html>x</html>');
    writeFileSync(paths.validationResultsJson, '[]');
    const a = await computeGateFingerprint('G2', paths, ctx, null);
    await new Promise((r) => setTimeout(r, 5)); // a real clock tick, to rule out a hidden timestamp dependency
    const b = await computeGateFingerprint('G2', paths, ctx, null);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});
