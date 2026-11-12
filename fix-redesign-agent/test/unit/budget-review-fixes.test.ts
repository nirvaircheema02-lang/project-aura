import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runR8 } from '../../src/agents/r8-react-preview/index.ts';
import type { CorrectionSummary, R1Output, R8Input } from '../../src/agents/types.ts';
import { emptyCoverage } from '../../src/fidelity/coverage.ts';
import { BudgetTracker } from '../../src/fidelity/loop.ts';
import type { FidelityReport } from '../../src/fidelity/types.ts';
import { redesignPaths, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { engineHashOf, scopeHashOf, stampEvidence } from '../../src/preview/budget-stop.ts';
import { basisHashOf, emptyCorrectionState, openCorrectionBudget, writeCorrectionState } from '../../src/preview/correction-state.ts';
import { sourceHashOf } from '../../src/preview/scaffold.ts';
import { settleStatus } from '../../src/preview/status.ts';
import { writeResolution } from '../../src/resolution/store.ts';
import { computeG2Fingerprint } from '../../src/session/gate-fingerprints.ts';
import type { PreviewServerRecord, PreviewVerification } from '../../src/preview/types.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile } from '../../src/resolution/schema.ts';

/**
 * The review's findings on the ONE correction budget (issue 2): a bare resume of an unchanged plan spends nothing, a damaged state file never refunds the
 * budget, active time survives a hard kill, and the budget stop says truthfully what it kept, what it did not, and why.
 */

let root: string;
let paths: RedesignPaths;
beforeEach(() => {
  servers.length = 0;
  touched.length = 0;
  root = mkdtempSync(join(tmpdir(), 'fra-budget-review-'));
  paths = redesignPaths(root, 'proj', 'run1');
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.originalHtml, '<!doctype html><html><body>x</body></html>');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cfg = { maxCycles: 2, maxVerifications: 3, maxDurationMs: 15 * 60_000 };
const spent = (over: Partial<{ verifications: number; elapsedMs: number }> = {}) => new BudgetTracker(cfg, () => 0, { usage: { cycles: 1, verifications: 3, elapsedMs: 5000, ...over } });
const touched: string[] = [];
const context = new Proxy({}, { get: (_t, prop) => { if (prop === 'browser') return () => ({}); touched.push(String(prop)); return () => { throw new Error(`the browser context was used (${String(prop)})`); }; } }) as unknown as R8Input['context'];
const r1 = { findings: [], fixFindings: [], sourceRun: { displayName: 'Page' }, targetUrl: 'https://example.com/' } as unknown as R1Output;
const resolutionOf = (): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets: [], noTargetFindings: [], notes: [] });
const inputOf = (budget: BudgetTracker, over: Partial<R8Input> = {}): R8Input => ({
  r1, context, entries: [], edits: [], unaddressed: [], paths, redesignRunId: 'run1', mode: 'full-page', sectionIds: ['hero'], behavior: null, resolution: resolutionOf(), baseline: null, budget,
  corrections: { stateGuards: [], droppedEdits: [], droppedIslands: [] }, ...over,
});
const servers: string[] = [];
const deps = { designSystemPath: '/nonexistent-ds', preview: { basePort: 4400, islands: true, behaviorProbes: true }, log: () => {}, startServer: async (a: { port: number; previewDir: string }): Promise<PreviewServerRecord> => { servers.push(a.previewDir); return { url: 'http://127.0.0.1:4400/', port: 4400, pid: null, startedAt: 't', source: a.previewDir, command: 'stub' }; } };
const basisOf = () => basisHashOf({ edits: [], resolution: resolutionOf(), baselineSha256: null });
const fidelityOf = (): FidelityReport => ({
  schemaVersion: 1, generatedAt: 't', baselineSha256: 'b'.repeat(64), baselineHtmlSha256: null, observedSource: null, differences: [], unavailable: [], statesNotCaptured: [],
  summary: { sections: 1, sectionsCompared: 1, elementsCompared: 12, statesCompared: { default: 12, hover: 4, 'focus-visible': 2 }, intentional: 0, regressions: 0, notCheckable: 0 }, verdict: 'pass', coverage: emptyCoverage(),
});
const verificationOf = (over: Partial<PreviewVerification> = {}): PreviewVerification => ({
  schemaVersion: 1, generatedAt: '2026-10-12T09:00:00.000Z', url: 'http://127.0.0.1:4400/', mode: 'full-page', expectedSectionIds: ['hero'], renderedSectionIds: ['hero'],
  checks: [{ id: 'scope.matches-run-scope', group: 'scope', name: 'scope', status: 'pass', detail: 'ok' }], findings: [], interactions: [], unavailable: [], simulated: [],
  summary: { passed: 1, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
});
const correctionOf = (over: Partial<CorrectionSummary> = {}): CorrectionSummary => ({
  stopReason: 'passed', budgetReason: null, cycles: [], open: [], plannerFeedback: [], corrections: { stateGuards: [], droppedEdits: [], droppedIslands: [] }, verifications: 1, required: { satisfied: true, open: [] }, ...over,
});

/** What a completed R8 leaves behind for `input`: the evidence files, a built preview with a source on disk, and the stamp that makes them retainable. */
async function seedEvidence(input: R8Input, over: { verification?: PreviewVerification; correction?: CorrectionSummary; basis?: string; scopeHash?: string; engineHash?: string; dist?: boolean } = {}): Promise<void> {
  mkdirSync(join(paths.previewAppDir, 'src'), { recursive: true });
  mkdirSync(join(paths.previewAppDir, 'public'), { recursive: true });
  if (over.dist !== false) { mkdirSync(join(paths.previewAppDir, 'dist'), { recursive: true }); writeFileSync(join(paths.previewAppDir, 'dist', 'index.html'), '<html></html>'); }
  writeFileSync(join(paths.previewAppDir, 'src', 'App.tsx'), 'export default () => null;');
  const sourceHash = await sourceHashOf(paths.previewAppDir);
  const fidelity = fidelityOf();
  const verification = over.verification ?? verificationOf();
  settleStatus(verification, fidelity, input.resolution ?? null);
  mkdirSync(paths.previewDir, { recursive: true });
  writeFileSync(paths.previewVerificationJson, JSON.stringify(verification, null, 2));
  writeFileSync(paths.fidelityReportJson, JSON.stringify(fidelity, null, 2));
  writeFileSync(paths.correctionLogJson, JSON.stringify(over.correction ?? correctionOf(), null, 2));
  writeFileSync(paths.previewGenerationJson, JSON.stringify({ runId: 'run1', mode: 'full-page', port: 4400, url: 'http://127.0.0.1:4400/', generation: { sectionIds: ['hero'], generatedSections: ['hero'], overriddenSections: [], sourceHash, assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 } }));
  await stampEvidence(paths, { basisHash: over.basis ?? basisOf(), scopeHash: over.scopeHash ?? (await scopeHashOf(input)), engineHash: over.engineHash ?? (await engineHashOf(deps)) });
}
const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const BUDGET_LINE = /verification budget exhausted: no new verification was allowed/;

describe('the budget stop with no evidence kept', () => {
  it('serves the scope it was asked about: pv-status.json and PREVIEW.md do not say "0 sections"', async () => {
    mkdirSync(join(paths.previewAppDir, 'public'), { recursive: true });
    await runR8(deps, inputOf(spent()));
    const pv = read<{ sections: string[] }>(join(paths.previewAppDir, 'public', 'pv-status.json'));
    expect(pv.sections).toEqual(['hero']);
    const md = readFileSync(join(paths.redesignDeliverableDir, 'PREVIEW.md'), 'utf8');
    expect(md).toMatch(/\*\*Sections:\*\* hero \(expected; none was measured\)/);
    expect(md).not.toMatch(/\*\*Sections:\*\* none/);
  });

  it('does not claim evidence was retained, and sets the stale evidence of another plan aside instead of leaving it beside a verification that says nothing was verified', async () => {
    const input = inputOf(spent());
    await seedEvidence(input, { basis: 'a-different-plan' });
    const out = await runR8(deps, input);
    expect(out.correction?.budget?.retained).toBe(false);
    expect(read<CorrectionSummary>(paths.correctionLogJson).budget?.retained).toBe(false);
    expect(out.fidelity).toBeNull();
    for (const f of [paths.fidelityReportJson, paths.previewGenerationJson, join(paths.previewDir, 'evidence-basis.json')]) expect(existsSync(f), f).toBe(false);
    // set aside, not destroyed
    expect(existsSync(paths.fidelityReportJson.replace(/\.json$/, '.superseded.json'))).toBe(true);
    expect(existsSync(paths.previewGenerationJson.replace(/\.json$/, '.superseded.json'))).toBe(true);
  });

  it('says WHY the comparison did not happen (no verification was allowed), never "no baseline of the original was captured"', async () => {
    const out = await runR8(deps, inputOf(spent()));
    const gap = out.verification.status!.gaps.find((g) => g.family === 'fidelity:not-compared')!;
    expect(gap.text).toMatch(/not compared \(no verification was allowed\)/);
    const md = readFileSync(join(paths.redesignDeliverableDir, 'PREVIEW.md'), 'utf8');
    expect(md).not.toMatch(/no baseline of the original/);
    expect(md).toMatch(/Design and state fidelity was not compared for this run: the correction budget allowed no verification/);
    expect(md).not.toMatch(/Nothing was found that the preview fails to reproduce/);
    expect(md).toMatch(/No interaction was probed/);
  });

  it('says the preview server is not running when it is not (the URL is not a promise)', async () => {
    const out = await runR8(deps, inputOf(spent()));
    expect(out.correction?.required.open.join('\n')).toMatch(/preview server is not running and was not started/);
  });
});

describe('the budget gap and the cap', () => {
  it('stays visible in status.gaps when the retained evidence already has more than twelve other unverified gaps', async () => {
    const input = inputOf(spent());
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `custom.c${i}`, group: 'interaction' as const, name: `custom ${i}`, status: 'not-checked' as const, detail: 'x' }));
    await seedEvidence(input, { verification: verificationOf({ checks: many, summary: { passed: 0, failed: 0, notChecked: 14, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 } }) });
    const out = await runR8(deps, input);
    expect(out.verification.verdict).toBe('incomplete');
    expect(out.verification.status!.gaps).toHaveLength(12);
    expect(out.verification.status!.gaps.map((g) => g.family)).toContain('budget');
    const pv = read<{ gaps: Array<{ family: string }> }>(join(paths.previewAppDir, 'public', 'pv-status.json'));
    expect(pv.gaps.map((g) => g.family)).toContain('budget');
  });
});

describe('the retained evidence is bound to the scope, not only to the edits', () => {
  it('evidence recorded for other sections (or another mode) is not kept', async () => {
    const stamped = inputOf(spent(), { sectionIds: ['hero', 'faq'] });
    await seedEvidence(stamped);
    const out = await runR8(deps, inputOf(spent(), { sectionIds: ['hero'] }));
    expect(out.fidelity).toBeNull();
    expect(out.correction?.required.open.join('\n')).toMatch(/different scope|different plan/);
    const other = await runR8(deps, inputOf(spent(), { sectionIds: ['hero', 'faq'], mode: 'selected-sections' }));
    expect(other.fidelity).toBeNull();
  });
});

describe('a plain resume of an unchanged plan costs nothing', () => {
  const reuse = { reuseEvidence: true } as const;

  it('reuses the earlier verification of identical inputs WITHOUT spending a verification - even when the allowance is already spent - and keeps it exactly as measured (no budget gap)', async () => {
    const budget = spent();
    const input = inputOf(budget, reuse);
    await seedEvidence(input);
    const out = await runR8(deps, input);
    expect(touched).toEqual([]);
    expect(budget.verifications).toBe(3);
    expect(out.verification.verdict).toBe('pass');
    expect(out.verification.generatedAt).toBe('2026-10-12T09:00:00.000Z'); // nothing was re-measured
    expect(out.verification.status!.gaps).toEqual([]);
    expect(out.correction).toMatchObject({ stopReason: 'passed', required: { satisfied: true }, budget: { reused: true, used: { verifications: 3 } } });
    expect(out.correction?.required.open).toEqual([]);
    expect(out.url).toBe('http://127.0.0.1:4400/');
    expect(out.fidelity?.verdict).toBe('pass');
  });

  it('keeps an INCOMPLETE or FAIL verdict as it was measured - reuse never improves a result', async () => {
    const input = inputOf(spent(), reuse);
    await seedEvidence(input, {
      verification: verificationOf({ checks: [{ id: 'interaction.parity', group: 'interaction', name: 'parity', status: 'not-checked', detail: 'not captured' }] }),
      correction: correctionOf({ required: { satisfied: false, open: ['parity: not checked - not captured'] } }),
    });
    const out = await runR8(deps, input);
    expect(out.verification.verdict).toBe('incomplete');
    expect(out.correction?.required.open.join('\n')).toMatch(/parity/);
    expect(out.correction?.required.open.join('\n')).not.toMatch(BUDGET_LINE);
  });

  it('starts the recorded server again when it is not running (a preview URL that is dead is not a deliverable)', async () => {
    const input = inputOf(spent(), reuse);
    await seedEvidence(input);
    await runR8(deps, input);
    expect(servers).toEqual([paths.previewAppDir]);
  });

  it.each([
    ['other edits', () => ({ edits: [{ findingId: 'f', selector: 's', expectedMatches: 1, kind: 'style', property: 'color', value: 'red', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'r', confidence: 1 }] as R8Input['edits'] })],
    ['another scope', () => ({ sectionIds: ['hero', 'faq'] })],
    ['another mode', () => ({ mode: 'selected-sections' as const })],
    ['other planner gaps', () => ({ unaddressed: [{ findingId: 'f', reason: 'a recorded conflict' }] })],
    ['other corrections in force', () => ({ corrections: { stateGuards: ['f1|color'], droppedEdits: [], droppedIslands: [] } })],
    ['another behaviour capture', () => ({ behavior: { schemaVersion: 1, capturedAt: 't', url: 'u', sections: [] } as unknown as R8Input['behavior'] })],
  ])('does NOT reuse it for %s: the budget decides, so with no allowance left it stops as incomplete', async (_name, change) => {
    const seeded = inputOf(spent());
    await seedEvidence(seeded);
    const budget = spent();
    const out = await runR8(deps, inputOf(budget, { ...reuse, ...change() }));
    expect(out.verification.verdict).toBe('incomplete');
    expect(out.correction?.stopReason).toBe('budget-exhausted');
    expect(budget.verifications).toBe(3);
  });

  it('does NOT reuse it after the hand-authored overrides or the design decisions changed', async () => {
    const input = inputOf(spent(), reuse);
    await seedEvidence(input);
    mkdirSync(paths.previewOverridesDir, { recursive: true });
    writeFileSync(join(paths.previewOverridesDir, 'Hero.tsx'), 'export default () => null;');
    const out = await runR8(deps, inputOf(spent(), reuse));
    expect(out.correction?.stopReason).toBe('budget-exhausted');
  });

  it('does NOT reuse it when the engine (generator / verifier code, design system, settings) is not the one that measured it', async () => {
    const input = inputOf(spent(), reuse);
    await seedEvidence(input, { engineHash: 'an-older-engine' });
    expect((await runR8(deps, input)).correction?.stopReason).toBe('budget-exhausted');
  });

  it('does NOT reuse it when the preview source changed, when its build is gone, after an intentional budget reset, or when the earlier result was itself a budget stop', async () => {
    const input = inputOf(spent(), reuse);
    await seedEvidence(input);
    writeFileSync(join(paths.previewAppDir, 'src', 'App.tsx'), 'export default () => <p>edited</p>;');
    expect((await runR8(deps, input)).correction?.stopReason).toBe('budget-exhausted');

    rmSync(paths.previewAppDir, { recursive: true, force: true });
    await seedEvidence(input, { dist: false });
    expect((await runR8(deps, input)).correction?.stopReason).toBe('budget-exhausted');

    rmSync(paths.previewAppDir, { recursive: true, force: true });
    await seedEvidence(input);
    const reset = { at: 't', reason: 'explicit reset (--reset-budget)', before: { cycles: 2, verifications: 3, elapsedMs: 1, reserved: 0 } };
    const afterReset = new BudgetTracker(cfg, () => 0, { usage: { cycles: 1, verifications: 3, elapsedMs: 5000 }, resets: [reset] });
    expect((await runR8(deps, inputOf(afterReset, reuse))).correction?.stopReason).toBe('budget-exhausted');

    rmSync(paths.previewAppDir, { recursive: true, force: true });
    await seedEvidence(input, { correction: correctionOf({ stopReason: 'budget-exhausted', budgetReason: 'verifications' }) });
    expect((await runR8(deps, input)).correction?.stopReason).toBe('budget-exhausted');
  });

  it('an APPROVED G2 stays valid across any number of plain resumes: the fingerprint is the same after a reuse at 3/3, and (as it should) changes when a budget stop rewrites the verdict', async () => {
    writeFileSync(paths.redesignContentHtml, '<html>content</html>');
    writeFileSync(paths.validationResultsJson, '[]');
    await writeResolution(paths.resolvedTargetsJson, resolutionOf());
    const input = inputOf(spent(), reuse);
    await seedEvidence(input);
    const approved = await computeG2Fingerprint(paths);
    expect(approved).not.toBeNull();
    for (let i = 0; i < 4; i++) await runR8(deps, inputOf(spent({ verifications: 3 }), reuse)); // the 4th, 5th... invocation
    expect(await computeG2Fingerprint(paths)).toBe(approved);

    await runR8(deps, inputOf(spent())); // not a reuse (e.g. `preview --regenerate`): held to the budget, and the verdict is INCOMPLETE now
    expect(await computeG2Fingerprint(paths)).not.toBe(approved);
  });

  it('is never used without the flag: `preview --regenerate` asks for a new verification and is held to the budget', async () => {
    const input = inputOf(spent());
    await seedEvidence(input);
    const out = await runR8(deps, input);
    expect(out.correction?.stopReason).toBe('budget-exhausted');
    expect(out.verification.verdict).toBe('incomplete');
    expect(out.correction?.required.open.join('\n')).toMatch(BUDGET_LINE);
  });
});

describe('a damaged correction-state.json never refunds the budget', () => {
  let dir: string;
  let path: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fra-budget-damaged-')); path = join(dir, 'correction-state.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const open = (over: Partial<Parameters<typeof openCorrectionBudget>[0]> = {}) => openCorrectionBudget({ path, basisHash: 'b1', config: cfg, now: () => new Date('2026-10-12T10:00:00.000Z'), ...over });

  it.each([['truncated JSON', '{'], ['a schema it does not know', JSON.stringify({ schemaVersion: 99, basisHash: 'b1' })], ['the wrong shape', JSON.stringify({ schemaVersion: 1, basisHash: 'b1', cyclesUsed: 'many' })]])('refuses to start from %s and points at --reset-budget; the file is left as it is', async (_n, body) => {
    writeFileSync(path, body);
    await expect(open()).rejects.toThrow(/--reset-budget/);
    expect(readFileSync(path, 'utf8')).toBe(body);
  });

  it('--reset-budget is the way out: it starts over and records that it did, saying the file was unreadable', async () => {
    writeFileSync(path, '{');
    const lines: string[] = [];
    const s = await open({ resetBudget: true, log: (l) => lines.push(l) });
    expect(s.budget.usage()).toEqual({ cycles: 0, verifications: 0, elapsedMs: 0, reserved: 0 });
    expect(s.state.budgetResets).toHaveLength(1);
    expect(s.state.budgetResets[0]!.reason).toMatch(/unreadable/);
    expect(lines.join('\n')).toMatch(/RESET/);
    expect(JSON.parse(readFileSync(path, 'utf8')).budgetResets).toHaveLength(1);
  });

  it('a state bound to a DIFFERENT plan is still discarded as before, and a good file is untouched', async () => {
    await writeCorrectionState(path, { ...emptyCorrectionState('other'), verificationsUsed: 3 });
    expect((await open()).budget.verifications).toBe(0);
    await writeCorrectionState(path, { ...emptyCorrectionState('b1'), verificationsUsed: 2 });
    expect((await open()).budget.verifications).toBe(2);
  });
});

describe('active time survives a hard kill', () => {
  it('is checkpointed periodically while a segment runs, not only when it closes', async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const saved: number[] = [];
      const t = new BudgetTracker(cfg, () => now, {}, { checkpointEveryMs: 30_000 });
      t.bind(async (u) => { saved.push(u.elapsedMs); });
      let release!: () => void;
      const work = t.active(() => new Promise<void>((r) => { release = r; }));
      now += 31_000;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(saved).toEqual([31_000]); // a SIGINT right now keeps these 31 s
      now += 30_000;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(saved).toEqual([31_000, 61_000]);
      release();
      await work;
      expect(saved.at(-1)).toBe(61_000); // closing the segment still records the final figure
      const count = saved.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(saved).toHaveLength(count); // no timer is left running after the segment
    } finally { vi.useRealTimers(); }
  });

  it('does not overlap writes: a slow checkpoint is not started again while it is in flight, and a failing one never masks the work', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      const t = new BudgetTracker(cfg, () => now, {}, { checkpointEveryMs: 1_000 });
      t.bind(async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5_000)); inFlight--; });
      let release!: () => void;
      const work = t.active(() => new Promise<void>((r) => { release = r; }));
      now += 4_000;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(maxInFlight).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(10_000);
      await work;

      const failing = new BudgetTracker(cfg, () => now, {}, { checkpointEveryMs: 1_000 });
      failing.bind(async () => { throw new Error('disk full'); });
      let go!: () => void;
      const w2 = failing.active(() => new Promise<string>((r) => { go = () => r('done'); }));
      await vi.advanceTimersByTimeAsync(3_000);
      go();
      await expect(w2).rejects.toThrow('disk full'); // the closing checkpoint of a successful segment still reports its failure
    } finally { vi.useRealTimers(); }
  });
});

describe('R8 cannot be run without the run\'s budget', () => {
  it('budget is a required R8 input: leaving it out is a compile error, so no caller can silently bypass the persisted budget', () => {
    const { budget: _omitted, ...withoutBudget } = inputOf(spent());
    // @ts-expect-error R8Input.budget is required
    const input: R8Input = withoutBudget;
    expect(input.budget).toBeUndefined();
  });
});
