import type { AuditProperty, Finding } from '../../src/audit-link/index.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import type { ResolutionDecision } from '../../src/resolution/judgment-schema.ts';
import type { ReferenceHooks } from '../../src/resolution/resolve.ts';
import type { ReferenceProvenance, ResolvedTarget } from '../../src/resolution/schema.ts';
import { makeFinding } from './fixture-audit-run.ts';

/** Shared builders for the Resolver tests that drive `resolveTargets` with a stub `ReferenceHooks` (so the test, not a registry, decides what a hook returns). */

export const RUN = { runId: 'r', projectName: 'p', dataJsonSha256: 'd', fixPlanSha256: 'f' };
export const now = () => new Date('2026-10-09T10:00:00Z');

export const prop = (over: Partial<AuditProperty> = {}): AuditProperty => ({ property: 'border-top-color', actual: 'rgb(204, 204, 204)', expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: 'Observed value; no verified DS requirement for this property/part.', ...over });

/** A selected NEEDS_REVIEW finding of the given production type (a residual design question). */
export function residual(id: string, productionType = 'card', properties: AuditProperty[] = [prop()], signals: string[] = []): Finding {
  const f = makeFinding({ findingId: id, classification: 'NEEDS_REVIEW', mismatches: [] });
  f.comparison.properties = properties;
  f.component = { ...f.component, productionType, productionLabel: 'Plan card', dsComponent: null, dsVariant: null };
  f.review = { status: 'NEEDS_REVIEW', reason: 'a card that needs a subtle border', node: 'B6', signals, possibleMatches: [{ dsComponent: 'ResourceCard', dsFile: 'atoms/ResourceCard.tsx', dsVariant: null, score: 0.2, why: 'x' }], observed: [] };
  return f;
}

export function entryFor(element: string, findingId: string, tagName = 'div'): MappingEntry {
  return {
    element, stamp: element, findingIds: [findingId], signature: null, instanceIndex: null, instanceCount: null, sectionId: 'main', scope: 'content',
    resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 }, candidatesConsidered: 1 },
    drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
    affordances: { tagName, role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
    dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
  };
}

export const decision = (over: Partial<ResolutionDecision> = {}): ResolutionDecision => ({ findingId: 'f-card', property: 'border-top-color', part: 'self', state: 'default', outcome: 'resolved-target', value: 'var(--border-soft)', source: 'approved-project-pattern', dsToken: null, reference: { project: 'competition-benchmarking-v2-react', patternId: 'near' }, reason: 'the card needs a subtle hairline separation', unresolvedReason: null, ...over });

export const baseProvenance = (over: Partial<ReferenceProvenance> = {}): ReferenceProvenance => ({
  project: 'competition-benchmarking-v2-react', pattern: 'near', sourcePath: '/ref/competition-benchmarking-v2-react', file: 'src/globals.css', fileSha256: 'a'.repeat(64), projectHash: 'b'.repeat(64),
  classification: 'approved-project-pattern', dsGrounded: true, tokens: [], renderingEvidence: 'source-only', note: null, colours: [], ...over,
});

export const stub = (applied: Record<string, string>, over: Partial<Awaited<ReturnType<ReferenceHooks['verify']>>> = {}): ReferenceHooks => ({
  registry: { version: 't', sha256: 's', approvedProjects: ['competition-benchmarking-v2-react'] },
  // a claim can only name a candidate that was offered for the finding, so the double offers the one the decisions name
  find: () => [{ project: 'competition-benchmarking-v2-react', pattern: 'near', purpose: 'light card separation', declarations: {}, preferred: true, elementKinds: ['card'] }],
  verify: async () => ({ ok: true, applied, classification: 'approved-project-pattern', provenance: baseProvenance(), reasons: [], ...over }),
});

export const targetFor = (targets: ResolvedTarget[], property: string, state: ResolvedTarget['state'] = 'default'): ResolvedTarget => targets.find((t) => t.property === property && t.state === state)!;
