import { describe, expect, it } from 'vitest';
import type { AppliedEdit } from '../../src/agents/types.ts';
import { selectorWithoutStateConditions } from '../../src/dom/apply-edit.ts';
import { guardedSelector } from '../../src/fidelity/guard.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { basisHashOf, emptyCorrectionState, readCorrectionState, writeCorrectionState } from '../../src/preview/correction-state.ts';
import { recordApplied, recordPlan, stateOfEdit } from '../../src/resolution/progress.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const edit = (over: Partial<TargetedEdit> = {}): TargetedEdit => ({ findingId: 'f1', selector: '[data-fra-element="e1"]', expectedMatches: 1, kind: 'style', property: 'border-top-left-radius', value: '8px', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1, ...over });
const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  id: 't1', findingId: 'f1', property: 'border-top-left-radius', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
  audit: { status: 'DIFFERENT', actual: '4px', expected: '8px', expectedToken: null, note: null, source: null }, reason: 'audit-expected-present', outcome: 'resolved-target', target: { value: '8px', comparison: 'length-px', token: null },
  provenance: { kind: 'audit-expected', ds: null, reference: null, evidence: [] }, decisionReason: 'x', route: 'css-edit', acceptance: [],
  status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
});
const file = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });
const applied = (e: TargetedEdit, over: Partial<AppliedEdit> = {}): AppliedEdit => ({ edit: e, matched: 1, applied: true, previousValue: '4px', error: null, ...over });

describe('state conditions on an edit selector', () => {
  it('a state-guarded selector still addresses the same elements: the guard is a condition, not part of the match count', () => {
    expect(selectorWithoutStateConditions(guardedSelector('[data-fra-element="e1"]'))).toBe('[data-fra-element="e1"]');
    expect(selectorWithoutStateConditions('[data-fra-element="e1"]:hover')).toBe('[data-fra-element="e1"]');
    expect(selectorWithoutStateConditions('[data-fra-element="e1"]:focus-visible')).toBe('[data-fra-element="e1"]');
    expect(selectorWithoutStateConditions('.card:not(:hover) .label:first-child')).toBe('.card .label:first-child');
  });

  it('never produces an invalid empty :not()', () => {
    expect(selectorWithoutStateConditions(guardedSelector('.a'))).not.toMatch(/:not\(\)/);
  });

  it('reads the state an edit applies in from its selector', () => {
    expect(stateOfEdit(edit())).toBe('default');
    expect(stateOfEdit(edit({ selector: '[data-fra-element="e1"]:hover' }))).toBe('hover');
    expect(stateOfEdit(edit({ selector: '[data-fra-element="e1"]:focus-visible' }))).toBe('focus-visible');
    expect(stateOfEdit(edit({ selector: guardedSelector('[data-fra-element="e1"]') }))).toBe('default');
  });
});

describe('implementation status', () => {
  it('records planned / blocked from the planner and applied / blocked from R4 — and never touches verification', () => {
    const r = file(target(), target({ id: 't2', property: 'background-color', state: 'hover' }));
    recordPlan(r, { targetNotes: [{ targetId: 't1', implementation: 'planned', detail: null }, { targetId: 't2', implementation: 'blocked', detail: 'no reliable selector' }] });
    expect(r.targets.map((t) => [t.status.implementation, t.status.verification])).toEqual([['planned', 'not-run'], ['blocked', 'not-run']]);
    expect(r.targets[1]!.status.implementationDetail).toBe('no reliable selector');
    recordApplied(r, [applied(edit())]);
    expect(r.targets[0]!.status).toMatchObject({ implementation: 'applied', verification: 'not-run' });
  });

  it('an edit that matched nothing or failed is BLOCKED with its error, not applied', () => {
    const r = file(target());
    recordApplied(r, [applied(edit(), { applied: false, matched: 0, error: 'selector matched 0 elements' })]);
    expect(r.targets[0]!.status).toMatchObject({ implementation: 'blocked', implementationDetail: 'selector matched 0 elements' });
  });

  it('an edit applies to the target of ITS state only', () => {
    const r = file(target(), target({ id: 'hover', state: 'hover' }));
    recordApplied(r, [applied(edit({ selector: '[data-fra-element="e1"]:hover' }))]);
    expect(r.targets.map((t) => t.status.implementation)).toEqual(['not-started', 'applied']);
  });

  it('only resolved targets carry an implementation status', () => {
    const r = file(target({ outcome: 'preserve-existing', target: null, status: { design: 'preserved', implementation: 'not-applicable', verification: 'not-run', implementationDetail: null, verificationDetail: null } }));
    recordApplied(r, [applied(edit())]);
    expect(r.targets[0]!.status.implementation).toBe('not-applicable');
  });
});

describe('correction state', () => {
  it('the basis changes with the edits, the targets and the baseline — and not with clocks or statuses', () => {
    const base = { edits: [edit()], resolution: file(target()), baselineSha256: 'a' };
    const h = basisHashOf(base);
    expect(basisHashOf({ ...base, resolution: file(target({ status: { design: 'resolved', implementation: 'applied', verification: 'verified-resolved-target', implementationDetail: 'x', verificationDetail: 'y' } })) })).toBe(h);
    expect(basisHashOf({ ...base, edits: [edit({ value: '12px' })] })).not.toBe(h);
    expect(basisHashOf({ ...base, resolution: file(target({ target: { value: '12px', comparison: 'length-px', token: null } })) })).not.toBe(h);
    expect(basisHashOf({ ...base, baselineSha256: 'b' })).not.toBe(h);
    expect(basisHashOf({ ...base, edits: [edit(), edit({ property: 'color', value: 'red' })].reverse() })).toBe(basisHashOf({ ...base, edits: [edit(), edit({ property: 'color', value: 'red' })] }));
  });

  it('round-trips, and an unreadable or malformed file is not trusted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fra-cstate-'));
    try {
      const path = join(dir, 'correction-state.json');
      expect(await readCorrectionState(path)).toBeNull();
      const state = { ...emptyCorrectionState('h'), stateGuards: ['f1|background-color'], plannerPasses: [['keep 12px']], cyclesUsed: 1, verificationsUsed: 2 };
      await writeCorrectionState(path, state);
      expect(await readCorrectionState(path)).toEqual(state);
      writeFileSync(path, '{"schemaVersion":1,"basisHash":3}');
      expect(await readCorrectionState(path)).toBeNull();
      writeFileSync(path, 'not json');
      expect(await readCorrectionState(path)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('correction state — structured planner feedback is additive (finding 1)', () => {
  const item = { id: 'target:t1', kind: 'target-not-met' as const, findingIds: ['f1'], targetId: 't1', property: 'padding-left', part: 'self', state: 'default' as const, viewport: 'any' as const, expected: '28px', observed: '12px', elementLabel: 'Sign up', sectionId: 'header', constraint: 'padding-left must measure 28px' };

  it('a new state starts with no stored feedback, and the feedback round-trips next to the constraint strings', async () => {
    expect(emptyCorrectionState('h').plannerFeedbacks).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'fra-cstate-fb-'));
    try {
      const path = join(dir, 'correction-state.json');
      const state = { ...emptyCorrectionState('h'), plannerPasses: [['padding-left must measure 28px']], plannerFeedbacks: [[item]], cyclesUsed: 1 };
      await writeCorrectionState(path, state);
      expect(await readCorrectionState(path)).toEqual(state);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a state file written before the feedback existed still parses, with no stored feedback (its passes replay as before)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fra-cstate-legacy-'));
    try {
      const path = join(dir, 'correction-state.json');
      const { plannerFeedbacks: _omit, ...legacy } = { ...emptyCorrectionState('h'), plannerPasses: [['keep 12px']], cyclesUsed: 1 };
      writeFileSync(path, JSON.stringify(legacy));
      const read = await readCorrectionState(path);
      expect(read).not.toBeNull();
      expect(read?.plannerPasses).toEqual([['keep 12px']]);
      expect(read?.plannerFeedbacks).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the plan basis does not depend on the stored feedback', () => {
    const base = { edits: [edit()], resolution: null, baselineSha256: 'a' };
    expect(basisHashOf(base)).toBe(basisHashOf({ ...base }));
  });
});
