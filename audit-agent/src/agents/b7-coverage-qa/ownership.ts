import type { Page } from 'playwright';
import type { DetectedComponent, SectionInfo } from '../types.ts';
import type { ItemOwner, RawManifestItem } from './manifest.ts';

/**
 * SECTION OWNERSHIP for B7's items — who owns an element, decided from the page's STRUCTURE, never from where the
 * element's box sits at the moment it is read.
 *
 * The bug this exists for: an item B7 reveals (a mega-menu opened from a sticky / fixed header, a dropdown, a
 * hover layer) has a page-absolute box that is the viewport position plus the scroll offset, so it lies over whatever
 * section is under it — the hero, say — and a y-range lookup handed it to that section. "All Reports" and "SURVEY
 * VERTICALS" (header mega-menu content) ended up under the hero's heading.
 *
 * Attribution priority — the first that answers wins, and only the last resort is geometry:
 *
 *   0. GLOBAL CHROME FIRST: an element inside the page's own banner (a top-level `<header>` / `role=banner`) or
 *      contentinfo (`<footer>`) — or revealed by a control that is — belongs to the Global Header / Global Footer
 *      section, whatever any other rule says. The hero owns only what sits in the page-content hero's own subtree;
 *   1. the section the audit ALREADY holds the element in (its component's own section — B1's ownership, preserved);
 *   2. the section B1 adopted the element into by DOM ancestry (`adoptedRefs`);
 *   3. the nearest stable DOM section owner: the B1 section root whose subtree holds the element;
 *   4. the owner of the control that reveals it (a hover host, a disclosure / tab control, an aria-controls trigger) —
 *      an overlay rendered outside its owner's subtree stays with the control that opens it;
 *   5. a known structural region it sits in — Header / Navigation / Footer — resolved to that region's section;
 *   6. geometry — ONLY for an item in the normal flow (never a fixed / sticky box, a dialog, or content that exists
 *      only while something is hovered / expanded), and only when B1's section roots could not be anchored at all;
 *   7. otherwise NO owner: `(outside any section)`, and a finding written for it says a human must confirm where it belongs.
 *
 * `resolveOwner` is the one decision, pure; it is used when the manifest is reconciled AND again — from a fresh read
 * of the live element — right before a recovered element's finding is written (revalidation).
 */

export type OwnerBasis = 'component' | 'adopted' | 'dom-subtree' | 'trigger' | 'region' | 'geometry' | 'unowned-overlay' | 'none';

export interface OwnerResolution {
  section: SectionInfo | null;
  basis: OwnerBasis;
}

type Box = { x: number; y: number; width: number; height: number };

/** The y-range lookup — the legacy (and last-resort) owner of an item in the normal flow. */
export function sectionByGeometry(box: Box, sections: SectionInfo[]): SectionInfo | null {
  const cy = box.y + box.height / 2;
  let best: SectionInfo | null = null;
  for (const s of sections) {
    if (!s.box) continue;
    if (cy < s.box.y - 4 || cy > s.box.y + s.box.height + 4) continue;
    if (!best || (best.box && s.box.height < best.box.height)) best = s;
  }
  return best;
}

/** The section a structural region names: Header → the navigation band named Header, Footer → the footer section. */
export function sectionOfRegion(region: NonNullable<ItemOwner['region']>, sections: SectionInfo[]): SectionInfo | null {
  const byName = (re: RegExp) => sections.find((s) => re.test(s.name));
  if (region === 'footer') return sections.find((s) => s.kind === 'footer') ?? byName(/^footer$/i) ?? null;
  if (region === 'header') return sections.find((s) => s.kind === 'nav' && /^header$/i.test(s.name)) ?? sections.find((s) => s.kind === 'nav') ?? byName(/^header$/i) ?? null;
  return sections.find((s) => s.kind === 'nav') ?? byName(/^(header|navigation)$/i) ?? null;
}

/** An item that exists only while something is hovered, expanded or revealed: its box is a snapshot of a transient overlay. */
export const isDynamic = (item: Pick<RawManifestItem, 'visibility' | 'reveal'>): boolean => item.visibility === 'faded' || item.visibility === 'collapsed' || item.reveal.kind !== null;

export function resolveOwner(
  item: Pick<RawManifestItem, 'box' | 'visibility' | 'reveal' | 'place'> & { owner?: ItemOwner | undefined },
  sections: SectionInfo[],
  known: { component?: Pick<DetectedComponent, 'sectionId'> | null | undefined; adopted?: SectionInfo | undefined } = {},
): OwnerResolution {
  const byId = (id: string | null | undefined): SectionInfo | null => (id ? sections.find((s) => s.id === id) ?? null : null);

  // 0. Global chrome is identified BEFORE the page's own sections: the page's banner / contentinfo landmark — or the
  //    landmark of the control that opens the item (a menu panel rendered elsewhere in the DOM) — decides it.
  const landmark = item.owner?.landmark ?? item.owner?.triggerLandmark ?? null;
  const chrome = landmark ? sectionOfRegion(landmark, sections) : null;
  if (chrome) return { section: chrome, basis: 'region' };

  const owner = item.owner;
  // A DETACHED overlay: fixed / sticky or a dialog, outside every section's subtree, opened by no section's control and in
  // no Header / Footer region (a cookie banner, a chat widget). Its box says nothing about who owns it, so a section the
  // first pass happened to give it by position is not trusted either: it is outside any section, for a human to place.
  if (owner?.anchored && owner.floating && !owner.sectionStamp && !owner.triggerSectionStamp && !(owner.region === 'header' || owner.region === 'footer')) {
    return { section: null, basis: 'unowned-overlay' };
  }

  const held = byId(known.component?.sectionId);
  if (held) return { section: held, basis: 'component' };
  if (known.adopted) return { section: known.adopted, basis: 'adopted' };

  // No DOM ownership evidence at all (an item the DOM scan did not produce, or B1's roots could not be stamped):
  // the legacy rule — an item with no box (collapsed behind a disclosure) cannot be placed by geometry.
  if (!owner || !owner.anchored) return item.visibility === 'collapsed' ? { section: null, basis: 'none' } : geometric(item, sections);

  const inSubtree = byId(owner.sectionStamp);
  if (inSubtree) return { section: inSubtree, basis: 'dom-subtree' };
  const viaTrigger = byId(owner.triggerSectionStamp);
  if (viaTrigger) return { section: viaTrigger, basis: 'trigger' };
  const region = owner.region ?? (item.place.inFooter ? 'footer' : item.place.inNavigation ? 'navigation' : null);
  const regional = region ? sectionOfRegion(region, sections) : null;
  if (regional) return { section: regional, basis: 'region' };

  // Anchored page, and nothing in the structure owns it. Geometry is only honest for content in the normal flow.
  if (owner.floating || isDynamic(item)) return { section: null, basis: 'unowned-overlay' };
  return geometric(item, sections);
}

function geometric(item: Pick<RawManifestItem, 'box'>, sections: SectionInfo[]): OwnerResolution {
  const section = sectionByGeometry(item.box, sections);
  return section ? { section, basis: 'geometry' } : { section: null, basis: 'none' };
}

// ── The page side ───────────────────────────────────────────────────────────────────────────────

/**
 * Marks every B1 section root on the page (`data-audit-section="<section id>"`), so the DOM scan can say which
 * section's SUBTREE holds an element. A root is found through its accessibility ref, exactly as B2's capture reaches
 * an element. Idempotent (a root already marked is left alone); gives up after two roots that cannot be reached in a
 * row (stale refs make every later root fail the same way, and each failure costs a timeout).
 */
export async function stampSectionRoots(page: Page, sections: SectionInfo[]): Promise<{ stamped: number; failed: number }> {
  let stamped = 0;
  let failed = 0;
  let consecutive = 0;
  for (const s of sections) {
    if (!s.rootRef) continue;
    const already = await page.evaluate((id) => document.querySelector(`[data-audit-section="${id}"]`) !== null, s.id).catch(() => false);
    if (already) {
      stamped++;
      continue;
    }
    try {
      await page.locator(`aria-ref=${s.rootRef}`).evaluate((el, id) => el.setAttribute('data-audit-section', id), s.id, { timeout: 600 });
      stamped++;
      consecutive = 0;
    } catch {
      failed++;
      if (++consecutive >= 2) break;
    }
  }
  return { stamped, failed };
}

/**
 * The ownership evidence of ONE live element, read right now — for revalidating a recovered element's section just
 * before its finding is written. Mirrors what the manifest scan records for an item (same questions, same answers).
 */
export async function readLiveOwner(page: Page, selector: string): Promise<ItemOwner | null> {
  try {
    return await page.locator(selector).first().evaluate((el) => {
      const stampOf = (e: Element | null | undefined) => e?.closest('[data-audit-section]')?.getAttribute('data-audit-section') ?? null;
      const region = el.closest('header,[role="banner"]') ? 'header' : el.closest('footer,[role="contentinfo"]') ? 'footer' : el.closest('nav,[role="navigation"],[role="menu"],[role="menubar"]') ? 'navigation' : null;
      let floating = !!el.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[popover]');
      for (let a: Element | null = el; a && !floating && a !== document.documentElement; a = a.parentElement) {
        const p = getComputedStyle(a).position;
        if (p === 'fixed' || p === 'sticky') floating = true;
      }
      const sectionStamp = stampOf(el);
      let triggerSectionStamp: string | null = null;
      if (!sectionStamp) {
        let n = 0;
        for (let a: Element | null = el; a && n < 10 && !triggerSectionStamp; a = a.parentElement, n++) {
          if (!a.id) continue;
          const c = document.querySelector(`[aria-controls~="${CSS.escape(a.id)}"]`);
          if (c) triggerSectionStamp = stampOf(c);
        }
      }
      const SECTIONING = 'article,aside,main,nav,section,[role="main"],[role="article"],[role="complementary"],[role="region"],[role="navigation"]';
      const landmarkOf = (e: Element | null | undefined): 'header' | 'footer' | null => {
        for (let a: Element | null | undefined = e; a; a = a.parentElement) {
          const role = (a.getAttribute('role') ?? '').split(/\s+/)[0]?.toLowerCase() || null;
          const t = a.tagName.toLowerCase();
          if (role === 'banner' || (t === 'header' && !role && !a.parentElement?.closest(SECTIONING))) return 'header';
          if (role === 'contentinfo' || (t === 'footer' && !role && !a.parentElement?.closest(SECTIONING))) return 'footer';
        }
        return null;
      };
      let controller: Element | null = null;
      for (let a: Element | null = el, n = 0; a && n < 10 && !controller; a = a.parentElement, n++) if (a.id) controller = document.querySelector(`[aria-controls~="${CSS.escape(a.id)}"]`);
      const landmark = landmarkOf(el);
      return { sectionStamp, triggerSectionStamp, region, floating, anchored: document.querySelector('[data-audit-section]') !== null, landmark, triggerLandmark: landmark ? null : landmarkOf(controller) } as const;
    }, undefined, { timeout: 1_500 });
  } catch {
    return null;
  }
}

/** Every `data-audit-el` stamp currently on the page — which audited elements are still LIVE (not replaced by a re-render). */
export async function liveStamps(page: Page): Promise<Set<string>> {
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-audit-el]')).map((e) => e.getAttribute('data-audit-el') as string)).catch(() => [] as string[]);
  return new Set(ids);
}
