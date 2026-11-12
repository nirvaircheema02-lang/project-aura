import { describe, expect, it } from 'vitest';
import { reconcile, type ReconcileState } from '../../src/agents/b7-coverage-qa/reconcile.ts';
import { resolveOwner } from '../../src/agents/b7-coverage-qa/ownership.ts';
import { annotateRegions, headerGroupOf, headerGroupRank, regionOfSection, rehomeToRegions } from '../../src/agents/b7-coverage-qa/regions.ts';
import type { ItemOwner, RawManifestItem } from '../../src/agents/b7-coverage-qa/manifest.ts';
import { buildAuditData } from '../../src/agents/c2-json-writer/index.ts';
import { HTML_TEMPLATE_VERSION, renderRun } from '../../src/dashboard/views/render.ts';
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent, SectionInfo } from '../../src/agents/types.ts';

/**
 * GLOBAL CHROME FIRST. Every item resolves to a structural region — Global Header, Page Content, Global Footer —
 * before any page section is consulted. Everything in the header (its base navigation, every menu and mega-menu,
 * search, the account / user menu) and every overlay opened from it is the Global Header's and is never the hero's;
 * the hero owns only what sits in the page-content hero's own subtree; a footer drawer is the Global Footer's; a
 * detached overlay nobody owns is outside any section, for a human to place.
 */

type Box = { x: number; y: number; width: number; height: number };

const section = (over: Partial<SectionInfo> & { id: string; name: string }): SectionInfo => ({ kind: 'content', rootRef: `e-${over.id}`, personalized: false, isListing: false, note: '', box: { x: 0, y: 0, width: 1440, height: 600 }, ...over });
const HEADER = section({ id: 's-header', name: 'Header', kind: 'nav', box: { x: 0, y: 0, width: 1440, height: 80 } });
const HERO = section({ id: 's-hero', name: 'Your Dealers Know What Your Data Doesn’t', kind: 'hero', box: { x: 0, y: 80, width: 1440, height: 700 } });
const FAQ = section({ id: 's-faq', name: 'FAQs', box: { x: 0, y: 780, width: 1440, height: 900 } });
const FOOTER = section({ id: 's-footer', name: 'Footer', kind: 'footer', box: { x: 0, y: 1680, width: 1440, height: 300 } });
const SECTIONS = [HEADER, HERO, FAQ, FOOTER];

const owner = (over: Partial<ItemOwner> = {}): ItemOwner => ({ sectionStamp: null, triggerSectionStamp: null, region: null, floating: false, anchored: true, landmark: null, triggerLandmark: null, ...over });

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

const hover = { kind: 'hover' as const, hostSelector: '[data-audit-b7-host="h-1"]', controlSelector: null };
/** Where a mega-menu panel lies when it opens under the header: over the hero. */
const overHero: Box = { x: 40, y: 160, width: 260, height: 28 };

const recordOf = (i: RawManifestItem, extra: Partial<ReconcileState> = {}) => reconcile([i], { components: [], findings: [], ariaElements: [], sections: SECTIONS, decisions: {}, viewportWidth: 1440, ...extra })[0]!;
const where = (i: RawManifestItem) => {
  const r = recordOf(i);
  return { section: r.sectionName, region: r.sectionId ? regionOfSection(SECTIONS.find((s) => s.id === r.sectionId)!, SECTIONS) : null, group: headerGroupOf(r.raw.owner?.menu), basis: r.ownerBasis };
};

describe('a header mega-menu visually overlaying the hero is the GLOBAL HEADER\'s — never the hero\'s', () => {
  it('"All Reports" / "SURVEY VERTICALS": inside the page banner, boxes inside the hero\'s y-range → Global Header', () => {
    const allReports = item({ id: 'b7-1', text: 'All Reports', box: overHero, visibility: 'faded', reveal: hover, owner: owner({ landmark: 'header', sectionStamp: 's-header', menu: { trigger: 'Reports', kind: null } }) });
    expect(where(allReports)).toMatchObject({ section: 'Header', region: 'global-header', group: 'Reports Menu' });
    expect(where(allReports).section).not.toBe(HERO.name);
  });

  it('even when B1\'s section root around the banner is a wrapper that also holds the hero (the section stamp says "hero"), the banner landmark decides', () => {
    const wrapped = item({ id: 'b7-2', text: 'Capabilities', box: overHero, owner: owner({ landmark: 'header', sectionStamp: 's-hero' }) });
    expect(where(wrapped)).toMatchObject({ section: 'Header', region: 'global-header', basis: 'region' });
  });

  it('with no landmark and no stamp, geometry would have filed it under the hero — which is exactly why geometry no longer decides', () => {
    const legacy = item({ id: 'b7-3', text: 'All Reports', box: overHero });
    expect(where(legacy).section).toBe(HERO.name); // an item with no ownership evidence keeps the legacy lookup — nothing else changed
    const anchored = item({ id: 'b7-3', text: 'All Reports', box: overHero, visibility: 'faded', reveal: hover, owner: owner({ floating: true, region: 'header' }) });
    expect(where(anchored).section).toBe('Header');
  });
});

describe('each menu opened from the header is its own sub-group of the Global Header', () => {
  it('a Reports menu opened over the hero → Global Header › Reports Menu', () => {
    const i = item({ id: 'b7-4', text: 'Dealer Voice', box: overHero, visibility: 'faded', reveal: hover, owner: owner({ landmark: 'header', menu: { trigger: 'Reports', kind: null } }) });
    expect(where(i)).toMatchObject({ section: 'Header', region: 'global-header', group: 'Reports Menu' });
  });

  it('an Industries menu opened while the page is scrolled far below (page-absolute y deep in the FAQ band) → Global Header › Industries Menu', () => {
    const i = item({ id: 'b7-5', text: 'Automotive', box: { x: 40, y: 1100, width: 260, height: 28 }, visibility: 'faded', reveal: hover, owner: owner({ landmark: 'header', floating: true, menu: { trigger: 'INDUSTRIES ▾', kind: null } }) });
    expect(where(i)).toMatchObject({ section: 'Header', region: 'global-header', group: 'Industries Menu' });
    expect(where(item({ id: 'b7-5', text: 'Automotive', box: { x: 40, y: 1100, width: 260, height: 28 } })).section).toBe(FAQ.name); // the legacy lookup would have said so
  });

  it('a header Search overlay (opened by the Search control, rendered outside the header\'s subtree) → Global Header › Search', () => {
    const portal = item({ id: 'b7-6', text: 'Popular searches', tag: 'p', kind: 'text', role: 'paragraph', box: overHero, visibility: 'faded', reveal: hover, owner: owner({ triggerLandmark: 'header', floating: true, menu: { trigger: 'Search', kind: 'search' } }) });
    expect(where(portal)).toMatchObject({ section: 'Header', region: 'global-header', group: 'Search' });
  });

  it('the Account / User menu → Global Header › Account/User Menu', () => {
    const profile = item({ id: 'b7-7', text: 'Sign out', box: overHero, visibility: 'faded', reveal: hover, owner: owner({ landmark: 'header', menu: { trigger: 'My account', kind: 'account' } }) });
    expect(where(profile)).toMatchObject({ section: 'Header', region: 'global-header', group: 'Account/User Menu' });
  });

  it('what sits in the header without belonging to a revealed layer — the logo, the visible links, the triggers themselves — is Base Navigation', () => {
    const link = item({ id: 'b7-8', text: 'Home', box: { x: 20, y: 20, width: 60, height: 20 }, owner: owner({ landmark: 'header', menu: { trigger: null, kind: null } }) });
    expect(where(link)).toMatchObject({ region: 'global-header', group: 'Base Navigation' });
  });

  it('group naming and order: a menu is named by the control that opens it; base navigation first, menus in the order found, then Search, then Account/User Menu', () => {
    expect(headerGroupOf({ trigger: 'REPORTS ▾', kind: null })).toBe('Reports Menu');
    expect(headerGroupOf({ trigger: 'Capabilities menu', kind: null })).toBe('Capabilities Menu');
    expect(headerGroupOf({ trigger: 'Insights', kind: null })).toBe('Insights Menu');
    expect(headerGroupOf({ trigger: 'Search', kind: 'search' })).toBe('Search');
    expect(headerGroupOf({ trigger: null, kind: 'account' })).toBe('Account/User Menu');
    expect(headerGroupOf(undefined)).toBe('Base Navigation');
    const groups = ['Account/User Menu', 'Industries Menu', 'Search', 'Base Navigation', 'Reports Menu'];
    expect([...groups].sort((a, b) => headerGroupRank(a) - headerGroupRank(b))).toEqual(['Base Navigation', 'Industries Menu', 'Reports Menu', 'Search', 'Account/User Menu']);
  });
});

describe('the hero owns only the hero — and dynamic content keeps the owner of its trigger', () => {
  it('a hero carousel slide (off-canvas) stays in the Hero; Page Content', () => {
    const slide = item({ id: 'b7-9', text: 'Step 05 slide', tag: 'p', kind: 'text', role: 'paragraph', box: { x: 2900, y: 300, width: 300, height: 24 }, visibility: 'off-canvas', reveal: { kind: 'carousel', hostSelector: null, controlSelector: null }, owner: owner({ sectionStamp: 's-hero' }) });
    expect(where(slide)).toMatchObject({ section: HERO.name, region: 'page-content' });
  });

  it('a section accordion panel (collapsed, no box) stays in its parent section', () => {
    const panel = item({ id: 'b7-10', text: 'We interview dealers directly.', tag: 'p', kind: 'text', role: 'paragraph', box: { x: 0, y: 0, width: 0, height: 0 }, visibility: 'collapsed', reveal: { kind: 'accordion', hostSelector: null, controlSelector: '#faq-1' }, owner: owner({ sectionStamp: 's-faq' }) });
    expect(where(panel)).toMatchObject({ section: 'FAQs', region: 'page-content' });
  });

  it('a card\'s own <header> inside a content section is NOT the Global Header: with no banner landmark the section\'s subtree decides', () => {
    const cardTitle = item({ id: 'b7-11', text: 'Card title', tag: 'h3', kind: 'heading', role: 'heading', box: { x: 100, y: 300, width: 200, height: 24 }, owner: owner({ sectionStamp: 's-hero', landmark: null }) });
    expect(where(cardTitle)).toMatchObject({ section: HERO.name, region: 'page-content' });
  });

  it('a footer drawer → Global Footer (by its own landmark, and when opened from a footer control but rendered elsewhere)', () => {
    const inside = item({ id: 'b7-12', text: 'Privacy policy', box: { x: 100, y: 400, width: 200, height: 24 }, visibility: 'faded', reveal: hover, owner: owner({ landmark: 'footer', floating: true }) });
    const portal = item({ id: 'b7-13', text: 'Terms of use', box: { x: 100, y: 440, width: 200, height: 24 }, visibility: 'faded', reveal: hover, owner: owner({ triggerLandmark: 'footer', floating: true }) });
    expect(where(inside)).toMatchObject({ section: 'Footer', region: 'global-footer' });
    expect(where(portal)).toMatchObject({ section: 'Footer', region: 'global-footer' });
  });
});

describe('a detached overlay no structure owns is OUTSIDE ANY SECTION — and is marked for review, never given to the hero', () => {
  const detachedBox: Box = { x: 900, y: 300, width: 320, height: 80 };
  const cookie = item({ id: 'b7-14', text: 'We use cookies', tag: 'div', kind: 'text', role: 'generic', box: detachedBox, owner: owner({ floating: true }) });

  it('floating, no section subtree, no opening control, no header / footer → no owner, even though its box lies over the hero', () => {
    expect(resolveOwner(cookie, SECTIONS)).toEqual({ section: null, basis: 'unowned-overlay' });
    expect(where(cookie)).toMatchObject({ section: '(outside any section)', basis: 'unowned-overlay' });
  });

  it('a first-pass finding the audit had put under the hero by position is moved outside any section and marked for review', () => {
    const component = { elId: 's-hero-7', ref: 'e7', findingId: 'f-cookie', sectionId: 's-hero', sectionName: HERO.name, componentType: 'paragraph', label: 'We use cookies' } as unknown as DetectedComponent;
    const f = { identity: { findingId: 'f-cookie' }, location: { section: HERO.name, sectionId: 's-hero' }, component: { dsComponent: null, signature: 's' }, classification: 'MATCH', comparison: { mismatches: [], ruleViolations: [] }, quality: { severity: 'LOW', escalationReasons: [], evidence: [] }, history: { currentStatus: 'MATCH' } } as unknown as Finding;
    const state = { sections: SECTIONS, components: [component], matched: [component], findings: [f] } as unknown as B4Output;
    const stamped = { ...cookie, stamps: { self: ['s-hero-7'], inner: [], owner: [] } };
    const records = reconcile([stamped], { components: [component], findings: [f], ariaElements: [], sections: SECTIONS, decisions: {}, viewportWidth: 1440 });
    expect(records[0]?.ownerBasis).toBe('unowned-overlay');
    const out = rehomeToRegions(state, records);
    expect(out.moved).toEqual([{ elId: 's-hero-7', from: HERO.name, to: '(outside any section)', label: 'We use cookies', why: 'detached' }]);
    const moved = out.state.findings[0]!;
    expect(moved.location).toMatchObject({ section: '(outside any section)', sectionId: 's-unsectioned' });
    expect(moved.classification).toBe('NEEDS_REVIEW');
    expect(moved.review?.reason).toMatch(/detached overlay/);
  });
});

describe('B7\'s final pass annotates sections and findings with their region — and re-homes a first-pass header item the hero held', () => {
  const component = (elId: string, findingId: string, sectionId: string, sectionName: string, label: string) => ({ elId, ref: `ref-${elId}`, findingId, sectionId, sectionName, componentType: 'link', label }) as unknown as DetectedComponent;
  const finding = (findingId: string, sectionId: string, sectionName: string, label: string): Finding => ({ identity: { findingId }, location: { url: 'u', pageId: 'p', pageName: 'n', templateFamily: null, section: sectionName, sectionId, captureState: 'default' }, component: { productionType: 'link', productionLabel: label, dsComponent: null, dsVariant: null, signature: `sig-${findingId}` }, classification: 'DEVIATION', comparison: { mismatches: [], ruleViolations: [] }, quality: { severity: 'LOW', confidence: 0.5, confidenceBand: 'LOW', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' }, action: { recommendation: '', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null }, history: { previousStatus: null, currentStatus: 'DEVIATION', delta: null, previousRunId: null } }) as unknown as Finding;

  it('the first pass held "Industries" (a banner link) under the hero by position: B7 moves it to the Global Header; every finding gets its region, the header ones their group', () => {
    const comps = [component('s-hero-1', 'f-ind', 's-hero', HERO.name, 'Industries'), component('s-hero-2', 'f-hero', 's-hero', HERO.name, 'Your Dealers Know…'), component('s-header-1', 'f-home', 's-header', 'Header', 'Home')];
    const findings = [finding('f-ind', 's-hero', HERO.name, 'Industries'), finding('f-hero', 's-hero', HERO.name, 'Your Dealers Know…'), finding('f-home', 's-header', 'Header', 'Home')];
    const state = { sections: SECTIONS, components: comps, matched: comps, findings } as unknown as B4Output;
    const items = [
      item({ id: 'b7-1', text: 'Industries', box: { x: 300, y: 120, width: 90, height: 20 }, stamps: { self: ['s-hero-1'], inner: [], owner: [] }, owner: owner({ landmark: 'header', menu: { trigger: null, kind: null } }) }),
      item({ id: 'b7-2', text: 'Your Dealers Know…', tag: 'h1', kind: 'heading', role: 'heading', box: { x: 100, y: 300, width: 500, height: 40 }, stamps: { self: ['s-hero-2'], inner: [], owner: [] }, owner: owner({ sectionStamp: 's-hero' }) }),
      item({ id: 'b7-3', text: 'Home', box: { x: 20, y: 20, width: 60, height: 20 }, stamps: { self: ['s-header-1'], inner: [], owner: [] }, owner: owner({ landmark: 'header', menu: { trigger: null, kind: null } }) }),
    ];
    const rs = { components: comps, findings, ariaElements: [], sections: SECTIONS, decisions: {}, viewportWidth: 1440 } as ReconcileState;
    const records = reconcile(items, rs);
    const rehomed = rehomeToRegions(state, records);
    expect(rehomed.moved).toEqual([{ elId: 's-hero-1', from: HERO.name, to: 'Header', label: 'Industries', why: 'landmark' }]);
    const annotated = annotateRegions(rehomed.state, reconcile(items, { ...rs, components: rehomed.state.components, findings: rehomed.state.findings }));
    const loc = (id: string) => annotated.findings.find((f) => f.identity.findingId === id)!.location;
    expect(loc('f-ind')).toMatchObject({ section: 'Header', sectionId: 's-header', region: 'global-header', group: 'Base Navigation' });
    expect(loc('f-home')).toMatchObject({ region: 'global-header', group: 'Base Navigation' });
    expect(loc('f-hero')).toMatchObject({ section: HERO.name, region: 'page-content' });
    expect(loc('f-hero').group).toBeUndefined(); // a hero finding is never a Global Header sub-group
    expect(annotated.sections.map((s) => [s.id, s.region])).toEqual([['s-header', 'global-header'], ['s-hero', 'page-content'], ['s-faq', 'page-content'], ['s-footer', 'global-footer']]);
  });
});

describe('the HTML report groups by region: Global Header with its sub-groups, then the hero and the page\'s sections, then the Global Footer', () => {
  const mk = (id: string, sectionId: string, section: string, label: string, region?: 'global-header' | 'page-content' | 'global-footer', group?: string): Finding => ({
    identity: { auditId: 'a1', runId: 'r1', findingId: id, timestamp: '2026-10-08T10:00:00.000Z', dsRegistryVersion: 'ds', policyVersion: 'p' },
    location: { url: 'https://example.test/', pageId: 'p1', pageName: 'A', templateFamily: null, section, sectionId, captureState: 'default', ...(region ? { region } : {}), ...(group ? { group } : {}) },
    component: { productionType: 'link', productionLabel: label, dsComponent: null, dsVariant: null, signature: `sig-${id}` },
    classification: 'DEVIATION',
    comparison: { mismatches: [{ property: 'color', actual: 'red', expected: 'black', expectedToken: null, comparison: 'exact', delta: null }], ruleViolations: [], properties: [] },
    quality: { severity: 'LOW', confidence: 0.8, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
    action: { recommendation: 'x', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: 'DEVIATION', delta: null, previousRunId: null },
  }) as Finding;

  function html(withRegions: boolean): string {
    const r = <T,>(v: T): T | undefined => (withRegions ? v : undefined);
    const findings = [
      mk('f1', 's-header', 'Header', 'Home', r('global-header'), r('Base Navigation')),
      mk('f2', 's-header', 'Header', 'All Reports', r('global-header'), r('Reports Menu')),
      mk('f3', 's-header', 'Header', 'Automotive', r('global-header'), r('Industries Menu')),
      mk('f4', 's-header', 'Header', 'Sign out', r('global-header'), r('Account/User Menu')),
      mk('f5', 's-header', 'Header', 'Search', r('global-header'), r('Search')),
      mk('f6', 's-hero', HERO.name, 'Your Dealers Know…', r('page-content')),
      mk('f7', 's-footer', 'Footer', 'Privacy policy', r('global-footer')),
    ];
    const page = {
      runId: 'r1', pageId: 'p1', url: 'https://example.test/', pageName: 'A', templateFamily: null, domHash: 'd', dsRegistryVersion: 'ds', policyVersion: 'p', findings,
      compliance: { match: 0, deviation: 7, incorrect: 0, newComponent: 0, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
      coverage: { sectionsAnalyzed: 4, componentsDetected: 7, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
      sections: [
        { id: 's-header', name: 'Header', note: '', ...(withRegions ? { region: 'global-header' as const } : {}) },
        { id: 's-hero', name: HERO.name, note: '', ...(withRegions ? { region: 'page-content' as const } : {}) },
        { id: 's-footer', name: 'Footer', note: '', ...(withRegions ? { region: 'global-footer' as const } : {}) },
      ],
    } as PageResult;
    const data = buildAuditData({ runId: 'r1', auditId: 'a1', mode: 'single-page', startedAt: '2026-10-08T10:00:00.000Z', targetUrl: 'https://example.test/', pages: [page], failedPages: [] });
    return renderRun('proj', data, '/evidence/proj/r1');
  }

  const headers = (out: string) => [...out.matchAll(/<(?:div|button) (?:type="button" )?class="fsec-header([^"]*)" data-section="([^"]*)"(?: data-group="([^"]*)")?[^>]*>([^<]*)</g)].map((m) => ({ cls: m[1]!.trim(), group: m[3] ?? null, text: m[4]!.split(' · ')[0]! }));

  it('is stamped with the new template version', () => {
    expect(HTML_TEMPLATE_VERSION).toBe('html-report-v19');
    expect(html(true)).toContain('<!-- html-report-v19 -->');
  });

  it('Global Header first — Base Navigation, the menus in the order found, Search, Account/User Menu — then the hero alone, then the Global Footer', () => {
    expect(headers(html(true)).map((h) => h.text)).toEqual(['Global Header', 'Base Navigation', 'Reports Menu', 'Industries Menu', 'Search', 'Account/User Menu', 'Your Dealers Know What Your Data Doesn’t', 'Global Footer']);
  });

  it('the hero\'s group holds ONLY the hero finding — no header or menu finding is in it', () => {
    const out = html(true);
    const heroStart = out.indexOf('>Your Dealers Know What Your Data Doesn’t · 1 finding');
    const footerStart = out.indexOf('>Global Footer ·');
    expect(heroStart).toBeGreaterThan(-1);
    const heroBlock = out.slice(heroStart, footerStart);
    expect(heroBlock.match(/class="frow"/g)).toHaveLength(1);
    expect(heroBlock).toContain('Your Dealers Know…');
    for (const label of ['All Reports', 'Automotive', 'Sign out', 'Home']) expect(heroBlock).not.toContain(`<span class="muted">${label}</span>`);
  });

  it('each sub-group header counts its own rows; rows carry their group for filtering', () => {
    const out = html(true);
    expect(out).toMatch(/data-group="Reports Menu"[^>]*>Reports Menu · 1 finding/);
    expect(out).toMatch(/<div class="frow"[^>]*data-section="p1\/s-header" data-group="Industries Menu"/);
  });

  it('v15 — the Global Header and Global Footer are ACCORDIONS: their region headers are disclosure buttons, collapsed by default (aria-expanded="false")', () => {
    const out = html(true);
    const toggles = [...out.matchAll(/<button type="button" class="fsec-header fsec-region fsec-toggle" data-section="([^"]*)" aria-expanded="([^"]*)">([^<]*)</g)].map((m) => ({ section: m[1], expanded: m[2], text: m[3]!.split(' · ')[0] }));
    expect(toggles).toEqual([{ section: 'p1/s-header', expanded: 'false', text: 'Global Header' }, { section: 'p1/s-footer', expanded: 'false', text: 'Global Footer' }]);
  });

  it('v15 — everything inside a global region (its sub-group headers and its rows) starts collapsed; the hero and every normal section are drawn exactly as before', () => {
    const out = html(true);
    const headerRows = [...out.matchAll(/<div class="frow"[^>]*data-section="p1\/s-header"[^>]*>/g)].map((m) => m[0]);
    expect(headerRows).toHaveLength(5);
    for (const tag of headerRows) expect(tag).toMatch(/ data-gr data-gr-collapsed>$/);
    const subs = [...out.matchAll(/<div class="fsec-header fsub-header"[^>]*>/g)].map((m) => m[0]);
    expect(subs).toHaveLength(5);
    for (const tag of subs) expect(tag).toMatch(/ data-gr data-gr-collapsed>$/);
    const footerRow = out.match(/<div class="frow"[^>]*data-section="p1\/s-footer"[^>]*>/)?.[0] ?? '';
    expect(footerRow).toMatch(/ data-gr data-gr-collapsed>$/);
    const heroRow = out.match(/<div class="frow"[^>]*data-section="p1\/s-hero"[^>]*>/)?.[0] ?? '';
    expect(heroRow).not.toContain('data-gr');
    expect(out).toMatch(/<div class="fsec-header" data-section="p1\/s-hero">/); // the hero header is the plain, non-collapsible one
  });

  it('v15 — the existing attributes are where they were: data-section and data-group on rows and sub-group headers, data-finding-id on rows', () => {
    const out = html(true);
    expect(out).toMatch(/<div class="frow" data-classification="DEVIATION" data-severity="LOW" data-section="p1\/s-header" data-group="Reports Menu" data-finding-id="f2"/);
    expect(out).toMatch(/<div class="fsec-header fsub-header" data-section="p1\/s-header" data-group="Search" data-gr data-gr-collapsed>/);
  });

  it('v15 — the client script opens a region when a filter or search lands on its findings, keeps the reader\'s own choice otherwise, and treats collapsed rows as not visible for the Fix Plan', () => {
    const out = html(true);
    expect(out).toContain("const targeted = filtering && allRows.some((row) => row.dataset.section === sec && !row.hidden);");
    expect(out).toContain("grSet(sec, targeted || grUser.get(sec) === true);");
    expect(out).toContain("b.setAttribute('aria-expanded', String(open));");
    expect(out).toContain("!host.hasAttribute('data-gr-collapsed')");
    expect(out).toContain('[data-gr-collapsed] { display: none !important; }');
  });

  it('v17 LOCK — the Findings section spacing is part of the locked HTML template: 10px before each new section header, never between rows, never before a sub-group header or the first section; section headers 10px tall, sub-group headers 8px', () => {
    const out = html(true);
    // 10px of space BEFORE each new section header — only a section header that is neither a sub-group header nor the first child
    expect(out).toContain('.fsec-header:not(.fsub-header):not(:first-child) { margin-top: 10px; }');
    expect(out).toContain('.fsec-header:first-child { border-top: 0; }');
    // section headers: 10px of vertical padding (the Global Header / Footer buttons are .fsec-header too, so they match)
    expect(out).toMatch(/\.fsec-header \{[^}]*padding: 10px 12px;/);
    // sub-group headers keep their own, tighter 8px
    expect(out).toMatch(/\.fsub-header \{ padding-top: 8px; padding-bottom: 8px;/);
    // NO spacing between individual finding rows: a row has no margin of its own
    expect(out).not.toMatch(/\.frow \{[^}]*margin/);
    expect(out).not.toMatch(/\.frow:not\(/);
    // a filtered-out Global Header / Footer button must really hide (a button's own display overrides [hidden])
    expect(out).toContain('button.fsec-toggle[hidden] { display: none; }');
  });

  it('v15 — a run with no regions has no accordion at all: no toggle button, no collapsed attribute on any row', () => {
    const out = html(false);
    expect(out).not.toContain('class="fsec-header fsec-region fsec-toggle"');
    expect(out).not.toMatch(/<div class="frow"[^>]*data-gr/);
  });

  it('v16 — the accordion chevron sits at the FAR RIGHT of each global row: label + counts stay the first thing in the button, then ONE aria-hidden Lucide chevron (right = collapsed, down = expanded)', () => {
    const out = html(true);
    const rows = [...out.matchAll(/<button type="button" class="fsec-header fsec-region fsec-toggle"[^>]*>([^<]*)(<svg class="fsec-chev"[^>]*>.*?<\/svg>)<\/button>/gs)];
    expect(rows).toHaveLength(2); // Global Header + Global Footer, nothing else
    for (const m of rows) {
      expect(m[1]).toMatch(/^Global (Header|Footer) · /); // label + counts are still the left-aligned text of the button
      expect(m[2]).toContain('aria-hidden="true"'); // decoration — the text and aria-expanded say everything
      expect(m[2]).toContain('class="fsec-chev-right" d="m9 18 6-6-6-6"'); // Lucide chevron-right, shown while collapsed
      expect(m[2]).toContain('class="fsec-chev-down" d="m6 9 6 6 6-6"'); // Lucide chevron-down, shown while expanded
    }
  });

  it('v16 — the stylesheet puts the chevron at the right end of a flex row, picks the glyph from aria-expanded alone, and the old left-hand text glyph is gone', () => {
    const out = html(true);
    expect(out).toMatch(/button\.fsec-toggle \{[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: space-between;/);
    expect(out).toContain('.fsec-chev .fsec-chev-down, button.fsec-toggle[aria-expanded="true"] .fsec-chev .fsec-chev-right { display: none; }');
    expect(out).toContain('button.fsec-toggle[aria-expanded="true"] .fsec-chev .fsec-chev-down { display: inline; }');
    expect(out).not.toContain("content: '▸'");
    expect(out).not.toContain("content: '▾'");
  });

  it('v16 — only the two global rows carry a chevron: the hero keeps its plain section header, and a run with no regions has no chevron at all', () => {
    const out = html(true);
    expect(out.match(/<svg class="fsec-chev"/g)).toHaveLength(2);
    expect(out).toMatch(/<div class="fsec-header" data-section="p1\/s-hero">/);
    expect(html(false)).not.toContain('fsec-chev"');
  });

  it('a run that predates regions (no region, no group) is grouped exactly as before — "Header", "Footer", no sub-groups', () => {
    const out = html(false);
    expect(headers(out).map((h) => h.text)).toEqual(['Header', 'Your Dealers Know What Your Data Doesn’t', 'Footer']);
    expect(out).not.toContain('fsub-header" data-section');
  });
});
