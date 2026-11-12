import { describe, expect, it } from 'vitest';
import { runL1, type L1NodeInput } from '../../src/agents/l1-resolve-plan/index.ts';
import { resolveL1 } from '../../src/library/resolve.ts';
import type { ComponentManifest, ManifestComponent } from '../../src/manifest/schema.ts';
import type { NewComponentPlan } from '../../src/library/new-component-plan-schema.ts';
import type { ComponentSelection } from '../../src/library/selection-schema.ts';

/**
 * L1's own node wrapper (`src/agents/l1-resolve-plan/index.ts`) is a thin pass-through over
 * `library/resolve.ts::resolveL1` — the branch coverage for resolution/reference/scope logic
 * belongs to that module's own test. This file proves only the wrapper's wiring (it forwards
 * inputs untouched into `resolveL1` and returns its result verbatim) and its logging.
 */

function makeComponent(overrides: Partial<ManifestComponent> & Pick<ManifestComponent, 'findingId' | 'signature'>): ManifestComponent {
  return {
    instanceIndex: 0,
    instanceCount: 1,
    relatedFindingIds: [],
    sectionId: 'sec-1',
    sectionName: 'Hero',
    scope: 'content',
    productionType: 'card',
    productionLabel: 'Pricing card',
    auditClassification: 'INCORRECT',
    severity: 'HIGH',
    ds: { dsComponent: null, dsVariant: null, dsFile: null, possibleMatches: [], registryUpdateRef: null, dsCandidateNote: null },
    mismatchProperties: [],
    mismatchClass: 'cosmetic',
    tokens: [],
    fixPlan: { decision: 'fix', note: null },
    redesign: { requested: true, planned: true, applied: false, verified: false, swappedTo: null, unaddressedReason: null },
    location: { located: true, method: 'objective', stamp: null, tagName: 'div', auditBox: null, liveBox: null },
    crops: { before: null, after: null },
    auditEvidence: [],
    states: { captured: ['default'], missing: [] },
    crossRun: { sightings: [], reuse: 'single' },
    suggestion: { bucket: 'page-fix-only', rule: 'R2', confidence: 'medium', reason: 'default fixture reason' },
    ...overrides,
  };
}

function manifest(components: ManifestComponent[]): ComponentManifest {
  return {
    schemaVersion: 1,
    redesignRunId: 'run-1',
    createdAt: '2026-09-18T10:00:00.000Z',
    pageId: 'p1',
    auditAiMode: null,
    auditDsRegistryVersion: 'e'.repeat(64),
    designSystem: { path: '/fake/design-system', dsRegistryVersion: 'f'.repeat(64), changedSinceAudit: false },
    viewport: { width: 1440, height: 900 },
    scope: { contentSectionIds: ['sec-1'], excludedSectionIds: [] },
    sections: [],
    components,
    counts: { findings: components.length, located: components.length, unlocated: 0, excluded: 0, fixRequested: 0, fixApplied: 0, fixVerified: 0, byBucket: {}, otherPageFindings: 0 },
  };
}

describe('runL1 (node wrapper)', () => {
  it('forwards inputs untouched into resolveL1 and logs the ambiguous/blocked/spec/disagreement counts in one line', async () => {
    const compA = makeComponent({ findingId: 'a'.repeat(32), signature: 'sig-a', suggestion: { bucket: 'existing-correct', rule: 'R1', confidence: 'high', reason: 'looks like an existing Button' } });
    const compB = makeComponent({
      findingId: 'b'.repeat(32),
      signature: 'sig-b',
      suggestion: { bucket: 'page-fix-only', rule: 'R2', confidence: 'medium', reason: 'page fix only' },
      redesign: { requested: true, planned: true, applied: false, verified: false, swappedTo: null, unaddressedReason: null },
    });
    const compC = makeComponent({
      findingId: 'c'.repeat(32),
      signature: 'sig-c',
      suggestion: { bucket: 'page-fix-only', rule: 'R3', confidence: 'medium', reason: 'reuse as-is' },
      crops: { before: '/tmp/c-before.png', after: null },
      location: { located: true, method: 'objective', stamp: 'stamp-c', tagName: 'div', auditBox: null, liveBox: null },
    });
    const compD = makeComponent({
      findingId: 'd'.repeat(32),
      signature: 'sig-d',
      suggestion: { bucket: 'new-component', rule: 'R4', confidence: 'medium', reason: 'repeats elsewhere' },
      redesign: { requested: true, planned: true, applied: true, verified: true, swappedTo: null, unaddressedReason: null },
      crops: { before: null, after: '/tmp/d-after.png' },
      location: { located: true, method: 'objective', stamp: 'stamp-d', tagName: 'div', auditBox: null, liveBox: null },
    });
    const componentManifest = manifest([compA, compB, compC, compD]);

    const upstream: NewComponentPlan = {
      schemaVersion: 1,
      runId: 'run-1',
      updatedAt: null,
      entries: [
        { findingId: 'a'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' },
        { findingId: 'b'.repeat(32), classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' },
        { findingId: 'd'.repeat(32), classification: 'NEW_COMPONENT', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' },
      ],
    };
    // compC is reached only via the checklist (no upstream entry); compD's checklist row deliberately
    // disagrees with its upstream row ('global-shared' vs upstream's implicit 'new-component') — an ask,
    // not silent precedence, per §2.2 — while compC's own row stands uncontested.
    const checklist: ComponentSelection = {
      schemaVersion: 1,
      redesignRunId: 'run-1',
      sourceRun: { runId: 'run-1', projectName: 'proj' },
      dsRegistryVersion: 'f'.repeat(64),
      exportedAt: '2026-09-17T11:00:00.000Z',
      decidedBy: 'reviewer@example.com',
      selections: [
        { patternId: 'sig-c', findingIds: ['c'.repeat(32)], selection: 'global-shared', suggestion: null, note: null },
        { patternId: 'sig-d', findingIds: ['d'.repeat(32)], selection: 'global-shared', suggestion: null, note: null },
      ],
      manualCandidates: [],
      globalCandidates: [],
    };

    const input: L1NodeInput = { redesignRunId: 'run-1', manifest: componentManifest, upstreamPlan: upstream, checklistSelection: checklist };

    const logs: string[] = [];
    const out = await runL1({ log: (l) => logs.push(l) }, input);
    const direct = resolveL1(input.redesignRunId, input.manifest, input.upstreamPlan, input.checklistSelection);

    // Wiring: the wrapper does not re-derive anything — its result is exactly resolveL1's.
    expect(out).toEqual(direct);

    // sig-a: manifest suggests existing-correct w/ high confidence, but every upstream row asks
    // for new-component — the conflicting-signal ambiguous case (§9.1).
    expect(out.ambiguous).toEqual([{ patternId: 'sig-a', reason: expect.stringContaining('existing-correct') }]);
    // sig-b: resolves (new), but its reference is blocked — classified via upstream, not yet verified fixed.
    expect(out.blocked).toEqual([{ componentId: 'sig-b', reason: expect.stringContaining('post-fix opportunity') }]);
    // sig-c (checklist-only reuse) and sig-d (upstream new, verified-corrected reference) both resolve to specs.
    expect(out.specs.map((s) => s.patternId).sort()).toEqual(['sig-c', 'sig-d']);
    expect(out.resolvedPlan.disagreements).toEqual([{ patternId: 'sig-d', upstream: 'new-component', checklist: 'global-shared' }]);

    expect(logs).toEqual(['L1 · 2 spec(s) resolved · 1 ambiguous · 1 blocked · 1 plan disagreement(s)']);
  });

  it('with no upstream plan, no checklist and an empty manifest, resolves nothing and logs all-zero counts (default no-op log never throws)', async () => {
    const input: L1NodeInput = { redesignRunId: 'run-empty', manifest: manifest([]), upstreamPlan: null, checklistSelection: null };
    const out = await runL1({}, input); // no `log` given — must not throw
    expect(out).toEqual({ resolvedPlan: { schemaVersion: 1, redesignRunId: 'run-empty', entries: [], disagreements: [] }, specs: [], ambiguous: [], blocked: [] });

    const logs: string[] = [];
    await runL1({ log: (l) => logs.push(l) }, input);
    expect(logs).toEqual(['L1 · 0 spec(s) resolved · 0 ambiguous · 0 blocked · 0 plan disagreement(s)']);
  });
});
