import { FIDELITY_SCHEMA_VERSION, type CapturedElement, type DesignBaseline, type DesignCapture, type SectionDesign, type StateCapture, type StickyTrace, type StyleRecord } from '../../src/fidelity/types.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';

/** Hand-built DesignCapture literals: the comparison and the preserve evaluation are pure, so they are tested without a browser. */

export const el = (key: string, over: Partial<CapturedElement> = {}): CapturedElement => ({
  key, tag: key === '' ? 'section' : 'a', label: key || 'root', textHash: `t${key}`, stamp: null, findingIds: [], roles: [], flags: {}, style: { color: 'rgb(0, 0, 0)', 'font-size': '16px' },
  hAlign: 'none', tAlign: 'none', widthRatio: 0, states: {}, ...over,
});

export const sec = (over: Partial<SectionDesign> = {}): SectionDesign => ({
  sectionId: 's', viewport: 'desktop', located: true, elements: [el(''), el('0', { roles: ['interactive'] })], groups: [], sticky: [], capped: null,
  coverage: { hover: { attempted: 0, captured: 0 }, focusVisible: { attempted: 0, captured: 0 } }, notes: [], ...over,
});

export const cap = (sections: SectionDesign[]): DesignCapture => ({
  schemaVersion: FIDELITY_SCHEMA_VERSION, capturedAt: 't', source: { kind: 'pre-edit-snapshot', htmlSha256: 'h', url: null },
  viewports: [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }], limits: { maxElements: 160, maxHoverTargets: 20, maxFocusTargets: 16, maxDescendants: 24 }, statesNotCaptured: [], sections,
});

export const base = (sections: SectionDesign[]): DesignBaseline => ({ ...cap(sections), baselineSha256: 'b'.repeat(64) });

/** A sticky trace of five section-relative positions; `reach[i]` says whether position i could be scrolled to, `tops[i]` where the element sat. */
export const sticky = (reach: boolean[] = [true, true, true, true, true], tops: number[] = [200, 24, 24, 24, -300], key = '0'): StickyTrace => ({
  key, top: '24px', positions: reach.map((reachable, i) => ({ requestedScroll: i * 500, actualScroll: reachable ? i * 500 : 0, reachable, rectTop: reachable ? (tops[i] ?? 0) : null })),
});

export const hoverState = (style: StyleRecord, effect = true): StateCapture => ({ subtree: { '': style }, effect });

export function target(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    id: 't1', findingId: 'F1', property: 'color', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
    audit: { status: 'UNRESOLVED', actual: 'rgb(0, 0, 0)', expected: null, expectedToken: null, note: null, source: null }, reason: 'no-ds-requirement', outcome: 'preserve-existing',
    target: null, provenance: { kind: 'original-baseline', ds: null, reference: null, evidence: [] }, decisionReason: 'the DS states no requirement', route: 'none', acceptance: [],
    status: { design: 'preserved', implementation: 'not-applicable', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
  };
}

export const resolutionOf = (...targets: ResolvedTarget[]): ResolutionFile => ({
  schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [],
});
