import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { effectiveTokenMap } from '../../src/ds/catalog.ts';
import { resolveToken } from '../../src/ds/d3-tokens/resolve.ts';
import { expectationsFor } from '../../src/ds/component-styles.ts';
import { assignmentsOf, decideMatch, dsIndex, type DsIndex } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import { deterministicEvaluations, filterFoundationViolations, matchedByIdentityOnly } from '../../src/agents/b4-compliance-auditor/index.ts';
import type { FoundationViolation } from '../../src/agents/b4-compliance-auditor/foundation-rules.ts';
import type { B3Output, DetectedComponent, DsMatch, PageSession } from '../../src/agents/types.ts';

/**
 * Precedence between a matched component's own contract and a foundation PROHIBITION (R1.2).
 * A scale rule (R1.3 / R3.5 / R3.6) only backstops a property nothing more specific covered — the matched
 * variant's exact value wins. R1.2 is different in kind: brand red is FORBIDDEN as a border or decorative
 * fill on a non-CTA element, so for an element matched only by FAMILY IDENTITY (it IS that family by type
 * and structure, whatever its styling) the variant's expectation for that colour can neither excuse it
 * nor replace its severity. An element that CONFORMS to its component is still judged by the component.
 */

let registry: DsRegistry;
let index: DsIndex;
const VIEWPORT = 1440;

beforeAll(async () => {
  registry = await loadDsRegistry(loadConfig().designSystemPath);
  index = await dsIndex(registry);
});

const violation = (over: Partial<FoundationViolation>): FoundationViolation => ({ ruleId: 'R1.2', title: 'Brand Red is for CTAs ONLY', why: 'brand red used decoratively', severity: 'CRITICAL', property: 'border-top-color', actual: 'rgb(176, 31, 36)', expected: 'a foundation or accent colour', ...over });
const mismatch = (property: string) => ({ property, actual: 'x', expected: 'y', expectedToken: null, comparison: 'exact' as const, delta: null });

describe('filterFoundationViolations — scale rules defer to the matched variant; the R1.2 prohibition may not', () => {
  const scale = violation({ ruleId: 'R3.6', property: 'border-top-left-radius', severity: 'LOW' });
  const red = violation({});

  it('by default every violation whose property the variant already resolved (pass OR mismatch) is dropped — the exact contract wins', () => {
    expect(filterFoundationViolations([scale, red], ['border-top-color'], [mismatch('border-top-left-radius')])).toEqual([]);
    expect(filterFoundationViolations([scale, red], [], [])).toEqual([scale, red]);
  });

  it('keepProhibitions keeps R1.2 — passed OR mismatched — but never a scale rule: the radius stays the variant\'s exact value', () => {
    expect(filterFoundationViolations([scale, red], ['border-top-color'], [mismatch('border-top-left-radius')], { keepProhibitions: true })).toEqual([red]);
    expect(filterFoundationViolations([scale, red], [], [mismatch('border-top-color'), mismatch('border-top-left-radius')], { keepProhibitions: true })).toEqual([red]);
  });
});

describe('matchedByIdentityOnly — only an answer that rests on family identity alone', () => {
  const answer = (basis: NonNullable<DsMatch['search']>['basis'] | null): DsMatch => ({ dsComponent: 'Badge', dsFile: 'atoms/Badge.tsx', dsVariant: null, confidence: 0.55, rationale: '', unanswered: false, confidenceOutOfContract: false, ...(basis ? { search: { family: null, basis } } : {}) });

  it('family identity and a single-component family are non-conforming matches; conformance, context and an unrecorded answer are not', () => {
    expect(matchedByIdentityOnly(answer('family-identity'))).toBe(true);
    expect(matchedByIdentityOnly(answer('single-component-family'))).toBe(true);
    for (const basis of ['class-fingerprint', 'rule-fit', 'context-slot', 'undecided'] as const) expect(matchedByIdentityOnly(answer(basis))).toBe(false);
    expect(matchedByIdentityOnly(answer(null))).toBe(false);
    expect(matchedByIdentityOnly(undefined)).toBe(false);
  });
});

describe('B4 end to end on the real Badge — decorative brand red stays reported, next to the exact-variant mismatches', () => {
  const tokens = () => effectiveTokenMap(registry, 'editorial-light');

  function badgeComponent(raw: Record<string, string>, over: Partial<DetectedComponent> = {}): DetectedComponent {
    return {
      elId: 'el-1', ref: 'e1', sectionId: 's1', sectionName: 'Test', captureState: 'default', componentType: 'badge', label: 'Phase 1', domSignals: [], visualSignals: '', instanceGroupKey: 'badge:1',
      detectionConfidence: 0.45, structural: true, confidenceOutOfContract: false,
      fingerprint: { structuralPath: 'div', role: 'generic', accessibleName: '', textPrefix: '', box: { x: 0, y: 0, width: 57, height: 28 } }, findingId: 'f1',
      style: { connected: true, raw, rootFontSizePx: 16, box: { width: 57, height: 28 } }, signature: 'sig', containsPlaceholder: false, screenshots: { element: null, context: null }, evidenceClipped: false, href: null,
      domFacts: { tag: 'div', classes: [], roleAttr: null, cursor: 'auto', text: 'Phase 1', hasSvg: false, hasImg: false, ownText: true, childElementCount: 0, style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: '', fontWeight: '', display: '', opacity: '', visibility: 'visible', textTransform: '', letterSpacing: '' }, box: { x: 0, y: 0, width: 57, height: 28 } },
      ...over,
    };
  }

  function baseline(assignment: Record<string, string>): Record<string, string> {
    const c = index.byFile.get('atoms/Badge.tsx')!;
    const raw: Record<string, string> = {};
    for (const e of expectationsFor(c.model, { ...assignmentsOf(c.model)[0], ...assignment }, { viewportWidth: VIEWPORT })) {
      const value = e.token ? resolveToken(e.token, tokens()) : e.literal;
      if (value !== null && value !== undefined) raw[e.property] = value;
    }
    return raw;
  }

  const evaluate = async (component: DetectedComponent) => {
    const session = { registry, page: { viewportSize: () => ({ width: VIEWPORT, height: 900 }) } } as unknown as PageSession; // built here: `registry` is loaded in beforeAll
    const match = decideMatch(component, index, registry, VIEWPORT);
    const input = { matched: [component], matches: new Map([[component.ref, match]]) } as unknown as B3Output;
    return { match, evaluation: (await deterministicEvaluations(session, input)).get(component.ref)! };
  };

  it('a red-bordered badge matched by family identity: R1.2 is reported AND the radius is the Badge variant\'s own value (a mismatch row, not an R3.6 rule)', async () => {
    const raw = baseline({ variant: 'rounded', size: 'sm', theme: 'neutral', bordered: 'true' });
    Object.assign(raw, { 'border-top-color': 'rgb(176, 31, 36)', 'border-top-left-radius': '6px', 'border-top-right-radius': '6px', 'border-bottom-right-radius': '6px', 'border-bottom-left-radius': '6px', 'font-size': '12px', 'padding-left': '8px', 'padding-right': '8px', 'font-weight': '400' });
    const { match, evaluation } = await evaluate(badgeComponent(raw));
    expect(match.search?.basis).toBe('family-identity');
    expect(evaluation.ruleViolations.map((v) => v.ruleId)).toEqual(['R1.2']);
    const radius = evaluation.mismatches.find((m) => m.property === 'border-top-left-radius')!;
    expect(radius.expectedToken).toBe('--radius-button');
    expect(evaluation.ruleViolations.some((v) => v.ruleId === 'R3.6')).toBe(false);
  });

  it('a badge that CONFORMS to the component (rule-fit) is judged by the component: nothing extra is reported', async () => {
    const raw = baseline({ variant: 'pill', size: 'sm', theme: 'neutral', bordered: 'true' });
    const { match, evaluation } = await evaluate(badgeComponent(raw));
    expect(['rule-fit', 'class-fingerprint']).toContain(match.search?.basis);
    expect(evaluation.ruleViolations).toEqual([]);
    expect(evaluation.mismatches).toEqual([]);
  });
});
