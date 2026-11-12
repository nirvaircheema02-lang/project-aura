import type { Page } from 'playwright';
import type { LiveCandidate } from './candidates.ts';
import type { Box } from './types.ts';

/**
 * Text-identity fallback for findings whose evidence box found no candidate (geometry fails when the audit measured an element in a state it is not
 * in at rest — e.g. a card's "Read More" that is revealed on hover — or when the page shifted). 246 of the 439 findings of the dealers-voice-survey
 * run stayed unmapped, so nothing could be applied to them.
 *
 * It maps ONLY on exact identity and only when it is unambiguous:
 *  - the live element's text equals the audit's label (a label cut with "…" — the audit cuts at ~60 characters — must be a prefix of at least 20 characters);
 *  - for a link/button the element is the nearest `<a>` / `<button>` / role=button around that text, otherwise the innermost element holding exactly it;
 *  - hidden elements (no box) are ignored;
 *  - the NUMBER of live matches equals the number of audit findings that share the label — a duplicate-labelled set ("Read More" ×4) is paired by
 *    reading order (audit evidence box y/x against live y/x). Any other count, and the whole group is left unmapped, never guessed.
 */

export interface UnmappedItem {
  findingId: string;
  label: string;
  type: string;
  auditBox: Box | null;
}

export interface TextMatch {
  findingId: string;
  candidate: LiveCandidate;
}

const LINK_LIKE = new Set(['link', 'button', 'nav-link']);
const MIN_LABEL = 3;

/**
 * A heading finding can only be an element that IS a heading. The same label often appears three times on a page (a card's h2, its button, a tab); pairing "the one free element left" with
 * the heading finding put the h2's DS size on a tab label (brand-perception run). Other types stay permissive: their tag says little (p / span / div / li).
 */
export const tagCompatible = (type: string, c: Pick<LiveCandidate, 'tagName' | 'role'>): boolean => (type === 'section-heading' ? /^h[1-6]$/i.test(c.tagName) || c.role === 'heading' : true);

export const labelKey = (label: string): string => label.replace(/\s+/g, ' ').replace(/…$/, '').trim();

/** All live elements that carry exactly this text, as candidates in reading order. */
export async function candidatesByText(page: Page, label: string, linkLike: boolean): Promise<LiveCandidate[]> {
  const cut = /…$/.test(label.trim());
  const key = labelKey(label);
  return page.evaluate(
    ({ key: k, cut: c, linkLike: ll }) => {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      const matches = (el: Element) => { const t = norm(el.textContent || ''); return c ? k.length >= 20 && t.startsWith(k) : t === k; };
      const skip = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH']);
      const picked = new Set<Element>();
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        if (skip.has(el.tagName) || !matches(el)) continue;
        if (ll) {
          const target = el.closest('a, button, [role="button"]');
          if (target && matches(target)) picked.add(target);
        } else if (!Array.from(el.children).some((ch) => matches(ch))) picked.add(el);
      }
      const out: Array<Record<string, unknown>> = [];
      for (const el of picked) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        out.push({
          tagName: el.tagName.toLowerCase(), role: el.getAttribute('role'), text: norm(el.textContent || '').slice(0, 200), classes: Array.from(el.classList),
          box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }, href: el.getAttribute('href'), type: el.getAttribute('type'),
          tabIndex: el.hasAttribute('tabindex') ? Number(el.getAttribute('tabindex')) : el instanceof HTMLElement ? el.tabIndex : null,
          ariaExpanded: el.getAttribute('aria-expanded'), ariaControls: el.getAttribute('aria-controls'), ariaHaspopup: el.getAttribute('aria-haspopup'),
          disabled: 'disabled' in el ? Boolean((el as unknown as { disabled: unknown }).disabled) : el.getAttribute('aria-disabled') === 'true', cursor: cs.cursor || null, formAssociated: Boolean(el.closest('form')),
        });
      }
      return out;
    },
    { key, cut, linkLike },
  ).then((rows) => (rows as unknown as Omit<LiveCandidate, 'candidateId'>[]).map((r, i) => ({ ...r, candidateId: `text-${i}` }) as LiveCandidate).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x));
}

/**
 * `unmapped` are the findings the objective checks could not place; `alreadyMapped` counts, per label key, the findings that DID map (their live
 * elements are already taken, so they are excluded from the live matches by `taken`). Returns the unambiguous pairs only.
 */
export async function mapByTextIdentity(page: Page, unmapped: UnmappedItem[], taken: (c: LiveCandidate) => boolean = () => false, log: (line: string) => void = () => {}): Promise<TextMatch[]> {
  const groups = new Map<string, UnmappedItem[]>();
  for (const u of unmapped) {
    const key = labelKey(u.label);
    if (key.length < MIN_LABEL) continue;
    const g = `${LINK_LIKE.has(u.type) ? 'L' : 'T'}|${key}|${/…$/.test(u.label.trim()) ? 'cut' : 'full'}`;
    groups.set(g, [...(groups.get(g) ?? []), u]);
  }
  const out: TextMatch[] = [];
  for (const [, items] of groups) {
    const live = (await candidatesByText(page, items[0]!.label, LINK_LIKE.has(items[0]!.type))).filter((c) => !taken(c));
    if (live.length !== items.length) { log(`C2 · text identity skipped "${items[0]!.label.slice(0, 40)}": ${items.length} finding(s) vs ${live.length} free live element(s)`); continue; } // ambiguous or absent: never guessed
    const ordered = [...items].sort((a, b) => (a.auditBox?.y ?? 0) - (b.auditBox?.y ?? 0) || (a.auditBox?.x ?? 0) - (b.auditBox?.x ?? 0));
    ordered.forEach((it, i) => {
      if (!tagCompatible(it.type, live[i]!)) { log(`C2 · text identity refused "${it.label.slice(0, 40)}": a ${it.type} finding cannot be a <${live[i]!.tagName.toLowerCase()}>`); return; }
      out.push({ findingId: it.findingId, candidate: live[i]! });
    });
  }
  return out;
}
