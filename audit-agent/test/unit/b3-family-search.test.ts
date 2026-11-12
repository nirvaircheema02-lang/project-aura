import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { effectiveTokenMap } from '../../src/ds/catalog.ts';
import { resolveToken } from '../../src/ds/d3-tokens/resolve.ts';
import { expectationsFor } from '../../src/ds/component-styles.ts';
import { assignmentsOf, decideMatch, dsIndex, familyOf, isInFamily, type DsIndex } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import { routesToNewComponentEvaluator } from '../../src/skills/s8-confidence-escalation-policy.ts';
import type { DetectedComponent } from '../../src/agents/types.ts';

/**
 * B3's family search — the rule that an element is only "no existing Design System family" after the
 * WHOLE family was tried, and that an existing family with wrong styling is an existing component with
 * deviations, never a new one:
 *   Recovered ≠ New Component · Existing DS family + wrong styling ≠ New Component ·
 *   Existing DS family + uncertain exact variant ≠ automatically B6.
 * Exercised on `decideMatch` against the REAL Design System (no browser): every fixture is built from a
 * real component's own expected values, then deliberately made wrong.
 */

let registry: DsRegistry;
let index: DsIndex;
let tokens: Map<string, string>;
const VIEWPORT = 1440;

beforeAll(async () => {
  registry = await loadDsRegistry(loadConfig().designSystemPath);
  index = await dsIndex(registry);
  tokens = effectiveTokenMap(registry, 'editorial-light');
});

/** The resolved CSS values the DS source declares for one variant — a genuine baseline to break, never a hand-guessed one. */
function realExpectedRaw(file: string, assignment: Record<string, string>): Record<string, string> {
  const c = index.byFile.get(file);
  if (!c) throw new Error(`no such DS component indexed: ${file}`);
  const full = { ...assignmentsOf(c.model)[0], ...assignment };
  const raw: Record<string, string> = {};
  for (const e of expectationsFor(c.model, full, { viewportWidth: VIEWPORT })) {
    const value = e.token ? resolveToken(e.token, tokens) : e.literal;
    if (value !== null && value !== undefined) raw[e.property] = value;
  }
  return raw;
}

/** A badge's measured style with its radius, colours, type and padding all off — wrong styling on an element that is evidently a badge. */
function wrongBadgeRaw(overrides: Record<string, string> = {}): Record<string, string> {
  const raw = realExpectedRaw('atoms/Badge.tsx', { variant: 'rounded', size: 'sm', theme: 'neutral', bordered: 'true' });
  Object.assign(raw, {
    'border-top-left-radius': '6px', 'border-top-right-radius': '6px', 'border-bottom-right-radius': '6px', 'border-bottom-left-radius': '6px',
    'font-size': '12px', 'letter-spacing': 'normal', 'text-transform': 'none', 'font-weight': '400',
    'padding-top': '4px', 'padding-bottom': '4px', 'padding-left': '8px', 'padding-right': '8px',
    ...overrides,
  });
  return raw;
}

let seq = 0;
function component(over: { componentType: string; tag?: string; raw: Record<string, string>; detectionConfidence?: number; structural?: boolean; classes?: string[]; box?: { width: number; height: number } }): DetectedComponent {
  seq += 1;
  const box = over.box ?? { width: 57, height: 28 };
  return {
    elId: `el-${seq}`, ref: `e${seq}`, sectionId: 'sec-1', sectionName: 'Test', captureState: 'default',
    componentType: over.componentType, label: `fixture ${seq}`, domSignals: [], visualSignals: '', instanceGroupKey: `${over.componentType}:${seq}`,
    detectionConfidence: over.detectionConfidence ?? 0.45, ...(over.structural ? { structural: true } : {}), confidenceOutOfContract: false,
    fingerprint: { structuralPath: `div:nth-of-type(${seq})`, role: 'generic', accessibleName: '', textPrefix: '', box: { x: 0, y: 0, ...box } },
    findingId: `finding-${seq}`,
    style: { connected: true, raw: over.raw, rootFontSizePx: 16, box },
    signature: `sig-${seq}`, containsPlaceholder: false, screenshots: { element: null, context: null }, evidenceClipped: false, href: null,
    domFacts: {
      tag: over.tag ?? 'div', classes: over.classes ?? [], roleAttr: null, cursor: 'auto', text: 'Phase 1', hasSvg: false, hasImg: false, ownText: true, childElementCount: 0,
      style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: '', fontWeight: '', display: '', opacity: '', visibility: 'visible', textTransform: '', letterSpacing: '' },
      box: { x: 0, y: 0, ...box },
    },
  };
}

describe('the family the DS names for a type — and the rest of it', () => {
  it('a badge-like type is the R4.6 Badge System: Badge first, then every Badge/Tag/Chip/Pill/Label/Status component of the DS', () => {
    const family = familyOf('badge', index)!;
    expect(family.ruleId).toBe('R4.6');
    expect(family.files).toEqual(['atoms/Badge.tsx']);
    // the rest of the family, found by name — whole words, and only atoms / molecules / ui
    expect(family.deep).toEqual(expect.arrayContaining(['atoms/FilterChip.tsx', 'atoms/StatBadge.tsx', 'atoms/IconBadge.tsx', 'atoms/SectionLabel.tsx', 'atoms/StatusDot.tsx', 'molecules/IndustryBadge.tsx', 'molecules/CompletionBadge.tsx']));
    expect(family.deep).not.toContain('atoms/Badge.tsx');
    expect(family.deep).not.toContain('organisms/ValuePillarsSection.tsx'); // "Pillars" is not a pill
    // tag and chip are the same family
    expect(familyOf('tag', index)?.deep).toEqual(family.deep);
    expect(familyOf('chip', index)?.ruleId).toBe('R4.9');
  });

  it('a card is the R4.3/R4.4 Card System: the rule\'s three files, then the other cards R4.4 lists', () => {
    const family = familyOf('card', index)!;
    expect(family.ruleId).toBe('R4.3');
    expect(family.files).toEqual(['atoms/Card.tsx', 'molecules/ReportCard.tsx', 'atoms/ResourceCard.tsx']);
    expect(family.deep).toEqual(expect.arrayContaining(['molecules/StatCard.tsx', 'molecules/SurveyCard.tsx', 'molecules/DataHighlightCard.tsx']));
    expect(isInFamily(family, 'molecules/StatCard.tsx')).toBe(true);
    expect(isInFamily(family, 'atoms/Button.tsx')).toBe(false);
  });

  it('a type the DS names no family for has none — B6 has no existing component to hand such an element to', () => {
    expect(familyOf('tabs', index)).toBeNull();
    expect(familyOf('paragraph', index)).toBeNull();
  });
});

describe('Recovered ≠ New Component: an existing family with wrong styling is an existing-component deviation', () => {
  it('a bordered, filled text leaf — LOW confidence, but STRUCTURAL — maps to the Badge family; its wrong radius, type and padding are for B4, not a reason for B6', () => {
    const c = component({ componentType: 'badge', structural: true, raw: wrongBadgeRaw() });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Badge');
    expect(m.dsFile).toBe('atoms/Badge.tsx');
    expect(m.search?.basis).toBe('family-identity');
    expect(m.search?.family).toMatchObject({ ruleId: 'R4.6', files: ['atoms/Badge.tsx'] });
    expect(m.rationale).toContain('identity is decided before compliance');
    expect(m.rationale).toContain('not as a different or new component');
    expect(m.assignments?.length).toBeGreaterThan(0); // the closest variant(s) B4 audits against
    expect(routesToNewComponentEvaluator(m)).toBe(false); // matched → B4, never B6
  });

  it('the SAME element without structural evidence (a role-less guess at LOW confidence) is not claimed — a doubtful TYPE never claims a family — but the search is on record', () => {
    const c = component({ componentType: 'badge', raw: wrongBadgeRaw() });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBeNull();
    expect(m.search?.basis).toBe('undecided');
    expect(m.search?.undecidedBecause).toBe('type-not-trusted'); // not "the family cannot represent it" — the TYPE was too weak to claim the family
    expect(m.search?.family?.ruleId).toBe('R4.6'); // the family WAS searched; the type was too weak to claim it
    expect(m.possibleMatches?.[0]?.dsComponent).toBe('Badge'); // …and a reviewer sees the closest candidate
    expect(routesToNewComponentEvaluator(m)).toBe(true);
  });

  it('the same wrongly-styled badge at normal detection confidence maps the same way — structural evidence is a second route to the same family, not a different decision', () => {
    const viaConfidence = decideMatch(component({ componentType: 'badge', detectionConfidence: 0.6, raw: wrongBadgeRaw() }), index, registry, VIEWPORT);
    const viaStructure = decideMatch(component({ componentType: 'badge', structural: true, raw: wrongBadgeRaw() }), index, registry, VIEWPORT);
    expect(viaConfidence.dsFile).toBe('atoms/Badge.tsx');
    expect(viaStructure.dsFile).toBe(viaConfidence.dsFile);
    expect(viaStructure.dsVariant).toBe(viaConfidence.dsVariant);
  });

  it('a Badge built exactly to a DS variant is a confident rule-fit match, not merely an identity claim — conformance and identity are different bases', () => {
    const raw = realExpectedRaw('atoms/Badge.tsx', { variant: 'pill', size: 'sm', theme: 'neutral', bordered: 'true' });
    const m = decideMatch(component({ componentType: 'badge', structural: true, raw }), index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Badge');
    expect(m.search?.basis).toBe('rule-fit');
    expect(m.dsVariant).toMatch(/pill · sm · neutral/);
  });

  it('a surfaced repeated block (a card) maps to the Card family exactly as a clickable card does — the closest existing variant, the rest reported as deviations', () => {
    const raw = realExpectedRaw('atoms/Card.tsx', { variant: 'outlined', padding: 'md', shadow: 'none' });
    Object.assign(raw, { 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px', 'border-top-color': 'rgb(221, 221, 221)' });
    const recovered = decideMatch(component({ componentType: 'card', structural: true, raw, box: { width: 320, height: 200 } }), index, registry, VIEWPORT);
    const clickable = decideMatch(component({ componentType: 'card', detectionConfidence: 0.6, raw, box: { width: 320, height: 200 } }), index, registry, VIEWPORT);
    expect(recovered.dsComponent).toBe('Card');
    expect(clickable.dsComponent).toBe('Card');
    expect(recovered.dsFile).toBe(clickable.dsFile);
    expect(recovered.dsVariant).toBe(clickable.dsVariant);
    expect(recovered.search?.basis).toBe(clickable.search?.basis);
  });
});

describe('the deeper search — "no family" is only said after the whole family was tried', () => {
  it('a badge-like element none of the rule-named files can represent (a button-rooted chip: Badge renders a span) is found in the rest of the family — FilterChip — not sent to B6', () => {
    const raw = realExpectedRaw('atoms/FilterChip.tsx', { active: 'false', disabled: 'false' });
    Object.assign(raw, { 'border-top-left-radius': '7px', 'border-top-right-radius': '7px', 'border-bottom-right-radius': '7px', 'border-bottom-left-radius': '7px' });
    const m = decideMatch(component({ componentType: 'badge', structural: true, tag: 'button', raw }), index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('FilterChip');
    expect(m.dsFile).toBe('atoms/FilterChip.tsx');
    expect(m.search?.family?.deep).toContain('atoms/FilterChip.tsx');
    expect(m.rationale).toContain('the rest of the family was searched');
    expect(routesToNewComponentEvaluator(m)).toBe(false);
  });

  it('an element whose class fingerprint points at a component OUTSIDE its family is not forced into the family', () => {
    const buttonClasses = [...index.byFile.get('atoms/Button.tsx')!.classes].filter((c) => /\[.+\]/.test(c)).slice(0, 6);
    expect(buttonClasses.length).toBeGreaterThanOrEqual(2);
    const m = decideMatch(component({ componentType: 'badge', structural: true, tag: 'button', classes: buttonClasses, raw: wrongBadgeRaw() }), index, registry, VIEWPORT);
    expect(m.dsFile).toBe('atoms/Button.tsx'); // built from Button's own classes: it IS a Button, whatever it was typed
    expect(m.search?.basis).toBe('class-fingerprint');
  });
});

describe('R1.2 — a variant that paints brand red is never the "closest" variant for a non-CTA element', () => {
  it('a red-bordered, red-filled badge is compared with the nearest PERMITTED variant — the finding never tells it to adopt brand red — and says so', () => {
    const raw = wrongBadgeRaw({ 'border-top-color': 'rgb(176, 31, 36)', 'background-color': 'rgb(176, 31, 36)', color: 'rgb(255, 255, 255)' });
    const m = decideMatch(component({ componentType: 'badge', structural: true, raw }), index, registry, VIEWPORT);
    expect(m.dsFile).toBe('atoms/Badge.tsx');
    expect(m.search?.basis).toBe('family-identity');
    expect(m.rationale).toContain('a variant that paints brand red was set aside');
    // …and nothing it names paints brand red on its border or background.
    const model = index.byFile.get('atoms/Badge.tsx')!.model;
    const brand = resolveToken('--color-brand-red', tokens)!;
    expect(m.assignments?.length).toBeGreaterThan(0);
    for (const assignment of m.assignments ?? []) {
      for (const e of expectationsFor(model, assignment, { viewportWidth: VIEWPORT })) {
        if (e.property !== 'border-top-color' && e.property !== 'background-color') continue;
        const value = e.token ? resolveToken(e.token, tokens) : e.literal;
        expect(value, `${e.property} of ${JSON.stringify(assignment)}`).not.toBe(brand);
      }
    }
    // …while a BUTTON is allowed brand red (R1.2): its closest variant is not restricted.
    const button = decideMatch(component({ componentType: 'button', detectionConfidence: 0.9, tag: 'button', raw: { ...realExpectedRaw('atoms/Button.tsx', { variant: 'brand', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' }), 'font-family': 'Arial, sans-serif' }, box: { width: 200, height: 48 } }), index, registry, VIEWPORT);
    expect(button.dsFile).toBe('atoms/Button.tsx');
    expect(button.rationale).not.toContain('set aside');
  });
});

describe('"the family cannot represent it" is said only after the whole family was tried', () => {
  it('a structural card rooted in a tag no card component renders (a list item) finds no viable member — rule files AND the deeper R4.4 members were tried — and is left for B6 with that cause', () => {
    const raw = realExpectedRaw('atoms/Card.tsx', { variant: 'outlined', padding: 'md', shadow: 'none' });
    const m = decideMatch(component({ componentType: 'card', structural: true, tag: 'li', raw, box: { width: 320, height: 200 } }), index, registry, VIEWPORT);
    expect(m.dsComponent).toBeNull();
    expect(m.search?.basis).toBe('undecided');
    expect(m.search?.undecidedBecause).toBe('family-cannot-represent');
    expect(m.search?.family?.deep.length).toBeGreaterThan(0); // the deeper members were part of the search
    expect(routesToNewComponentEvaluator(m)).toBe(true);
  });
});

describe('every answer records the family search', () => {
  it('a type with no DS family is recorded as having none — and is the only case B6 is for', () => {
    const m = decideMatch(component({ componentType: 'tabs', detectionConfidence: 0.9, tag: 'button', raw: { color: 'rgb(0, 0, 0)' } }), index, registry, VIEWPORT);
    expect(m.dsComponent).toBeNull();
    expect(m.search).toEqual({ family: null, basis: 'undecided', undecidedBecause: 'no-family' });
    expect(routesToNewComponentEvaluator(m)).toBe(true);
  });

  it('a heading is decided by its context slot, not a family search', () => {
    const raw = realExpectedRaw('atoms/SectionHeading.tsx', {});
    const c = component({ componentType: 'section-heading', detectionConfidence: 0.9, tag: 'h2', raw, box: { width: 600, height: 48 } });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('SectionHeading');
    expect(m.search?.basis).toBe('context-slot');
  });
});
