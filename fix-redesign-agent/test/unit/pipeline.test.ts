import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureSession, CorrectionSummary, R1Output, R3Input, R4Input, R5Input, R5Output, R6Input, R7Input, R8Input, R8Output, B1Input, RVInput } from '../../src/agents/types.ts';
import type { L1NodeInput } from '../../src/agents/l1-resolve-plan/index.ts';
import type { ComponentSpec, L1Output, L2Output, L3Output, L4Output } from '../../src/library/types.ts';
import { deriveOutcome, RedesignPipelineError, runRedesignPipeline, type PipelineContext, type PipelineNodes } from '../../src/pipeline.ts';
import { readRedesignRunMeta, redesignPaths, sectionFragmentPath, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { recordDecision } from '../../src/session/decisions.ts';
import { computeG2Fingerprint, computeG4Fingerprint } from '../../src/session/gate-fingerprints.ts';
import { TerminalError } from '../../src/retry.ts';
import { readSpans } from '../../src/tracing/index.ts';
import { fakeRegistry, makeFinding } from '../helpers/fixture-audit-run.ts';
import type { ComponentManifest } from '../../src/manifest/schema.ts';
import type { NewComponentPlan } from '../../src/library/new-component-plan-schema.ts';
import { AwaitingJudgmentError } from '../../src/judgment/types.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { readResolution } from '../../src/resolution/store.ts';
import { basisHashOf, readCorrectionState } from '../../src/preview/correction-state.ts';
import type { CorrectionFeedback, FidelityReport } from '../../src/fidelity/types.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { unverifiedByFamily } from '../../src/fidelity/coverage.ts';
import { base as baselineOf, cap as captureOf, sec, sticky } from '../helpers/fidelity-captures.ts';
import { runR3 } from '../../src/agents/r3-redesign-plan/index.ts';
import { feedbackForUnmetTargets } from '../../src/fidelity/feedback.ts';
import type { DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { ScriptedLlmClient } from '../../src/llm/provider.ts';
import type { RedesignPlan, TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';

/**
 * The orchestrator with every node faked: proves the loop cap, the early exit on PASS, the
 * PARTIAL/FAIL derivation, the per-(node, iteration) trace, G2 always asking (§11.2) and
 * resuming once approved, the `components`-only run opening and (critically) RELEASING its
 * own browser session, and the `combined` run reusing Workflow A's session for Workflow B
 * rather than opening a second one.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-pipeline-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const r1Output = (overrides: Partial<R1Output> = {}): R1Output => {
  const findings = [makeFinding({ findingId: 'a'.repeat(32) }), makeFinding({ findingId: 'b'.repeat(32) })];
  return {
    sourceRun: {
      auditAgentRepoRoot: '/aa',
      projectName: 'www.example.com-page',
      runId: 'page-audit',
      displayName: 'Page Audit',
      targetUrl: 'https://example.com/page',
      runDir: '/aa/projects/www.example.com-page/runs/page-audit',
      dataJsonPath: '/aa/…/data.json',
      dataJsonSha256: 'd',
      fixPlanJsonPath: '/aa/…/fix-plan.json',
      fixPlanSha256: 'f',
      newComponentPlanJsonPath: null,
      newComponentPlanSha256: null,
      reportHtmlPath: null,
      screenshotsDir: '/aa/…/screenshots',
    },
    audit: { schemaVersion: 1, run: { runId: 'page-audit', targetUrl: 'https://example.com/page' }, findingCount: 2 },
    targetUrl: 'https://example.com/page',
    findings,
    fixPlan: { schemaVersion: 1, runId: 'page-audit', updatedAt: null, entries: [] },
    fixEntries: [],
    fixFindings: findings,
    decisionCounts: { fix: 2, skip: 0, keep_for_review: 0, undecided: 0 },
    droppedUnknownFindingIds: [],
    newComponentPlan: null,
    registry: fakeRegistry(),
    warnings: [],
    ...overrides,
  };
};

const validation = (iteration: number, overall: R5Output['overall'], opts: { failed?: string[]; fixedIds?: string[] } = {}): R5Output => ({
  iteration,
  checks: (opts.fixedIds ?? []).map((findingId) => ({ findingId, fixed: true, detail: 'ok', measured: [] })),
  structural: { ok: true, lostInteractive: [], lostText: [], note: '' },
  vision: 'NOT_CHECKED',
  visionIssues: [],
  visionVerdicts: null,
  overall,
  failedChecks: opts.failed ?? [],
  usage: null,
});

const manifestFixture = (): ComponentManifest => ({
  schemaVersion: 1,
  redesignRunId: 'page-audit-redesign-test',
  createdAt: '2026-09-18T10:00:00.000Z',
  pageId: 'p1',
  auditAiMode: null,
  auditDsRegistryVersion: 'e'.repeat(64),
  designSystem: { path: '/fake/design-system', dsRegistryVersion: 'f'.repeat(64), changedSinceAudit: false },
  viewport: { width: 1440, height: 900 },
  scope: { contentSectionIds: [], excludedSectionIds: [] },
  sections: [],
  components: [],
  counts: { findings: 2, located: 2, unlocated: 0, excluded: 0, fixRequested: 2, fixApplied: 0, fixVerified: 0, byBucket: {}, otherPageFindings: 0 },
});

function fakeSession(overrides: Partial<CaptureSession> = {}, released: { count: number } = { count: 0 }): CaptureSession {
  return {
    page: {} as CaptureSession['page'],
    context: {} as CaptureSession['context'],
    observer: {} as CaptureSession['observer'],
    capture: {} as CaptureSession['capture'],
    before: { tiles: [], totalHeight: 0, truncated: false, composite: null },
    viewport: { width: 1440, height: 900 },
    captureFingerprint: { domHash: 'h', stylesheets: [], fonts: [], assets: [], viewport: { width: 1440, height: 900 }, renderingPolicyHash: 'r' },
    originalHtml: null,
    mapping: { entries: [], unmapped: [], conflicts: [], usage: null },
    release: async () => void released.count++,
    ...overrides,
  };
}

// Writes real (minimal) files — G2's fingerprint (§11.3) is computed from REAL bytes on disk,
// not from these path strings, so a mock that only returns paths without writing anything
// would make computeG2Fingerprint see nothing there and always return null.
const r7Mock = async (input: R7Input) => {
  writeFileSync(input.paths.redesignHtml, `<!doctype html><html><body>redesign iter=${input.iterations.length}</body></html>`);
  writeFileSync(input.paths.redesignContentHtml, `<!doctype html><html><body>content iter=${input.iterations.length}</body></html>`);
  writeFileSync(input.paths.validationResultsJson, JSON.stringify(input.iterations.map((it) => it.validation)));
  return {
    originalHtml: input.paths.originalHtml,
    redesignHtml: input.paths.redesignHtml,
    redesignContentHtml: input.paths.redesignContentHtml,
    sectionHtmlPaths: [],
    htmlBytes: 1,
    beforePng: null,
    afterPng: null,
    redesignPlanJson: input.paths.redesignPlanJson,
    validationResultsJson: input.paths.validationResultsJson,
    exportValidationJson: input.paths.exportValidationJson,
    changeListMd: input.paths.changeListMd,
    componentManifestJson: input.paths.componentManifestJson,
    componentReviewHtml: input.paths.componentReviewHtml,
    reviewIndexHtml: input.paths.reviewIndexHtml,
    exportValidation: [],
    embeddedAssets: 0,
    missingAssets: [],
    unlocatedFindingIds: [],
  };
};

// R8's mock writes the verification file for real: G2's fingerprint covers it, exactly like the real node.
const r8Mock = async (input: R8Input): Promise<R8Output> => {
  const verification = {
    schemaVersion: 1, generatedAt: '2026-09-18T10:00:00.000Z', url: 'http://127.0.0.1:4400/', mode: input.mode, expectedSectionIds: input.sectionIds, renderedSectionIds: input.sectionIds,
    // a verification R8 finished: its fidelity comparison is on record (a verification with no fidelity evidence at all is INCOMPLETE, not PASS)
    checks: [{ id: 'fidelity.design-state', group: 'fidelity' as const, name: 'Design, state and composition are preserved', status: 'pass' as const, detail: '0 regression(s)' }], findings: [], interactions: [], unavailable: [], simulated: [],
    summary: { passed: 3, failed: 0, notChecked: 0, findingsVerified: 2, findingsTotal: 2, interactionsMatched: 4, interactionsTotal: 5, interactionsUnavailable: 1 },
    verdict: 'pass' as const,
  };
  mkdirSync(input.paths.previewDir, { recursive: true });
  writeFileSync(input.paths.previewVerificationJson, JSON.stringify(verification));
  return { url: 'http://127.0.0.1:4400/', port: 4400, previewDir: input.paths.previewAppDir, sourceHash: 'h', verificationJson: input.paths.previewVerificationJson, verification, generation: { sectionIds: input.sectionIds, generatedSections: input.sectionIds, overriddenSections: [], sourceHash: 'h', assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 } };
};

interface Harness {
  nodes: PipelineNodes;
  calls: string[];
  released: { count: number };
  r3Inputs: R3Input[];
  r7Inputs: R7Input[];
  r6Inputs: R6Input[];
  r8Inputs: R8Input[];
  b1Inputs: B1Input[];
  rvInputs: RVInput[];
}

function unexpected(name: string) {
  return async () => {
    throw new Error(`unexpected call: ${name}`);
  };
}

function harness(outcomes: Array<R5Output['overall']>, opts: { failAt?: { node: 'R4'; iteration: number }; fixedIdsOnPass?: string[]; failR8?: boolean } = {}): Harness {
  const released = { count: 0 };
  const h: Harness = { nodes: undefined as unknown as PipelineNodes, calls: [], released, r3Inputs: [], r7Inputs: [], r6Inputs: [], r8Inputs: [], b1Inputs: [], rvInputs: [] };
  h.nodes = {
    r1: async () => {
      h.calls.push('R1');
      return r1Output();
    },
    r2: async (_r1, _paths) => {
      h.calls.push('R2');
      return fakeSession({}, released);
    },
    c2: async (_r1, session) => {
      h.calls.push('C2');
      return session;
    },
    b1: async (input: B1Input) => {
      h.calls.push('B1');
      h.b1Inputs.push(input);
      return null;
    },
    rv: async (input: RVInput) => {
      h.calls.push('RV');
      h.rvInputs.push(input);
      return { resolution: { schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'page-audit', projectName: 'www.example.com-page', dataJsonSha256: 'd', fixPlanSha256: 'f' }, generatedAt: '2026-09-18T10:00:00.000Z', dsRegistryVersion: null, referenceRegistry: null, targets: [], noTargetFindings: [], notes: [] }, residualQuestions: 0, counts: { targets: 0, resolved: 0, preserved: 0, unresolved: 0, byReason: {} } };
    },
    r3: async (input: R3Input) => {
      h.calls.push(`R3#${input.iteration}`);
      h.r3Inputs.push(input);
      return { iteration: input.iteration, plan: { edits: [], unaddressed: [] }, chunks: 1, usage: null };
    },
    r4: async (input: R4Input, _paths: RedesignPaths) => {
      h.calls.push(`R4#${input.iteration}`);
      if (opts.failAt?.node === 'R4' && opts.failAt.iteration === input.iteration) throw new TerminalError('selector matched 0 elements');
      return { iteration: input.iteration, applied: [], after: { tiles: [], totalHeight: 0, truncated: false, composite: null } };
    },
    r5: async (input: R5Input) => {
      h.calls.push(`R5#${input.iteration}`);
      const overall = outcomes[input.iteration - 1] ?? 'FAIL';
      return validation(input.iteration, overall, overall === 'PASS' ? (opts.fixedIdsOnPass ? { fixedIds: opts.fixedIdsOnPass } : {}) : { failed: [`finding b: still wrong (iteration ${input.iteration})`] });
    },
    r6: async (input: R6Input) => {
      h.calls.push('R6');
      h.r6Inputs.push(input);
      return { manifest: manifestFixture() };
    },
    r7: async (input: R7Input) => {
      h.calls.push('R7');
      h.r7Inputs.push(input);
      return r7Mock(input);
    },
    r8: async (input: R8Input) => {
      h.calls.push('R8');
      h.r8Inputs.push(input);
      if (opts.failR8) throw new TerminalError('the generated React preview does not build');
      return r8Mock(input);
    },
    l1: unexpected('l1'),
    l2: unexpected('l2'),
    l2b: unexpected('l2b'),
    l3: unexpected('l3'),
    l4: unexpected('l4'),
    l5: unexpected('l5'),
  };
  return h;
}

const ctx = (overrides: Partial<PipelineContext> = {}): PipelineContext => ({
  projectsRoot: join(root, 'projects'),
  redesignRunId: 'page-audit-redesign-test',
  now: () => new Date('2026-09-18T10:00:00Z'),
  runType: 'redesign',
  mode: 'full-page',
  auditAgentRepoRoot: '/aa',
  ...overrides,
});

describe('runRedesignPipeline — Workflow A', () => {
  it('runs R1→R2→C2→loop→R6→R7 then ALWAYS stops at G2 (§11.1 rule 4) — one span per (node, iteration), session released once', async () => {
    const h = harness(['PARTIAL', 'PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    const result = await runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });

    expect(h.calls).toEqual(['R1', 'R2', 'C2', 'B1', 'RV', 'R3#1', 'R4#1', 'R5#1', 'R3#2', 'R4#2', 'R5#2', 'R6', 'R7', 'R8']);
    expect(h.released.count).toBe(1);
    expect(result.awaitingGate).toMatchObject({ awaitingGate: 'G2' });
    expect(result.runOutcome).toBe('awaiting-approval');
    expect(result.iterations.map((i) => i.validation.overall)).toEqual(['PARTIAL', 'PASS']);
    expect(result.r7).not.toBeNull();

    // The "Fix" half of Build→Render→Compare→Fix: iteration 2 sees iteration 1's plan + verdict.
    expect(h.r3Inputs[0]!.previous).toBeNull();
    expect(h.r3Inputs[1]!.previous?.validation.failedChecks).toEqual(['finding b: still wrong (iteration 1)']);
    expect(h.r7Inputs[0]!.outcome).toBe('PASS');
    expect(h.r7Inputs[0]!.iterations).toHaveLength(2);
    expect(h.r6Inputs[0]!.iterations).toHaveLength(2);

    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', 'page-audit-redesign-test');
    expect(result.paths.runDir).toBe(paths.runDir);
    const meta = (await readRedesignRunMeta(paths))!;
    expect(meta).toMatchObject({ runOutcome: 'awaiting-approval', iterations: 2, fixFindingCount: 2, failedAt: null, error: null });

    const spans = readSpans(paths.traceJsonl);
    expect(spans.map((s) => `${s.nodeId}#${s.attempt}:${s.status}`)).toEqual(['R1#1:OK', 'R2#1:OK', 'C2#1:OK', 'B1#1:OK', 'RV#1:OK', 'R3#1:OK', 'R4#1:OK', 'R5#1:OK', 'R3#2:OK', 'R4#2:OK', 'R5#2:OK', 'R6#1:OK', 'R7#1:OK', 'R8#1:OK']);
    expect(new Set(spans.map((s) => s.runId))).toEqual(new Set(['page-audit-redesign-test']));

    // Resume: approve G2 with the SAME fingerprint the real `decide` CLI would compute (real
    // file bytes on disk, not the in-memory PATHS r7 returns) — the run then completes without asking again.
    const g2Fp = await computeG2Fingerprint(result.paths);
    await recordDecision(result.paths.decisionsJson, result.redesignRunId, { gate: 'G2', outcome: 'approve', fingerprint: g2Fp, unitId: null, by: 'reviewer', at: '2026-09-18T10:05:00.000Z', note: null });

    const h2 = harness(['PARTIAL', 'PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    const resumed = await runRedesignPipeline(ctx(), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(resumed.awaitingGate).toBeNull();
    expect(resumed.runOutcome).toBe('completed');
    expect(h2.released.count).toBe(1);
  });

  it('never exceeds the cap; PARTIAL on the last iteration is PARTIAL, not PASS and not FAIL', async () => {
    const h = harness(['FAIL', 'PARTIAL', 'PARTIAL', 'PASS']); // the 4th would pass — it must never run
    const result = await runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(result.outcome).toBe('PARTIAL');
    expect(h.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1', 'R3#2', 'R3#3']);
  });

  it('FAIL when the cap exhausts without anything holding; maxIterations from the context is honoured', async () => {
    const h = harness(['PARTIAL', 'FAIL']);
    const result = await runRedesignPipeline(ctx({ maxIterations: 2 }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(result.outcome).toBe('FAIL');
    expect(h.calls.filter((c) => c.startsWith('R5'))).toEqual(['R5#1', 'R5#2']);
    expect(h.released.count).toBe(1);
  });

  it('a node failure names the node + iteration, keeps its TERMINAL class, releases the session once, and writes failed meta', async () => {
    const h = harness(['PARTIAL', 'PASS'], { failAt: { node: 'R4', iteration: 2 } });
    const err = await runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedesignPipelineError);
    const e = err as RedesignPipelineError;
    expect(e.nodeId).toBe('R4');
    expect(e.iteration).toBe(2);
    expect(e.class).toBe('TERMINAL');
    expect(e.message).toBe('R4 (iteration 2): selector matched 0 elements');
    expect(h.released.count).toBe(1);
    expect(h.calls).not.toContain('R6');
    expect(h.calls).not.toContain('R7');
    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', 'page-audit-redesign-test');
    const meta = (await readRedesignRunMeta(paths))!;
    expect(meta).toMatchObject({ runOutcome: 'failed', failedAt: 'R4#2', error: 'R4 (iteration 2): selector matched 0 elements', iterations: 1 });
    const spans = readSpans(paths.traceJsonl);
    expect(spans.at(-1)).toMatchObject({ nodeId: 'R4', attempt: 2, status: 'ERROR', errorDetail: 'selector matched 0 elements' });
  });

  it('a stale failedAt/error from an earlier failed invocation is CLEARED once a later invocation of the same run gets further — never left stuck forever on a run that has since moved on (found live against a real run)', async () => {
    const failing = harness(['PASS'], { failAt: { node: 'R4', iteration: 1 } });
    await runRedesignPipeline(ctx(), failing.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' }).catch(() => {});
    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', 'page-audit-redesign-test');
    expect((await readRedesignRunMeta(paths))!).toMatchObject({ runOutcome: 'failed', failedAt: 'R4', error: expect.stringContaining('selector matched 0 elements') });

    // A later invocation of the SAME run (e.g. after whatever the earlier failure was got
    // fixed) succeeds further this time — the stale failure info must not survive.
    const succeeding = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    const result = await runRedesignPipeline(ctx(), succeeding.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(result.awaitingGate).toMatchObject({ awaitingGate: 'G2' });
    const meta = (await readRedesignRunMeta(paths))!;
    expect(meta.failedAt).toBeNull();
    expect(meta.error).toBeNull();
    expect(meta.runOutcome).toBe('awaiting-approval');
  });

  it('an R1 failure happens before any run folder exists — nothing is written, nothing released', async () => {
    const h = harness(['PASS']);
    h.nodes.r1 = async () => {
      throw new TerminalError('no fix-plan.json');
    };
    const err = await runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' }).catch((e: unknown) => e);
    expect((err as RedesignPipelineError).message).toBe('R1: no fix-plan.json');
    expect(existsSync(join(root, 'projects'))).toBe(false);
    expect(h.released.count).toBe(0);
  });

  it('generates <sourceRunId>-<runType>-<stamp> when no id is given', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    const result = await runRedesignPipeline({ projectsRoot: join(root, 'projects'), now: () => new Date('2026-09-18T11:22:33Z'), runType: 'redesign', mode: 'full-page', auditAgentRepoRoot: '/aa' }, h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(result.redesignRunId).toBe('page-audit-redesign-20260918-112233');
  });

  it('redesign-only scope (2026-09-28): Selected Sections derives its scope automatically, on the FIRST invocation, from every non-global section with a Fix finding — never pauses at G1 for this', async () => {
    // Two distinct, non-global sections — under the old behaviour this would ask at G1; now it
    // must derive both sections automatically and proceed straight through to G2.
    const findings = [makeFinding({ findingId: 'a'.repeat(32), section: 'Hero' }), makeFinding({ findingId: 'b'.repeat(32), section: 'Features' })];
    const h = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    h.nodes.r1 = async () => {
      h.calls.push('R1');
      return r1Output({ findings, fixFindings: findings });
    };
    const first = await runRedesignPipeline(ctx({ mode: 'selected-sections' }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(first.awaitingGate).toMatchObject({ awaitingGate: 'G2' }); // NOT G1 — resolved automatically, no pause
    expect(h.calls).toEqual(['R1', 'R2', 'C2', 'B1', 'RV', 'R3#1', 'R4#1', 'R5#1', 'R6', 'R7', 'R8']);
    expect(existsSync(first.paths.scopeJson)).toBe(true);
    const persisted = JSON.parse(readFileSync(first.paths.scopeJson, 'utf-8'));
    expect(persisted.sectionIds).toEqual(['hero', 'features']); // both non-global sections, derived — never asked

    // A later invocation of the same run re-derives the same candidate set and stays consistent
    // (no ask, no drift) — proving this isn't just a one-off first-run fluke.
    const h2 = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    h2.nodes.r1 = async () => {
      h2.calls.push('R1');
      return r1Output({ findings, fixFindings: findings });
    };
    const second = await runRedesignPipeline(ctx({ mode: 'selected-sections' }), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(second.awaitingGate).toMatchObject({ awaitingGate: 'G2' });
    const persistedAgain = JSON.parse(readFileSync(first.paths.scopeJson, 'utf-8'));
    expect(persistedAgain.sectionIds).toEqual(['hero', 'features']);
  });
});

describe('runRedesignPipeline — React Preview is the default deliverable (R8) and B1 captures the original first', () => {
  it('B1 runs once, after scope/G1 and BEFORE any edit; R8 runs after R7 and BEFORE G2; the G2 reason names the preview URL and its verification', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    const result = await runRedesignPipeline(ctx({ mode: 'selected-sections' }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });

    expect(h.calls.indexOf('B1')).toBeGreaterThan(h.calls.indexOf('C2'));
    expect(h.calls.indexOf('B1')).toBeLessThan(h.calls.indexOf('R3#1'));
    expect(h.calls.indexOf('R8')).toBeGreaterThan(h.calls.indexOf('R7'));
    expect(h.calls.filter((c) => c === 'B1')).toHaveLength(1);
    expect(result.awaitingGate?.awaitingGate).toBe('G2');
    expect(result.awaitingGate?.reason).toContain('React preview PASS at http://127.0.0.1:4400/');
    expect(result.awaitingGate?.reason).toContain('2/2 findings measured fixed');
    expect(result.r8?.url).toBe('http://127.0.0.1:4400/');
    // R8 receives the resolved scope, the mode and the edits R4 left in force
    expect(h.r8Inputs[0]).toMatchObject({ mode: 'selected-sections' });
    expect(h.r8Inputs[0]!.sectionIds).toEqual(h.r7Inputs[0]!.sectionIds);
  });

  it('there is no static-HTML fallback: if R8 fails the run FAILS at R8, never reaches G2, and says so', async () => {
    const h = harness(['PASS'], { failR8: true });
    await expect(runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' })).rejects.toThrow(/R8.*does not build/);
    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', 'page-audit-redesign-test');
    const meta = (await readRedesignRunMeta(paths))!;
    expect(meta).toMatchObject({ runOutcome: 'failed', failedAt: 'R8' });
    expect(h.released.count).toBe(1);
  });

  it('a G2 approval is invalidated when the preview verification or source changes after it was given', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    const result = await runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    const approved = await computeG2Fingerprint(result.paths);
    await recordDecision(result.paths.decisionsJson, result.redesignRunId, { gate: 'G2', outcome: 'approve', fingerprint: approved, unitId: null, by: 'reviewer', at: '2026-09-18T10:05:00.000Z', note: null });

    // the preview's verification changes (e.g. a regenerated preview now fails a check) → same decision no longer applies
    const v = JSON.parse(readFileSync(result.paths.previewVerificationJson, 'utf8'));
    writeFileSync(result.paths.previewVerificationJson, JSON.stringify({ ...v, verdict: 'fail' }));
    expect(await computeG2Fingerprint(result.paths)).not.toBe(approved);

    // …and so does a change to the generated source
    writeFileSync(result.paths.previewVerificationJson, JSON.stringify(v));
    expect(await computeG2Fingerprint(result.paths)).toBe(approved);
    mkdirSync(join(result.paths.previewAppDir, 'src'), { recursive: true });
    writeFileSync(join(result.paths.previewAppDir, 'src', 'App.tsx'), 'export default () => null;');
    expect(await computeG2Fingerprint(result.paths)).not.toBe(approved);
  });

  it('a recorded, still-valid behaviour capture is reused on resume instead of probing production again', async () => {
    const h = harness(['PASS']);
    const first = await runRedesignPipeline(ctx({ mode: 'selected-sections' }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    const sections = first.r7 ? h.r7Inputs[0]!.sectionIds : [];
    writeFileSync(first.paths.behaviorJson, JSON.stringify({ schemaVersion: 1, capturedAt: 'x', source: 'production', url: 'u', reloads: 0, sections: sections.map((id) => ({ sectionId: id, located: true, items: [], scroll: null, animations: [], sticky: [] })) }));
    writeFileSync(first.paths.designBaselineJson, '{}');
    const h2 = harness(['PASS']);
    await runRedesignPipeline(ctx({ mode: 'selected-sections' }), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(h2.calls).not.toContain('B1');
    expect(h2.r8Inputs[0]!.behavior?.sections.map((b) => b.sectionId)).toEqual(sections);
  });

  it('REGRESSION: a behaviour capture WITHOUT its design baseline is not reused — B1 runs again so the baseline is (re)captured (an unstyled one was set aside)', async () => {
    const h = harness(['PASS']);
    const first = await runRedesignPipeline(ctx({ mode: 'selected-sections' }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    const sections = first.r7 ? h.r7Inputs[0]!.sectionIds : [];
    writeFileSync(first.paths.behaviorJson, JSON.stringify({ schemaVersion: 1, capturedAt: 'x', source: 'production', url: 'u', reloads: 0, sections: sections.map((id) => ({ sectionId: id, located: true, items: [], scroll: null, animations: [], sticky: [] })) }));
    rmSync(first.paths.designBaselineJson, { force: true });
    const h2 = harness(['PASS']);
    await runRedesignPipeline(ctx({ mode: 'selected-sections' }), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(h2.calls).toContain('B1');
  });
});

describe('runRedesignPipeline — the Resolver, the shared targets and the bounded correction loop', () => {
  const FA = 'a'.repeat(32);
  const makeTarget = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
    id: 'tgt-radius', findingId: FA, property: 'border-top-left-radius', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
    audit: { status: 'DIFFERENT', actual: '4px', expected: '8px', expectedToken: null, note: null, source: 'atoms/Card.tsx' }, reason: 'audit-expected-present', outcome: 'resolved-target',
    target: { value: '8px', comparison: 'length-px', token: null }, provenance: { kind: 'audit-expected', ds: null, reference: null, evidence: [] }, decisionReason: 'audit measured it', route: 'css-edit', acceptance: [],
    status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
  });
  const resolutionWith = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'page-audit', projectName: 'www.example.com-page', dataJsonSha256: 'd', fixPlanSha256: 'f' }, generatedAt: '2026-09-18T10:00:00.000Z', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });

  const replan = (id: string, constraint: string): CorrectionFeedback => ({
    id, kind: 'default-regression', sectionId: 'hero', viewport: 'desktop', elementKey: 'card:0', elementLabel: 'Alpha card', state: 'default', property: 'border-top-left-radius', expected: '12px', observed: '4px', findingIds: [FA],
    message: `Alpha card: border-top-left-radius should be 12px but is 4px`, responsible: 'planner', action: { type: 'replan', findingIds: [FA], constraint }, blockedReason: null,
  });

  /** An R8 whose correction outcome is scripted per call; everything else is the shared mock. */
  function withScriptedR8(h: Harness, script: Array<{ plannerFeedback?: CorrectionFeedback[]; droppedEdits?: string[]; open?: string[]; fidelity?: FidelityReport; unverified?: CorrectionSummary['required']['unverified']; preserve?: NonNullable<R8Output['verification']['preserve']> }>): void {
    let call = 0;
    h.nodes.r8 = async (input: R8Input) => {
      h.calls.push('R8');
      h.r8Inputs.push(input);
      const step = script[Math.min(call++, script.length - 1)] ?? {};
      const base = await r8Mock(input);
      const plannerFeedback = step.plannerFeedback ?? [];
      const open = step.open ?? [];
      return { ...base, ...(step.fidelity ? { fidelity: step.fidelity } : {}), ...(step.preserve ? { verification: { ...base.verification, preserve: step.preserve } } : {}), correction: { stopReason: plannerFeedback.length ? 'planner-needed' : 'passed', budgetReason: null, cycles: [], open: plannerFeedback, plannerFeedback, corrections: { stateGuards: [], droppedEdits: step.droppedEdits ?? [], droppedIslands: [] }, verifications: input.budget?.verifications ?? 0, required: { satisfied: open.length === 0, open, ...(step.unverified ? { unverified: step.unverified } : {}) } } };
    };
  }

  const run = (h: Harness, over: Partial<PipelineContext> = {}) => runRedesignPipeline(ctx(over), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
  const pathsOf = () => redesignPaths(join(root, 'projects'), 'www.example.com-page', 'page-audit-redesign-test');

  it('RV runs once, after B1 and before any planning; its targets reach R3, R4, R5 and R8 as the SAME object, and are persisted', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    const resolution = resolutionWith(makeTarget());
    h.nodes.rv = async (input) => { h.calls.push('RV'); h.rvInputs.push(input); return { resolution, residualQuestions: 0, counts: { targets: 1, resolved: 1, preserved: 0, unresolved: 0, byReason: {} } }; };
    const seen: Record<string, unknown> = {};
    const r3 = h.nodes.r3; h.nodes.r3 = async (input, p, id) => { seen.r3 = input.resolution; return r3(input, p, id); };
    const r4 = h.nodes.r4; h.nodes.r4 = async (input, p) => { seen.r4 = input.resolution; return r4(input, p); };
    const r5 = h.nodes.r5; h.nodes.r5 = async (input, p, id) => { seen.r5 = input.resolution; return r5(input, p, id); };
    const result = await run(h);

    expect(h.calls.slice(0, 6)).toEqual(['R1', 'R2', 'C2', 'B1', 'RV', 'R3#1']);
    expect(h.calls.filter((c) => c === 'RV')).toHaveLength(1);
    expect(h.rvInputs[0]).toMatchObject({ mode: 'full-page' });
    expect(seen.r3).toBe(resolution);
    expect(seen.r4).toBe(resolution);
    expect(seen.r5).toBe(resolution);
    expect(h.r8Inputs[0]!.resolution).toBe(resolution);
    expect(h.r8Inputs[0]!.budget).toBeDefined();
    expect(h.r8Inputs[0]!.corrections).toEqual({ stateGuards: [], droppedEdits: [], droppedIslands: [] });
    const onDisk = await readResolution(result.paths.resolvedTargetsJson);
    expect(onDisk?.targets.map((t) => t.id)).toEqual(['tgt-radius']);
  });

  it('records each target\'s IMPLEMENTATION status as the stages report it (planned → applied, or blocked with the reason) — never as verified', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    const resolution = resolutionWith(makeTarget(), makeTarget({ id: 'tgt-hover', property: 'background-color', state: 'hover', target: { value: 'rgb(255, 255, 255)', comparison: 'color-deltaE', token: null } }));
    h.nodes.rv = async () => ({ resolution, residualQuestions: 0, counts: { targets: 2, resolved: 2, preserved: 0, unresolved: 0, byReason: {} } });
    const r3 = h.nodes.r3;
    h.nodes.r3 = async (input, p, id) => ({ ...(await r3(input, p, id)), targetNotes: [{ targetId: 'tgt-radius', implementation: 'planned', detail: null }, { targetId: 'tgt-hover', implementation: 'blocked', detail: 'a hover target has no reliable live-DOM selector' }] });
    h.nodes.r4 = async (input) => ({
      iteration: input.iteration, after: { tiles: [], totalHeight: 0, truncated: false, composite: null },
      applied: [{ edit: { findingId: FA, selector: '[data-fra-element="e1"]', expectedMatches: 1, kind: 'style', property: 'border-top-left-radius', value: '8px', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1 }, matched: 1, applied: true, previousValue: '4px', error: null }],
    });
    await run(h);
    const byId = Object.fromEntries(resolution.targets.map((t) => [t.id, t.status]));
    expect(byId['tgt-radius']).toMatchObject({ implementation: 'applied', verification: 'not-run' });
    expect(byId['tgt-hover']).toMatchObject({ implementation: 'blocked', implementationDetail: 'a hover target has no reliable live-DOM selector' });
  });

  it('feedback only the planner can correct goes back to it with the measured values, inside the SHARED budget, then the preview is rebuilt and rechecked', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    const constraint = 'border-top-left-radius on "Alpha card" must keep the original value 12px; the preview shows 4px';
    withScriptedR8(h, [{ plannerFeedback: [replan('d1', constraint)], open: ['1 of 1 resolved target(s) not verified'] }, {}]);
    const result = await run(h);

    expect(h.calls.slice(h.calls.indexOf('R8'))).toEqual(['R8', 'R3#2', 'R4#2', 'R5#2', 'R6', 'R7', 'R8']);
    expect(h.r3Inputs[1]!.acknowledgedConstraints).toContain(constraint);
    expect(h.r3Inputs[1]!.previous?.iteration).toBe(1);
    expect(h.r8Inputs[0]!.budget).toBe(h.r8Inputs[1]!.budget); // one budget, not one per stage
    expect(h.r8Inputs[1]!.budget!.cycles).toBe(1);
    const state = await readCorrectionState(result.paths.correctionStateJson);
    expect(state).toMatchObject({ plannerPasses: [[constraint]], cyclesUsed: 1 });
    expect(result.awaitingGate?.awaitingGate).toBe('G2');
    expect(result.iterations).toHaveLength(2);
  });

  it('does NOT re-plan when the shared budget is exhausted: the open items reach G2 and the required checks are reported NOT satisfied', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    withScriptedR8(h, [{ plannerFeedback: [replan('d1', 'c')], open: ['design/state fidelity: 1 regression(s)'] }]);
    const result = await run(h, { correctionBudget: { maxCycles: 0, maxVerifications: 3, maxDurationMs: null } });
    expect(h.calls.filter((c) => c === 'R8')).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1']);
    expect(result.awaitingGate?.reason).toMatch(/1 required check\(s\) NOT satisfied/);
  });

  it('the G2 reason names INCOMPLETE fidelity with the unverified counts per family and the preserve counts, and keeps the NOT satisfied clause', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    const dead = sticky([false, false, false, false, false]);
    const fidelity = compareDesign({ baseline: baselineOf([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), observed: captureOf([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), exemptions: [] });
    withScriptedR8(h, [{ open: ['design/state fidelity is INCOMPLETE: 1 of 9 required check(s) not verified'], fidelity, unverified: unverifiedByFamily(fidelity), preserve: { total: 6, verified: 2, failed: 1, unverified: 3, reasons: [], worst: [] } }]);
    const result = await run(h);
    const reason = result.awaitingGate?.reason ?? '';
    expect(reason).toMatch(/design\/state fidelity INCOMPLETE/);
    expect(reason).toMatch(/1 UNVERIFIED: sticky 1/);
    expect(reason).toMatch(/preserve decisions: 2 verified \/ 3 unverified \/ 1 changed/);
    expect(reason).toMatch(/1 required check\(s\) NOT satisfied/);
  });

  it('the G2 reason LEADS with the open required state (not "PASS" alone), and prints the actionable / by-design split of the fidelity gaps and of the preserve decisions', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    const dead = sticky([false, false, false, false, false]);
    const fidelity = compareDesign({ baseline: baselineOf([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), observed: captureOf([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), exemptions: [] });
    withScriptedR8(h, [{ open: ['design/state fidelity is INCOMPLETE: 1 of 9 required check(s) not verified'], fidelity, unverified: unverifiedByFamily(fidelity), preserve: { total: 6, verified: 2, failed: 1, unverified: 3, byDesign: 2, reasons: [], worst: [] } }]);
    const reason = (await run(h)).awaitingGate?.reason ?? '';
    expect(reason).toMatch(/React preview PASS \(NOT fully verified: 1 required fidelity check\(s\) unverified \(1 actionable \/ 0 by-design\); 1 required check\(s\) open\) at http/);
    expect(reason).toMatch(/1 UNVERIFIED: sticky 1 \(1 actionable \/ 0 by-design\)/);
    expect(reason).toMatch(/preserve decisions: 2 verified \/ 3 unverified \/ 1 changed \(unverified: 1 actionable \/ 2 by-design\)/);
    expect(reason).toMatch(/1 required check\(s\) NOT satisfied/);
  });

  it('a fully verified preview keeps the plain "React preview PASS at" lead', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    withScriptedR8(h, [{}]);
    const reason = (await run(h)).awaitingGate?.reason ?? '';
    expect(reason).toContain('React preview PASS at http');
    expect(reason).not.toContain('NOT fully verified');
  });

  it('stops re-planning when a pass removes nothing that was open — it never loops on the same defect', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    withScriptedR8(h, [{ plannerFeedback: [replan('d1', 'c')], open: ['x'] }]); // the same feedback after every re-plan
    const result = await run(h, { correctionBudget: { maxCycles: 6, maxVerifications: 9, maxDurationMs: null } });
    expect(h.calls.filter((c) => c === 'R8')).toHaveLength(2); // one re-plan, then the unchanged defect ends it
    expect(h.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1', 'R3#2']);
    expect(result.awaitingGate?.reason).toMatch(/NOT satisfied/);
  });

  it('a resumed run replays the planner passes already decided for the same plan and targets, and does not spend the budget twice', async () => {
    const first = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    withScriptedR8(first, [{ plannerFeedback: [replan('d1', 'keep the 12px radius')] }, {}]);
    await run(first);

    const second = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    withScriptedR8(second, [{}]);
    await run(second);
    expect(second.calls.slice(second.calls.indexOf('R5#1'))).toEqual(['R5#1', 'R3#2', 'R4#2', 'R5#2', 'R6', 'R7', 'R8']); // the pass is replayed BEFORE the preview, with its constraint
    expect(second.r3Inputs[1]!.acknowledgedConstraints).toContain('keep the 12px radius');
    expect(second.r8Inputs[0]!.budget!.cycles).toBe(1); // restored, not reset
  });

  it('corrections decided for a DIFFERENT plan or set of targets are discarded: the budget starts over', async () => {
    const first = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    withScriptedR8(first, [{ plannerFeedback: [replan('d1', 'keep the 12px radius')] }, {}]);
    await run(first);

    const second = harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
    const other = resolutionWith(makeTarget({ id: 'tgt-other', property: 'padding-top', target: { value: '12px', comparison: 'length-px', token: null } }));
    second.nodes.rv = async () => ({ resolution: other, residualQuestions: 0, counts: { targets: 1, resolved: 1, preserved: 0, unresolved: 0, byReason: {} } });
    withScriptedR8(second, [{}]);
    await run(second);
    expect(second.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1']); // nothing replayed
    expect(second.r8Inputs[0]!.budget!.cycles).toBe(0);
    expect((await readCorrectionState(pathsOf().correctionStateJson))?.plannerPasses).toEqual([]);
  });

  // ── finding 1: a preview failure must reopen the finding, even when R5 measured it fixed ──────────────────────────────
  describe('R5 passes, R8 fails the finding: the REAL R3 processes it and the preview is rechecked', () => {
    const FB = 'b'.repeat(32);
    const stampA = '[data-fra-element="e-a"]';
    const registry = (): DsRegistry => ({
      designSystemPath: '/fake/design-system', loadedAt: Date.now(),
      version: { dsRegistryVersion: 'f'.repeat(64), tokensHash: '1'.repeat(64), componentsHash: '2'.repeat(64), advisory: { tokensPackageVersion: '0.1.0', coreV2PackageVersion: '0.1.0' }, findings: [] },
      tokens: { sourceTokens: [{ name: '--button-px-md' }], effective: [] },
      components: { totalTsxFiles: 1, componentFiles: ['atoms/Button.tsx'], stringUnionVariants: [], iifeLogic: [], cvaConfigs: [] },
      rules: { checkerScripts: [], rules: [{ id: 'R1.1', title: 'Button spacing', fields: { WHAT: 'padding must equal the DS token' }, startLine: 1, endLine: 5 }], findings: [] },
      allFindings: [],
    }) as unknown as DsRegistry;
    const entryFor = (stamp: string, findingId: string): MappingEntry => ({
      element: stamp, stamp, findingIds: [findingId], signature: null, instanceIndex: null, instanceCount: null, sectionId: 'hero', scope: 'content',
      resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 }, candidatesConsidered: 1 },
      drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
      affordances: { tagName: 'button', role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
      dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
    }) as MappingEntry;
    const edit = (findingId: string, selector: string, value = '28px'): TargetedEdit => ({ findingId, selector, expectedMatches: 1, kind: 'style', property: 'padding-left', value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'close the padding mismatch', confidence: 0.9 });
    const plan = (...edits: TargetedEdit[]): RedesignPlan => ({ edits, unaddressed: [] });
    const unmet = () => feedbackForUnmetTargets([{ targetId: 'tgt-pl', findingId: FA, property: 'padding-left', state: 'default', expected: '28px', observed: 'padding-left is 12px, expected 28px', label: 'Sign up', sectionId: 'hero', part: 'self' }]);

    /** The REAL runR3 behind a scripted model; R4 reports every planned edit applied; R5 says every finding is fixed. */
    function withRealR3(script: RedesignPlan[]): { h: Harness; llm: ScriptedLlmClient } {
      const h = harness(['PASS', 'PASS', 'PASS'], { fixedIdsOnPass: [FA, FB] });
      const llm = new ScriptedLlmClient({ R3: script });
      h.nodes.r1 = async () => { h.calls.push('R1'); return r1Output({ registry: registry() }); };
      h.nodes.c2 = async (_r1, session) => { h.calls.push('C2'); return { ...session, mapping: { entries: [entryFor('e-a', FA), entryFor('e-b', FB)], unmapped: [], conflicts: [], usage: null } }; };
      h.nodes.rv = async (input) => { h.calls.push('RV'); h.rvInputs.push(input); return { resolution: resolutionWith(makeTarget({ id: 'tgt-pl', property: 'padding-left', target: { value: '28px', comparison: 'length-px', token: null } })), residualQuestions: 0, counts: { targets: 1, resolved: 1, preserved: 0, unresolved: 0, byReason: {} } }; };
      h.nodes.r3 = async (input) => { h.calls.push(`R3#${input.iteration}`); h.r3Inputs.push(input); return runR3({ llm }, input); };
      h.nodes.r4 = async (input) => { h.calls.push(`R4#${input.iteration}`); return { iteration: input.iteration, after: { tiles: [], totalHeight: 0, truncated: false, composite: null }, applied: input.plan.plan.edits.map((e) => ({ edit: e, matched: 1, applied: true, previousValue: '12px', error: null })) }; };
      return { h, llm };
    }

    it('R5 fixed:true + R8 fail: R3 is called for that finding with the structured feedback, the corrected edit replaces the failing one, and R8 runs again on it', async () => {
      const { h, llm } = withRealR3([plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, `${stampA} span`))]);
      withScriptedR8(h, [{ plannerFeedback: unmet(), open: ['1 of 1 resolved target(s) not verified in the rendered preview (1 failed)'] }, {}]);
      const result = await run(h);

      expect(h.calls.slice(h.calls.indexOf('R8'))).toEqual(['R8', 'R3#2', 'R4#2', 'R5#2', 'R6', 'R7', 'R8']);
      // R5 measured FA fixed in iteration 1, yet R3 really processed it in the re-plan: the model was asked, and only about FA
      expect(h.r3Inputs[0]!.previous).toBeNull();
      expect(h.r3Inputs[1]!.previous?.validation.checks.find((c) => c.findingId === FA)?.fixed).toBe(true);
      expect(llm.requests).toHaveLength(2);
      expect(llm.requests[1]!.prompt).toContain(`findingId=${FA}`);
      expect(llm.requests[1]!.prompt).not.toContain(`findingId=${FB}`);
      expect(llm.requests[1]!.prompt).toContain('rendered React preview');
      // the structured feedback: finding ids, failed target, property, state, expected and observed
      expect(h.r3Inputs[1]!.feedback).toEqual([expect.objectContaining({ id: 'target:tgt-pl', kind: 'target-not-met', findingIds: [FA], targetId: 'tgt-pl', part: 'self', property: 'padding-left', state: 'default', expected: '28px', observed: 'padding-left is 12px, expected 28px' })]);
      expect(h.r3Inputs[1]!.acknowledgedConstraints).toEqual(unmet().map((f) => (f.action?.type === 'replan' ? f.action.constraint : '')));
      expect(h.r3Inputs[1]!.editsInForce).toEqual([edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')]);
      // the second R8 gets the corrected edit INSTEAD of the failing one, and keeps the other finding's edit
      const second = h.r8Inputs[1]!.edits.map((e) => `${e.findingId === FA ? 'A' : 'B'} ${e.selector}`);
      expect(second.sort()).toEqual([`A ${stampA} span`, 'B [data-fra-element="e-b"]']);
      expect(h.r8Inputs[0]!.edits).toHaveLength(2);
      // one shared budget: the re-plan cost one cycle
      expect(h.r8Inputs[0]!.budget).toBe(h.r8Inputs[1]!.budget);
      expect(h.r8Inputs[1]!.budget!.cycles).toBe(1);
      expect(result.iterations).toHaveLength(2);
      expect(result.iterations[1]!.reopened).toEqual([{ findingId: FA, property: 'padding-left', state: 'default', part: 'self' }]);
      expect(result.awaitingGate?.awaitingGate).toBe('G2');
    });

    it('the structured feedback is persisted next to the constraint strings, and a resumed run replays it into R3 (same request) without spending the budget twice', async () => {
      const script = () => [plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, `${stampA} span`))];
      const first = withRealR3(script());
      withScriptedR8(first.h, [{ plannerFeedback: unmet() }, {}]);
      const r1 = await run(first.h);
      const state = await readCorrectionState(r1.paths.correctionStateJson);
      expect(state?.plannerPasses).toHaveLength(1);
      expect(state?.plannerFeedbacks).toEqual([[expect.objectContaining({ id: 'target:tgt-pl', findingIds: [FA], targetId: 'tgt-pl' })]]);

      const second = withRealR3(script());
      withScriptedR8(second.h, [{}]);
      await run(second.h);
      expect(second.h.calls.slice(second.h.calls.indexOf('R5#1'))).toEqual(['R5#1', 'R3#2', 'R4#2', 'R5#2', 'R6', 'R7', 'R8']);
      expect(second.h.r3Inputs[1]!.feedback).toEqual(first.h.r3Inputs[1]!.feedback);
      expect(second.llm.requests[1]!.prompt).toBe(first.llm.requests[1]!.prompt);
      expect(second.h.r8Inputs[0]!.budget!.cycles).toBe(1);
      expect(second.h.r8Inputs[0]!.edits.map((e) => e.selector).sort()).toEqual([`${stampA} span`, '[data-fra-element="e-b"]'].sort());
    });

    it('a state file written before the structured feedback existed still replays (as before: no reopening, so no model call for the fixed finding)', async () => {
      const first = withRealR3([plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, `${stampA} span`))]);
      withScriptedR8(first.h, [{ plannerFeedback: unmet() }, {}]);
      const r1 = await run(first.h);
      const stored = JSON.parse(readFileSync(r1.paths.correctionStateJson, 'utf8')) as Record<string, unknown>;
      delete stored['plannerFeedbacks'];
      writeFileSync(r1.paths.correctionStateJson, JSON.stringify(stored));

      const second = withRealR3([plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]'))]);
      withScriptedR8(second.h, [{}]);
      await run(second.h);
      expect(second.h.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1', 'R3#2']); // the pass is still replayed
      expect(second.h.r3Inputs[1]!.feedback ?? []).toEqual([]);
      expect(second.h.r3Inputs[1]!.acknowledgedConstraints).toEqual(unmet().map((f) => (f.action?.type === 'replan' ? f.action.constraint : '')));
      expect(second.llm.requests).toHaveLength(1); // nothing reopened
    });

    it('the shared budget still holds: with no cycle left the finding is not re-planned and the failure reaches G2', async () => {
      const { h, llm } = withRealR3([plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]'))]);
      withScriptedR8(h, [{ plannerFeedback: unmet(), open: ['1 of 1 resolved target(s) not verified'] }]);
      const result = await run(h, { correctionBudget: { maxCycles: 0, maxVerifications: 3, maxDurationMs: null } });
      expect(h.calls.filter((c) => c === 'R8')).toHaveLength(1);
      expect(h.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1']);
      expect(llm.requests).toHaveLength(1);
      expect(result.awaitingGate?.reason).toMatch(/NOT satisfied/);
    });

    it('the no-progress rule still holds: when the same feedback id persists after the reopened pass the loop stops after ONE re-plan', async () => {
      const { h, llm } = withRealR3([plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, `${stampA} span`)), plan(edit(FA, `${stampA} b`))]);
      withScriptedR8(h, [{ plannerFeedback: unmet(), open: ['x'] }]); // the same defect after every re-plan
      const result = await run(h, { correctionBudget: { maxCycles: 6, maxVerifications: 9, maxDurationMs: null } });
      expect(h.calls.filter((c) => c === 'R8')).toHaveLength(2);
      expect(h.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1', 'R3#2']);
      expect(llm.requests).toHaveLength(2); // the reopened pass did reach the model
      expect(result.awaitingGate?.reason).toMatch(/NOT satisfied/);
    });

    it('a dropped edit of the reopened finding/property is released when the planner supplies the corrected edit (otherwise the correction would be dropped at replay)', async () => {
      const { h } = withRealR3([plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, `${stampA} span`))]);
      withScriptedR8(h, [{ plannerFeedback: unmet(), droppedEdits: [`${FA}|padding-left`, `${FB}|color`] }, { droppedEdits: [`${FB}|color`] }]); // a real R8 returns the corrections it was given
      const result = await run(h);
      expect(h.r8Inputs[1]!.corrections?.droppedEdits).toEqual([`${FB}|color`]);
      expect((await readCorrectionState(result.paths.correctionStateJson))?.droppedEdits).toEqual([`${FB}|color`]);
    });

    it('a dropped edit stays dropped when the planner supplied nothing new for it', async () => {
      const { h } = withRealR3([plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), { edits: [], unaddressed: [{ findingId: FA, reason: 'no selector reaches the visible text' }] }]);
      withScriptedR8(h, [{ plannerFeedback: unmet(), droppedEdits: [`${FA}|padding-left`] }, {}]);
      await run(h);
      expect(h.r8Inputs[1]!.corrections?.droppedEdits).toEqual([`${FA}|padding-left`]);
    });

    // ── the failing target's part reaches the supersede rule (fresh pass AND replay) ──────────────────────────────────────
    const unmetPart = (part: string) => feedbackForUnmetTargets([{ targetId: 'tgt-pl', findingId: FA, property: 'padding-left', state: 'default', expected: '28px', observed: 'padding-left is 12px, expected 28px', label: 'Sign up', sectionId: 'hero', part }]);
    const selectorsOfA = (edits: TargetedEdit[]) => edits.filter((e) => e.findingId === FA).map((e) => e.selector).sort();

    for (const [part, expected] of [['label', [stampA, `${stampA} span`]], ['self', [`${stampA} span`]]] as const) {
      it(`a ${part}-part feedback pass ${part === 'label' ? 'leaves the bare-stamp edit in force beside the descendant correction' : 'retires the bare-stamp edit: the descendant edit is the cure for the element'}`, async () => {
        const { h } = withRealR3([plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, `${stampA} span`))]);
        withScriptedR8(h, [{ plannerFeedback: unmetPart(part) }, {}]);
        const result = await run(h);
        expect(selectorsOfA(h.r8Inputs[0]!.edits)).toEqual([stampA]);
        expect(selectorsOfA(h.r8Inputs[1]!.edits)).toEqual([...expected]);
        expect(result.iterations[1]!.reopened).toEqual([{ findingId: FA, property: 'padding-left', state: 'default', part }]);
      });
    }

    for (const [part, expected] of [['label', [stampA, `${stampA} span`]], ['self', [`${stampA} span`]]] as const) {
      it(`the same on a REPLAY: the stored ${part}-part feedback ${part === 'label' ? 'keeps' : 'retires'} the bare-stamp edit in the resumed run's first R8`, async () => {
        const script = () => [plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, `${stampA} span`))];
        const first = withRealR3(script());
        withScriptedR8(first.h, [{ plannerFeedback: unmetPart(part) }, {}]);
        const r1 = await run(first.h);
        expect((await readCorrectionState(r1.paths.correctionStateJson))?.plannerFeedbacks).toEqual([[expect.objectContaining({ part })]]);

        const second = withRealR3(script());
        withScriptedR8(second.h, [{}]);
        const replayed = await run(second.h);
        expect(selectorsOfA(second.h.r8Inputs[0]!.edits)).toEqual([...expected]);
        expect(replayed.iterations[1]!.reopened).toEqual([{ findingId: FA, property: 'padding-left', state: 'default', part }]);
      });
    }

    // ── a fidelity regression names no part (null): it must not retire the stamp edit that satisfies the element's own target ──
    const regression = (): CorrectionFeedback[] => [{
      id: 'd-pl', kind: 'default-regression', sectionId: 'hero', viewport: 'desktop', elementKey: '0/0', elementLabel: 'Sign up label', state: 'default', property: 'padding-left', expected: '28px', observed: '12px', findingIds: [FA],
      message: 'Sign up label: padding-left should be 28px (the original), but is 12px.', responsible: 'planner', action: { type: 'replan', findingIds: [FA], constraint: 'padding-left on "Sign up label" must keep the original value 28px unless a resolved target authorizes a change; the preview shows 12px' }, blockedReason: null,
    }];

    it('a default-regression (part null) whose restore sits on a DESCENDANT leaves the bare-stamp edit in force; the replay of the stored feedback does the same', async () => {
      const script = () => [plan(edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, `${stampA} span`))];
      const first = withRealR3(script());
      withScriptedR8(first.h, [{ plannerFeedback: regression() }, {}]);
      const result = await run(first.h);
      expect(selectorsOfA(first.h.r8Inputs[0]!.edits)).toEqual([stampA]);
      expect(first.h.r3Inputs[1]!.feedback).toEqual([expect.objectContaining({ kind: 'default-regression', part: null, targetId: null })]);
      expect(result.iterations[1]!.reopened).toEqual([{ findingId: FA, property: 'padding-left', state: 'default', part: null }]);
      expect(selectorsOfA(first.h.r8Inputs[1]!.edits)).toEqual([stampA, `${stampA} span`]);

      const second = withRealR3(script());
      withScriptedR8(second.h, [{}]);
      await run(second.h);
      expect(selectorsOfA(second.h.r8Inputs[0]!.edits)).toEqual([stampA, `${stampA} span`]);
    });

    it('the same default-regression restored ON the stamp selector still replaces the offending edit (a restore on the same selector)', async () => {
      const { h } = withRealR3([plan(edit(FA, stampA, '40px'), edit(FB, '[data-fra-element="e-b"]')), plan(edit(FA, stampA))]);
      withScriptedR8(h, [{ plannerFeedback: regression() }, {}]);
      await run(h);
      expect(h.r8Inputs[1]!.edits.filter((e) => e.findingId === FA).map((e) => `${e.selector}=${e.value}`)).toEqual([`${stampA}=28px`]);
    });

    it('a conflict the planner explained for a property it deliberately did NOT edit (a mismatch of the finding) survives a correction of another property', async () => {
      const gap = 'font-weight conflicts with the surface token';
      const { h } = withRealR3([{ edits: [edit(FA, stampA), edit(FB, '[data-fra-element="e-b"]')], unaddressed: [{ findingId: FA, reason: gap }] }, plan(edit(FA, `${stampA} span`))]);
      withScriptedR8(h, [{ plannerFeedback: unmet() }, {}]);
      await run(h);
      expect(h.r8Inputs[0]!.unaddressed).toEqual([{ findingId: FA, reason: gap }]);
      expect(h.r8Inputs[1]!.unaddressed).toEqual([{ findingId: FA, reason: gap }]);
    });

    // ── review 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
    const stampB = '[data-fra-element="e-b"]';
    const withProp = (e: TargetedEdit, property: string, value: string): TargetedEdit => ({ ...e, property, value });
    const unmetB = () => feedbackForUnmetTargets([{ targetId: 'tgt-fb', findingId: FB, property: 'padding-left', state: 'default', expected: '28px', observed: 'padding-left is 12px, expected 28px', label: 'Sign up B', sectionId: 'hero', part: 'self' }]);
    const lengthTarget = (id: string, findingId: string, property: string, value: string): ResolvedTarget => makeTarget({ id, findingId, property, target: { value, comparison: 'length-px', token: null } });

    /** R5 as the real node reports a finding R3 listed as unaddressed: not fixed, nothing measured. */
    function withR5LikeReal(h: Harness): void {
      h.nodes.r5 = async (input: R5Input) => {
        h.calls.push(`R5#${input.iteration}`);
        const gaps = new Map(input.plan.plan.unaddressed.map((u) => [u.findingId, u.reason] as const));
        const checks = [FA, FB].map((findingId) => (gaps.has(findingId) ? { findingId, fixed: false, detail: `unaddressed: ${gaps.get(findingId)}`, measured: [] } : { findingId, fixed: true, detail: 'ok', measured: [] }));
        const ok = checks.every((c) => c.fixed);
        return { ...validation(input.iteration, ok ? 'PASS' : 'PARTIAL', { failed: ok ? [] : [`finding ${FB}: unaddressed`] }), checks };
      };
    }

    it('a third pass with a CHANGED id set: the restriction survives R5\'s "unaddressed" record, supersession follows the passes in order, the gap of a pass that landed its correction is gone, and the budget holds', async () => {
      const { h, llm } = withRealR3([
        plan(edit(FA, stampA), edit(FB, stampB), withProp(edit(FB, stampB), 'font-weight', '500')),
        // pass 2 reopens A and B: A is corrected, B is corrected AND its font-weight (outside the feedback) is refused
        plan(edit(FA, `${stampA} span`), withProp(edit(FB, stampB), 'font-weight', '700'), edit(FB, `${stampB} span`)),
        // pass 3 reopens only B: its font-weight is still outside the feedback, the deeper selector replaces the previous correction
        plan(withProp(edit(FB, stampB), 'font-weight', '700'), edit(FB, `${stampB} span b`)),
      ]);
      h.nodes.rv = async (input) => { h.calls.push('RV'); h.rvInputs.push(input); return { resolution: resolutionWith(lengthTarget('tgt-pl', FA, 'padding-left', '28px'), lengthTarget('tgt-fb', FB, 'padding-left', '28px'), makeTarget({ id: 'tgt-fb-fw', findingId: FB, property: 'font-weight', target: { value: '500', comparison: 'exact', token: null } })), residualQuestions: 0, counts: { targets: 3, resolved: 3, preserved: 0, unresolved: 0, byReason: {} } }; };
      withR5LikeReal(h);
      withScriptedR8(h, [{ plannerFeedback: [...unmet(), ...unmetB()], open: ['x'] }, { plannerFeedback: unmetB(), open: ['x'] }, {}]);
      const result = await run(h);

      expect(h.calls.slice(h.calls.indexOf('R8'))).toEqual(['R8', 'R3#2', 'R4#2', 'R5#2', 'R6', 'R7', 'R8', 'R3#3', 'R4#3', 'R5#3', 'R6', 'R7', 'R8']);
      expect(llm.requests).toHaveLength(3);
      expect(llm.requests[2]!.prompt).toContain(`findingId=${FB}`);
      expect(llm.requests[2]!.prompt).not.toContain(`findingId=${FA}`); // the id set changed: A is no longer named
      // pass 3: the out-of-scope font-weight is refused although R5 recorded B as "unaddressed" with nothing measured
      expect(h.r3Inputs[2]!.previous?.validation.checks.find((c) => c.findingId === FB)).toMatchObject({ fixed: false, measured: [] });
      expect(result.iterations[2]!.plan.plan.unaddressed).toEqual([{ findingId: FB, reason: expect.stringMatching(/outside the preview feedback scope/) }]);
      expect(result.iterations[2]!.plan.plan.edits.map((e) => e.selector)).toEqual([`${stampB} span b`]);
      // supersession in order: the bare stamp edit, then the first correction, are replaced; the untouched font-weight edit stays
      expect(h.r8Inputs[1]!.edits.map((e) => `${e.findingId === FA ? 'A' : 'B'} ${e.property}@${e.selector.replace('[data-fra-element="e-', '').replace('"]', '')}`).sort()).toEqual(['A padding-left@a span', 'B font-weight@b', 'B padding-left@b span']);
      expect(h.r8Inputs[2]!.edits.map((e) => `${e.findingId === FA ? 'A' : 'B'} ${e.property}@${e.selector.replace('[data-fra-element="e-', '').replace('"]', '')}`).sort()).toEqual(['A padding-left@a span', 'B font-weight@b', 'B padding-left@b span b']);
      // a pass that landed its correction leaves no stale "outside the preview feedback scope" gap to explain away the failing target
      expect(h.r8Inputs[1]!.unaddressed).toEqual([]);
      expect(h.r8Inputs[2]!.unaddressed).toEqual([]);
      // one shared budget: two re-plans, two cycles
      expect(h.r8Inputs[2]!.budget!.cycles).toBe(2);
      expect((await readCorrectionState(result.paths.correctionStateJson))).toMatchObject({ cyclesUsed: 2, plannerPasses: [expect.any(Array), expect.any(Array)], plannerFeedbacks: [expect.any(Array), [expect.objectContaining({ findingIds: [FB] })]] });
      expect(result.awaitingGate?.awaitingGate).toBe('G2');
    });

    it('a legacy state file (passes, no structured feedback) followed by a NEW live re-plan: the feedback list is padded so the new pass lines up with its index, and the next resume replays both', async () => {
      const script = () => [plan(edit(FA, stampA), edit(FB, stampB)), plan(edit(FA, `${stampA} span`))];
      const first = withRealR3(script());
      withScriptedR8(first.h, [{ plannerFeedback: unmet() }, {}]);
      const r1 = await run(first.h);
      const stored = JSON.parse(readFileSync(r1.paths.correctionStateJson, 'utf8')) as Record<string, unknown>;
      delete stored['plannerFeedbacks'];
      writeFileSync(r1.paths.correctionStateJson, JSON.stringify(stored));

      // second run: the legacy pass replays as strings only (nothing reopened), then the preview fails the finding again and a NEW pass is decided live
      const second = withRealR3(script());
      withScriptedR8(second.h, [{ plannerFeedback: unmet() }, {}]);
      await run(second.h);
      expect(second.h.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1', 'R3#2', 'R3#3']);
      expect(second.h.r3Inputs[1]!.feedback ?? []).toEqual([]);
      expect(second.h.r3Inputs[2]!.feedback).toEqual([expect.objectContaining({ findingIds: [FA], targetId: 'tgt-pl' })]);
      const state = await readCorrectionState(r1.paths.correctionStateJson);
      expect(state?.plannerPasses).toHaveLength(2);
      expect(state?.plannerFeedbacks).toEqual([[], [expect.objectContaining({ findingIds: [FA] })]]);

      // third run: both passes replay with THEIR OWN feedback (the legacy one none, the live one the stored item)
      const third = withRealR3(script());
      withScriptedR8(third.h, [{}]);
      await run(third.h);
      expect(third.h.r3Inputs.map((i) => (i.feedback ?? []).length)).toEqual([0, 0, 1]);
      expect(third.llm.requests).toHaveLength(2);
      expect(third.h.r8Inputs[0]!.edits.map((e) => e.selector).sort()).toEqual([`${stampA} span`, stampB].sort());
      expect(third.h.r8Inputs[0]!.budget!.cycles).toBe(2);
    });

    it('a crash between persisting the pass and releasing the dropped edit: the REPLAY releases it too, so the planner\'s correction is not dropped again', async () => {
      const script = () => [plan(edit(FA, stampA), edit(FB, stampB)), plan(edit(FA, `${stampA} span`))];
      const first = withRealR3(script());
      withScriptedR8(first.h, [{ plannerFeedback: unmet(), droppedEdits: [`${FA}|padding-left`, `${FB}|color`] }, { droppedEdits: [`${FB}|color`] }]);
      const r1 = await run(first.h);
      // the state as it was when the process died after the pass was stored and BEFORE the release was written
      const stored = JSON.parse(readFileSync(r1.paths.correctionStateJson, 'utf8')) as { droppedEdits: string[] };
      writeFileSync(r1.paths.correctionStateJson, JSON.stringify({ ...stored, droppedEdits: [`${FA}|padding-left`, `${FB}|color`] }));

      const second = withRealR3(script());
      withScriptedR8(second.h, [{ droppedEdits: [`${FB}|color`] }]); // a real R8 returns the corrections it was given
      await run(second.h);
      expect(second.h.calls.filter((c) => c.startsWith('R3'))).toEqual(['R3#1', 'R3#2']);
      expect(second.h.r8Inputs[0]!.corrections?.droppedEdits).toEqual([`${FB}|color`]);
      expect((await readCorrectionState(r1.paths.correctionStateJson))?.droppedEdits).toEqual([`${FB}|color`]);
    });

    it('a replayed pass that landed NO correction does not release the dropped edit', async () => {
      const script = () => [plan(edit(FA, stampA), edit(FB, stampB)), { edits: [], unaddressed: [{ findingId: FA, reason: 'no selector reaches the visible text' }] }];
      const first = withRealR3(script());
      withScriptedR8(first.h, [{ plannerFeedback: unmet(), droppedEdits: [`${FA}|padding-left`] }, { droppedEdits: [`${FA}|padding-left`] }]);
      const r1 = await run(first.h);
      const second = withRealR3(script());
      withScriptedR8(second.h, [{ droppedEdits: [`${FA}|padding-left`] }]);
      await run(second.h);
      expect(second.h.r8Inputs[0]!.corrections?.droppedEdits).toEqual([`${FA}|padding-left`]);
      expect((await readCorrectionState(r1.paths.correctionStateJson))?.droppedEdits).toEqual([`${FA}|padding-left`]);
    });

    it('PINNED: R5 called the finding fixed, but the reopened pass ends in "unaddressed": the unit state is failed (the last check decides) while the page verdict stays the R5 live-page one, and G2 reports the open required check', async () => {
      const { h } = withRealR3([plan(edit(FA, stampA), edit(FB, stampB)), { edits: [], unaddressed: [{ findingId: FA, reason: 'no selector reaches the visible text' }] }]);
      withR5LikeReal(h);
      withScriptedR8(h, [{ plannerFeedback: unmet(), open: ['1 of 1 resolved target(s) not verified in the rendered preview (1 failed)'] }, { open: ['1 of 1 resolved target(s) not verified in the rendered preview (1 failed)'] }]);
      const result = await run(h);
      expect(result.iterations[0]!.validation.checks.find((c) => c.findingId === FA)?.fixed).toBe(true);
      expect(result.iterations[1]!.validation.checks.find((c) => c.findingId === FA)).toMatchObject({ fixed: false, measured: [] });
      expect(result.meta.unitStates[FA]).toBe('failed');
      expect(result.meta.unitStates[FB]).toBe('done');
      expect(result.awaitingGate?.reason).toMatch(/page verdict PASS/); // deriveOutcome: any iteration that passed on the live page
      expect(result.awaitingGate?.reason).toMatch(/1 required check\(s\) NOT satisfied/);
    });
  });
});

describe('runRedesignPipeline — clean user-facing deliverable (redesign/, a sibling of new-component/)', () => {
  it('Full Page mode: redesign/redesigned-page.html exists as soon as R7 runs, well before G2 is answered — no wrapping folder, no redesigned-sections.html', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    const result = await runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(result.awaitingGate).toMatchObject({ awaitingGate: 'G2' });

    const pagePath = join(result.paths.redesignDeliverableDir, 'redesigned-page.html');
    expect(existsSync(pagePath)).toBe(true);
    expect(readFileSync(pagePath, 'utf-8')).toContain('content iter=1'); // the SAME content r7Mock wrote to redesign-content.html
    expect(existsSync(join(result.paths.redesignDeliverableDir, 'redesigned-sections.html'))).toBe(false);
    expect(existsSync(result.paths.newComponentDir)).toBe(false); // a page-only run never creates the sibling
  });

  it('Selected Sections mode: redesigned-sections.html PLUS one standalone file per selected section land directly in redesign/', async () => {
    const findings = [makeFinding({ findingId: 'a'.repeat(32), section: 'Hero' }), makeFinding({ findingId: 'b'.repeat(32), section: 'Features' })];
    const h = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    h.nodes.r1 = async () => {
      h.calls.push('R1');
      return r1Output({ findings, fixFindings: findings });
    };
    h.nodes.r7 = async (input: R7Input) => {
      h.calls.push('R7');
      h.r7Inputs.push(input);
      // Real R7 writes one fragment per resolved section id (§8.2) — mirrored here so the
      // deliverable-copy step has real, section-specific files to actually copy.
      for (const id of input.sectionIds) writeFileSync(sectionFragmentPath(input.paths, id), `<!doctype html><html><body>fragment ${id}</body></html>`);
      return r7Mock(input);
    };
    const result = await runRedesignPipeline(ctx({ mode: 'selected-sections', resolvedSectionIds: ['hero', 'features'] }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(result.awaitingGate).toMatchObject({ awaitingGate: 'G2' });

    expect(existsSync(join(result.paths.redesignDeliverableDir, 'redesigned-sections.html'))).toBe(true);
    expect(readFileSync(join(result.paths.redesignDeliverableSectionsDir, 'hero.html'), 'utf-8')).toContain('fragment hero');
    expect(readFileSync(join(result.paths.redesignDeliverableSectionsDir, 'features.html'), 'utf-8')).toContain('fragment features');
  });
});

describe('runRedesignPipeline — claude-session judgmentProvider: checkpoint/resume (§judgmentProvider)', () => {
  it('a judgment pause from C2 checkpoints as awaiting-judgment (never failed), releases the session, and is a DISTINCT axis from awaitingGate', async () => {
    const pending = new AwaitingJudgmentError('C2', 'bundle123', '/fake/run/judgments/bundle123.bundle.json');
    const h = harness(['PASS']);
    h.nodes.c2 = async () => {
      h.calls.push('C2');
      throw pending;
    };
    const result = await runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });

    expect(h.calls).toEqual(['R1', 'R2', 'C2']); // never reaches the R3→R4→R5 loop
    expect(h.released.count).toBe(1); // the open R2 session is still released on a judgment pause
    expect(result.awaitingGate).toBeNull(); // a judgment pause is NOT a gate pause
    expect(result.awaitingJudgment).toEqual({ nodeId: 'C2', bundleId: 'bundle123', bundlePath: '/fake/run/judgments/bundle123.bundle.json' });
    expect(result.runOutcome).toBe('awaiting-judgment');

    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', 'page-audit-redesign-test');
    const meta = (await readRedesignRunMeta(paths))!;
    expect(meta.runOutcome).toBe('awaiting-judgment');
    expect(meta.failedAt).toBeNull(); // never recorded as a failure
    expect(meta.error).toBeNull();
  });

  it('a judgment pause mid-loop (R3, iteration 2) does not consume or skip an iteration: resuming re-plans iteration 2 for real, not iteration 3', async () => {
    const pending = new AwaitingJudgmentError('R3', 'bundle-r3-2', '/fake/bundle-r3-2.bundle.json');
    const h = harness(['PARTIAL']);
    const originalR3 = h.nodes.r3;
    h.nodes.r3 = async (input: R3Input, paths, redesignRunId) => {
      if (input.iteration === 2) {
        h.calls.push(`R3#${input.iteration}(paused)`);
        throw pending;
      }
      return originalR3(input, paths, redesignRunId);
    };
    const paused = await runRedesignPipeline(ctx(), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(h.calls).toEqual(['R1', 'R2', 'C2', 'B1', 'RV', 'R3#1', 'R4#1', 'R5#1', 'R3#2(paused)']);
    expect(h.released.count).toBe(1);
    expect(paused.awaitingJudgment).toMatchObject({ nodeId: 'R3', bundleId: 'bundle-r3-2' });
    expect(paused.runOutcome).toBe('awaiting-judgment');

    // Resume (a fresh invocation, exactly like an approved-gate resume already works elsewhere in
    // this file): iteration 2 runs for real this time — never silently treated as already done,
    // and never jumped ahead to iteration 3 as if the paused attempt had counted.
    const h2 = harness(['PARTIAL', 'PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    const resumed = await runRedesignPipeline(ctx(), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
    expect(h2.calls).toEqual(['R1', 'R2', 'C2', 'B1', 'RV', 'R3#1', 'R4#1', 'R5#1', 'R3#2', 'R4#2', 'R5#2', 'R6', 'R7', 'R8']);
    expect(resumed.iterations.map((i) => i.validation.overall)).toEqual(['PARTIAL', 'PASS']);
    expect(resumed.awaitingJudgment).toBeFalsy();
  });

  it('a judgment pause from L2 (Workflow B) also checkpoints cleanly — propagates through runComponentWorkflow\'s own try/finally', async () => {
    const dsRepoPath = join(root, 'fake-ds-repo-judgment');
    mkdirSync(dsRepoPath, { recursive: true });
    const upstream: NewComponentPlan = { schemaVersion: 1, runId: 'page-audit', updatedAt: null, entries: [{ findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' }] };
    const pending = new AwaitingJudgmentError('L2', 'bundle-l2', '/fake/bundle-l2.bundle.json');
    const redesignRunId = 'page-audit-components-judgment-test';
    const h = harness(['PASS']);
    h.nodes.r1 = async () => {
      h.calls.push('R1');
      return r1Output({ newComponentPlan: upstream });
    };
    h.nodes.l1 = async (input: L1NodeInput) => {
      h.calls.push('L1');
      return {
        resolvedPlan: { schemaVersion: 1, redesignRunId: input.redesignRunId, entries: [], disagreements: [] },
        specs: [
          {
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
            anatomy: 'card — 1 instance',
            variantAxes: [],
            tokens: [],
            statesObserved: ['default'],
            statesToDesign: ['hover'],
            postFixPrerequisite: null,
            writeSet: ['core-v2/src/molecules/Card.tsx'],
            declaredSharedChanges: { barrelEntries: [], tokenAdditions: [] },
            dependsOn: { findings: [], components: [] },
            constraints: [],
          },
        ],
        ambiguous: [],
        blocked: [],
      };
    };
    h.nodes.l2 = async () => {
      h.calls.push('L2');
      throw pending;
    };

    const result = await runRedesignPipeline(ctx({ redesignRunId, runType: 'components', dsRepoPath }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'components' });
    expect(h.calls).toEqual(['R1', 'R2', 'C2', 'R6', 'L1', 'L2']);
    expect(h.released.count).toBe(1); // components-only owns its session — still released on a judgment pause
    expect(result.awaitingJudgment).toEqual({ nodeId: 'L2', bundleId: 'bundle-l2', bundlePath: '/fake/bundle-l2.bundle.json' });
    expect(result.runOutcome).toBe('awaiting-judgment');
    expect(result.awaitingGate).toBeNull();
  });
});

describe('runRedesignPipeline — Workflow B', () => {
  const componentSpec = (): ComponentSpec => ({
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
    anatomy: 'card — 1 instance',
    variantAxes: [],
    tokens: [],
    statesObserved: ['default'],
    statesToDesign: ['hover'],
    postFixPrerequisite: null,
    writeSet: ['core-v2/src/molecules/Card.tsx', 'core-v2/src/molecules/Card.stories.tsx'],
    declaredSharedChanges: { barrelEntries: [], tokenAdditions: [] },
    dependsOn: { findings: [], components: [] },
    constraints: [],
  });

  const l2Pass = (): L2Output => ({ componentId: 'comp-1', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true, violatingPaths: [], usage: null });
  const l3Pass = (): L3Output => ({ componentId: 'comp-1', dsChecks: { typecheck: true, lint: true, verify: true, storyBuild: true, detail: [] }, acceptance: [], visionVerdict: 'NOT_CHECKED', status: 'PASS', failedChecks: [], usage: null });
  const l4Pass = (): L4Output => ({ componentId: 'comp-1', previewHtmlPath: '/fake/preview.html', previewPngPaths: [], inContextRendered: true });

  function componentNodes(h: Harness) {
    h.nodes.l1 = async (input: L1NodeInput): Promise<L1Output> => {
      h.calls.push('L1');
      return { resolvedPlan: { schemaVersion: 1, redesignRunId: input.redesignRunId, entries: [], disagreements: [] }, specs: [componentSpec()], ambiguous: [], blocked: [] };
    };
    h.nodes.l2 = async (spec) => {
      h.calls.push('L2');
      expect(spec.componentId).toBe('comp-1');
      return l2Pass();
    };
    h.nodes.l2b = async () => {
      h.calls.push('L2b');
      return { barrelsTouched: [], tokenStylesheetTouched: null };
    };
    h.nodes.l3 = async () => {
      h.calls.push('L3');
      return l3Pass();
    };
    h.nodes.l4 = async () => {
      h.calls.push('L4');
      return l4Pass();
    };
    h.nodes.l5 = async () => {
      h.calls.push('L5');
      return { committed: true, commitSha: 'abc123', pushed: true, pushedRemote: 'origin', prUrl: null, reason: null };
    };
  }

  function fakeDsRepo(): string {
    const dsRepoPath = join(root, 'fake-ds-repo');
    mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
    writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'), 'export const Card = () => null;\n');
    return dsRepoPath;
  }

  it('a `components`-only run opens its OWN session via R2/C2/R6 and RELEASES it when done — no leaked browser context', async () => {
    const redesignRunId = 'page-audit-components-test';
    const dsRepoPath = fakeDsRepo();
    const upstream: NewComponentPlan = { schemaVersion: 1, runId: 'page-audit', updatedAt: null, entries: [{ findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' }] };
    const withComponentPlanUpstream = (owner: Harness) => async () => {
      owner.calls.push('R1');
      return r1Output({ newComponentPlan: upstream });
    };
    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', redesignRunId);

    // First pass: no G4 decision exists yet — must stop there, but L1-L4 already ran for real
    // (L4's preview/acceptance/spec files on disk are exactly what G4's fingerprint covers).
    const h = harness(['PASS']);
    componentNodes(h);
    h.nodes.r1 = withComponentPlanUpstream(h);
    const first = await runRedesignPipeline(ctx({ redesignRunId, runType: 'components', dsRepoPath }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'components' });
    expect(first.awaitingGate).toMatchObject({ awaitingGate: 'G4' });
    expect(h.released.count).toBe(1); // components-only owns its session and must release it even when stopped at a gate
    // Honest reporting: nothing approved yet, so new-component/ (and the sibling redesign/,
    // which a components-only run never creates at all) simply don't exist yet.
    expect(existsSync(first.paths.newComponentDir)).toBe(false);
    expect(existsSync(first.paths.redesignDeliverableDir)).toBe(false);

    // Approve with the SAME fingerprint the real `decide` CLI would compute from those files.
    const g4Fp = await computeG4Fingerprint(paths, dsRepoPath, 'comp-1');
    await recordDecision(paths.decisionsJson, redesignRunId, { gate: 'G4', outcome: 'approve-and-push', fingerprint: g4Fp, unitId: 'comp-1', by: 'reviewer', at: '2026-09-18T10:00:00.000Z', note: null });

    const h2 = harness(['PASS']);
    componentNodes(h2);
    h2.nodes.r1 = withComponentPlanUpstream(h2);
    const result = await runRedesignPipeline(ctx({ redesignRunId, runType: 'components', dsRepoPath }), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'components' });

    expect(h2.calls).toEqual(['R1', 'R2', 'C2', 'R6', 'L1', 'L2', 'L3', 'L2b', 'L4', 'L5']);
    expect(h2.released.count).toBe(1); // the critical regression check: components-only owns its session and must release it
    expect(result.awaitingGate).toBeNull();
    expect(result.l1?.specs).toHaveLength(1);

    // Clean deliverable — `new-component/`, a sibling of `redesign/` (which a components-only run never creates).
    expect(existsSync(result.paths.newComponentIndexHtml)).toBe(true);
    expect(readFileSync(result.paths.newComponentIndexHtml, 'utf-8')).toContain('Card');
    expect(readFileSync(join(result.paths.newComponentDir, 'Card', 'Card.tsx'), 'utf-8')).toContain('export const Card');
    expect(existsSync(result.paths.redesignDeliverableDir)).toBe(false);
  });

  it('§7.7 regression: a component L1 could not resolve (blocked/ambiguous) is never silently absent from unitStates — the run never reports "completed" while it sits unresolved', async () => {
    const redesignRunId = 'page-audit-components-blocked-test';
    const dsRepoPath = fakeDsRepo();
    const upstream: NewComponentPlan = { schemaVersion: 1, runId: 'page-audit', updatedAt: null, entries: [{ findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' }] };
    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', redesignRunId);

    function componentNodesWithBlocked(h: Harness) {
      componentNodes(h);
      h.nodes.l1 = async (input: L1NodeInput): Promise<L1Output> => {
        h.calls.push('L1');
        return {
          resolvedPlan: { schemaVersion: 1, redesignRunId: input.redesignRunId, entries: [], disagreements: [] },
          specs: [componentSpec()],
          ambiguous: [],
          blocked: [{ componentId: 'comp-blocked', reason: 'depends on a post-fix opportunity not yet verified' }],
        };
      };
    }

    const h = harness(['PASS']);
    componentNodesWithBlocked(h);
    h.nodes.r1 = async () => {
      h.calls.push('R1');
      return r1Output({ newComponentPlan: upstream });
    };
    const first = await runRedesignPipeline(ctx({ redesignRunId, runType: 'components', dsRepoPath }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'components' });
    expect(first.awaitingGate).toMatchObject({ awaitingGate: 'G4' });
    expect(first.meta.unitStates['comp-blocked']).toBe('blocked'); // present even while the run is only awaiting G4 for the OTHER component

    const g4Fp = await computeG4Fingerprint(paths, dsRepoPath, 'comp-1');
    await recordDecision(paths.decisionsJson, redesignRunId, { gate: 'G4', outcome: 'approve-and-push', fingerprint: g4Fp, unitId: 'comp-1', by: 'reviewer', at: '2026-09-18T10:00:00.000Z', note: null });

    const h2 = harness(['PASS']);
    componentNodesWithBlocked(h2);
    h2.nodes.r1 = async () => {
      h2.calls.push('R1');
      return r1Output({ newComponentPlan: upstream });
    };
    const result = await runRedesignPipeline(ctx({ redesignRunId, runType: 'components', dsRepoPath }), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'components' });

    expect(result.awaitingGate).toBeNull(); // comp-1 is fully approved and published — nothing left to ASK
    expect(result.meta.unitStates['comp-blocked']).toBe('blocked'); // still there, never silently dropped
    expect(result.meta.unitStates['comp-1']).toBe('done');
    expect(result.runOutcome).toBe('blocked'); // NOT "completed" — a requested-but-blocked component still exists
    expect(result.meta.componentCount).toBe(2); // the resolved spec AND the blocked one both count as requested
  });

  it('a `combined` run reuses Workflow A\'s session for Workflow B — no second R2/C2, released exactly once total', async () => {
    const h = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    componentNodes(h);
    const redesignRunId = 'page-audit-combined-test';
    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', redesignRunId);

    const withComponentPlan = (owner: Harness) => async () => {
      owner.calls.push('R1');
      const upstream: NewComponentPlan = { schemaVersion: 1, runId: 'page-audit', updatedAt: null, entries: [{ findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' }] };
      return r1Output({ newComponentPlan: upstream });
    };
    h.nodes.r1 = withComponentPlan(h);

    const dsRepoPath = fakeDsRepo();

    // First pass stops at G2 (always asks) — approve it, then resume into Workflow B.
    const first = await runRedesignPipeline(ctx({ redesignRunId, runType: 'combined', dsRepoPath }), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'combined' });
    expect(first.awaitingGate).toMatchObject({ awaitingGate: 'G2' });
    expect(h.released.count).toBe(1); // G2-stop still releases the session — it is reopened on resume

    const g2Fp = await computeG2Fingerprint(first.paths);
    await recordDecision(paths.decisionsJson, redesignRunId, { gate: 'G2', outcome: 'approve', fingerprint: g2Fp, unitId: null, by: 'reviewer', at: '2026-09-18T10:05:00.000Z', note: null });

    // Second pass: G2 is now recognized as approved, so it proceeds into Workflow B for the
    // first time — L1-L4 run for real, and it stops at G4 since no component decision exists yet.
    const h2 = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    componentNodes(h2);
    h2.nodes.r1 = withComponentPlan(h2);
    const second = await runRedesignPipeline(ctx({ redesignRunId, runType: 'combined', dsRepoPath }), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'combined' });
    expect(second.awaitingGate).toMatchObject({ awaitingGate: 'G4' });
    expect(h2.released.count).toBe(1);

    const g4Fp = await computeG4Fingerprint(paths, dsRepoPath, 'comp-1');
    await recordDecision(paths.decisionsJson, redesignRunId, { gate: 'G4', outcome: 'approve-and-push', fingerprint: g4Fp, unitId: 'comp-1', by: 'reviewer', at: '2026-09-18T10:06:00.000Z', note: null });

    const h3 = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    componentNodes(h3);
    h3.nodes.r1 = withComponentPlan(h3);
    const resumed = await runRedesignPipeline(ctx({ redesignRunId, runType: 'combined', dsRepoPath }), h3.nodes, { runRef: { runId: 'page-audit' }, runType: 'combined' });

    // R2/C2 run exactly once (Workflow A's session) — Workflow B's L1-L5 never re-open one.
    expect(h3.calls.filter((c) => c === 'R2')).toHaveLength(1);
    expect(h3.calls.filter((c) => c === 'C2')).toHaveLength(1);
    expect(h3.calls).toEqual(['R1', 'R2', 'C2', 'B1', 'RV', 'R3#1', 'R4#1', 'R5#1', 'R6', 'R7', 'R8', 'L1', 'L2', 'L3', 'L2b', 'L4', 'L5']);
    expect(h3.released.count).toBe(1); // released exactly once total by the OUTER finally, never a second time inside runComponentWorkflow
    expect(resumed.awaitingGate).toBeNull();

    // Clean deliverables — TWO true siblings, `redesign/` and `new-component/`, neither nested
    // in the other, each built at its own point (R7-time vs. approved-package-time) without
    // needing to know about or clobber the other's half (no shared index between them anymore).
    expect(existsSync(join(resumed.paths.redesignDeliverableDir, 'redesigned-page.html'))).toBe(true);
    expect(existsSync(join(resumed.paths.newComponentDir, 'Card', 'Card.tsx'))).toBe(true);
    expect(resumed.paths.newComponentDir.startsWith(resumed.paths.redesignDeliverableDir)).toBe(false);
    expect(resumed.paths.redesignDeliverableDir.startsWith(resumed.paths.newComponentDir)).toBe(false);
  });

  it('a component approved in an EARLIER invocation survives a LATER invocation that never reaches the components-rebuild step (dsRepo unavailable this time) — files are never spuriously deleted just because this run did not touch them', async () => {
    const redesignRunId = 'page-audit-combined-preserve-test';
    const paths = redesignPaths(join(root, 'projects'), 'www.example.com-page', redesignRunId);
    const withComponentPlan = (owner: Harness) => async () => {
      owner.calls.push('R1');
      const upstream: NewComponentPlan = { schemaVersion: 1, runId: 'page-audit', updatedAt: null, entries: [{ findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' }] };
      return r1Output({ newComponentPlan: upstream });
    };
    const dsRepoPath = fakeDsRepo();

    // Drive it all the way to a fully-approved, fully-built state (mirrors the test above).
    const h1 = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    componentNodes(h1);
    h1.nodes.r1 = withComponentPlan(h1);
    const p1 = await runRedesignPipeline(ctx({ redesignRunId, runType: 'combined', dsRepoPath }), h1.nodes, { runRef: { runId: 'page-audit' }, runType: 'combined' });
    const g2Fp = await computeG2Fingerprint(p1.paths);
    await recordDecision(paths.decisionsJson, redesignRunId, { gate: 'G2', outcome: 'approve', fingerprint: g2Fp, unitId: null, by: 'reviewer', at: '2026-09-18T10:05:00.000Z', note: null });

    const h2 = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    componentNodes(h2);
    h2.nodes.r1 = withComponentPlan(h2);
    await runRedesignPipeline(ctx({ redesignRunId, runType: 'combined', dsRepoPath }), h2.nodes, { runRef: { runId: 'page-audit' }, runType: 'combined' });
    const g4Fp = await computeG4Fingerprint(paths, dsRepoPath, 'comp-1');
    await recordDecision(paths.decisionsJson, redesignRunId, { gate: 'G4', outcome: 'approve-and-push', fingerprint: g4Fp, unitId: 'comp-1', by: 'reviewer', at: '2026-09-18T10:06:00.000Z', note: null });

    const h3 = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    componentNodes(h3);
    h3.nodes.r1 = withComponentPlan(h3);
    const done = await runRedesignPipeline(ctx({ redesignRunId, runType: 'combined', dsRepoPath }), h3.nodes, { runRef: { runId: 'page-audit' }, runType: 'combined' });
    expect(done.awaitingGate).toBeNull();
    expect(existsSync(join(done.paths.newComponentDir, 'Card', 'Card.tsx'))).toBe(true);

    // A LATER invocation reaches Workflow A's page-time write again (this orchestrator always
    // re-runs R1..R7 from scratch) but this time dsRepo is unavailable, so it stops in Workflow B
    // before ever reaching the components-rebuild step again. The component's files must remain
    // physically on disk from the earlier successful build — untouched, not deleted.
    const h4 = harness(['PASS'], { fixedIdsOnPass: ['a'.repeat(32), 'b'.repeat(32)] });
    componentNodes(h4);
    h4.nodes.r1 = withComponentPlan(h4);
    const later = await runRedesignPipeline(ctx({ redesignRunId, runType: 'combined', dsRepoPath: null }), h4.nodes, { runRef: { runId: 'page-audit' }, runType: 'combined' });
    expect(later.awaitingGate).toMatchObject({ awaitingGate: 'G4' });
    expect(existsSync(join(later.paths.newComponentDir, 'Card', 'Card.tsx'))).toBe(true); // never deleted — this invocation never reached the components rebuild
  });
});

describe('runRedesignPipeline — ONE correction budget across invocations, pauses and planner passes', () => {
  const FA = 'a'.repeat(32);
  const planner = (id: string): CorrectionFeedback => ({
    id, kind: 'default-regression', sectionId: 'hero', viewport: 'desktop', elementKey: 'card:0', elementLabel: 'Alpha card', state: 'default', property: 'border-top-left-radius', expected: '12px', observed: '4px', findingIds: [FA],
    message: 'Alpha card: border-top-left-radius should be 12px but is 4px', responsible: 'planner', action: { type: 'replan', findingIds: [FA], constraint: 'keep the 12px radius' }, blockedReason: null,
  });
  const run = (h: Harness, over: Partial<PipelineContext> = {}) => runRedesignPipeline(ctx(over), h.nodes, { runRef: { runId: 'page-audit' }, runType: 'redesign' });
  const pathsOf = () => redesignPaths(join(root, 'projects'), 'www.example.com-page', 'page-audit-redesign-test');
  const fresh = () => harness(['PASS'], { fixedIdsOnPass: [FA, 'b'.repeat(32)] });
  const clock = () => { let t = 10_000; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

  /** An R8 that spends the budget exactly like the real correction loop does (reserve, then work inside an active segment), with scripted feedback. */
  function budgetedR8(h: Harness, script: Array<{ verifications?: number; planner?: CorrectionFeedback[]; spendMs?: number; fail?: boolean }>, c = clock()): void {
    let call = 0;
    h.nodes.r8 = async (input: R8Input) => {
      h.calls.push('R8');
      h.r8Inputs.push(input);
      const step = script[Math.min(call++, script.length - 1)] ?? {};
      const b = input.budget!;
      for (let i = 0; i < (step.verifications ?? 1); i++) {
        await b.reserveVerification();
        await b.active(async () => { c.advance(step.spendMs ?? 0); if (step.fail) throw new TerminalError('chromium crashed mid-verification'); });
      }
      const base = await r8Mock(input);
      const plannerFeedback = step.planner ?? [];
      return { ...base, correction: { stopReason: plannerFeedback.length ? 'planner-needed' : 'passed', budgetReason: null, cycles: [], open: plannerFeedback, plannerFeedback, corrections: { stateGuards: [], droppedEdits: [], droppedIslands: [] }, verifications: b.verifications, required: { satisfied: true, open: [] } } };
    };
  }

  it('a crash in the middle of R8 does not refund the verification it had started: the next invocation starts from the stored count', async () => {
    const c = clock();
    const first = fresh();
    budgetedR8(first, [{ fail: true, spendMs: 250 }], c);
    await expect(run(first, { budgetClock: c.now })).rejects.toThrow(/chromium crashed/);
    expect(await readCorrectionState(pathsOf().correctionStateJson)).toMatchObject({ verificationsUsed: 1, elapsedMs: 250 });

    const second = fresh();
    budgetedR8(second, [{}], c);
    let atEntry: unknown;
    const inner = second.nodes.r8;
    second.nodes.r8 = async (input) => { atEntry = input.budget!.usage(); return inner(input); };
    await run(second, { budgetClock: c.now });
    expect(atEntry).toMatchObject({ verifications: 1, elapsedMs: 250 });
    expect((await readCorrectionState(pathsOf().correctionStateJson))?.verificationsUsed).toBe(2);
  });

  it('a re-plan reserves its cycle AND the verification that re-checks it, persisted before the planner runs; the next R8 consumes the reservation instead of spending another', async () => {
    const h = fresh();
    budgetedR8(h, [{ planner: [planner('d1')] }, {}]);
    let during: unknown;
    const r3 = h.nodes.r3;
    h.nodes.r3 = async (input, p, id) => { if (input.iteration === 2) during = await readCorrectionState(pathsOf().correctionStateJson); return r3(input, p, id); };
    await run(h);
    expect(during).toMatchObject({ cyclesUsed: 1, verificationsUsed: 2, reservedVerifications: 1, plannerPasses: [['keep the 12px radius']] });
    expect(await readCorrectionState(pathsOf().correctionStateJson)).toMatchObject({ cyclesUsed: 1, verificationsUsed: 2, reservedVerifications: 0 });
  });

  it('does NOT re-plan when no verification is left to re-check it, even though correction cycles remain', async () => {
    const h = fresh();
    budgetedR8(h, [{ verifications: 3, planner: [planner('d1')] }]);
    const result = await run(h, { correctionBudget: { maxCycles: 2, maxVerifications: 3, maxDurationMs: null } });
    expect(h.calls.filter((x) => x.startsWith('R3'))).toEqual(['R3#1']);
    expect(h.calls.filter((x) => x === 'R8')).toHaveLength(1);
    expect(await readCorrectionState(pathsOf().correctionStateJson)).toMatchObject({ cyclesUsed: 0, verificationsUsed: 3 });
    expect(result.awaitingGate?.awaitingGate).toBe('G2');
  });

  it('a judgment pause in the middle of a re-plan keeps the reserved cycle and verification; the resumed run replays the pass and does not spend again', async () => {
    const first = fresh();
    budgetedR8(first, [{ planner: [planner('d1')] }]);
    const r3 = first.nodes.r3;
    first.nodes.r3 = async (input, p, id) => { if (input.iteration === 2) throw new AwaitingJudgmentError('R3', 'bundle1', '/fake/bundle1.json'); return r3(input, p, id); };
    const paused = await run(first);
    expect(paused.awaitingJudgment).toMatchObject({ nodeId: 'R3' });
    expect(await readCorrectionState(pathsOf().correctionStateJson)).toMatchObject({ cyclesUsed: 1, verificationsUsed: 2, reservedVerifications: 1 });

    const second = fresh();
    budgetedR8(second, [{}]);
    await run(second);
    expect(second.calls.filter((x) => x.startsWith('R3'))).toEqual(['R3#1', 'R3#2']); // replayed
    expect(await readCorrectionState(pathsOf().correctionStateJson)).toMatchObject({ cyclesUsed: 1, verificationsUsed: 2, reservedVerifications: 0 }); // 2, not 3
  });

  it('the time allowance is ACTIVE time summed over invocations: a resumed run does not get a fresh allowance, and the wait between them is not counted', async () => {
    const c = clock();
    const first = fresh();
    budgetedR8(first, [{ spendMs: 14 * 60_000 }], c);
    await run(first, { budgetClock: c.now });
    c.advance(6 * 3_600_000); // a human gate, a judgment pause: not counted

    const second = fresh();
    let entry: { canVerify: boolean; elapsedMs: number } | undefined;
    second.nodes.r8 = async (input: R8Input) => { second.calls.push('R8'); second.r8Inputs.push(input); entry = { canVerify: input.budget!.canVerify(), elapsedMs: input.budget!.elapsedMs() }; return r8Mock(input); };
    await run(second, { budgetClock: c.now });
    expect(entry).toEqual({ canVerify: true, elapsedMs: 14 * 60_000 });

    const third = fresh();
    budgetedR8(third, [{ spendMs: 2 * 60_000 }], c);
    const inner = third.nodes.r8;
    third.nodes.r8 = async (input) => { const out = await inner(input); entry = { canVerify: input.budget!.canVerify(), elapsedMs: input.budget!.elapsedMs() }; return out; };
    await run(third, { budgetClock: c.now });
    expect(entry).toEqual({ canVerify: false, elapsedMs: 16 * 60_000 }); // 14 + 2 minutes of work, over the 15 minute allowance
  });

  it('a fresh planner pass counts as active time; a replayed one (cached judgments) does not', async () => {
    const c = clock();
    const first = fresh();
    budgetedR8(first, [{ planner: [planner('d1')] }, {}], c);
    const r3 = first.nodes.r3;
    first.nodes.r3 = async (input, p, id) => { if (input.iteration === 2) c.advance(300_000); return r3(input, p, id); };
    await run(first, { budgetClock: c.now });
    expect((await readCorrectionState(pathsOf().correctionStateJson))?.elapsedMs).toBe(300_000);

    const second = fresh();
    budgetedR8(second, [{}], c);
    const r3b = second.nodes.r3;
    second.nodes.r3 = async (input, p, id) => { if (input.iteration === 2) c.advance(300_000); return r3b(input, p, id); };
    await run(second, { budgetClock: c.now });
    expect((await readCorrectionState(pathsOf().correctionStateJson))?.elapsedMs).toBe(300_000); // the replay is not new work
  });

  it('every R8 of the pipeline asks to REUSE an unchanged earlier verification (a plain resume must not spend the budget); only `preview --regenerate` does not', async () => {
    const h = fresh();
    budgetedR8(h, [{ planner: [planner('d1')] }, {}]);
    await run(h);
    expect(h.r8Inputs.length).toBeGreaterThanOrEqual(2);
    expect(h.r8Inputs.every((i) => i.reuseEvidence === true)).toBe(true);
  });

  it('the stored state records the basis of the edits R8 was last given, which is what `preview --regenerate` recomputes from the run folder', async () => {
    const h = fresh();
    budgetedR8(h, [{}]);
    await run(h);
    const state = await readCorrectionState(pathsOf().correctionStateJson);
    const resolution = await readResolution(pathsOf().resolvedTargetsJson);
    expect(state?.appliedBasisHash).toBe(basisHashOf({ edits: [], resolution, baselineSha256: null }));
  });

  it('the usage is reset ONLY by the explicit option: a plain resume keeps it, the option zeroes it, records it, and keeps the decided passes', async () => {
    const first = fresh();
    budgetedR8(first, [{ planner: [planner('d1')] }, {}]);
    await run(first);
    expect(await readCorrectionState(pathsOf().correctionStateJson)).toMatchObject({ cyclesUsed: 1, verificationsUsed: 2 });

    const plain = fresh();
    let entry: unknown;
    plain.nodes.r8 = async (input: R8Input) => { plain.calls.push('R8'); plain.r8Inputs.push(input); entry = input.budget!.usage(); return r8Mock(input); };
    await run(plain);
    expect(entry).toMatchObject({ cycles: 1, verifications: 2 });
    expect((await readCorrectionState(pathsOf().correctionStateJson))?.budgetResets).toEqual([]);

    const reset = fresh();
    reset.nodes.r8 = async (input: R8Input) => { reset.calls.push('R8'); reset.r8Inputs.push(input); entry = input.budget!.usage(); return r8Mock(input); };
    await run(reset, { resetBudget: true });
    expect(entry).toMatchObject({ cycles: 0, verifications: 0, elapsedMs: 0 });
    expect(reset.calls.filter((x) => x.startsWith('R3'))).toEqual(['R3#1', 'R3#2']); // the decided pass is still replayed, not re-planned
    const stored = await readCorrectionState(pathsOf().correctionStateJson);
    expect(stored?.budgetResets).toHaveLength(1);
    expect(stored?.budgetResets[0]).toMatchObject({ before: { cycles: 1, verifications: 2 } });
    expect(stored?.plannerPasses).toHaveLength(1);
  });
});

describe('deriveOutcome', () => {
  it('PASS if any iteration passed; otherwise the last iteration decides; nothing run = FAIL', () => {
    expect(deriveOutcome([validation(1, 'FAIL'), validation(2, 'PASS')])).toBe('PASS');
    expect(deriveOutcome([validation(1, 'FAIL'), validation(2, 'PARTIAL')])).toBe('PARTIAL');
    expect(deriveOutcome([validation(1, 'PARTIAL'), validation(2, 'FAIL')])).toBe('FAIL');
    expect(deriveOutcome([])).toBe('FAIL');
  });
});
