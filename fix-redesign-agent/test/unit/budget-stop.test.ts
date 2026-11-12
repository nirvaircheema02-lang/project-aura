import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runR8 } from '../../src/agents/r8-react-preview/index.ts';
import type { CorrectionSummary, R1Output, R8Input } from '../../src/agents/types.ts';
import { emptyCoverage } from '../../src/fidelity/coverage.ts';
import { BudgetTracker } from '../../src/fidelity/loop.ts';
import type { FidelityReport } from '../../src/fidelity/types.ts';
import { redesignPaths, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { basisHashOf } from '../../src/preview/correction-state.ts';
import { engineHashOf, readRetainedEvidence, scopeHashOf, stampEvidence } from '../../src/preview/budget-stop.ts';
import { sourceHashOf } from '../../src/preview/scaffold.ts';
import { settleStatus } from '../../src/preview/status.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';

/**
 * R8 when the correction budget allows no verification: no regeneration, no build, no server, no measurement; the previous evidence of the SAME
 * plan is kept as measured; an open required item says that no new verification was allowed; the overall status is never PASS.
 */

let root: string;
let paths: RedesignPaths;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-budget-stop-'));
  paths = redesignPaths(root, 'proj', 'run1');
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.originalHtml, '<!doctype html><html><body>x</body></html>');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cfg = { maxCycles: 2, maxVerifications: 3, maxDurationMs: 15 * 60_000 };
const spent = (over: Partial<{ verifications: number; elapsedMs: number }> = {}) => new BudgetTracker(cfg, () => 0, { usage: { cycles: 1, verifications: 3, elapsedMs: 5000, ...over } });

/** A browser context that proves nothing used it: the stop must not touch the browser at all. */
const touched: string[] = [];
const context = new Proxy({}, { get: (_t, prop) => { if (prop === 'browser') return () => ({}); touched.push(String(prop)); return () => { throw new Error(`the browser context was used (${String(prop)})`); }; } }) as unknown as R8Input['context'];

const r1 = { findings: [], fixFindings: [], sourceRun: { displayName: 'Page' }, targetUrl: 'https://example.com/' } as unknown as R1Output;
const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  id: 't1', findingId: 'f1', property: 'padding-top', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
  audit: { status: 'DIFFERENT', actual: '4px', expected: '8px', expectedToken: null, note: null, source: 'x' }, reason: 'audit-expected-present', outcome: 'resolved-target',
  target: { value: '8px', comparison: 'length-px', token: null }, provenance: { kind: 'audit-expected', ds: null, reference: null, evidence: [] }, decisionReason: 'audit', route: 'css-edit', acceptance: [],
  status: { design: 'resolved', implementation: 'applied', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
});
const resolutionOf = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });

const inputOf = (budget: BudgetTracker, resolution: ResolutionFile | null = resolutionOf()): R8Input => ({
  r1, context, entries: [], edits: [], unaddressed: [], paths, redesignRunId: 'run1', mode: 'full-page', sectionIds: ['hero'], behavior: null, resolution, baseline: null, budget,
  corrections: { stateGuards: [], droppedEdits: [], droppedIslands: [] },
});
const deps = { designSystemPath: '/nonexistent-ds', preview: { basePort: 4400, islands: true, behaviorProbes: true }, log: () => {} };
const basisOf = (resolution: ResolutionFile | null = resolutionOf()) => basisHashOf({ edits: [], resolution, baselineSha256: null });

const fidelityOf = (over: Partial<FidelityReport> = {}): FidelityReport => ({
  schemaVersion: 1, generatedAt: 't', baselineSha256: 'b'.repeat(64), baselineHtmlSha256: null, observedSource: null, differences: [], unavailable: [], statesNotCaptured: [],
  summary: { sections: 1, sectionsCompared: 1, elementsCompared: 12, statesCompared: { default: 12, hover: 4, 'focus-visible': 2 }, intentional: 0, regressions: 0, notCheckable: 0 }, verdict: 'pass', coverage: emptyCoverage(), ...over,
});

function verificationOf(over: Partial<PreviewVerification> = {}): PreviewVerification {
  return {
    schemaVersion: 1, generatedAt: '2026-10-12T09:00:00.000Z', url: 'http://localhost:4400/', mode: 'full-page', expectedSectionIds: ['hero'], renderedSectionIds: ['hero'],
    checks: [{ id: 'scope.matches-run-scope', group: 'scope', name: 'scope', status: 'pass', detail: 'ok' }],
    findings: [{ findingId: 'f1', section: 'hero', type: 'card', label: 'Alpha card', status: 'fixed-verified', route: 'css-edit', detail: 'measured' }], interactions: [], unavailable: [], simulated: [],
    summary: { passed: 1, failed: 0, notChecked: 0, findingsVerified: 1, findingsTotal: 1, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
  };
}

const retainedCorrection = (over: Partial<CorrectionSummary> = {}): CorrectionSummary => ({
  stopReason: 'passed', budgetReason: null, cycles: [{ cycle: 1, feedbackIds: ['d1'], applied: ['state-guard f1/color'], blockedIds: [], durationMs: 3 }], open: [], plannerFeedback: [],
  corrections: { stateGuards: ['f1|color'], droppedEdits: [], droppedIslands: [] }, verifications: 3, required: { satisfied: true, open: [] }, ...over,
});

/** The files a previous R8 run left behind for the plan `basisOf()`, with a preview source on disk whose hash they record. */
async function seedEvidence(over: { verification?: PreviewVerification; fidelity?: FidelityReport; basis?: string; resolution?: ResolutionFile } = {}): Promise<{ verification: PreviewVerification; fidelity: FidelityReport }> {
  mkdirSync(join(paths.previewAppDir, 'src'), { recursive: true });
  writeFileSync(join(paths.previewAppDir, 'src', 'App.tsx'), 'export default () => null;');
  const sourceHash = await sourceHashOf(paths.previewAppDir);
  const fidelity = over.fidelity ?? fidelityOf();
  const verification = over.verification ?? verificationOf();
  settleStatus(verification, fidelity, over.resolution ?? resolutionOf());
  mkdirSync(paths.previewDir, { recursive: true });
  writeFileSync(paths.previewVerificationJson, JSON.stringify(verification, null, 2));
  writeFileSync(paths.fidelityReportJson, JSON.stringify(fidelity, null, 2));
  writeFileSync(paths.correctionLogJson, JSON.stringify(retainedCorrection(), null, 2));
  writeFileSync(paths.previewGenerationJson, JSON.stringify({ runId: 'run1', mode: 'full-page', port: 4400, url: 'http://localhost:4400/', generation: { sectionIds: ['hero'], generatedSections: ['hero'], overriddenSections: [], sourceHash, assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 } }));
  await stampEvidence(paths, { basisHash: over.basis ?? basisOf(), scopeHash: await scopeHashOf(inputOf(spent())), engineHash: await engineHashOf(deps) });
  return { verification, fidelity };
}
const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const BUDGET_LINE = /verification budget exhausted: no new verification was allowed/;

describe('R8 with an exhausted verification budget — no previous evidence', () => {
  it('does ZERO verification work (no browser, no generation, no build, no server) and is INCOMPLETE with every required check unverified', async () => {
    const budget = spent();
    const resolution = resolutionOf(target());
    const out = await runR8(deps, inputOf(budget, resolution));

    expect(touched).toEqual([]);
    expect(existsSync(paths.previewAppDir)).toBe(false); // nothing generated
    expect(existsSync(paths.previewServerJson)).toBe(false); // nothing served
    expect(budget.verifications).toBe(3); // not 4
    expect(out.verification.verdict).toBe('incomplete');
    expect(out.verification.status?.verdict).toBe('incomplete');
    const gaps = (out.verification.status?.gaps ?? []).map((g) => `${g.family}:${g.kind}`);
    expect(gaps).toContain('budget:unverified');
    expect(gaps).toContain('fidelity:not-compared:unverified'); // the comparison never ran
    expect(gaps).toContain('target:unverified'); // the resolved target was not measured
    expect(out.fidelity).toBeNull();
    expect(out.correction).toMatchObject({ stopReason: 'budget-exhausted', budgetReason: 'verifications', verifications: 3, required: { satisfied: false }, budget: { retained: false, used: { verifications: 3 } } }); // nothing was retained, and the log must not say it was
    expect(out.correction?.required.open.join('\n')).toMatch(BUDGET_LINE);
    expect(out.correction?.required.open.join('\n')).toMatch(/no previous verification of this plan is on disk/);
    // the targets say not measured, in the file as well
    expect(resolution.targets[0]?.status.verification).toBe('not-run');
  });

  it('writes the same truthful status into verification.json, pv-status.json and PREVIEW.md', async () => {
    mkdirSync(join(paths.previewAppDir, 'public'), { recursive: true });
    await runR8(deps, inputOf(spent()));
    const v = read<PreviewVerification>(paths.previewVerificationJson);
    const pv = read<{ verdict: string; unverifiedRequired: number; gaps: Array<{ family: string }> }>(join(paths.previewAppDir, 'public', 'pv-status.json'));
    expect(v.verdict).toBe('incomplete');
    expect(pv.verdict).toBe('incomplete');
    expect(pv.unverifiedRequired).toBe(v.status?.unverifiedRequired);
    expect(pv.gaps.map((g) => g.family)).toContain('budget');
    const md = readFileSync(join(paths.redesignDeliverableDir, 'PREVIEW.md'), 'utf8');
    expect(md).toMatch(/INCOMPLETE/);
    expect(md).toMatch(BUDGET_LINE);
    expect(read<CorrectionSummary>(paths.correctionLogJson).stopReason).toBe('budget-exhausted');
  });

  it('the active-time allowance being spent stops it the same way (reason: time)', async () => {
    const out = await runR8(deps, inputOf(spent({ verifications: 1, elapsedMs: 15 * 60_000 })));
    expect(out.correction).toMatchObject({ stopReason: 'budget-exhausted', budgetReason: 'time' });
    expect(out.verification.verdict).toBe('incomplete');
    expect(out.correction?.required.open.join('\n')).toMatch(/time: 15 of 15 min of active time used/);
  });
});

describe('R8 with an exhausted verification budget — previous evidence of the same plan', () => {
  it('keeps the measured results intact, adds the open item and the reason, and is INCOMPLETE — never PASS, even though the retained verification was a clean pass', async () => {
    const { verification: before } = await seedEvidence();
    expect(before.verdict).toBe('pass');
    const budget = spent();
    const out = await runR8(deps, inputOf(budget));

    expect(touched).toEqual([]);
    expect(budget.verifications).toBe(3);
    expect(out.verification.verdict).toBe('incomplete');
    expect(out.verification.findings).toEqual(before.findings); // the verified results are intact
    expect(out.verification.checks).toEqual(before.checks);
    expect(out.verification.generatedAt).toBe(before.generatedAt); // nothing was re-measured
    expect(out.fidelity?.verdict).toBe('pass');
    expect(out.url).toBe('http://localhost:4400/');
    expect(out.correction).toMatchObject({ stopReason: 'budget-exhausted', budgetReason: 'verifications', required: { satisfied: false }, budget: { retained: true } });
    expect(out.correction?.cycles).toHaveLength(1); // the retained cycles
    expect(out.correction?.corrections.stateGuards).toEqual(['f1|color']);
    expect(out.correction?.required.open.join('\n')).toMatch(BUDGET_LINE);
    expect(out.correction?.required.open.join('\n')).toMatch(/previous verification of this plan is kept as measured/);
    expect(out.verification.status?.gaps.map((g) => g.family)).toEqual(['budget']);
    expect(out.verification.fidelity?.open.join('\n')).toMatch(BUDGET_LINE);
  });

  it('a required failure in the retained evidence stays a FAIL, with the budget stop disclosed beside it', async () => {
    const failed = verificationOf({ checks: [{ id: 'interaction.parity', group: 'interaction', name: 'parity', status: 'fail', detail: 'x' }], summary: { passed: 0, failed: 1, notChecked: 0, findingsVerified: 1, findingsTotal: 1, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'fail' });
    await seedEvidence({ verification: failed });
    const out = await runR8(deps, inputOf(spent()));
    expect(out.verification.verdict).toBe('fail');
    expect(out.verification.status?.failedRequired).toBeGreaterThan(0);
    expect(out.verification.status?.gaps.map((g) => g.family)).toEqual(expect.arrayContaining(['checks', 'budget']));
  });

  it('records an earlier intentional reset of the budget in correction-log.json (the only way usage ever went down)', async () => {
    await seedEvidence();
    const reset = { at: '2026-10-12T08:00:00.000Z', reason: 'explicit reset (--reset-budget)', before: { cycles: 2, verifications: 3, elapsedMs: 900_000, reserved: 0 } };
    const budget = new BudgetTracker(cfg, () => 0, { usage: { cycles: 1, verifications: 3, elapsedMs: 5000 }, resets: [reset] });
    await runR8(deps, inputOf(budget));
    expect(read<CorrectionSummary>(paths.correctionLogJson).budget).toMatchObject({ resets: [reset], used: { verifications: 3 }, retained: true });
  });

  it('is idempotent: stopping again on the written result changes nothing (no duplicated open item, same status)', async () => {
    await seedEvidence();
    const first = await runR8(deps, inputOf(spent()));
    const files = [paths.previewVerificationJson, paths.correctionLogJson].map((p) => readFileSync(p, 'utf8'));
    const second = await runR8(deps, inputOf(spent()));
    expect([paths.previewVerificationJson, paths.correctionLogJson].map((p) => readFileSync(p, 'utf8'))).toEqual(files);
    expect(second.correction?.required.open).toEqual(first.correction?.required.open);
    expect(second.correction?.required.open.filter((o) => BUDGET_LINE.test(o))).toHaveLength(1);
  });

  it('keeps resolved-targets.json in step with what the retained verification measured', async () => {
    const resolution = resolutionOf(target());
    const v = verificationOf({ targetResults: [{ targetId: 't1', findingId: 'f1', verification: 'verified-resolved-target', detail: 'padding-top measures 8px' }] });
    await seedEvidence({ verification: v, basis: basisOf(resolution), resolution: (() => { const r = resolutionOf(target({ status: { ...target().status, verification: 'verified-resolved-target', verificationDetail: 'padding-top measures 8px' } })); return r; })() });
    const fresh = resolutionOf(target()); // what RV hands R8 on a resume: not-run
    const out = await runR8(deps, inputOf(spent(), fresh));
    expect(fresh.targets[0]?.status).toMatchObject({ verification: 'verified-resolved-target', verificationDetail: 'padding-top measures 8px' });
    expect(out.verification.status?.gaps.map((g) => g.family)).toEqual(['budget']); // the measured target is not reported open
  });

  it('does not keep evidence recorded for a DIFFERENT plan', async () => {
    await seedEvidence({ basis: 'some-other-basis' });
    const out = await runR8(deps, inputOf(spent()));
    expect(out.fidelity).toBeNull();
    expect(out.correction?.required.open.join('\n')).toMatch(/recorded for a different plan/);
    expect(out.verification.findings).toEqual([]);
  });

  it('does not keep evidence once the preview source changed after it was verified', async () => {
    await seedEvidence();
    writeFileSync(join(paths.previewAppDir, 'src', 'App.tsx'), 'export default () => <p>hand edited</p>;');
    const out = await runR8(deps, inputOf(spent()));
    expect(out.fidelity).toBeNull();
    expect(out.correction?.required.open.join('\n')).toMatch(/preview source changed/);
  });

  it('retains nothing from a stamp without its files (a crash between writes)', async () => {
    mkdirSync(paths.previewDir, { recursive: true });
    mkdirSync(join(paths.previewAppDir, 'src'), { recursive: true });
    writeFileSync(join(paths.previewAppDir, 'src', 'App.tsx'), 'x');
    await stampEvidence(paths, { basisHash: basisOf(), scopeHash: await scopeHashOf(inputOf(spent())), engineHash: 'e' });
    const r = await readRetainedEvidence(paths, { basisHash: basisOf(), scopeHash: await scopeHashOf(inputOf(spent())) });
    expect(r.kept).toBeNull();
  });
});
