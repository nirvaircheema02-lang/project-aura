import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runR6 } from '../../src/agents/r6-component-review/index.ts';
import type { CaptureSession, R1Output, R6Input } from '../../src/agents/types.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import { fakeRegistry, writeFixtureAuditRun } from '../helpers/fixture-audit-run.ts';

/**
 * runR6 over a hand-built mapping + findings, with REAL cross-run evidence read from disk
 * (two fixture audit-agent runs under one root, via `writeFixtureAuditRun` — the same helper
 * `find-run`/R1 tests use). Covers Decision Log #16 (every finding becomes a manifest
 * component, located or not — never only the ones an iteration actually touched) and that
 * `otherRunDataJsonPaths` genuinely gets read and threaded into `crossRun.sightings`.
 */

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fra-r6-'));
  roots.push(root);
  return root;
}

function mappingEntry(elementId: string, findingId: string, sectionId: string): MappingEntry {
  return {
    element: elementId,
    stamp: elementId,
    findingIds: [findingId],
    signature: null,
    instanceIndex: null,
    instanceCount: null,
    sectionId,
    scope: 'content',
    resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 }, candidatesConsidered: 1 },
    drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
    affordances: { tagName: 'button', role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
    dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
  };
}

function fakeSession(mapping: CaptureSession['mapping']): CaptureSession {
  return {
    page: {} as CaptureSession['page'],
    context: {} as CaptureSession['context'],
    observer: {} as CaptureSession['observer'],
    capture: {} as CaptureSession['capture'],
    before: { tiles: [], totalHeight: 0, truncated: false, composite: null },
    viewport: { width: 1440, height: 900 },
    captureFingerprint: { domHash: 'h', stylesheets: [], fonts: [], assets: [], viewport: { width: 1440, height: 900 }, renderingPolicyHash: 'r' },
    originalHtml: '<html></html>',
    mapping,
    release: async () => {},
  };
}

function r1From(run: ReturnType<typeof writeFixtureAuditRun>): R1Output {
  return {
    sourceRun: {
      auditAgentRepoRoot: run.auditAgentRepoRoot,
      projectName: run.projectName,
      runId: run.runId,
      displayName: run.displayName,
      targetUrl: run.targetUrl,
      runDir: run.runDir,
      dataJsonPath: run.dataJsonPath,
      dataJsonSha256: 'd',
      fixPlanJsonPath: run.fixPlanJsonPath,
      fixPlanSha256: 'f',
      newComponentPlanJsonPath: null,
      newComponentPlanSha256: null,
      reportHtmlPath: null,
      screenshotsDir: join(run.runDir, 'screenshots'),
    },
    audit: { schemaVersion: 1, run: { runId: run.runId, targetUrl: run.targetUrl }, findingCount: run.findings.length },
    targetUrl: run.targetUrl,
    findings: run.findings,
    fixPlan: { schemaVersion: 1, runId: run.runId, updatedAt: null, entries: [] },
    fixEntries: [],
    fixFindings: run.findings,
    decisionCounts: { fix: run.findings.length, skip: 0, keep_for_review: 0, undecided: 0 },
    droppedUnknownFindingIds: [],
    newComponentPlan: null,
    registry: fakeRegistry(),
    warnings: [],
  };
}

describe('runR6 — manifest coverage + real cross-run evidence', () => {
  it('covers every finding on the page (located or not) and threads otherRunDataJsonPaths into crossRun.sightings', async () => {
    const root = freshRoot();
    // Two SEPARATE audit-agent runs under one repo root — run-1 is "this" run, run-2 supplies cross-run evidence.
    const run1 = writeFixtureAuditRun(root, { projectName: 'p', runId: 'run-1' });
    const run2 = writeFixtureAuditRun(root, { projectName: 'p', runId: 'run-2' });
    const [findingA, findingB, findingC] = run1.findings; // ids 'a'…, 'b'…, 'c'… per makeFinding defaults

    // Only A and B are actually mapped to a live element; C is a real, authorized finding that
    // C2 never located — R6 must still carry it (Decision Log #16), just with location.located=false.
    const entries: MappingEntry[] = [mappingEntry('e-a', findingA!.identity.findingId, 'hero'), mappingEntry('e-b', findingB!.identity.findingId, 'hero')];
    const session = fakeSession({ entries, unmapped: [{ findingId: findingC!.identity.findingId, reason: 'no live candidate scored above the geometry threshold', candidatesConsidered: 2 }], conflicts: [], usage: null });

    const r1 = r1From(run1);
    const input: R6Input = { r1, session, iterations: [], otherRunDataJsonPaths: [run2.dataJsonPath] };
    const result = await runR6({ auditAgentRepoRoot: root, plausibilityBar: 0.35, log: () => {} }, input);

    expect(result.manifest.components).toHaveLength(3);
    const byFinding = new Map(result.manifest.components.map((c) => [c.findingId, c] as const));

    const compA = byFinding.get(findingA!.identity.findingId)!;
    const compB = byFinding.get(findingB!.identity.findingId)!;
    const compC = byFinding.get(findingC!.identity.findingId)!;
    expect(compA.location.located).toBe(true);
    expect(compA.location.stamp).toBe('e-a');
    expect(compB.location.located).toBe(true);
    // Unmapped, but still present in the manifest, not silently dropped.
    expect(compC.location.located).toBe(false);
    expect(compC.location.stamp).toBeNull();

    // Nothing was redesigned in this test (iterations: []) — every component reports that honestly.
    for (const c of [compA, compB, compC]) {
      expect(c.redesign.applied).toBe(false);
      expect(c.redesign.verified).toBe(false);
    }

    // otherRunDataJsonPaths was genuinely read from disk: run-2's default fixture findings share
    // this run's dsComponent/dsVariant, so every component sees a real 'ds-match' sighting from it.
    for (const c of [compA, compB, compC]) {
      expect(c.crossRun.sightings).toHaveLength(1);
      expect(c.crossRun.sightings[0]!.runId).toBe('run-2');
      expect(c.crossRun.sightings[0]!.basis).toBe('ds-match');
      expect(c.crossRun.sightings[0]!.findingIds.length).toBeGreaterThan(0);
    }

    expect(result.manifest.sections.map((s) => s.sectionId)).toEqual(['hero']);
    expect(result.manifest.counts.located).toBe(2);
    expect(result.manifest.counts.unlocated).toBe(1);
  });

  it('with no other runs on disk, crossRun.sightings is empty rather than guessed', async () => {
    const root = freshRoot();
    const run1 = writeFixtureAuditRun(root, { projectName: 'solo', runId: 'only-run' });
    const [findingA] = run1.findings;
    const session = fakeSession({ entries: [mappingEntry('e-a', findingA!.identity.findingId, 'hero')], unmapped: [], conflicts: [], usage: null });
    const r1 = r1From(run1);
    const input: R6Input = { r1, session, iterations: [], otherRunDataJsonPaths: [] };
    const result = await runR6({ auditAgentRepoRoot: root, plausibilityBar: 0.35, log: () => {} }, input);
    for (const c of result.manifest.components) expect(c.crossRun.sightings).toEqual([]);
  });
});
