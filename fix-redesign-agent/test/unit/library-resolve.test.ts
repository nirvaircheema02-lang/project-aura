import { describe, expect, it } from 'vitest';
import { buildSpec, categoryFor, mergePlanSources, resolveEntry, resolveReference } from '../../src/library/resolve.ts';
import type { ComponentManifest, ManifestComponent } from '../../src/manifest/schema.ts';
import type { NewComponentPlan } from '../../src/library/new-component-plan-schema.ts';
import type { ComponentSelection } from '../../src/library/selection-schema.ts';
import type { ComponentSpec, PlanEntryOrigin } from '../../src/library/types.ts';

/**
 * resolve.ts is otherwise only exercised indirectly (mocked node functions in pipeline.test.ts) —
 * this file drives its four exported functions directly against hand-built manifest fixtures.
 */

const F1 = 'a'.repeat(32);
const F2 = 'b'.repeat(32);

function makeComponent(overrides: Partial<ManifestComponent> = {}): ManifestComponent {
  return {
    findingId: F1,
    signature: 'sig-a',
    instanceIndex: 0,
    instanceCount: 1,
    relatedFindingIds: [],
    sectionId: 'hero',
    sectionName: 'Hero',
    scope: 'content',
    productionType: 'card',
    productionLabel: 'Promo card',
    auditClassification: 'INCORRECT',
    severity: 'HIGH',
    ds: { dsComponent: null, dsVariant: null, dsFile: null, possibleMatches: [], registryUpdateRef: null, dsCandidateNote: null },
    mismatchProperties: [],
    mismatchClass: 'none',
    tokens: [],
    fixPlan: { decision: 'fix', note: null },
    redesign: { requested: false, planned: false, applied: false, verified: false, swappedTo: null, unaddressedReason: null },
    location: { located: true, method: 'objective', stamp: 'stamp-1', tagName: 'div', auditBox: null, liveBox: null },
    crops: { before: null, after: null },
    auditEvidence: [],
    states: { captured: [], missing: [] },
    crossRun: { sightings: [], reuse: 'single' },
    suggestion: { bucket: 'new-component', rule: 'R1', confidence: 'medium', reason: 'test' },
    ...overrides,
  };
}

function makeManifest(components: ManifestComponent[] = []): ComponentManifest {
  return {
    schemaVersion: 1,
    redesignRunId: 'run-1',
    createdAt: '2026-09-18T10:00:00.000Z',
    pageId: 'p1',
    auditAiMode: null,
    auditDsRegistryVersion: 'e'.repeat(64),
    designSystem: { path: '/fake/design-system', dsRegistryVersion: 'f'.repeat(64), changedSinceAudit: false },
    viewport: { width: 1440, height: 900 },
    scope: { contentSectionIds: [], excludedSectionIds: [] },
    sections: [],
    components,
    counts: { findings: components.length, located: components.length, unlocated: 0, excluded: 0, fixRequested: 0, fixApplied: 0, fixVerified: 0, byBucket: {}, otherPageFindings: 0 },
  };
}

function makeEntry(overrides: Partial<PlanEntryOrigin> = {}): PlanEntryOrigin {
  return { origin: 'checklist', patternId: 'sig-a', findingIds: [F1], classification: null, selection: null, note: null, ...overrides };
}

// ── mergePlanSources ─────────────────────────────────────────────────────────────────────────

describe('mergePlanSources', () => {
  it('upstream-only: one entry, resolved via the manifest component signature, findingIds include relatedFindingIds', () => {
    const manifest = makeManifest([makeComponent({ findingId: F1, signature: 'sig-a', relatedFindingIds: ['r1'] })]);
    const upstream: NewComponentPlan = { schemaVersion: 1, runId: 'run-1', updatedAt: null, entries: [{ findingId: F1, classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' }] };
    const result = mergePlanSources('run-1', manifest, upstream, null);
    expect(result.entries).toEqual([{ origin: 'upstream', patternId: 'sig-a', findingIds: [F1, 'r1'], classification: 'DS_CANDIDATE', selection: 'new-component', note: null }]);
    expect(result.disagreements).toEqual([]);
  });

  it('checklist-only: one entry from selections, classification null (no upstream classification to carry)', () => {
    const manifest = makeManifest([]);
    const checklist: ComponentSelection = {
      schemaVersion: 1,
      redesignRunId: 'run-1',
      sourceRun: { runId: 'run-1', projectName: 'p' },
      dsRegistryVersion: 'f'.repeat(64),
      exportedAt: '2026-09-18T10:00:00.000Z',
      decidedBy: null,
      selections: [{ patternId: 'sig-b', findingIds: [F2], selection: 'global-shared', suggestion: 'global-shared', note: 'checklist note' }],
      manualCandidates: [],
      globalCandidates: [],
    };
    const result = mergePlanSources('run-1', manifest, null, checklist);
    expect(result.entries).toEqual([{ origin: 'checklist', patternId: 'sig-b', findingIds: [F2], classification: null, selection: 'global-shared', note: 'checklist note' }]);
    expect(result.disagreements).toEqual([]);
  });

  it('both sources agreeing on the same pattern: checklist entry wins, but carries the upstream classification and its own note', () => {
    const manifest = makeManifest([makeComponent({ findingId: F1, signature: 'sig-a' })]);
    const upstream: NewComponentPlan = { schemaVersion: 1, runId: 'run-1', updatedAt: null, entries: [{ findingId: F1, classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: 'upstream note', candidateSource: 'current_state' }] };
    const checklist: ComponentSelection = {
      schemaVersion: 1,
      redesignRunId: 'run-1',
      sourceRun: { runId: 'run-1', projectName: 'p' },
      dsRegistryVersion: 'f'.repeat(64),
      exportedAt: '2026-09-18T10:00:00.000Z',
      decidedBy: null,
      selections: [{ patternId: 'sig-a', findingIds: [F1], selection: 'new-component', suggestion: 'new-component', note: 'checklist note' }],
      manualCandidates: [],
      globalCandidates: [],
    };
    const result = mergePlanSources('run-1', manifest, upstream, checklist);
    expect(result.entries).toEqual([{ origin: 'checklist', patternId: 'sig-a', findingIds: [F1], classification: 'DS_CANDIDATE', selection: 'new-component', note: 'checklist note' }]);
    expect(result.disagreements).toEqual([]);
  });

  it('both sources DISAGREEING on the same pattern: recorded in disagreements; the conflicting checklist value never overwrites — entries keeps whatever was already resolved (here, upstream\'s)', () => {
    const manifest = makeManifest([makeComponent({ findingId: F1, signature: 'sig-a' })]);
    const upstream: NewComponentPlan = { schemaVersion: 1, runId: 'run-1', updatedAt: null, entries: [{ findingId: F1, classification: 'DS_CANDIDATE', selectedAt: '2026-09-17T10:00:00.000Z', note: null, candidateSource: 'current_state' }] };
    const checklist: ComponentSelection = {
      schemaVersion: 1,
      redesignRunId: 'run-1',
      sourceRun: { runId: 'run-1', projectName: 'p' },
      dsRegistryVersion: 'f'.repeat(64),
      exportedAt: '2026-09-18T10:00:00.000Z',
      decidedBy: null,
      selections: [{ patternId: 'sig-a', findingIds: [F1], selection: 'global-shared', suggestion: null, note: null }],
      manualCandidates: [],
      globalCandidates: [],
    };
    const result = mergePlanSources('run-1', manifest, upstream, checklist);
    expect(result.disagreements).toEqual([{ patternId: 'sig-a', upstream: 'new-component', checklist: 'global-shared' }]);
    // held out of entries: the checklist's conflicting selection is never merged in — the pre-existing (upstream) entry is what remains.
    expect(result.entries).toEqual([{ origin: 'upstream', patternId: 'sig-a', findingIds: [F1], classification: 'DS_CANDIDATE', selection: 'new-component', note: null }]);
  });

  it('manual candidates get a synthetic manual:<sectionId>:<label> patternId, empty findingIds, null classification', () => {
    const manifest = makeManifest([]);
    const checklist: ComponentSelection = {
      schemaVersion: 1,
      redesignRunId: 'run-1',
      sourceRun: { runId: 'run-1', projectName: 'p' },
      dsRegistryVersion: 'f'.repeat(64),
      exportedAt: '2026-09-18T10:00:00.000Z',
      decidedBy: null,
      selections: [],
      manualCandidates: [{ sectionId: 'hero', label: 'Promo banner', selection: 'new-component', note: 'manually added' }],
      globalCandidates: [],
    };
    const result = mergePlanSources('run-1', manifest, null, checklist);
    expect(result.entries).toEqual([{ origin: 'checklist', patternId: 'manual:hero:Promo banner', findingIds: [], classification: null, selection: 'new-component', note: 'manually added' }]);
  });
});

// ── resolveEntry ─────────────────────────────────────────────────────────────────────────────

describe('resolveEntry', () => {
  it('no backing manifest component at all → new, "manually added candidate"', () => {
    const manifest = makeManifest([]);
    const entry = makeEntry({ patternId: 'manual:hero:X', findingIds: [] });
    const result = resolveEntry(entry, manifest);
    expect(result).toEqual({ resolution: 'new', reason: 'manually added candidate with no backing audit finding', updateTarget: null });
  });

  it('bucket existing-correct + human says new + high confidence → ambiguous (conflicting signals)', () => {
    const manifest = makeManifest([makeComponent({ suggestion: { bucket: 'existing-correct', rule: 'R2', confidence: 'high', reason: 'x' } })]);
    const entry = makeEntry({ selection: 'new-component' });
    const result = resolveEntry(entry, manifest);
    expect(result.resolution).toBe('ambiguous');
    expect(result.updateTarget).toBeNull();
    expect(result.reason).toMatch(/existing-correct.*high confidence/);
  });

  it('human says new (any other bucket/confidence) → new', () => {
    const manifest = makeManifest([makeComponent({ suggestion: { bucket: 'existing-needs-update', rule: 'R3', confidence: 'medium', reason: 'x' } })]);
    const entry = makeEntry({ selection: 'new-component' });
    const result = resolveEntry(entry, manifest);
    expect(result).toEqual({ resolution: 'new', reason: 'marked new-component in the selected plan', updateTarget: null });
  });

  it('bucket page-fix-only → reuse', () => {
    const manifest = makeManifest([makeComponent({ suggestion: { bucket: 'page-fix-only', rule: 'R4', confidence: 'high', reason: 'x' } })]);
    const result = resolveEntry(makeEntry(), manifest);
    expect(result.resolution).toBe('reuse');
    expect(result.updateTarget).toBeNull();
  });

  it('bucket existing-correct (human did not say new) → reuse', () => {
    const manifest = makeManifest([makeComponent({ suggestion: { bucket: 'existing-correct', rule: 'R2', confidence: 'high', reason: 'x' } })]);
    const result = resolveEntry(makeEntry(), manifest);
    expect(result.resolution).toBe('reuse');
  });

  it('bucket existing-needs-update → update, with updateTarget populated from ds.dsFile/ds.dsComponent', () => {
    const manifest = makeManifest([makeComponent({ suggestion: { bucket: 'existing-needs-update', rule: 'R5', confidence: 'medium', reason: 'x' }, ds: { dsComponent: 'Card', dsVariant: null, dsFile: 'molecules/Card.tsx', possibleMatches: [], registryUpdateRef: null, dsCandidateNote: null } })]);
    const result = resolveEntry(makeEntry(), manifest);
    expect(result.resolution).toBe('update');
    expect(result.updateTarget).toEqual({ dsFile: 'molecules/Card.tsx', dsComponent: 'Card' });
  });

  it('bucket existing-needs-update but ds.dsFile/dsComponent missing → update with null updateTarget', () => {
    const manifest = makeManifest([makeComponent({ suggestion: { bucket: 'existing-needs-update', rule: 'R5', confidence: 'medium', reason: 'x' } })]); // ds fields default null
    const result = resolveEntry(makeEntry(), manifest);
    expect(result.resolution).toBe('update');
    expect(result.updateTarget).toBeNull();
  });

  it('bucket new-component → new', () => {
    const manifest = makeManifest([makeComponent({ suggestion: { bucket: 'new-component', rule: 'R6', confidence: 'low', reason: 'x' } })]);
    const result = resolveEntry(makeEntry(), manifest);
    expect(result.resolution).toBe('new');
  });

  it('anything else (unresolved) → ambiguous', () => {
    const manifest = makeManifest([makeComponent({ suggestion: { bucket: 'unresolved', rule: 'R8', confidence: 'low', reason: 'x' } })]);
    const result = resolveEntry(makeEntry(), manifest);
    expect(result.resolution).toBe('ambiguous');
    expect(result.reason).toMatch(/unresolved/);
  });
});

// ── resolveReference ─────────────────────────────────────────────────────────────────────────

describe('resolveReference', () => {
  it('no backing component → live-capture with empty stamp/cropPath', () => {
    const manifest = makeManifest([]);
    const result = resolveReference(makeEntry({ findingIds: [] }), manifest);
    expect(result).toEqual({ source: 'live-capture', priorRunId: null, elementStamp: '', cropPath: null });
  });

  it('verified-corrected-this-run takes priority over live-capture when applied+verified+crop exist', () => {
    const manifest = makeManifest([makeComponent({ redesign: { requested: true, planned: true, applied: true, verified: true, swappedTo: null, unaddressedReason: null }, crops: { before: 'before.png', after: 'after.png' }, location: { located: true, method: 'objective', stamp: 'stamp-x', tagName: 'div', auditBox: null, liveBox: null } })]);
    // origin 'checklist' (not 'upstream') so postFix is false regardless of classification — isolates the priority behaviour from the blocked branch.
    const entry = makeEntry({ origin: 'checklist', classification: 'DS_CANDIDATE' });
    const result = resolveReference(entry, manifest);
    expect(result).toEqual({ source: 'verified-corrected-this-run', priorRunId: null, elementStamp: 'stamp-x', cropPath: 'after.png' });
  });

  it('falls back to live-capture (before crop preferred) when not applied/verified', () => {
    const manifest = makeManifest([makeComponent({ redesign: { requested: false, planned: false, applied: false, verified: false, swappedTo: null, unaddressedReason: null }, crops: { before: 'before.png', after: null } })]);
    const result = resolveReference(makeEntry({ origin: 'checklist' }), manifest);
    expect(result).toEqual({ source: 'live-capture', priorRunId: null, elementStamp: 'stamp-1', cropPath: 'before.png' });
  });

  it('a post_fix candidate (origin upstream + classification set) whose related finding is not verified fixed yet → blocked', () => {
    const manifest = makeManifest([makeComponent({ findingId: F1, redesign: { requested: true, planned: true, applied: false, verified: false, swappedTo: null, unaddressedReason: null } })]);
    const entry = makeEntry({ origin: 'upstream', classification: 'DS_CANDIDATE', findingIds: [F1] });
    const result = resolveReference(entry, manifest);
    expect(result).toEqual({ blocked: `this candidate depends on a post-fix opportunity (${F1}) that has not been verified fixed in this run — reference unavailable until it is` });
  });
});

// ── categoryFor ──────────────────────────────────────────────────────────────────────────────

describe('categoryFor', () => {
  it('maps a representative sample of productionType → category', () => {
    expect(categoryFor('button')).toBe('atoms');
    expect(categoryFor('input')).toBe('atoms');
    expect(categoryFor('card')).toBe('molecules');
    expect(categoryFor('tabs')).toBe('molecules');
    expect(categoryFor('navbar')).toBe('organisms');
    expect(categoryFor('modal')).toBe('organisms');
  });

  it('falls back to molecules for an unknown production type', () => {
    expect(categoryFor('some-totally-unmapped-type')).toBe('molecules');
  });
});

// ── buildSpec ────────────────────────────────────────────────────────────────────────────────

/** `buildSpec` can now refuse (§security: an unsafe path-derived write-set is `{blocked}`, never built) — every case here is a legitimate input that must NOT be refused. */
function expectSpec(result: ReturnType<typeof buildSpec>): ComponentSpec {
  if ('blocked' in result) throw new Error(`expected a built spec, got blocked: ${result.blocked}`);
  return result;
}

describe('buildSpec', () => {
  it('writeSet for `update` targets only the existing dsFile', () => {
    const manifest = makeManifest([makeComponent({ productionType: 'card' })]);
    const entry = makeEntry({ patternId: 'sig-a' });
    const resolved = { resolution: 'update' as const, reason: 'x', updateTarget: { dsFile: 'molecules/Card.tsx', dsComponent: 'Card' } };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    const spec = expectSpec(buildSpec(entry, resolved, reference, manifest, 0));
    expect(spec.writeSet).toEqual(['core-v2/src/molecules/Card.tsx']);
  });

  it('writeSet for `new`/`reuse` is the new component + stories files, named from productionType', () => {
    const manifest = makeManifest([makeComponent({ productionType: 'card' })]);
    const entry = makeEntry({ patternId: 'sig-a' });
    const resolved = { resolution: 'new' as const, reason: 'x', updateTarget: null };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    const spec = expectSpec(buildSpec(entry, resolved, reference, manifest, 0));
    expect(spec.name).toBe('Card');
    expect(spec.category).toBe('molecules');
    expect(spec.writeSet).toEqual(['core-v2/src/molecules/Card.tsx', 'core-v2/src/molecules/Card.stories.tsx']);
  });

  it('scopeEvidenceMissing true only when global-shared is selected with no cross-run sightings and scope is not excluded', () => {
    const manifest = makeManifest([makeComponent({ scope: 'content', crossRun: { sightings: [], reuse: 'single' } })]);
    const entry = makeEntry({ selection: 'global-shared' });
    const resolved = { resolution: 'new' as const, reason: 'x', updateTarget: null };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    expect(expectSpec(buildSpec(entry, resolved, reference, manifest, 0)).scopeEvidenceMissing).toBe(true);
  });

  it('scopeEvidenceMissing false when cross-run sightings exist', () => {
    const manifest = makeManifest([makeComponent({ scope: 'content', crossRun: { sightings: [{ runId: 'r2', displayName: 'Other', url: 'https://x', findingIds: [], basis: 'ds-match', score: 0.9 }], reuse: 'single' } })]);
    const entry = makeEntry({ selection: 'global-shared' });
    const resolved = { resolution: 'new' as const, reason: 'x', updateTarget: null };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    expect(expectSpec(buildSpec(entry, resolved, reference, manifest, 0)).scopeEvidenceMissing).toBe(false);
  });

  it('scopeEvidenceMissing false when component scope is already "excluded" (header/footer)', () => {
    const manifest = makeManifest([makeComponent({ scope: 'excluded', crossRun: { sightings: [], reuse: 'single' } })]);
    const entry = makeEntry({ selection: 'global-shared' });
    const resolved = { resolution: 'new' as const, reason: 'x', updateTarget: null };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    expect(expectSpec(buildSpec(entry, resolved, reference, manifest, 0)).scopeEvidenceMissing).toBe(false);
  });

  it('scopeEvidenceMissing false when the selection is not global-shared', () => {
    const manifest = makeManifest([makeComponent({ scope: 'content', crossRun: { sightings: [], reuse: 'single' } })]);
    const entry = makeEntry({ selection: 'new-component' });
    const resolved = { resolution: 'new' as const, reason: 'x', updateTarget: null };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    expect(expectSpec(buildSpec(entry, resolved, reference, manifest, 0)).scopeEvidenceMissing).toBe(false);
  });

  it('§security: a productionType containing path-traversal segments never escapes core-v2/src/<category>/ — the component name is built ONLY from alnum runs', () => {
    const manifest = makeManifest([makeComponent({ productionType: '../../../etc/passwd', scope: 'content' })]);
    const entry = makeEntry({ patternId: 'sig-evil' });
    const resolved = { resolution: 'new' as const, reason: 'x', updateTarget: null };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    const spec = expectSpec(buildSpec(entry, resolved, reference, manifest, 0));
    expect(spec.name).toMatch(/^[a-zA-Z0-9]+$/);
    for (const p of spec.writeSet) {
      expect(p.startsWith('core-v2/src/')).toBe(true);
      expect(p).not.toContain('..');
    }
  });

  it('§regression: scope evidence is aggregated across EVERY instance sharing a pattern, not just the first (components[0]) — a later instance recorded scope:"excluded" still makes the pattern global', () => {
    const manifest = makeManifest([
      makeComponent({ findingId: 'a'.repeat(32), signature: 'shared-sig', scope: 'content' }), // representative instance — NOT excluded
      makeComponent({ findingId: 'b'.repeat(32), signature: 'shared-sig', scope: 'excluded' }), // a LATER instance IS excluded (header/footer)
    ]);
    const entry = makeEntry({ patternId: 'shared-sig', findingIds: ['a'.repeat(32), 'b'.repeat(32)] });
    const resolved = { resolution: 'new' as const, reason: 'x', updateTarget: null };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    const spec = expectSpec(buildSpec(entry, resolved, reference, manifest, 0));
    expect(spec.scope).toBe('global');
  });

  it('§regression: cross-run sightings on a NON-representative instance still count as scope evidence (scopeEvidenceMissing stays false)', () => {
    const manifest = makeManifest([
      makeComponent({ findingId: 'a'.repeat(32), signature: 'shared-sig', scope: 'content', crossRun: { sightings: [], reuse: 'single' } }),
      makeComponent({ findingId: 'b'.repeat(32), signature: 'shared-sig', scope: 'content', crossRun: { sightings: [{ runId: 'r2', displayName: 'Other', url: 'https://x', findingIds: [], basis: 'ds-match', score: 0.9 }], reuse: 'multi-page' } }),
    ]);
    const entry = makeEntry({ patternId: 'shared-sig', findingIds: ['a'.repeat(32), 'b'.repeat(32)], selection: 'global-shared' });
    const resolved = { resolution: 'new' as const, reason: 'x', updateTarget: null };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    const spec = expectSpec(buildSpec(entry, resolved, reference, manifest, 0));
    expect(spec.scopeEvidenceMissing).toBe(false);
    expect(spec.scope).toBe('multi-page');
  });

  it('§security: an unsafe updateTarget.dsFile (path traversal in the audit-recorded DS match) is BLOCKED, never built against', () => {
    const manifest = makeManifest([makeComponent({ productionType: 'card' })]);
    const entry = makeEntry({ patternId: 'sig-a' });
    const resolved = { resolution: 'update' as const, reason: 'x', updateTarget: { dsFile: '../../outside/Evil.tsx', dsComponent: 'Evil' } };
    const reference = { source: 'live-capture' as const, priorRunId: null, elementStamp: '', cropPath: null };
    const result = buildSpec(entry, resolved, reference, manifest, 0);
    expect('blocked' in result).toBe(true);
  });
});
