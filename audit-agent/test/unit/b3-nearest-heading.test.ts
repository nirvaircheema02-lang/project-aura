import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { decideMatch, dsIndex, type DsIndex } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import type { DetectedComponent } from '../../src/agents/types.ts';

/**
 * Nearest typography match, as B3 applies it to a heading (permanent audit-engine rule, not a
 * per-page fix). `decideMatch` against the REAL Design System: SectionHeading renders level 1 at
 * 3.052rem (48.83px), level 2 at 2.441rem (39.06px) and level 3 at 1.953rem (31.25px) at a desktop
 * viewport. Which level an element is audited against is decided by the NEAREST of those to the
 * rendered size — the element's own tag (h1/h2/h3) is supporting evidence that only breaks an
 * exact tie. The semantic tag itself is never changed by the choice.
 */

let registry: DsRegistry;
let index: DsIndex;
const DESKTOP = 1440;

beforeAll(async () => {
  registry = await loadDsRegistry(loadConfig().designSystemPath);
  index = await dsIndex(registry);
});

let seq = 0;
function heading(over: { tag?: string; fontSize?: string | null; letterSpacing?: string; weight?: string; rootFontSizePx?: number; subtitle?: boolean; connected?: boolean }): DetectedComponent {
  seq += 1;
  const raw: Record<string, string> = {
    'font-weight': over.weight ?? '300',
    'letter-spacing': over.letterSpacing ?? 'normal',
    'font-family': '"Noto Serif", serif',
    color: 'rgb(0, 0, 0)',
  };
  if (over.fontSize !== null) raw['font-size'] = over.fontSize ?? '32px';
  return {
    elId: `el-${seq}`,
    ref: `e${seq}`,
    sectionId: 'sec-1',
    sectionName: 'Test',
    captureState: 'default',
    componentType: 'section-heading',
    label: `heading ${seq}`,
    domSignals: [],
    visualSignals: '',
    instanceGroupKey: `section-heading:${seq}`,
    detectionConfidence: 0.9,
    confidenceOutOfContract: false,
    fingerprint: { structuralPath: `h2:nth-of-type(${seq})`, role: 'heading', accessibleName: '', textPrefix: '', box: { x: 0, y: 0, width: 560, height: 48 } },
    findingId: `finding-${seq}`,
    style: over.connected === false ? { connected: false } : { connected: true, raw, rootFontSizePx: over.rootFontSizePx ?? 16, box: { width: 560, height: 48 } },
    signature: `sig-${seq}`,
    containsPlaceholder: false,
    screenshots: { element: null, context: null },
    evidenceClipped: false,
    href: null,
    domFacts: {
      tag: over.tag ?? 'h2',
      classes: [],
      roleAttr: null,
      cursor: 'auto',
      text: 'Heading',
      hasSvg: false,
      hasImg: false,
      ownText: true,
      childElementCount: 0,
      ...(over.subtitle ? { context: { breadcrumb: false, current: false, expanded: false, surface: 'light' as const, surfaceEvidence: 'test', imageSource: null, accessibleName: 'Heading', subtitleCandidate: true } } : {}),
      style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: over.fontSize ?? '', fontWeight: '', display: '', opacity: '', visibility: 'visible', textTransform: '', letterSpacing: '' },
      box: { x: 0, y: 0, width: 560, height: 48 },
    },
  };
}

describe('regression 1 + 3: an h2 rendered at 32px is audited against level 3 (31.25px) — and stays an h2', () => {
  it('chooses level 3 by distance (0.75px) over level 2 (7.06px), recording the semantic tag it did NOT follow', () => {
    const m = decideMatch(heading({ tag: 'h2', fontSize: '32px', letterSpacing: '0.48px' }), index, registry, DESKTOP);
    expect(m).toMatchObject({ dsComponent: 'SectionHeading', dsFile: 'atoms/SectionHeading.tsx', dsVariant: 'level 3', contextSlot: 'heading', visualSlot: 'h3' });
    expect(m.typography).toMatchObject({ property: 'font-size', variant: 'level 3', closestValue: '1.953rem', closestToken: null, semanticTag: 'h2', followsSemanticLevel: false, decidedBy: 'distance' });
    expect(m.typography?.actualPx).toBe(32);
    expect(m.typography?.closestPx).toBeCloseTo(31.248, 3);
    expect(m.typography?.differencePx).toBeCloseTo(0.752, 3);
    // Every DS heading size was considered, nearest first — the audit can show its working.
    expect(m.typography?.considered.map((c) => c.variant)).toEqual(['level 3', 'level 2', 'level 1']);
    expect(m.typography?.considered.map((c) => Math.round(c.distancePx * 100) / 100)).toEqual([0.75, 7.06, 16.83]);
    expect(m.confidence).toBe(0.85); // a decisive nearest is as confident as the tag-based claim ever was
  });

  it('the rationale keeps the tag and the visual level apart: it never asks to change the HTML level', () => {
    const m = decideMatch(heading({ tag: 'h2', fontSize: '32px' }), index, registry, DESKTOP);
    expect(m.rationale).toContain('nearest to level 3');
    expect(m.rationale).toContain('the semantic tag stays h2');
    expect(m.rationale).not.toMatch(/change|replace|switch/i);
  });

  it('a heading whose nearest level IS the one its tag names is unchanged — the tag agrees, nothing is overridden', () => {
    const m = decideMatch(heading({ tag: 'h2', fontSize: '40px' }), index, registry, DESKTOP);
    expect(m).toMatchObject({ dsVariant: 'level 2', visualSlot: 'h2' });
    expect(m.typography).toMatchObject({ variant: 'level 2', followsSemanticLevel: true, semanticTag: 'h2' });
    expect(m.rationale).toContain('Compare the actual h2 child from SectionHeading at the captured viewport, not its wrapper.');
  });
});

describe('regression 2: 38px → 39.06px, whatever the tag', () => {
  it.each(['h1', 'h2', 'h3'])('an %s at 38px is audited against level 2 (2.441rem)', (tag) => {
    const m = decideMatch(heading({ tag, fontSize: '38px' }), index, registry, DESKTOP);
    expect(m.dsVariant).toBe('level 2');
    expect(m.visualSlot).toBe('h2');
    expect(m.typography?.closestValue).toBe('2.441rem');
    expect(m.typography?.differencePx).toBeCloseTo(1.056, 3);
    expect(m.typography?.decidedBy).toBe('distance');
  });

  it('an h1 at 42px (a real hero on the audited page) is nearest level 2, not level 1 forced by the tag', () => {
    const m = decideMatch(heading({ tag: 'h1', fontSize: '42px' }), index, registry, DESKTOP);
    expect(m.dsVariant).toBe('level 2');
    expect(m.typography).toMatchObject({ semanticTag: 'h1', followsSemanticLevel: false });
  });
});

describe('regression 5: an exact DS size is preserved', () => {
  it.each([
    ['h1', '48.832px', 'level 1', '3.052rem'],
    ['h2', '39.056px', 'level 2', '2.441rem'],
    ['h3', '31.248px', 'level 3', '1.953rem'],
    ['h2', '31.248px', 'level 3', '1.953rem'], // an h2 that IS level 3's size exactly
  ])('an %s rendered at exactly %s is level-matched to %s (%s) with no distance', (tag, fontSize, variant, value) => {
    const m = decideMatch(heading({ tag, fontSize }), index, registry, DESKTOP);
    expect(m.dsVariant).toBe(variant);
    expect(m.typography?.closestValue).toBe(value);
    expect(m.typography?.differencePx).toBeCloseTo(0, 3);
  });
});

describe('regression 4: equal-distance levels are separated by evidence, tag LAST', () => {
  // 35.152px is exactly halfway between level 3 (31.248px) and level 2 (39.056px): 3.904px from each.
  const MID = '35.152px';

  it('tier 1 (context): the level whose OTHER typography the element already fits wins — even against the tag', () => {
    // letter-spacing −0.015em of 35.152px = −0.52728px: level 2's tracking. The tag says h3.
    const l2 = decideMatch(heading({ tag: 'h3', fontSize: MID, letterSpacing: '-0.52728px' }), index, registry, DESKTOP);
    expect(l2.dsVariant).toBe('level 2');
    expect(l2.typography?.decidedBy).toBe('context');
    // −0.01em of 35.152px = −0.35152px: level 3's tracking. The tag says h2.
    const l3 = decideMatch(heading({ tag: 'h2', fontSize: MID, letterSpacing: '-0.35152px' }), index, registry, DESKTOP);
    expect(l3.dsVariant).toBe('level 3');
    expect(l3.typography?.decidedBy).toBe('context');
  });

  it('a tie settled by evidence is a judgment call: lower confidence, and the rationale says so', () => {
    const m = decideMatch(heading({ tag: 'h3', fontSize: MID, letterSpacing: '-0.52728px' }), index, registry, DESKTOP);
    expect(m.confidence).toBe(0.7);
    expect(m.rationale).toContain('level 2 and level 3 are equally close');
    expect(m.rationale).toContain('settled by how many of its other typography properties the element already fits');
    expect(m.rationale).toContain('judgment call, the family is not');
  });

  it('tier 2 (visual hierarchy): with no distinguishing context, the level that keeps the element\'s rank among the page\'s headings', () => {
    // Page headings: 48.8, 39.06 ×2, 31.25. The element (35.15) is below both 39s and above the 31: rank 2.
    // Level 3 keeps it there; level 2 would make it equal to the 39s. The tag (h2) would have said level 2.
    const page = { headingSizesPx: [48.832, 39.056, 39.056, 31.248] };
    const m = decideMatch(heading({ tag: 'h2', fontSize: MID }), index, registry, DESKTOP, page);
    expect(m.dsVariant).toBe('level 3');
    expect(m.typography?.decidedBy).toBe('hierarchy');
  });

  it('tier 3 (semantic level): only when nothing else separates them does the tag decide', () => {
    const h2 = decideMatch(heading({ tag: 'h2', fontSize: MID }), index, registry, DESKTOP);
    const h3 = decideMatch(heading({ tag: 'h3', fontSize: MID }), index, registry, DESKTOP);
    expect(h2.dsVariant).toBe('level 2');
    expect(h3.dsVariant).toBe('level 3');
    expect(h2.typography?.decidedBy).toBe('semantic-level');
    expect(h3.typography?.decidedBy).toBe('semantic-level');
    expect(h2.typography?.followsSemanticLevel).toBe(true);
  });
});

describe('the size is measured the way the comparator measures it', () => {
  it('at the CAPTURED viewport: the same 31.25px h2 is level 3 on a desktop page and exactly level 2 on a phone', () => {
    // SectionHeading level 2 is `text-[1.953rem] sm:text-[2.441rem]`: 31.25px below 640px, 39.06px above.
    const desktop = decideMatch(heading({ tag: 'h2', fontSize: '31.248px' }), index, registry, DESKTOP);
    const phone = decideMatch(heading({ tag: 'h2', fontSize: '31.248px' }), index, registry, 390);
    expect(desktop.dsVariant).toBe('level 3');
    expect(phone.dsVariant).toBe('level 2');
    expect(phone.typography?.differencePx).toBeCloseTo(0, 3);
    expect(phone.typography?.followsSemanticLevel).toBe(true);
  });

  it('rem is relative to the page\'s own root font size: an h2 at 46px is level 1 on a 16px root, level 2 on an 18px root', () => {
    expect(decideMatch(heading({ tag: 'h2', fontSize: '46px', rootFontSizePx: 16 }), index, registry, DESKTOP).dsVariant).toBe('level 1'); // 48.83 vs 39.06
    expect(decideMatch(heading({ tag: 'h2', fontSize: '46px', rootFontSizePx: 18 }), index, registry, DESKTOP).dsVariant).toBe('level 2'); // 54.94 vs 43.94
  });
});

describe('never invents a size', () => {
  it('an unreadable font-size keeps the tag\'s own level exactly as before — no typography claim, no visual slot', () => {
    for (const fontSize of [null, 'normal', 'clamp(2rem, 4vw, 3rem)']) {
      const m = decideMatch(heading({ tag: 'h2', fontSize }), index, registry, DESKTOP);
      expect(m.dsVariant).toBe('level 2');
      expect(m.visualSlot).toBeUndefined();
      expect(m.typography).toBeUndefined();
      expect(m.confidence).toBe(0.85);
      expect(m.rationale).toBe('Compare the actual h2 child from SectionHeading at the captured viewport, not its wrapper.');
    }
  });

  it('a detached element keeps the tag\'s own level', () => {
    const m = decideMatch(heading({ tag: 'h3', connected: false }), index, registry, DESKTOP);
    expect(m.dsVariant).toBe('level 3');
    expect(m.typography).toBeUndefined();
  });

  it('a subtitle candidate is still only a candidate — no heading size is chosen for it', () => {
    const m = decideMatch(heading({ tag: 'h2', fontSize: '16px', subtitle: true }), index, registry, DESKTOP);
    expect(m).toMatchObject({ dsVariant: 'subtitle candidate', contextSlot: 'subtitle', confidence: 0.55 });
    expect(m.typography).toBeUndefined();
    expect(m.visualSlot).toBeUndefined();
  });

  it('a tag the DS has no heading level for (h4) is not forced into one — the generic matcher still decides', () => {
    const m = decideMatch(heading({ tag: 'h4', fontSize: '32px' }), index, registry, DESKTOP);
    expect(m.contextSlot).toBeUndefined();
    expect(m.visualSlot).toBeUndefined();
  });
});
