import { ColourMappingSchema, type ColourMapping, type ResolvedTarget } from '../../src/resolution/schema.ts';

/** A reference colour mapping (border, exact, `--border-card`) as the Resolver records it, for tests that measure a target. */
export const colourMapping = (over: Partial<ColourMapping> = {}): ColourMapping =>
  ColourMappingSchema.parse({
    property: 'border', declaration: '1px solid var(--soft-edge)', referenceValue: 'var(--soft-edge)', referenceResolved: 'rgba(0,0,0,.08)', referenceRgba: { r: 0, g: 0, b: 0, alpha: 0.08 },
    referenceToken: '--soft-edge', referenceChain: ['--soft-edge'], role: 'border', state: 'default', theme: 'light', backdrops: ['rgb(255, 255, 255)'], backdropSource: 'measured',
    outcome: 'exact', sameName: false, nameCollision: null, dsToken: '--border-card', dsValue: 'rgba(0, 0, 0, 0.08)', dsScope: null, dsFile: 'base.css', tier: 'role', keyword: null,
    distance: { deltaE: 0, perBackdrop: [0], alphaDelta: 0, strengthRatio: 1 }, reason: 'exact', rejected: [],
    verification: { designTime: { polarityOk: true, strengthOk: true, contrastOk: null, stateDistinct: null }, rendered: { status: 'not-run', measuredBy: null, backdrop: null, strength: null, detail: null } },
    ...over,
  });

/** A resolved colour target for `border-top-color` with a `colour-visible` check (and whatever else `extraAcceptance` adds). */
export function colourTarget(findingId: string, over: Partial<ResolvedTarget> = {}, extraAcceptance: ResolvedTarget['acceptance'] = [], mappings: ColourMapping[] = [colourMapping()]): ResolvedTarget {
  const state = over.state ?? 'default';
  const value = over.target?.value ?? 'rgba(0, 0, 0, 0.08)';
  return {
    id: `t-${findingId}-${state}`, findingId, property: 'border-top-color', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state,
    audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, reason: 'missing-ds-treatment', outcome: 'resolved-target',
    target: { value, comparison: 'color-deltaE', token: '--border-card' },
    provenance: { kind: 'approved-project-pattern', ds: null, reference: { project: 'p', pattern: 'x', sourcePath: '/p', file: 'a.css', fileSha256: 'a', projectHash: 'b', classification: 'approved-project-pattern', dsGrounded: true, tokens: [], renderingEvidence: 'source-only', note: null, colours: mappings }, evidence: [] },
    decisionReason: 'test', route: 'css-edit',
    acceptance: [
      { kind: 'property-equals', property: 'border-top-color', state, viewport: 'any', comparison: 'color-deltaE', expected: value },
      { kind: 'colour-visible', property: 'border-top-color', state, viewport: 'any', comparison: 'color-deltaE', expected: 'border:1.5' },
      ...extraAcceptance,
    ],
    status: { design: 'resolved', implementation: 'applied', verification: 'not-run', implementationDetail: null, verificationDetail: null },
    ...over,
  };
}
