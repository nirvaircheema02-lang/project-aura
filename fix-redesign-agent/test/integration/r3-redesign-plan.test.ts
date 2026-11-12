import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, runR3 } from '../../src/agents/r3-redesign-plan/index.ts';
import type { CaptureSession, IterationRecord, R1Output, R3Input } from '../../src/agents/types.ts';
import type { Finding } from '../../src/audit-link/index.ts';
import type { DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { ScriptedLlmClient } from '../../src/llm/provider.ts';
import type { RedesignPlan, TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import type { PlannerFeedbackItem } from '../../src/fidelity/types.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import type { MappingEntry, MappingResult } from '../../src/mapping/types.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

/**
 * runR3 with a real ScriptedLlmClient (answers validated against RedesignPlanSchema, exactly
 * like a live response). Covers: CHUNK_SIZE batching, the no-basis pre-filter that skips the
 * model entirely, and iteration>1 only re-planning findings R5 reported still failing.
 */

function sessionWithMapping(mapping: MappingResult): CaptureSession {
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

function r1Base(overrides: Partial<R1Output> & { registry: DsRegistry; fixFindings: Finding[]; findings: Finding[] }): R1Output {
  return {
    sourceRun: {
      auditAgentRepoRoot: '/aa',
      projectName: 'r3-project',
      runId: 'r3-run',
      displayName: 'R3 Fixture Run',
      targetUrl: 'http://127.0.0.1/fixture',
      runDir: '/aa/projects/r3-project/runs/r3-run',
      dataJsonPath: '/aa/…/data.json',
      dataJsonSha256: 'd',
      fixPlanJsonPath: null,
      fixPlanSha256: null,
      newComponentPlanJsonPath: null,
      newComponentPlanSha256: null,
      reportHtmlPath: null,
      screenshotsDir: '/aa/…/screenshots',
    },
    audit: { schemaVersion: 1, run: { runId: 'r3-run', targetUrl: 'http://127.0.0.1/fixture' }, findingCount: overrides.findings.length },
    targetUrl: 'http://127.0.0.1/fixture',
    fixPlan: { schemaVersion: 1, runId: 'r3-run', updatedAt: null, entries: [] },
    fixEntries: [],
    decisionCounts: { fix: overrides.fixFindings.length, skip: 0, keep_for_review: 0, undecided: 0 },
    droppedUnknownFindingIds: [],
    newComponentPlan: null,
    warnings: [],
    ...overrides,
  };
}

function makeRegistry(): DsRegistry {
  return {
    designSystemPath: '/fake/design-system',
    loadedAt: Date.now(),
    version: { dsRegistryVersion: 'f'.repeat(64), tokensHash: '1'.repeat(64), componentsHash: '2'.repeat(64), advisory: { tokensPackageVersion: '0.1.0', coreV2PackageVersion: '0.1.0' }, findings: [] },
    tokens: { sourceTokens: [{ name: '--button-px-md' }], effective: [] },
    components: { totalTsxFiles: 1, componentFiles: ['atoms/Button.tsx'], stringUnionVariants: [], iifeLogic: [], cvaConfigs: [] },
    rules: { checkerScripts: [], rules: [{ id: 'R1.1', title: 'Button spacing', fields: { WHAT: 'padding must equal the DS token' }, startLine: 1, endLine: 5 }], findings: [] },
    allFindings: [],
  } as unknown as DsRegistry;
}

function mappingEntry(elementId: string, findingId: string, overrides: Partial<MappingEntry> = {}): MappingEntry {
  return {
    element: elementId,
    stamp: elementId,
    findingIds: [findingId],
    signature: null,
    instanceIndex: null,
    instanceCount: null,
    sectionId: 'hero',
    scope: 'content',
    resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 }, candidatesConsidered: 1 },
    drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
    affordances: { tagName: 'button', role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
    dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
    ...overrides,
  };
}

function scriptedPlan(findingIds: string[]): RedesignPlan {
  return {
    edits: findingIds.map((id) => ({
      findingId: id,
      selector: `[data-fra-element="e-${id}"]`,
      expectedMatches: 1,
      kind: 'style',
      property: 'padding-left',
      value: '28px',
      removeValue: null,
      dsComponent: null,
      dsVariant: null,
      dsToken: '--button-px-md',
      rationale: 'close the padding mismatch',
      confidence: 0.9,
    })),
    unaddressed: [],
  };
}

describe('runR3 — real ScriptedLlmClient, schema-validated', () => {
  it('includes persistent rules and refuses primary CTA and unrelated alignment edits returned by the model', async () => {
    const finding = makeFinding({ findingId: 'a'.repeat(32) });
    const r1 = r1Base({ registry: makeRegistry(), fixFindings: [finding], findings: [finding] });
    const session = sessionWithMapping({ entries: [mappingEntry('e-a', finding.identity.findingId)], unmapped: [], conflicts: [], usage: null });
    const safe = scriptedPlan([finding.identity.findingId]).edits[0]!;
    const llm = new ScriptedLlmClient({ R3: [{ edits: [
      safe,
      { ...safe, kind: 'component-swap', property: null, dsComponent: 'Button', dsVariant: 'primary', value: 'px-4' },
      { ...safe, property: 'text-align', value: 'left' },
    ], unaddressed: [] }] });
    const result = await runR3({ llm }, { r1, session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [] });
    expect(llm.requests[0]!.prompt).toContain('Never choose the DS Button `primary`');
    expect(llm.requests[0]!.prompt).toContain('sticky pin/release');
    expect(result.plan.edits).toEqual([safe]);
    expect(result.plan.unaddressed).toHaveLength(2);
  });
  it('tells the planner that DS custom properties do not exist on the production page, so var(--token) edits would silently do nothing', async () => {
    const registry = makeRegistry();
    const f = makeFinding({ findingId: 'c'.repeat(32) });
    const session = sessionWithMapping({ entries: [mappingEntry('e1', f.identity.findingId)], unmapped: [], conflicts: [], usage: null });
    const llm = new ScriptedLlmClient({ R3: [scriptedPlan([f.identity.findingId])] });
    await runR3({ llm, log: () => {} }, { r1: r1Base({ registry, fixFindings: [f], findings: [f] }), session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [] });
    expect(llm.requests[0]!.system).toMatch(/does not define the Design System's custom properties/);
    expect(llm.requests[0]!.system).toMatch(/Write the literal value/);
  });
  it(`batches beyond CHUNK_SIZE (${CHUNK_SIZE}) into multiple model calls`, async () => {
    const registry = makeRegistry();
    const count = CHUNK_SIZE + 2;
    const findings = Array.from({ length: count }, (_, i) => makeFinding({ findingId: i.toString(16).padStart(32, '0') }));
    const entries = findings.map((f) => mappingEntry(`e-${f.identity.findingId}`, f.identity.findingId));
    const session = sessionWithMapping({ entries, unmapped: [], conflicts: [], usage: null });
    const r1 = r1Base({ registry, fixFindings: findings, findings });

    const llm = new ScriptedLlmClient({
      R3: [
        scriptedPlan(findings.slice(0, CHUNK_SIZE).map((f) => f.identity.findingId)),
        scriptedPlan(findings.slice(CHUNK_SIZE).map((f) => f.identity.findingId)),
      ],
    });

    const input: R3Input = { r1, session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [] };
    const result = await runR3({ llm, log: () => {} }, input);

    expect(result.chunks).toBe(2);
    expect(llm.requests).toHaveLength(2);
    expect((llm.requests[0]!.prompt.match(/findingId=/g) ?? []).length).toBe(CHUNK_SIZE);
    expect((llm.requests[1]!.prompt.match(/findingId=/g) ?? []).length).toBe(2);
    expect(result.plan.edits).toHaveLength(count);
  });

  it('pre-filters a finding with no mismatch, no rule violation and no DS target straight to unaddressed — no model call', async () => {
    const registry = makeRegistry();
    const finding = makeFinding({ findingId: 'a'.repeat(32), mismatches: [] });
    const entry = mappingEntry('e-a', finding.identity.findingId, { dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' } });
    const session = sessionWithMapping({ entries: [entry], unmapped: [], conflicts: [], usage: null });
    const r1 = r1Base({ registry, fixFindings: [finding], findings: [finding] });

    const llm = new ScriptedLlmClient({});
    const input: R3Input = { r1, session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [] };
    const result = await runR3({ llm, log: () => {} }, input);

    expect(llm.requests).toHaveLength(0);
    expect(result.chunks).toBe(0);
    expect(result.plan.edits).toHaveLength(0);
    expect(result.plan.unaddressed).toHaveLength(1);
    expect(result.plan.unaddressed[0]).toMatchObject({ findingId: finding.identity.findingId });
    expect(result.plan.unaddressed[0]!.reason).toContain('no measurable mismatch, no rule violation and no DS target');
  });

  it('iteration > 1 only re-plans findings the previous iteration left unfixed', async () => {
    const registry = makeRegistry();
    const fixedFinding = makeFinding({ findingId: 'b'.repeat(32) });
    const unfixedFinding = makeFinding({ findingId: 'c'.repeat(32) });
    const entries = [mappingEntry('e-fixed', fixedFinding.identity.findingId), mappingEntry('e-unfixed', unfixedFinding.identity.findingId)];
    const session = sessionWithMapping({ entries, unmapped: [], conflicts: [], usage: null });
    const r1 = r1Base({ registry, fixFindings: [fixedFinding, unfixedFinding], findings: [fixedFinding, unfixedFinding] });

    const previous: IterationRecord = {
      iteration: 1,
      plan: { iteration: 1, plan: { edits: [], unaddressed: [] }, chunks: 1, usage: null },
      applied: { iteration: 1, applied: [], after: { tiles: [], totalHeight: 0, truncated: false, composite: null } },
      validation: {
        iteration: 1,
        checks: [
          { findingId: fixedFinding.identity.findingId, fixed: true, detail: 'now matches', measured: [] },
          { findingId: unfixedFinding.identity.findingId, fixed: false, detail: 'still wrong', measured: [] },
        ],
        structural: { ok: true, lostInteractive: [], lostText: [], note: '' },
        vision: 'NOT_CHECKED',
        visionIssues: [],
        visionVerdicts: null,
        overall: 'PARTIAL',
        failedChecks: [`finding ${unfixedFinding.identity.findingId}: still wrong`],
        usage: null,
      },
    };

    const llm = new ScriptedLlmClient({ R3: [scriptedPlan([unfixedFinding.identity.findingId])] });
    const input: R3Input = { r1, session, iteration: 2, previous, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [] };
    const result = await runR3({ llm, log: () => {} }, input);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.prompt).toContain(unfixedFinding.identity.findingId);
    expect(llm.requests[0]!.prompt).not.toContain(fixedFinding.identity.findingId);
    expect(result.plan.edits).toHaveLength(1);
    expect(result.plan.edits[0]!.findingId).toBe(unfixedFinding.identity.findingId);
  });

  it('iteration > 1 shows the planner what was MEASURED on the live page for each unfixed finding, so a retry targets what actually failed', async () => {
    const registry = makeRegistry();
    const unfixed = makeFinding({ findingId: 'c'.repeat(32) });
    const session = sessionWithMapping({ entries: [mappingEntry('e-unfixed', unfixed.identity.findingId)], unmapped: [], conflicts: [], usage: null });
    const r1 = r1Base({ registry, fixFindings: [unfixed], findings: [unfixed] });
    const previous: IterationRecord = {
      iteration: 1,
      plan: { iteration: 1, plan: { edits: [], unaddressed: [] }, chunks: 1, usage: null },
      applied: { iteration: 1, applied: [], after: { tiles: [], totalHeight: 0, truncated: false, composite: null } },
      validation: {
        iteration: 1,
        checks: [{ findingId: unfixed.identity.findingId, fixed: false, detail: 'the text is still set in manrope; not yet corrected: the stamp selector followed by " > span:nth-of-type(1)" is set in manrope', measured: [{ property: 'font-family', actual: 'manrope', expected: 'a design-system typeface (DM Sans or Noto Serif), not manrope', matches: false }] }],
        structural: { ok: true, lostInteractive: [], lostText: [], note: '' },
        vision: 'NOT_CHECKED', visionIssues: [], visionVerdicts: null, overall: 'PARTIAL', failedChecks: [], usage: null,
      },
    };
    const llm = new ScriptedLlmClient({ R3: [scriptedPlan([unfixed.identity.findingId])] });
    await runR3({ llm, log: () => {} }, { r1, session, iteration: 2, previous, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [] });
    const prompt = llm.requests[0]!.prompt;
    expect(prompt).toContain('What the previous iteration measured on the live page');
    expect(prompt).toContain('> span:nth-of-type(1)');
    expect(prompt).toContain('font-family: measured "manrope"');
    // the first iteration has nothing to report
    const first = new ScriptedLlmClient({ R3: [scriptedPlan([unfixed.identity.findingId])] });
    await runR3({ llm: first, log: () => {} }, { r1, session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [] });
    expect(first.requests[0]!.prompt).not.toContain('What the previous iteration measured');
  });
});

describe('§8.1 content-isolation guarantee — Selected Sections mode never plans an edit outside the selected sections', () => {
  it('regression: a finding mapped to an UNSELECTED section is never sent to the model, even though its mapping scope is "content"', async () => {
    const registry = makeRegistry();
    const selectedFinding = makeFinding({ findingId: 'a'.repeat(32), section: 'Hero' });
    const unselectedFinding = makeFinding({ findingId: 'b'.repeat(32), section: 'Features' });
    const entries = [mappingEntry('e-hero', selectedFinding.identity.findingId, { sectionId: 'hero' }), mappingEntry('e-features', unselectedFinding.identity.findingId, { sectionId: 'features' })];
    const session = sessionWithMapping({ entries, unmapped: [], conflicts: [], usage: null });
    const r1 = r1Base({ registry, fixFindings: [selectedFinding, unselectedFinding], findings: [selectedFinding, unselectedFinding] });

    const llm = new ScriptedLlmClient({ R3: [scriptedPlan([selectedFinding.identity.findingId])] });
    const input: R3Input = { r1, session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'selected-sections', sectionIds: ['hero'] };
    const result = await runR3({ llm, log: () => {} }, input);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.prompt).toContain(selectedFinding.identity.findingId);
    expect(llm.requests[0]!.prompt).not.toContain(unselectedFinding.identity.findingId);
    expect(result.plan.edits.map((e) => e.findingId)).toEqual([selectedFinding.identity.findingId]);
  });

  it('a finding whose section wrapper could not be located (sectionId: null) is still planned in Full Page mode (§8.2), but never in Selected Sections mode', async () => {
    const registry = makeRegistry();
    const finding = makeFinding({ findingId: 'a'.repeat(32) });
    const entry = mappingEntry('e-a', finding.identity.findingId, { sectionId: null });
    const session = sessionWithMapping({ entries: [entry], unmapped: [], conflicts: [], usage: null });
    const r1 = r1Base({ registry, fixFindings: [finding], findings: [finding] });

    const fullPageLlm = new ScriptedLlmClient({ R3: [scriptedPlan([finding.identity.findingId])] });
    const fullPageResult = await runR3({ llm: fullPageLlm, log: () => {} }, { r1, session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [] });
    expect(fullPageResult.plan.edits).toHaveLength(1);

    const selectedSectionsLlm = new ScriptedLlmClient({});
    const selectedSectionsResult = await runR3({ llm: selectedSectionsLlm, log: () => {} }, { r1, session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'selected-sections', sectionIds: ['hero'] });
    expect(selectedSectionsLlm.requests).toHaveLength(0);
    expect(selectedSectionsResult.plan.edits).toHaveLength(0);
  });
});

// ── Finding 1: a preview failure reopens a finding R5 marked fixed ────────────────────────────

describe('R8 preview feedback reopens a finding R5 measured fixed', () => {
  const FA = 'a'.repeat(32);
  const FB = 'b'.repeat(32);
  const FC = 'c'.repeat(32);
  const stampOf = (id: string) => `[data-fra-element="e-${id}"]`;
  const mine = (id: string, over: Partial<TargetedEdit> = {}): TargetedEdit => ({ ...scriptedPlan([id]).edits[0]!, ...over });
  const item = (over: Partial<PlannerFeedbackItem> = {}): PlannerFeedbackItem => ({
    id: 'target:tgt-pl', kind: 'target-not-met', findingIds: [FA], targetId: 'tgt-pl', property: 'padding-left', part: 'self', state: 'default', viewport: 'any', expected: '28px', observed: '12px',
    elementLabel: 'Sign up', sectionId: 'header', constraint: 'padding-left on "Sign up" must measure 28px; the rendered preview measures 12px. An edit that does not reach the visible element is not a fix.', ...over,
  });
  const previousWith = (checks: Array<{ id: string; fixed: boolean }>): IterationRecord => ({
    iteration: 1,
    plan: { iteration: 1, plan: { edits: [], unaddressed: [] }, chunks: 1, usage: null },
    applied: { iteration: 1, applied: [], after: { tiles: [], totalHeight: 0, truncated: false, composite: null } },
    validation: {
      iteration: 1,
      checks: checks.map((c) => ({ findingId: c.id, fixed: c.fixed, detail: c.fixed ? 'every measured property now matches its expected value' : 'still wrong', measured: c.fixed ? [] : [{ property: 'font-weight', actual: '400', expected: '500', matches: false }] })),
      structural: { ok: true, lostInteractive: [], lostText: [], note: '' }, vision: 'NOT_CHECKED', visionIssues: [], visionVerdicts: null, overall: 'PASS', failedChecks: [], usage: null,
    },
  });
  const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
    id: 'tgt-pl', findingId: FA, property: 'padding-left', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
    audit: { status: 'DIFFERENT', actual: '12px', expected: '28px', expectedToken: null, note: null, source: null }, reason: 'audit-expected-present', outcome: 'resolved-target',
    target: { value: '28px', comparison: 'length-px', token: null }, provenance: { kind: 'ds-token', ds: null, reference: null, evidence: [] }, decisionReason: 'the DS padding', route: 'css-edit', acceptance: [],
    status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
  });
  const resolutionWith = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r3-run', projectName: 'r3-project', dataJsonSha256: 'd', fixPlanSha256: null }, generatedAt: '2026-09-18T10:00:00.000Z', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });

  function setup(ids: string[], mode: 'full-page' | 'selected-sections' = 'full-page', sectionOf: (id: string) => string = () => 'hero') {
    const findings = ids.map((id) => makeFinding({ findingId: id }));
    const session = sessionWithMapping({ entries: ids.map((id) => mappingEntry(`e-${id}`, id, { sectionId: sectionOf(id) })), unmapped: [], conflicts: [], usage: null });
    const r1 = r1Base({ registry: makeRegistry(), fixFindings: findings, findings });
    const base = { r1, session, iteration: 2, mode, sectionIds: mode === 'selected-sections' ? ['hero'] : [] } as const;
    return { findings, session, r1, base };
  }

  it('R5 says fixed:true, R8 names the finding: R3 calls the model with it, shows the structured feedback and the edit in force, and returns the corrected edit', async () => {
    const { base } = setup([FA]);
    const inForce = mine(FA);
    const corrected = mine(FA, { selector: `${stampOf(FA)} span` });
    const llm = new ScriptedLlmClient({ R3: [{ edits: [corrected], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [item().constraint], feedback: [item()], editsInForce: [inForce] });

    expect(llm.requests).toHaveLength(1);
    const prompt = llm.requests[0]!.prompt;
    expect(prompt).toContain(`findingId=${FA}`);
    expect(prompt).toContain('rendered React preview');
    expect(prompt).toContain('padding-left');
    expect(prompt).toContain('28px');
    expect(prompt).toContain('measures 12px');
    expect(prompt).toContain('Sign up');
    expect(prompt).toContain('edits currently in force');
    expect(prompt).toContain(`${stampOf(FA)}`);
    // the feedback sits next to ITS finding; it is not repeated as a global constraint
    expect(prompt).not.toContain('Constraints from a rejected prior preview');
    expect(result.plan.edits).toEqual([corrected]);
    expect(result.plan.unaddressed).toEqual([]);
  });

  it('plans ONLY the finding the feedback names; another fixed finding is not reopened, an R5-unfixed one still is', async () => {
    const { base } = setup([FA, FB, FC]);
    const llm = new ScriptedLlmClient({ R3: [{ edits: [mine(FA, { selector: `${stampOf(FA)} span` }), mine(FC)], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }, { id: FB, fixed: true }, { id: FC, fixed: false }]), acknowledgedConstraints: [item().constraint], feedback: [item()], editsInForce: [mine(FA)] });
    const prompt = llm.requests[0]!.prompt;
    expect(prompt).toContain(`findingId=${FA}`);
    expect(prompt).toContain(`findingId=${FC}`);
    expect(prompt).not.toContain(`findingId=${FB}`);
    expect(result.plan.edits.map((e) => e.findingId).sort()).toEqual([FA, FC]);
  });

  it('with no feedback and everything fixed it still plans nothing and never calls the model', async () => {
    const { base } = setup([FA]);
    const llm = new ScriptedLlmClient({});
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [] });
    expect(llm.requests).toHaveLength(0);
    expect(result.plan.edits).toEqual([]);
  });

  it('restricts a reopened finding to the feedback property and state: other properties, the :hover state, a wider shorthand and non-style kinds are refused with the scope reason', async () => {
    const { base } = setup([FA]);
    const keep = mine(FA, { selector: `${stampOf(FA)} span` });
    const llm = new ScriptedLlmClient({ R3: [{ edits: [keep, mine(FA, { property: 'font-weight', value: '500' }), mine(FA, { selector: `${stampOf(FA)}:hover` }), mine(FA, { property: 'padding', value: '4px 28px' }), mine(FA, { kind: 'attribute', property: 'data-x', value: '1' })], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA)] });
    expect(result.plan.edits).toEqual([keep]);
    expect(result.plan.unaddressed).toHaveLength(4);
    for (const u of result.plan.unaddressed) expect(u.reason).toMatch(/outside the preview feedback scope/);
  });

  it('a longhand of the feedback property is in scope, a sibling property is not', async () => {
    const { base } = setup([FA]);
    const left = mine(FA, { property: 'padding-left', selector: `${stampOf(FA)} span` });
    const llm = new ScriptedLlmClient({ R3: [{ edits: [left, mine(FA, { property: 'margin-left', value: '4px' })], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item({ property: 'padding', expected: '4px 28px' })], editsInForce: [] });
    expect(result.plan.edits).toEqual([left]);
    expect(result.plan.unaddressed).toHaveLength(1);
  });

  it('the project policy still wins for a reopened finding: a preserve-existing property and a black CTA fill are refused, never widened by the feedback', async () => {
    const { base } = setup([FA]);
    const preserved = resolutionWith(target({ outcome: 'preserve-existing', target: null }));
    const llmA = new ScriptedLlmClient({ R3: [{ edits: [mine(FA, { selector: `${stampOf(FA)} span` })], unaddressed: [] }] });
    const a = await runR3({ llm: llmA, log: () => {} }, { ...base, resolution: preserved, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [] });
    expect(a.plan.edits).toEqual([]);
    expect(a.plan.unaddressed[0]!.reason).toMatch(/Project redesign policy/);

    const llmB = new ScriptedLlmClient({ R3: [{ edits: [mine(FA, { property: 'background-color', value: '#000' })], unaddressed: [] }] });
    const b = await runR3({ llm: llmB, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item({ property: 'background-color', expected: '#b01f24', targetId: null })], editsInForce: [] });
    expect(b.plan.edits).toEqual([]);
    expect(b.plan.unaddressed[0]!.reason).toMatch(/black CTA fill is prohibited/);
  });

  it('a target the model did not cover is derived from the TARGET, only for the targets named in the feedback, and only those targets are noted', async () => {
    const { base } = setup([FA]);
    const other = target({ id: 'tgt-other', property: 'border-top-left-radius', target: { value: '8px', comparison: 'length-px', token: null } });
    const llm = new ScriptedLlmClient({ R3: [{ edits: [], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, resolution: resolutionWith(target(), other), previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA, { value: '12px' })] });
    expect(result.plan.edits).toHaveLength(1);
    expect(result.plan.edits[0]).toMatchObject({ findingId: FA, selector: stampOf(FA), property: 'padding-left', value: '28px' });
    expect(result.targetNotes).toEqual([{ targetId: 'tgt-pl', implementation: 'planned', detail: expect.stringContaining('derived from the resolved target') }]);
    expect(result.synthesizedEdits).toBe(1);
  });

  it('an audit-expected COLOUR target is derived from the target when the model\'s colour edit was refused: the refused edit never makes it "planned"', async () => {
    const { base } = setup([FA]);
    const colour = target({
      id: 'tgt-bc', property: 'border-top-color', audit: { status: 'DIFFERENT', actual: '#ff0000', expected: '#e5e5e5', expectedToken: '--border-card', note: null, source: null },
      target: { value: '#e5e5e5', comparison: 'color-deltaE', token: '--border-card' }, provenance: { ...target().provenance, kind: 'audit-expected' },
    });
    // a raw colour that is not the target's: the guard refuses it, so only the unaddressed entry exists for the finding
    const llm = new ScriptedLlmClient({ R3: [{ edits: [mine(FA, { property: 'border-top-color', value: '#ff00aa' })], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 1, previous: null, acknowledgedConstraints: [], resolution: resolutionWith(colour) });
    expect(result.plan.edits).toHaveLength(1);
    expect(result.plan.edits[0]).toMatchObject({ findingId: FA, selector: stampOf(FA), property: 'border-top-color', value: '#e5e5e5', dsToken: '--border-card' });
    expect(result.targetNotes).toEqual([{ targetId: 'tgt-bc', implementation: 'planned', detail: expect.stringContaining('derived from the resolved target') }]);
    expect(result.synthesizedEdits).toBe(1);
  });

  it('an audit-expected NON-colour target is still "planned" through the finding\'s other edit (component / class)', async () => {
    const { base } = setup([FA]);
    const audit = target({ provenance: { ...target().provenance, kind: 'audit-expected' } });
    const swap = mine(FA, { kind: 'class', property: null, value: 'px-7' });
    const llm = new ScriptedLlmClient({ R3: [{ edits: [swap], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 1, previous: null, acknowledgedConstraints: [], resolution: resolutionWith(audit) });
    expect(result.targetNotes).toEqual([{ targetId: 'tgt-pl', implementation: 'planned', detail: expect.stringContaining('component/class edit') }]);
  });

  it('does not fake a plan: an edit identical to the one already in force is not re-planned, the target is blocked with "the cause is not the plan", and the finding is reported', async () => {
    const { base } = setup([FA]);
    const inForce = mine(FA, { selector: stampOf(FA), value: '28px' });
    const llm = new ScriptedLlmClient({ R3: [{ edits: [inForce], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, resolution: resolutionWith(target()), previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [inForce] });
    expect(result.plan.edits).toEqual([]);
    expect(result.synthesizedEdits).toBe(0);
    expect(result.targetNotes).toEqual([{ targetId: 'tgt-pl', implementation: 'blocked', detail: expect.stringMatching(/cause is not the plan/) }]);
    expect(result.plan.unaddressed.some((u) => u.findingId === FA && /already in force/.test(u.reason))).toBe(true);
  });

  it('mobile-viewport feedback cannot be satisfied by a plain edit: reported with its reason, no model call for it', async () => {
    const { base } = setup([FA]);
    const llm = new ScriptedLlmClient({});
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item({ viewport: 'mobile' })], editsInForce: [mine(FA)] });
    expect(llm.requests).toHaveLength(0);
    expect(result.plan.edits).toEqual([]);
    expect(result.plan.unaddressed).toEqual([{ findingId: FA, reason: expect.stringMatching(/mobile viewport/) }]);
  });

  it('a default-regression item ("keep the original value") accepts ONLY an edit that restores that value on that property and state', async () => {
    const { base } = setup([FA]);
    const regression = item({ id: 'd1', kind: 'default-regression', targetId: null, part: null, viewport: 'desktop', expected: '12px', observed: '28px' });
    const restore = mine(FA, { value: '12px', rationale: 'restore the original' });
    const llm = new ScriptedLlmClient({ R3: [{ edits: [restore, mine(FA, { value: '20px' }), mine(FA, { property: 'padding-right', value: '12px' })], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [regression], editsInForce: [mine(FA)] });
    expect(llm.requests[0]!.prompt).toContain('original value');
    expect(result.plan.edits).toEqual([restore]);
    expect(result.plan.unaddressed).toHaveLength(2);
    expect(result.plan.unaddressed[0]!.reason).toMatch(/outside the preview feedback scope/);
  });

  it('a preserve-broken item has no recorded original value to restore: it is reported, not guessed, and no model call is spent on it', async () => {
    const { base } = setup([FA]);
    const llm = new ScriptedLlmClient({});
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item({ id: 'preserve:t', kind: 'preserve-broken', expected: null })], editsInForce: [mine(FA)] });
    expect(llm.requests).toHaveLength(0);
    expect(result.plan.unaddressed).toEqual([{ findingId: FA, reason: expect.stringMatching(/original value/) }]);
  });

  it('a reopened finding the planner returns as unaddressed is reported, never silently dropped', async () => {
    const { base } = setup([FA]);
    const llm = new ScriptedLlmClient({ R3: [{ edits: [], unaddressed: [{ findingId: FA, reason: 'no selector reaches the visible text' }] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA)] });
    expect(result.plan.unaddressed).toEqual([{ findingId: FA, reason: 'no selector reaches the visible text' }]);
  });

  it('feedback that names a finding outside the selected sections is ignored: nothing is planned outside the scope', async () => {
    const { base } = setup([FA, FB], 'selected-sections', (id) => (id === FA ? 'hero' : 'features'));
    const llm = new ScriptedLlmClient({});
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item({ findingIds: [FB], targetId: null })], editsInForce: [] });
    expect(llm.requests).toHaveLength(0);
    expect(result.plan.edits).toEqual([]);
  });

  it('a finding that is BOTH unfixed by R5 and named by the feedback is planned once, with the feedback in its block; R5 measured properties stay allowed', async () => {
    const { base } = setup([FA]);
    const fontWeight = mine(FA, { property: 'font-weight', value: '500' });
    const llm = new ScriptedLlmClient({ R3: [{ edits: [mine(FA, { selector: `${stampOf(FA)} span` }), fontWeight, mine(FA, { property: 'margin-left', value: '3px' })], unaddressed: [] }] });
    const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: false }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA)] });
    expect((llm.requests[0]!.prompt.match(new RegExp(`findingId=${FA}`, 'g')) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(result.plan.edits.map((e) => e.property).sort()).toEqual(['font-weight', 'padding-left']);
    expect(result.plan.unaddressed).toHaveLength(1);
  });

  // ── review 2: the restriction, the in-force guard and the restore comparison on later passes ─────────────────────────────

  const REOPENED_FA: NonNullable<IterationRecord['reopened']> = [{ findingId: FA, property: 'padding-left', state: 'default' }];
  /** What R5 builds for a finding R3 listed as unaddressed in the previous pass: fixed:false with nothing measured (r5-compare/index.ts). */
  const UNADDRESSED_FA = { findingId: FA, fixed: false, detail: 'unaddressed: outside the preview feedback scope (property/state)', measured: [] };
  const previousFrom = (check: IterationRecord['validation']['checks'][number], reopened?: IterationRecord['reopened']): IterationRecord => {
    const p = previousWith([]);
    return { ...p, validation: { ...p.validation, checks: [check] }, ...(reopened ? { reopened } : {}) };
  };

  describe('the scope restriction of a reopened finding survives the next pass', () => {
    it('a finding reopened in the previous pass whose R5 check is "unaddressed" (nothing measured) stays feedback-scoped: R3 does not widen it to every property', async () => {
      const { base } = setup([FA]);
      const span = mine(FA, { selector: `${stampOf(FA)} span` });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [mine(FA, { property: 'margin-top', value: '40px' }), mine(FA, { kind: 'attribute', property: 'data-x', value: '1' }), span], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 3, previous: previousFrom(UNADDRESSED_FA, REOPENED_FA), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA)] });
      expect(result.plan.edits).toEqual([span]);
      expect(result.plan.unaddressed).toHaveLength(2);
      for (const u of result.plan.unaddressed) expect(u.reason).toMatch(/outside the preview feedback scope/);
      // the unaddressed check of the previous pass is not a live-page failure to retry: it is not shown as one
      expect(llm.requests[0]!.prompt).not.toContain('not fixed by the previous iteration');
      // the planner is told what a correction replaces (finalAppliedEdits' rule), so it corrects each failing element itself
      expect(llm.requests[0]!.system).toContain('an edit on a sibling element is not replaced');
    });

    it('pass 3 with a CHANGED id set: a finding reopened last pass and no longer named is not planned again, the newly named one is feedback-scoped', async () => {
      const { base } = setup([FA, FB]);
      const spanB = mine(FB, { selector: `${stampOf(FB)} span` });
      const p = previousWith([{ id: FB, fixed: true }]);
      const previous: IterationRecord = { ...p, validation: { ...p.validation, checks: [UNADDRESSED_FA, ...p.validation.checks] }, reopened: REOPENED_FA };
      const llm = new ScriptedLlmClient({ R3: [{ edits: [mine(FB, { property: 'margin-top', value: '40px' }), spanB], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 3, previous, acknowledgedConstraints: [], feedback: [item({ id: 'target:tgt-b', findingIds: [FB], targetId: null })], editsInForce: [mine(FA), mine(FB)] });
      expect(llm.requests[0]!.prompt).not.toContain(`findingId=${FA}`);
      expect(llm.requests[0]!.prompt).toContain(`findingId=${FB}`);
      expect(result.plan.edits).toEqual([spanB]);
      expect(result.plan.unaddressed).toEqual([{ findingId: FB, reason: expect.stringMatching(/outside the preview feedback scope/) }]);
    });

    it('a finding reopened last pass and no longer named by any feedback is not re-planned (the planner said it could not; R5 recorded that, not a live failure)', async () => {
      const { base } = setup([FA]);
      const llm = new ScriptedLlmClient({});
      const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 3, previous: previousFrom(UNADDRESSED_FA, REOPENED_FA), acknowledgedConstraints: [], feedback: [], editsInForce: [mine(FA)] });
      expect(llm.requests).toHaveLength(0);
      expect(result.plan).toEqual({ edits: [], unaddressed: [] });
    });

    it('PINNED main-loop behaviour: an "unaddressed" finding that was NEVER reopened is retried by the next iteration, and with feedback it keeps its widening (nothing measured, no extra restriction)', async () => {
      const { base } = setup([FA]);
      const retry = new ScriptedLlmClient({ R3: [scriptedPlan([FA])] });
      const a = await runR3({ llm: retry, log: () => {} }, { ...base, previous: previousFrom(UNADDRESSED_FA), acknowledgedConstraints: [] });
      expect(retry.requests).toHaveLength(1);
      expect(a.plan.edits).toHaveLength(1);

      const widened = new ScriptedLlmClient({ R3: [{ edits: [mine(FA, { property: 'margin-top', value: '40px' })], unaddressed: [] }] });
      const b = await runR3({ llm: widened, log: () => {} }, { ...base, previous: previousFrom(UNADDRESSED_FA), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA)] });
      expect(b.plan.edits.map((e) => e.property)).toEqual(['margin-top']);
    });

    it('PINNED: a reopened finding whose R5 check measured a real mismatch on the live page keeps the properties R5 measured wrong, and nothing else', async () => {
      const { base } = setup([FA]);
      const check = { findingId: FA, fixed: false, detail: '1/1 propert(y/ies) still do not match', measured: [{ property: 'font-weight', actual: '400', expected: '500', matches: false }] };
      const fontWeight = mine(FA, { property: 'font-weight', value: '500' });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [fontWeight, mine(FA, { property: 'margin-left', value: '4px' })], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 3, previous: previousFrom(check, REOPENED_FA), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA)] });
      expect(result.plan.edits).toEqual([fontWeight]);
      expect(result.plan.unaddressed).toHaveLength(1);
    });
  });

  describe('the model re-emits the edit already in force', () => {
    it('together with the correction: the correction is accepted and the redundant re-emission is NOT reported, so R5 cannot turn the finding into "unaddressed"', async () => {
      const { base } = setup([FA]);
      const inForce = mine(FA);
      const corrected = mine(FA, { selector: `${stampOf(FA)} span` });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [inForce, corrected], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [inForce] });
      expect(result.plan.edits).toEqual([corrected]);
      expect(result.plan.unaddressed).toEqual([]);
    });

    it('alone: it is not a plan, and the finding is reported with the "cause is not the plan" reason (unchanged)', async () => {
      const { base } = setup([FA]);
      const inForce = mine(FA);
      const llm = new ScriptedLlmClient({ R3: [{ edits: [inForce], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [inForce] });
      expect(result.plan.edits).toEqual([]);
      expect(result.plan.unaddressed).toEqual([{ findingId: FA, reason: expect.stringMatching(/already in force.*cause is not the plan/) }]);
    });

    it('for a finding that is ALSO unfixed by R5 and named by the feedback: an identical edit is refused too, never counted as a new plan', async () => {
      const { base } = setup([FA]);
      const inForce = mine(FA);
      const llm = new ScriptedLlmClient({ R3: [{ edits: [inForce], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: false }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [inForce] });
      expect(result.plan.edits).toEqual([]);
      expect(result.plan.unaddressed).toEqual([{ findingId: FA, reason: expect.stringMatching(/already in force/) }]);
    });

    it('R5-unfixed + feedback + no model edit: the synthesized edit identical to the one in force is NOT claimed "planned" (blocked, reported)', async () => {
      const { base } = setup([FA]);
      const inForce = mine(FA, { selector: stampOf(FA), value: '28px' });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, resolution: resolutionWith(target()), previous: previousWith([{ id: FA, fixed: false }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [inForce] });
      expect(result.plan.edits).toEqual([]);
      expect(result.synthesizedEdits).toBe(0);
      expect(result.targetNotes).toEqual([{ targetId: 'tgt-pl', implementation: 'blocked', detail: expect.stringMatching(/cause is not the plan/) }]);
      expect(result.plan.unaddressed.some((u) => u.findingId === FA && /already in force/.test(u.reason))).toBe(true);
    });

    it('R5-unfixed, nothing in the feedback for the target: a derived edit is still planned as before (the guard only applies to targets the preview failed)', async () => {
      const { base } = setup([FA]);
      const other = target({ id: 'tgt-other', property: 'border-top-left-radius', target: { value: '8px', comparison: 'length-px', token: null } });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [], unaddressed: [] }] });
      const radiusInForce = mine(FA, { selector: stampOf(FA), property: 'border-top-left-radius', value: '8px' });
      const result = await runR3({ llm, log: () => {} }, { ...base, resolution: resolutionWith(target(), other), previous: previousWith([{ id: FA, fixed: false }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA, { value: '28px' }), radiusInForce] });
      expect(result.plan.edits.map((e) => e.property)).toEqual(['border-top-left-radius']);
      expect(result.targetNotes?.find((n) => n.targetId === 'tgt-other')?.implementation).toBe('planned');
      expect(result.targetNotes?.find((n) => n.targetId === 'tgt-pl')?.implementation).toBe('blocked');
    });
  });

  describe('a "keep the original value" item recognises an equivalent spelling of the original', () => {
    const restoreItem = (property: string, expected: string): PlannerFeedbackItem => item({ id: `d:${property}`, kind: 'default-regression', targetId: null, part: null, viewport: 'desktop', property, expected, observed: 'something else' });
    const run = async (property: string, expected: string, values: string[]) => {
      const { base } = setup([FA]);
      const edits = values.map((value, n) => mine(FA, { property, value, selector: `${stampOf(FA)} s${n}` }));
      const llm = new ScriptedLlmClient({ R3: [{ edits, unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [restoreItem(property, expected)], editsInForce: [mine(FA, { property })] });
      return { accepted: result.plan.edits.map((e) => e.value), refused: result.plan.unaddressed.map((u) => u.reason), prompt: llm.requests[0]!.prompt };
    };

    it('colours: the computed baseline rgb(255, 255, 255) is restored by rgb(255,255,255), #fff and #FFFFFF, not by #000000', async () => {
      const r = await run('color', 'rgb(255, 255, 255)', ['rgb(255,255,255)', '#fff', '#FFFFFF', '#000000']);
      expect(r.accepted).toEqual(['rgb(255,255,255)', '#fff', '#FFFFFF']);
      expect(r.refused).toHaveLength(1);
      expect(r.refused[0]).toMatch(/outside the preview feedback scope/);
      // the instruction to the model keeps the original value verbatim
      expect(r.prompt).toContain('the ORIGINAL value rgb(255, 255, 255) must be kept');
    });

    it('lengths: 16px is restored by 16.0px and !important spellings, not by 20px, and NOT by 1rem / 1em (no measured root or element font size reaches R3: fail closed)', async () => {
      const r = await run('padding-left', '16px', ['1rem', '16.0px', '16px !important', '20px', '1em']);
      expect(r.accepted).toEqual(['16.0px', '16px !important']);
      expect(r.refused).toHaveLength(3);
    });

    it('a rem original is restored only by its verbatim spelling (the root size that would make 1rem equal 16px is not known)', async () => {
      const r = await run('padding-left', '1rem', ['1rem', '16px', '1.0rem', '1REM']);
      expect(r.accepted).toEqual(['1rem', '1REM']);
      expect(r.refused).toHaveLength(2);
    });

    it('other properties still compare textually (case and spacing only)', async () => {
      const r = await run('font-weight', '500', ['500', '600']);
      expect(r.accepted).toEqual(['500']);
      expect(r.refused).toHaveLength(1);
    });
  });

  describe('more than CHUNK_SIZE findings', () => {
    it('feedback for a finding in a LATER chunk: its block and edits stay in its own chunk, a stray edit from chunk 1 is refused, and the G1 constraint is kept while the feedback constraint is not repeated', async () => {
      const ids = Array.from({ length: CHUNK_SIZE + 2 }, (_, n) => (n + 1).toString(16).padStart(32, '0'));
      const last = ids.at(-1)!;
      const { base } = setup(ids);
      const previous = previousFrom({ findingId: ids[0]!, fixed: false, detail: 'still wrong', measured: [{ property: 'font-weight', actual: '400', expected: '500', matches: false }] });
      previous.validation.checks = [...ids.slice(0, -1).map((id) => ({ findingId: id, fixed: false, detail: 'still wrong', measured: [{ property: 'font-weight', actual: '400', expected: '500', matches: false }] })), { findingId: last, fixed: true, detail: 'ok', measured: [] }];
      const stray = mine(last);
      const corrected = mine(last, { selector: `${stampOf(last)} span` });
      const chunk1 = { edits: [...scriptedPlan(ids.slice(0, CHUNK_SIZE)).edits, stray], unaddressed: [] };
      const chunk2 = { edits: [...scriptedPlan(ids.slice(CHUNK_SIZE, -1)).edits, corrected], unaddressed: [] };
      const llm = new ScriptedLlmClient({ R3: [chunk1, chunk2] });
      const fb = item({ findingIds: [last], targetId: null });
      const g1 = 'G1 note: keep the hero compact';
      const result = await runR3({ llm, log: () => {} }, { ...base, previous, acknowledgedConstraints: [g1, fb.constraint], feedback: [fb], editsInForce: [mine(last)] });

      expect(result.chunks).toBe(2);
      expect(llm.requests[0]!.prompt).not.toContain(`findingId=${last}`);
      expect(llm.requests[0]!.prompt).not.toContain('preview feedback (HARD REQUIREMENT');
      expect(llm.requests[1]!.prompt).toContain(`findingId=${last}`);
      expect(llm.requests[1]!.prompt).toContain('preview feedback (HARD REQUIREMENT');
      for (const r of llm.requests) {
        expect(r.prompt).toContain(g1);
        expect(r.prompt).not.toContain('Constraints from a rejected prior preview (hard requirements this iteration):\n- G1 note: keep the hero compact\n- padding-left');
        expect(r.prompt.split(fb.constraint).length - 1).toBe(0);
      }
      expect(result.plan.edits.filter((e) => e.findingId === last)).toEqual([corrected]);
      expect(result.plan.unaddressed).toEqual([{ findingId: last, reason: expect.stringMatching(/does not belong to this authorized batch/) }]);
      expect(result.plan.edits).toHaveLength(CHUNK_SIZE + 2);
    });
  });

  describe('part-specific feedback', () => {
    const labelItem = item({ id: 'target:tgt-label', targetId: 'tgt-label', part: 'label' });
    const labelTarget = target({ id: 'tgt-label', part: 'label' });

    it('the plain stamp edit that is already in force cannot reach the label part: it is refused as already in force, a descendant edit is accepted, and the prompt names the part', async () => {
      const { base } = setup([FA]);
      const span = mine(FA, { selector: `${stampOf(FA)} span` });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [mine(FA), span], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, resolution: resolutionWith(labelTarget), previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [labelItem], editsInForce: [mine(FA)] });
      expect(llm.requests[0]!.prompt).toContain('label, default state');
      expect(result.plan.edits).toEqual([span]);
      expect(result.plan.unaddressed).toEqual([]);
    });

    it('a label-part target the model did not cover is never derived onto the stamp (no reliable live-DOM selector): it is noted blocked', async () => {
      const { base } = setup([FA]);
      const llm = new ScriptedLlmClient({ R3: [{ edits: [], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, resolution: resolutionWith(labelTarget), previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [labelItem], editsInForce: [mine(FA, { value: '12px' })] });
      expect(result.plan.edits).toEqual([]);
      expect(result.synthesizedEdits).toBe(0);
      expect(result.targetNotes).toEqual([{ targetId: 'tgt-label', implementation: 'blocked', detail: expect.stringMatching(/no reliable live-DOM selector/) }]);
    });
  });

  // ── review 3: planner reports are recognised by what they SAY, repeats are never dropped silently, length spellings ─────────────

  describe('a reopened finding\'s failed R5 check: the planner\'s own report is not a live-page failure, a vision downgrade is', () => {
    const VISION_DOWNGRADE = { findingId: FA, fixed: false, detail: 'every measured property now matches its expected value — but the vision check says NOT_FIXED: the heading now wraps', measured: [{ property: 'font-weight', actual: '500', expected: '500', matches: true }] };
    const POLICY_REFUSED = { findingId: FA, fixed: false, detail: 'Project redesign policy: black CTA fill is prohibited; use the existing red brand variant.', measured: [] as Array<{ property: string; actual: string; expected: string; matches: boolean }> };

    it('R5\'s vision downgrade of a measured-fixed check (fixed:false, every measured row matching) is a real failure: the reopened finding is retried', async () => {
      const { base } = setup([FA]);
      const llm = new ScriptedLlmClient({ R3: [scriptedPlan([FA])] });
      const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 3, previous: previousFrom(VISION_DOWNGRADE, REOPENED_FA), acknowledgedConstraints: [], feedback: [], editsInForce: [] });
      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0]!.prompt).toContain('not fixed by the previous iteration');
      expect(llm.requests[0]!.prompt).toContain('the vision check says NOT_FIXED');
      expect(result.plan.edits).toHaveLength(1);
    });

    it('the same downgrade on a finding NOT reopened before is retried too (unchanged)', async () => {
      const { base } = setup([FA]);
      const llm = new ScriptedLlmClient({ R3: [scriptedPlan([FA])] });
      const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 3, previous: previousFrom(VISION_DOWNGRADE), acknowledgedConstraints: [], feedback: [], editsInForce: [] });
      expect(llm.requests).toHaveLength(1);
      expect(result.plan.edits).toHaveLength(1);
    });

    it('a project-policy refusal recorded by R5 for a finding reopened before is the planner\'s report, not retried (the refusal would simply repeat)', async () => {
      const { base } = setup([FA]);
      const llm = new ScriptedLlmClient({});
      const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 3, previous: previousFrom(POLICY_REFUSED, REOPENED_FA), acknowledgedConstraints: [], feedback: [], editsInForce: [] });
      expect(llm.requests).toHaveLength(0);
      expect(result.plan).toEqual({ edits: [], unaddressed: [] });
    });

    it('a vision downgrade after a reopened pass makes the finding R5-unfixed with nothing measured wrong: like any such finding it gets no extra property restriction', async () => {
      const { base } = setup([FA]);
      const span = mine(FA, { selector: `${stampOf(FA)} span` });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [span, mine(FA, { property: 'margin-top', value: '40px' })], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, iteration: 3, previous: previousFrom(VISION_DOWNGRADE, REOPENED_FA), acknowledgedConstraints: [], feedback: [item()], editsInForce: [mine(FA)] });
      expect(result.plan.edits.map((e) => e.property)).toEqual(['padding-left', 'margin-top']);
    });
  });

  describe('an in-force edit the model repeats while another correction lands is reported, not dropped', () => {
    const fwItem = item({ id: 'target:tgt-fw', targetId: 'tgt-fw', property: 'font-weight', expected: '500', observed: '400' });
    const fwTarget = target({ id: 'tgt-fw', property: 'font-weight', target: { value: '500', comparison: 'exact', token: null } });
    const padInForce = (): TargetedEdit => mine(FA);
    const fwInForce = (): TargetedEdit => mine(FA, { property: 'font-weight', value: '500' });
    const fwSpan = (): TargetedEdit => mine(FA, { property: 'font-weight', value: '500', selector: `${stampOf(FA)} span` });

    it('another property\'s correction is accepted and the repeat of the unrelated in-force property is reported as unaddressed', async () => {
      const { base } = setup([FA]);
      const llm = new ScriptedLlmClient({ R3: [{ edits: [padInForce(), fwSpan()], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item(), fwItem], editsInForce: [padInForce(), fwInForce()] });
      expect(result.plan.edits).toEqual([fwSpan()]);
      expect(result.plan.unaddressed).toEqual([{ findingId: FA, reason: expect.stringMatching(/already in force.*cause is not the plan/) }]);
    });

    it('with resolved targets the repeated property\'s target is noted blocked, the corrected one planned (an audit-expected target too)', async () => {
      const { base } = setup([FA]);
      const audit = target({ provenance: { ...target().provenance, kind: 'audit-expected' } });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [padInForce(), fwSpan()], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, resolution: resolutionWith(audit, fwTarget), previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item(), fwItem], editsInForce: [padInForce(), fwInForce()] });
      expect(result.plan.edits).toEqual([fwSpan()]);
      expect(result.targetNotes).toEqual(expect.arrayContaining([{ targetId: 'tgt-pl', implementation: 'blocked', detail: expect.stringMatching(/cause is not the plan/) }, { targetId: 'tgt-fw', implementation: 'planned', detail: null }]));
      expect(result.plan.unaddressed).toHaveLength(1);
    });

    it('a repeat stays silent when an accepted edit of the same finding covers the same property and state', async () => {
      const { base } = setup([FA]);
      const llm = new ScriptedLlmClient({ R3: [{ edits: [padInForce(), mine(FA, { selector: `${stampOf(FA)} span` })], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item()], editsInForce: [padInForce()] });
      expect(result.plan.unaddressed).toEqual([]);
    });

    it('an accepted edit in ANOTHER state does not cover the repeat', async () => {
      const { base } = setup([FA]);
      const hover = mine(FA, { property: 'font-weight', value: '500', selector: `${stampOf(FA)}:hover` });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [padInForce(), hover], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item(), item({ id: 'target:h', targetId: null, property: 'font-weight', state: 'hover', expected: '500', observed: '400' })], editsInForce: [padInForce()] });
      expect(result.plan.edits).toEqual([hover]);
      expect(result.plan.unaddressed).toEqual([{ findingId: FA, reason: expect.stringMatching(/already in force/) }]);
    });
  });

  describe('length-like properties beyond the verifier\'s set are compared by value', () => {
    const restoreItem = (property: string, expected: string): PlannerFeedbackItem => item({ id: `d:${property}`, kind: 'default-regression', targetId: null, part: null, viewport: 'desktop', property, expected, observed: 'something else' });
    const run = async (property: string, expected: string, values: string[]) => {
      const { base } = setup([FA]);
      const edits = values.map((value, n) => mine(FA, { property, value, selector: `${stampOf(FA)} s${n}` }));
      const llm = new ScriptedLlmClient({ R3: [{ edits, unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [restoreItem(property, expected)], editsInForce: [mine(FA, { property })] });
      return { accepted: result.plan.edits.map((e) => e.value), refused: result.plan.unaddressed.length };
    };

    it('margin-top 16px is restored by 16.0px, not by 17px, 1rem or 1em (relative units are never converted)', async () => {
      const r = await run('margin-top', '16px', ['1rem', '16.0px', '17px', '1em']);
      expect(r.accepted).toEqual(['16.0px']);
      expect(r.refused).toBe(3);
    });

    it('width 200px is restored by 200.0px, not by 201px or 12.5rem; a multi-value margin compares per token in px', async () => {
      const a = await run('width', '200px', ['200.0px', '12.5rem', '201px']);
      expect(a.accepted).toEqual(['200.0px']);
      const b = await run('margin', '0px 16px', ['0 1rem', '0px 17px', '0 16.0px']);
      expect(b.accepted).toEqual(['0 16.0px']);
    });

    it('a rem value in force is the same edit only when spelled the same: 16px beside an in-force 1rem is a different edit, 1rem beside 1rem is not', async () => {
      const go = async (value: string) => {
        const { base } = setup([FA]);
        const llm = new ScriptedLlmClient({ R3: [{ edits: [mine(FA, { value })], unaddressed: [] }] });
        return runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item({ expected: '28px' })], editsInForce: [mine(FA, { value: '1rem' })] });
      };
      expect((await go('16px')).plan.edits.map((e) => e.value)).toEqual(['16px']);
      const same = await go('1rem');
      expect(same.plan.edits).toEqual([]);
      expect(same.plan.unaddressed).toEqual([{ findingId: FA, reason: expect.stringMatching(/cause is not the plan/) }]);
    });

    it('a non-length property is never made equal by this: width auto stays text-compared', async () => {
      const r = await run('width', 'auto', ['AUTO', '100%']);
      expect(r.accepted).toEqual(['AUTO']);
    });

    it('PINNED tolerance: for a property the verifier compares with its 0.5px tolerance, 28.4px beside the 28px in force counts as already in force (the verifier itself calls them equal)', async () => {
      const { base } = setup([FA]);
      const near = mine(FA, { value: '28.4px' });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [near], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item({ expected: '28.4px' })], editsInForce: [mine(FA, { value: '28px' })] });
      expect(result.plan.edits).toEqual([]);
      expect(result.plan.unaddressed).toEqual([{ findingId: FA, reason: expect.stringMatching(/cause is not the plan/) }]);
    });

    it('for the extra length-like set the comparison is exact (after normalising units): 16.3px beside 16px in force is a different edit', async () => {
      const { base } = setup([FA]);
      const near = mine(FA, { property: 'margin-top', value: '16.3px' });
      const llm = new ScriptedLlmClient({ R3: [{ edits: [near], unaddressed: [] }] });
      const result = await runR3({ llm, log: () => {} }, { ...base, previous: previousWith([{ id: FA, fixed: true }]), acknowledgedConstraints: [], feedback: [item({ property: 'margin-top', expected: '16.3px' })], editsInForce: [mine(FA, { property: 'margin-top', value: '16px' })] });
      expect(result.plan.edits).toEqual([near]);
    });
  });
});
