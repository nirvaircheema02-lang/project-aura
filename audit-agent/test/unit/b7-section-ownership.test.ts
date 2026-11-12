import { describe, expect, it } from 'vitest';
import { reconcile, type ReconcileState } from '../../src/agents/b7-coverage-qa/reconcile.ts';
import { resolveOwner, sectionOfRegion } from '../../src/agents/b7-coverage-qa/ownership.ts';
import type { ItemOwner, RawManifestItem } from '../../src/agents/b7-coverage-qa/manifest.ts';
import type { DetectedComponent, SectionInfo } from '../../src/agents/types.ts';

/**
 * SECTION OWNERSHIP of recovered / dynamic items. Who owns an element is decided from the page's STRUCTURE — the
 * section whose DOM subtree holds it, the control that opens it, its Header / Footer region — and only an item in the
 * normal flow may be placed by where its box sits. A mega-menu revealed from a sticky header lies over the hero; it is
 * still the header's. (Real audit: "All Reports" and "SURVEY VERTICALS" were filed under the hero's heading.)
 */

type Box = { x: number; y: number; width: number; height: number };

const section = (over: Partial<SectionInfo> & { id: string; name: string }): SectionInfo => ({ kind: 'content', rootRef: `e-${over.id}`, personalized: false, isListing: false, note: '', box: { x: 0, y: 0, width: 1440, height: 600 }, ...over });
/** A header band, a tall hero under it, a features band, a footer — the shape of a real page. */
const HEADER = section({ id: 's-header', name: 'Header', kind: 'nav', box: { x: 0, y: 0, width: 1440, height: 80 } });
const HERO = section({ id: 's-hero', name: 'Your Dealers Know What Your Data Doesn’t', kind: 'hero', box: { x: 0, y: 80, width: 1440, height: 700 } });
const FEATURES = section({ id: 's-features', name: 'What Makes Our Way Different', box: { x: 0, y: 780, width: 1440, height: 900 } });
const FOOTER = section({ id: 's-footer', name: 'Footer', kind: 'footer', box: { x: 0, y: 1680, width: 1440, height: 300 } });
const SECTIONS = [HEADER, HERO, FEATURES, FOOTER];

const owner = (over: Partial<ItemOwner> = {}): ItemOwner => ({ sectionStamp: null, triggerSectionStamp: null, region: null, floating: false, anchored: true, ...over });

function item(over: Partial<RawManifestItem> & { id: string; text: string }): RawManifestItem {
  const box: Box = over.box ?? { x: 100, y: 200, width: 300, height: 24 };
  const tag = over.tag ?? 'a';
  const facts = over.facts ?? {
    tag, classes: [], roleAttr: null, cursor: 'pointer', text: over.text, hasSvg: false, hasImg: false, ownText: true, childElementCount: 0,
    style: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderTopWidth: '0px', borderTopStyle: 'none', paddingLeft: '0px', paddingTop: '0px', color: 'rgb(10, 10, 10)', fontSize: '14px', fontWeight: '400', display: 'block', opacity: '1', visibility: 'visible', textTransform: 'none', letterSpacing: 'normal' },
    box,
  };
  return {
    kind: 'control', role: 'link', tag, box, facts, visibility: 'visible', where: [], reveal: { kind: null, hostSelector: null, controlSelector: null },
    place: { inNavigation: false, inFooter: false, insideOwner: false, ownerText: null }, stamps: { self: [], inner: [], owner: [] }, source: 'dom', ...over,
  };
}

const state = (over: Partial<ReconcileState> = {}): ReconcileState => ({ components: [], findings: [], ariaElements: [], sections: SECTIONS, decisions: {}, viewportWidth: 1440, ...over });
const ownerOf = (i: RawManifestItem) => {
  const [r] = reconcile([i], state());
  return { name: r?.sectionName, id: r?.sectionId, basis: r?.ownerBasis };
};

/** A mega-menu panel opens under the header and lies OVER the hero: its box is in the hero's y-range. */
const overHero: Box = { x: 40, y: 160, width: 260, height: 28 };
const hoverLayer = { kind: 'hover' as const, hostSelector: '[data-audit-b7-host="h-1"]', controlSelector: null };

describe('a header mega-menu revealed over the hero stays in the Header', () => {
  it('"All Reports" and "SURVEY VERTICALS" — in the header\'s DOM subtree, faded until hover, boxes inside the hero\'s y-range — are the HEADER\'s, never the hero\'s', () => {
    const allReports = item({ id: 'b7-1', text: 'All Reports', box: overHero, visibility: 'faded', reveal: hoverLayer, owner: owner({ sectionStamp: 's-header', region: 'header' }) });
    const verticals = item({ id: 'b7-2', text: 'SURVEY VERTICALS', tag: 'p', kind: 'text', role: 'paragraph', box: { ...overHero, y: 200 }, visibility: 'faded', reveal: hoverLayer, owner: owner({ sectionStamp: 's-header', region: 'header' }) });
    for (const i of [allReports, verticals]) {
      expect(ownerOf(i), i.text).toEqual({ name: 'Header', id: 's-header', basis: 'dom-subtree' });
    }
  });

  it('and the geometry that used to decide it would have been WRONG — which is why it no longer does', () => {
    // the same item with no ownership evidence (the legacy lookup) lands in the hero
    const legacy = item({ id: 'b7-1', text: 'All Reports', box: overHero });
    expect(ownerOf(legacy).name).toBe(HERO.name);
    expect(sectionOfRegion('header', SECTIONS)?.name).toBe('Header');
  });

  it('a menu rendered OUTSIDE the header\'s subtree (a portal) stays with the control that opens it', () => {
    const portal = item({ id: 'b7-3', text: 'Dealer Voice survey', box: overHero, visibility: 'faded', reveal: hoverLayer, owner: owner({ sectionStamp: null, triggerSectionStamp: 's-header' }) });
    expect(ownerOf(portal)).toEqual({ name: 'Header', id: 's-header', basis: 'trigger' });
  });

  it('a header landmark with no stamped root of its own still resolves to the Header region — not to whatever lies under it', () => {
    const regional = item({ id: 'b7-4', text: 'Insights', box: overHero, visibility: 'faded', reveal: hoverLayer, owner: owner({ region: 'header', floating: true }) });
    expect(ownerOf(regional)).toEqual({ name: 'Header', id: 's-header', basis: 'region' });
  });
});

describe('a dropdown opened while the page is scrolled to another section keeps its original owner', () => {
  it('a position:fixed / sticky header\'s dropdown has page-absolute y = viewport y + scroll — deep inside the features band — and is still the header\'s', () => {
    const scrolledOver: Box = { x: 40, y: 1100, width: 260, height: 28 }; // header dropdown while scrolled ~1000px down
    const dropdown = item({ id: 'b7-5', text: 'Pricing', box: scrolledOver, visibility: 'faded', reveal: hoverLayer, owner: owner({ sectionStamp: 's-header', region: 'header', floating: true }) });
    expect(ownerOf(dropdown)).toEqual({ name: 'Header', id: 's-header', basis: 'dom-subtree' });
    expect(ownerOf(item({ id: 'b7-5', text: 'Pricing', box: scrolledOver })).name).toBe(FEATURES.name); // the legacy lookup would have said so
  });

  it('a component the audit ALREADY holds in a section keeps that section whatever the box now says', () => {
    const c = { elId: 's-header-1', ref: 'e1', findingId: 'f1', sectionId: 's-header', componentType: 'link', label: 'Pricing' } as unknown as DetectedComponent;
    const i = item({ id: 'b7-5', text: 'Pricing', box: { x: 40, y: 1100, width: 80, height: 20 }, stamps: { self: ['s-header-1'], inner: [], owner: [] } });
    const [r] = reconcile([i], state({ components: [c] }));
    expect(r).toMatchObject({ sectionId: 's-header', sectionName: 'Header', ownerBasis: 'component' });
  });
});

describe('carousel / tab content stays in its parent section', () => {
  it('a tab panel (collapsed, no box) and an off-canvas carousel slide are placed by the section whose subtree holds them', () => {
    const panel = item({ id: 'b7-6', text: 'Panel two words only a tab reveals', tag: 'p', kind: 'text', role: 'paragraph', box: { x: 0, y: 0, width: 0, height: 0 }, visibility: 'collapsed', reveal: { kind: 'tab-panel', hostSelector: null, controlSelector: '#t2' }, owner: owner({ sectionStamp: 's-features' }) });
    const slide = item({ id: 'b7-7', text: 'Step 07 slide', tag: 'p', kind: 'text', role: 'paragraph', box: { x: 2900, y: 900, width: 300, height: 24 }, visibility: 'off-canvas', reveal: { kind: 'carousel', hostSelector: null, controlSelector: null }, owner: owner({ sectionStamp: 's-features' }) });
    expect(ownerOf(panel)).toEqual({ name: FEATURES.name, id: 's-features', basis: 'dom-subtree' });
    expect(ownerOf(slide)).toEqual({ name: FEATURES.name, id: 's-features', basis: 'dom-subtree' });
  });

  it('a slide that sits in the features DOM while its box is off in the hero\'s y-range is still the features section\'s', () => {
    const slide = item({ id: 'b7-8', text: 'Step 05 slide', tag: 'p', kind: 'text', role: 'paragraph', box: { x: 100, y: 300, width: 300, height: 24 }, visibility: 'faded', reveal: { kind: 'carousel', hostSelector: null, controlSelector: null }, owner: owner({ sectionStamp: 's-features' }) });
    expect(ownerOf(slide).id).toBe('s-features');
  });
});

describe('a footer drawer / menu stays in the Footer', () => {
  it('a drawer opened from the footer (fixed, over the middle of the page) is the footer\'s by its subtree — and by its region when nothing is stamped', () => {
    const inFooter = item({ id: 'b7-9', text: 'Privacy policy', box: { x: 100, y: 400, width: 200, height: 24 }, visibility: 'faded', reveal: hoverLayer, owner: owner({ sectionStamp: 's-footer', region: 'footer', floating: true }) });
    const byRegion = item({ id: 'b7-10', text: 'Terms of use', box: { x: 100, y: 440, width: 200, height: 24 }, visibility: 'faded', reveal: hoverLayer, owner: owner({ region: 'footer', floating: true }) });
    expect(ownerOf(inFooter)).toEqual({ name: 'Footer', id: 's-footer', basis: 'dom-subtree' });
    expect(ownerOf(byRegion)).toEqual({ name: 'Footer', id: 's-footer', basis: 'region' });
  });
});

describe('an unknown detached overlay is NOT assigned to the nearest visible section', () => {
  it('owned by no section\'s subtree, opened by no section\'s control, in no known region: it is outside any section — even though its box lies over the hero', () => {
    const cookie = item({ id: 'b7-11', text: 'Manage cookie preferences', box: overHero, visibility: 'faded', reveal: hoverLayer, owner: owner({ floating: true }) });
    const detached = item({ id: 'b7-12', text: 'Chat with us', box: overHero, owner: owner({ floating: true }) });
    for (const i of [cookie, detached]) {
      const r = ownerOf(i);
      expect(r, i.text).toEqual({ name: '(outside any section)', id: null, basis: 'unowned-overlay' });
    }
  });

  it('only ordinary flow content falls back to its position — and only when B1\'s roots are anchored and name nothing', () => {
    const flow = item({ id: 'b7-13', text: 'Plain flow link', box: { x: 100, y: 1000, width: 200, height: 24 }, owner: owner() });
    expect(ownerOf(flow)).toEqual({ name: FEATURES.name, id: 's-features', basis: 'geometry' });
  });

  it('an item with no ownership evidence at all (an accessibility-tree-only item) keeps the legacy position lookup — nothing else changed', () => {
    const legacy = item({ id: 'b7-14', text: 'Tree only', box: { x: 100, y: 1000, width: 200, height: 24 }, source: 'a11y' });
    expect(ownerOf(legacy)).toEqual({ name: FEATURES.name, id: 's-features', basis: 'geometry' });
    // …and a page whose section roots could not be stamped falls back the same way
    const unanchored = item({ id: 'b7-15', text: 'Unanchored', box: { x: 100, y: 1000, width: 200, height: 24 }, owner: owner({ anchored: false, floating: true }) });
    expect(ownerOf(unanchored).basis).toBe('geometry');
  });

  it('resolveOwner is the single decision: component → adopted → DOM subtree → trigger → region → (flow) geometry → none', () => {
    const base = item({ id: 'b7-16', text: 'x', box: overHero, owner: owner({ sectionStamp: 's-footer', triggerSectionStamp: 's-features', region: 'header' }) });
    expect(resolveOwner(base, SECTIONS, { component: { sectionId: 's-hero' } }).basis).toBe('component');
    expect(resolveOwner(base, SECTIONS, { adopted: FEATURES }).basis).toBe('adopted');
    expect(resolveOwner(base, SECTIONS).section?.id).toBe('s-footer');
    expect(resolveOwner({ ...base, owner: owner({ triggerSectionStamp: 's-features', region: 'header' }) }, SECTIONS).section?.id).toBe('s-features');
    expect(resolveOwner({ ...base, owner: owner({ region: 'header' }) }, SECTIONS).section?.id).toBe('s-header');
  });
});
