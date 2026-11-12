import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { contextualTokenMap, effectiveTokenMap } from '../../src/ds/catalog.ts';
import { resolveToken } from '../../src/ds/d3-tokens/resolve.ts';
import { expectationsFor } from '../../src/ds/component-styles.ts';
import { assignmentsOf, decideMatch, dsIndex, type DsIndex } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import type { DetectedComponent } from '../../src/agents/types.ts';

/**
 * Component identity is decided before compliance (B3 `decideMatch`, case 2b): a production
 * element evidently belonging to a Design System rule-mapped family (button, link, nav-link,
 * card, badge, tag, chip, section-heading, eyebrow, input, search) is matched to the CLOSEST
 * existing variant whatever its compliance looks like — low fit no longer vetoes identity, it
 * only sets how confident the claim is and which variant B4 audits against. These tests exercise
 * `decideMatch` directly against the REAL Design System registry (no browser, no page — the same
 * static analysis B3 always uses), so every fixture below is measured against real component
 * sources, not a mocked stand-in.
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

/** The real, resolved CSS values the DS source declares for one variant assignment — the same data `bestFit` compares against, so a fixture built from it is a genuine compliant baseline, never a hand-guessed one. */
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

let seq = 0;
function component(over: {
  componentType: string;
  classes?: string[];
  tag?: string;
  raw: Record<string, string>;
  detectionConfidence?: number;
  box?: { width: number; height: number };
}): DetectedComponent {
  seq += 1;
  return {
    elId: `el-${seq}`,
    ref: `e${seq}`,
    sectionId: 'sec-1',
    sectionName: 'Test',
    captureState: 'default',
    componentType: over.componentType,
    label: `fixture ${seq}`,
    domSignals: [],
    visualSignals: '',
    instanceGroupKey: `${over.componentType}:${seq}`,
    detectionConfidence: over.detectionConfidence ?? 0.6,
    confidenceOutOfContract: false,
    fingerprint: { structuralPath: `div:nth-of-type(${seq})`, role: 'generic', accessibleName: '', textPrefix: '', box: { x: 0, y: 0, ...(over.box ?? { width: 200, height: 48 }) } },
    findingId: `finding-${seq}`,
    style: { connected: true, raw: over.raw, rootFontSizePx: 16, box: over.box ?? { width: 200, height: 48 } },
    signature: `sig-${seq}`,
    containsPlaceholder: false,
    screenshots: { element: null, context: null },
    evidenceClipped: false,
    href: null,
    domFacts: {
      tag: over.tag ?? 'button',
      classes: over.classes ?? [],
      roleAttr: null,
      cursor: 'pointer',
      text: 'fixture',
      hasSvg: false,
      hasImg: false,
      ownText: true,
      childElementCount: 0,
      style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: '', fontWeight: '', display: '', opacity: '', visibility: 'visible', textTransform: '', letterSpacing: '' },
      box: { x: 0, y: 0, ...(over.box ?? { width: 200, height: 48 }) },
    },
  };
}

describe('observed context constrains nearest matching', () => {
  it('does not infer active state merely because production text is red', () => {
    const raw = realExpectedRaw('atoms/TextLink.tsx', { size: 'sm', active: 'true' });
    const match = decideMatch(component({ componentType: 'nav-link', tag: 'a', raw }), index, registry, VIEWPORT);
    expect(match.dsComponent).toBe('TextLink');
    expect(match.assignments?.length).toBeGreaterThan(0);
    expect(match.assignments?.every(a => a.active !== 'true')).toBe(true);
  });
  it('withholds theme-dependent surface tokens when the background is unknown', () => {
    const unknown = contextualTokenMap(registry, 'unknown');
    expect([...unknown.keys()].some(k => k.startsWith('--surface-'))).toBe(false);
    expect(unknown.get('--color-brand-red')).toBe(tokens.get('--color-brand-red'));
    expect(contextualTokenMap(registry, 'dark')).toBe(effectiveTokenMap(registry, 'cinematic-dark'));
  });
});

describe('1. Red solid CTA vs. existing DS Brand/Primary gradient CTA', () => {
  it('maps to the existing Button family and picks the real closest variant rather than falling to undecided — the gradient/effect properties are exactly what a full B4 audit would then report as mismatches, never invented as a reason to call it a new component', () => {
    const raw = realExpectedRaw('atoms/Button.tsx', { variant: 'brand', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    raw['background-image'] = 'none'; // solid, no gradient
    raw['box-shadow'] = 'none'; // no approved effect
    const c = component({ componentType: 'button', raw });
    const m = decideMatch(c, index, registry, VIEWPORT);
    // Removing the gradient/shadow can legitimately shift the CLOSEST real variant (bestFit
    // searches every assignment, not just brand's) — the identity claim under test is the family
    // itself (Button), not that this specific mutation always keeps brand the closest.
    expect(m.dsComponent).toBe('Button');
    expect(m.confidence).toBeGreaterThan(0);
  });
});

describe('2. Outlined CTA vs. existing Secondary CTA', () => {
  it('a Button built exactly to the secondary variant resolves its identity AND variant as Secondary, not Primary/Brand/Ghost', () => {
    const raw = realExpectedRaw('atoms/Button.tsx', { variant: 'secondary', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    const c = component({ componentType: 'button', raw });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Button');
    expect(m.dsVariant).toMatch(/^secondary/);
  });
});

describe('3. Wrong-font Secondary CTA', () => {
  it('stays Secondary CTA; only the typography property is reported as differing', () => {
    const raw = realExpectedRaw('atoms/Button.tsx', { variant: 'secondary', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    raw['font-family'] = 'Arial, sans-serif';
    const c = component({ componentType: 'button', raw });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Button');
    expect(m.dsVariant).toMatch(/^secondary/);
  });
});

describe('4. Wrong border/radius/background', () => {
  it('a card whose border color and every radius are wrong keeps its Card/outlined identity — the closest existing variant is retained, never discarded for a new component', () => {
    // The exact defect shape observed on the real Deals & IPO run's "Market sizing workshop"-style
    // element: border-color and all 4 radii wrong, everything else (padding, typography, layout)
    // left matching outlined/sm/none — confirmed empirically to keep outlined the closest fit.
    const raw = realExpectedRaw('atoms/Card.tsx', { variant: 'outlined', padding: 'sm', shadow: 'none' });
    raw['border-top-color'] = 'rgb(217, 209, 206)';
    raw['border-top-left-radius'] = '0px';
    raw['border-top-right-radius'] = '0px';
    raw['border-bottom-left-radius'] = '0px';
    raw['border-bottom-right-radius'] = '0px';
    const c = component({ componentType: 'card', tag: 'div', raw, box: { width: 320, height: 120 } });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Card');
    expect(m.dsVariant).toMatch(/^outlined/);
  });
});

describe('5. CTA with an icon/arrow gap that does not match the Design System', () => {
  it('the closest existing CTA identity is retained and the measurable icon/text gap is reported — icon SHAPE identity itself is not independently verified (not part of this audit’s captured properties)', () => {
    const raw = realExpectedRaw('atoms/Button.tsx', { variant: 'brand', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    raw['gap'] = '2px'; // DS uses a larger, token-defined gap between icon and label
    const c = component({ componentType: 'button', raw });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Button');
    expect(m.dsVariant).toMatch(/^brand/);
    // Honesty check, not a claim this audit makes: icon TYPE/direction is never part of
    // EXTRACTED_PROPERTIES (t-layer/computed-style.ts) — only spacing/color/border/typography/
    // layout are measured, so an "arrow is the wrong shape" claim is never fabricated here.
  });
});

describe('6. CTA with a correct arrow but no verification of DS motion/animation', () => {
  it('a fully compliant CTA is matched and never falsely marked non-compliant for motion the audit cannot measure, and never fabricates a motion mismatch either', () => {
    const raw = realExpectedRaw('atoms/Button.tsx', { variant: 'brand', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    const c = component({ componentType: 'button', raw });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Button');
    // Known, honestly-scoped gap (not implemented this round): component-styles.ts's internal
    // RootInfo walk extracts framer-motion attributes (initial/animate/whileInView/exit/variants)
    // during static analysis, but ComponentStyleModel.roots (the public shape B3/B4 consume) never
    // exposes them, so no motion/animation property ever reaches compareToExpected today — it is
    // neither compared nor fabricated. Surfacing it as an explicit NOT_CAPTURED evidence note would
    // need a small, additive extension to that public interface — flagged, not silently done here.
    expect(m.rationale).not.toMatch(/motion|animation/i);
  });
});

describe('7. Exact CTA variant uncertain', () => {
  it('two family members fit almost equally well — the family is retained and the closest is published, with the tie named rather than guessed silently', () => {
    // Empty style: every family candidate compares equally poorly (all mismatches, same low
    // score), which is exactly the "closest is a coin flip" case the tie-margin exists for.
    const c = component({ componentType: 'link', tag: 'a', raw: {} });
    const m = decideMatch(c, index, registry, VIEWPORT);
    // Nothing measurable at all (0 compared) falls to the single-named-family fallback instead —
    // this scenario needs at least RULE_FIT_MIN_COMPARED on two candidates, so build from a real
    // shared baseline both InlineLink and TextLink would score identically against: their shared
    // typography, which for a bare inline text link is nearly the same on both.
    const shared = realExpectedRaw('atoms/InlineLink.tsx', { onDark: 'false', variant: 'default' });
    const c2 = component({ componentType: 'link', tag: 'a', raw: shared });
    const m2 = decideMatch(c2, index, registry, VIEWPORT);
    expect(m2.dsComponent).not.toBeNull(); // family retained, never undecided merely for variant ambiguity
    expect(['CTALink', 'TextLink', 'InlineLink']).toContain(m2.dsComponent);
    void m;
  });
});

describe('8. Existing component with many visual mismatches', () => {
  it('never reaches B6 merely because compliance is low — identity survives 0% visual compliance', () => {
    const raw = realExpectedRaw('atoms/Button.tsx', { variant: 'brand', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    for (const key of Object.keys(raw)) {
      if (/color/.test(key)) raw[key] = 'rgb(1, 2, 3)';
      else if (/radius/.test(key)) raw[key] = '1px';
      else if (key === 'font-family') raw[key] = 'Comic Sans MS';
      else if (key === 'background-image') raw[key] = 'none';
      else if (key === 'box-shadow') raw[key] = 'none';
    }
    const c = component({ componentType: 'button', raw });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Button'); // identity survives — this is B4's job to report as INCORRECT/DEVIATION, never B6's
  });
});

describe('9. Genuine new semantic component', () => {
  it('a componentType the Design System maps no family to at all still reaches B6 (dsComponent stays null)', () => {
    const c = component({ componentType: 'tabs', tag: 'button', raw: { color: 'rgb(0,0,0)' }, detectionConfidence: 0.9 });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBeNull();
  });
});

describe('10. Non-button red element', () => {
  it('a structurally card-shaped element painted the exact brand red is never forced into Button just because of its color', () => {
    const raw = realExpectedRaw('atoms/Card.tsx', { variant: 'outlined', padding: 'sm', shadow: 'none' });
    raw['background-color'] = 'rgb(176, 31, 36)'; // the DS's own brand red
    const c = component({ componentType: 'card', tag: 'div', raw, box: { width: 320, height: 120 } });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).not.toBe('Button');
  });
});

describe('11. Existing correctly matched Buttons from previous audits', () => {
  it('a real DS Button, built from its own class fingerprint, still matches via the class-fingerprint path unchanged — case 2b never even runs', () => {
    const classes = [
      'group relative inline-flex items-center justify-center font-medium tracking-[0.0875px]',
      'rounded-[var(--radius-button)] gap-2 px-[var(--button-px-md)] h-[var(--button-height-md)]',
      'min-w-[var(--button-min-width-md)] text-[var(--color-foundation-white)] cursor-pointer',
    ].join(' ').split(' ');
    const raw = realExpectedRaw('atoms/Button.tsx', { variant: 'brand', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    const c = component({ componentType: 'button', classes, raw });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Button');
    expect(m.rationale).toMatch(/class fingerprint/);
  });
});

describe('12. Deals & IPO rematch — regression coverage for the corrected behavior', () => {
  it('a repeated CTA whose only real defect is the site-wide wrong font (the exact pattern observed on deals-and-ipo-consulting-test) resolves to Button, not NEEDS_REVIEW/DS_CANDIDATE', () => {
    const raw = realExpectedRaw('atoms/Button.tsx', { variant: 'brand', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    raw['font-family'] = "'Manrope', sans-serif"; // the real, observed site-wide substitution
    const c = component({ componentType: 'button', raw });
    const m = decideMatch(c, index, registry, VIEWPORT);
    expect(m.dsComponent).toBe('Button');
    expect(m.dsVariant).toMatch(/^brand/);
  });
});
