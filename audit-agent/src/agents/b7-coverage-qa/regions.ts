import { markNeedsReview } from '../b5-visual-verifier/completeness.ts';
import type { Finding, StructuralRegion } from '../../skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent, SectionInfo } from '../types.ts';
import { sectionOfRegion } from './ownership.ts';
import type { ItemRecord } from './reconcile.ts';

/**
 * STRUCTURAL REGIONS — global chrome is identified BEFORE the page's own sections:
 *
 *   Global Header   the site header: its base navigation, every menu / mega-menu, search, account / user controls and
 *                   every overlay opened from any of them
 *   Page Content    the page's own sections — the hero owns ONLY what sits in the page-content hero's own subtree
 *   Global Footer   the site footer and every drawer opened from it
 *
 * No new agent, node or edge: B7's own final pass annotates what the audit already produced (a finding's `region` and,
 * inside the Global Header, its `group`), after ownership (`ownership.ts`) has decided who owns each item.
 */

export const BASE_NAVIGATION = 'Base Navigation';
export const SEARCH_GROUP = 'Search';
export const ACCOUNT_GROUP = 'Account/User Menu';

export const REGION_LABEL: Readonly<Record<StructuralRegion, string>> = {
  'global-header': 'Global Header',
  'page-content': 'Page Content',
  'global-footer': 'Global Footer',
};

/** The stated catch-all for an element no section owns. */
export const UNSECTIONED = { id: 's-unsectioned', name: '(outside any section)' } as const;

/** A finding whose owning section nothing in the page's structure could name: kept as measured, and a human is asked where it belongs. */
export function markUnowned(finding: Finding): Finding {
  const marked = markNeedsReview(finding, 'unowned', 'B7');
  if (marked.review === undefined || marked.review === finding.review) return marked;
  return {
    ...marked,
    review: { ...marked.review, reason: 'nothing in the page\'s structure names the section this element belongs to — it is a detached overlay: outside every section\'s DOM subtree, not opened from one, and not in the header or footer. It is listed under "(outside any section)" rather than assigned to whichever section happened to lie beneath it; confirm where it belongs' },
  };
}

/** A control's own label as a menu name: "REPORTS ▾" → "Reports". */
function menuName(label: string): string {
  const stripped = label.replace(/[\s▾▼▲⌄⌃˅˄›»+\-–—:·|]+$/u, '').replace(/^[\s▾▼▲⌄⌃˅˄›»+\-–—:·|]+/u, '').replace(/\s+menu$/i, '').replace(/\s+/g, ' ').trim();
  const cased = stripped.length > 3 && stripped === stripped.toUpperCase() ? stripped.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : stripped;
  return cased.length > 28 ? `${cased.slice(0, 27)}…` : cased;
}

/**
 * The Global Header sub-group an item belongs to. The label of the CONTROL that opens it names a menu
 * (Industries trigger → "Industries Menu"); search and account / user controls are their own groups; whatever sits in
 * the header without belonging to a revealed layer — the logo, the visible links, the triggers themselves — is the base navigation.
 */
export function headerGroupOf(menu: { trigger: string | null; kind: 'search' | 'account' | null } | undefined): string {
  if (menu?.kind === 'search') return SEARCH_GROUP;
  if (menu?.kind === 'account') return ACCOUNT_GROUP;
  const name = menu?.trigger ? menuName(menu.trigger) : '';
  return name ? `${name} Menu` : BASE_NAVIGATION;
}

/** Group order in a report: base navigation, then the menus in the order they were found, then search, then the account / user menu. */
export const headerGroupRank = (group: string): number => (group === BASE_NAVIGATION ? 0 : group === SEARCH_GROUP ? 2 : group === ACCOUNT_GROUP ? 3 : 1);

/** Which structural region a section is. */
export function regionOfSection(section: Pick<SectionInfo, 'id' | 'kind'>, sections: SectionInfo[]): StructuralRegion {
  if (sectionOfRegion('header', sections)?.id === section.id && section.kind === 'nav') return 'global-header';
  if (section.kind === 'footer') return 'global-footer';
  return 'page-content';
}

/**
 * A finding the first pass wrote under one section whose element sits in the page's banner or contentinfo landmark is
 * moved to the Global Header / Global Footer section: the hero (or any content section) must own only what is in its
 * own subtree. Only a LANDMARK decision does this — for an item that already carries a component, resolution reaches
 * 'region' only through the landmark rule, never through the looser region heuristics. Pure.
 */
export function rehomeToRegions<T extends B4Output>(state: T, records: ItemRecord[]): { state: T; moved: Array<{ elId: string; from: string; to: string; label: string; why: 'landmark' | 'detached' }> } {
  const target = new Map<string, { id: string; name: string; from: string; label: string; why: 'landmark' | 'detached' }>();
  for (const r of records) {
    const c = r.component;
    if (!c) continue;
    // a detached overlay (no section's subtree, no section's control, no header / footer): outside any section
    if (r.ownerBasis === 'unowned-overlay' && c.sectionId !== UNSECTIONED.id) {
      target.set(c.elId, { id: UNSECTIONED.id, name: UNSECTIONED.name, from: c.sectionName, label: c.label, why: 'detached' });
      continue;
    }
    if (r.ownerBasis !== 'region' || !r.sectionId || c.sectionId === r.sectionId) continue;
    if (!r.raw.owner?.landmark && !r.raw.owner?.triggerLandmark) continue; // only the landmark rule re-homes an audited element
    if (!state.sections.some((s) => s.id === r.sectionId)) continue;
    target.set(c.elId, { id: r.sectionId, name: r.sectionName, from: c.sectionName, label: c.label, why: 'landmark' });
  }
  if (target.size === 0) return { state, moved: [] };
  const move = (c: DetectedComponent): DetectedComponent => {
    const t = target.get(c.elId);
    return t ? { ...c, sectionId: t.id, sectionName: t.name } : c;
  };
  const findingTarget = new Map<string, { id: string; name: string; why: 'landmark' | 'detached' }>();
  for (const c of state.components) {
    const t = target.get(c.elId);
    if (t) findingTarget.set(c.findingId, t);
  }
  return {
    state: {
      ...state,
      components: state.components.map(move),
      matched: state.matched.map(move),
      findings: state.findings.map((f) => {
        const t = findingTarget.get(f.identity.findingId);
        if (!t) return f;
        const moved: Finding = { ...f, location: { ...f.location, section: t.name, sectionId: t.id } };
        return t.why === 'detached' ? markUnowned(moved) : moved;
      }),
    },
    moved: [...target].map(([elId, t]) => ({ elId, from: t.from, to: t.name, label: t.label, why: t.why })),
  };
}

/**
 * Annotates the audit's output with its structural regions: every section gets its `region`; every finding in a
 * section gets `location.region`, and a finding in the Global Header gets its sub-group (`location.group`). Pure.
 */
export function annotateRegions<T extends B4Output>(state: T, records: ItemRecord[]): T {
  const sections = state.sections.map((s) => ({ ...s, region: regionOfSection(s, state.sections) }));
  const regionOf = new Map(sections.map((s) => [s.id, s.region]));
  const groupOf = new Map<string, string>();
  for (const r of records) {
    const findingId = r.finding?.identity.findingId ?? r.component?.findingId;
    if (!findingId || groupOf.has(findingId) || !r.sectionId || regionOf.get(r.sectionId) !== 'global-header') continue;
    groupOf.set(findingId, headerGroupOf(r.raw.owner?.menu));
  }
  const findings = state.findings.map((f): Finding => {
    const region = f.location.sectionId ? regionOf.get(f.location.sectionId) : undefined;
    if (!region) return f;
    return { ...f, location: { ...f.location, region, ...(region === 'global-header' ? { group: groupOf.get(f.identity.findingId) ?? BASE_NAVIGATION } : {}) } };
  });
  return { ...state, sections, findings };
}
