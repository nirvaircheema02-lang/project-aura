import { describe, expect, it } from 'vitest';
import {
  ComponentManifestSchema,
  CrossRunSightingSchema,
  LIBRARY_BUCKETS,
  ManifestComponentSchema,
  ManifestSectionSchema,
  SuggestionSchema,
  type ManifestComponent,
  type ManifestSection,
} from '../../src/manifest/schema.ts';

/**
 * Round-trip validation for R6's manifest contract (ARCHITECTURE.md §8.6, §13) — a minimal
 * valid object of each shape parses unchanged; a missing required field is rejected with a
 * zod issue whose `path` names it (never a bare "invalid").
 */

function validComponent(overrides: Partial<ManifestComponent> = {}): ManifestComponent {
  return {
    findingId: 'a'.repeat(32),
    signature: 'sig-button-1',
    instanceIndex: null,
    instanceCount: 1,
    relatedFindingIds: [],
    sectionId: 'hero',
    sectionName: 'Hero',
    scope: 'content',
    productionType: 'button',
    productionLabel: 'Sign up',
    auditClassification: 'INCORRECT',
    severity: 'HIGH',
    ds: {
      dsComponent: 'Button',
      dsVariant: 'primary · md · light',
      dsFile: 'core-v2/src/atoms/Button.tsx',
      possibleMatches: [],
      registryUpdateRef: null,
      dsCandidateNote: null,
    },
    mismatchProperties: ['padding-left'],
    mismatchClass: 'cosmetic',
    tokens: [],
    fixPlan: { decision: 'fix', note: null },
    redesign: { requested: true, planned: true, applied: true, verified: true, swappedTo: null, unaddressedReason: null },
    location: { located: true, method: 'objective', stamp: 'e1', tagName: 'button', auditBox: { x: 0, y: 0, width: 10, height: 10 }, liveBox: null },
    crops: { before: null, after: null },
    auditEvidence: [],
    states: { captured: ['default'], missing: ['hover'] },
    crossRun: { sightings: [], reuse: 'single' },
    suggestion: { bucket: 'page-fix-only', rule: 'R3', confidence: 'high', reason: 'verified fixed' },
    ...overrides,
  };
}

function validSection(overrides: Partial<ManifestSection> = {}): ManifestSection {
  return {
    sectionId: 'hero',
    name: 'Hero',
    scope: 'content',
    excludedReason: null,
    order: 0,
    wrapper: { located: true, stamp: 'hero', tagName: 'section' },
    memberFindingIds: ['a'.repeat(32)],
    bucketCounts: { 'page-fix-only': 1 },
    ...overrides,
  };
}

function validManifest() {
  return {
    schemaVersion: 1 as const,
    redesignRunId: 'page-audit-redesign-test',
    createdAt: '2026-09-18T10:00:00.000Z',
    pageId: 'p1',
    auditAiMode: null,
    auditDsRegistryVersion: 'e'.repeat(64),
    designSystem: { path: '/fake/design-system', dsRegistryVersion: 'f'.repeat(64), changedSinceAudit: false },
    viewport: { width: 1440, height: 900 },
    scope: { contentSectionIds: ['hero'], excludedSectionIds: [] },
    sections: [validSection()],
    components: [validComponent()],
    counts: { findings: 1, located: 1, unlocated: 0, excluded: 0, fixRequested: 1, fixApplied: 1, fixVerified: 1, byBucket: { 'page-fix-only': 1 }, otherPageFindings: 0 },
  };
}

function pathOf(result: { success: false; error: { issues: Array<{ path: PropertyKey[] }> } }): string[] {
  return result.error.issues.map((i) => i.path.join('.'));
}

describe('ComponentManifestSchema', () => {
  it('parses a minimal valid manifest unchanged', () => {
    const manifest = validManifest();
    const parsed = ComponentManifestSchema.parse(manifest);
    expect(parsed).toEqual(manifest);
  });

  it('rejects a missing top-level required field, naming its path', () => {
    const manifest = validManifest() as Record<string, unknown>;
    delete manifest.schemaVersion;
    const result = ComponentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('schemaVersion');
  });

  it('rejects schemaVersion !== 1 (literal)', () => {
    const manifest = { ...validManifest(), schemaVersion: 2 };
    const result = ComponentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('schemaVersion');
  });

  it('rejects a missing nested required field inside components[]', () => {
    const manifest = validManifest();
    const component = manifest.components[0] as Record<string, unknown>;
    delete component.ds;
    const result = ComponentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result).some((p) => p.startsWith('components.0.ds'))).toBe(true);
  });

  it('rejects an unknown component scope enum value', () => {
    const manifest = validManifest();
    (manifest.components[0] as Record<string, unknown>).scope = 'global'; // real values are content|excluded|unselected
    const result = ComponentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('components.0.scope');
  });
});

describe('ManifestComponentSchema', () => {
  it('parses a minimal valid component unchanged', () => {
    const component = validComponent();
    expect(ManifestComponentSchema.parse(component)).toEqual(component);
  });

  it('rejects a missing required field with its path named', () => {
    const component = validComponent() as Record<string, unknown>;
    delete component.findingId;
    const result = ManifestComponentSchema.safeParse(component);
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('findingId');
  });

  it('rejects a bad mismatchClass enum value', () => {
    const component = { ...validComponent(), mismatchClass: 'severe' };
    const result = ManifestComponentSchema.safeParse(component);
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('mismatchClass');
  });
});

describe('ManifestSectionSchema', () => {
  it('parses a minimal valid section unchanged', () => {
    const section = validSection();
    expect(ManifestSectionSchema.parse(section)).toEqual(section);
  });

  it('rejects a missing required field (bucketCounts), naming its path', () => {
    const section = validSection() as Record<string, unknown>;
    delete section.bucketCounts;
    const result = ManifestSectionSchema.safeParse(section);
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('bucketCounts');
  });
});

describe('SuggestionSchema', () => {
  it('accepts every declared LIBRARY_BUCKETS value', () => {
    for (const bucket of LIBRARY_BUCKETS) {
      const suggestion = { bucket, rule: 'R1', confidence: 'high' as const, reason: 'x' };
      expect(SuggestionSchema.parse(suggestion)).toEqual(suggestion);
    }
  });

  it('rejects a bucket value outside LIBRARY_BUCKETS, naming the path', () => {
    const result = SuggestionSchema.safeParse({ bucket: 'not-a-real-bucket', rule: 'R1', confidence: 'high', reason: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('bucket');
  });

  it('rejects a missing rule id, naming the path', () => {
    const result = SuggestionSchema.safeParse({ bucket: 'unresolved', confidence: 'low', reason: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('rule');
  });
});

describe('CrossRunSightingSchema', () => {
  const valid = { runId: 'run-b', displayName: 'run-b', url: 'https://example.com/page', findingIds: ['a'.repeat(32)], basis: 'ds-match' as const, score: 1 };

  it('parses a minimal valid sighting unchanged', () => {
    expect(CrossRunSightingSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a missing required field (basis), naming the path', () => {
    const { basis: _basis, ...rest } = valid;
    const result = CrossRunSightingSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('basis');
  });

  it('rejects a basis value outside CROSS_RUN_BASIS, naming the path', () => {
    const result = CrossRunSightingSchema.safeParse({ ...valid, basis: 'vibes' });
    expect(result.success).toBe(false);
    if (!result.success) expect(pathOf(result)).toContain('basis');
  });
});
