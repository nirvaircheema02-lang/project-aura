import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { RenderingPolicy } from '../t-layer/browser.ts';
import { findCandidateElements, type LiveCandidate } from './candidates.ts';
import { iou } from './objective-checks.ts';
import type { Affordances, Box, CaptureFingerprint } from './types.ts';

export const STAMP_ATTR_ELEMENT = 'data-fra-element';
export const STAMP_ATTR_FINDINGS = 'data-fra-findings';
export const STAMP_ATTR_SIGNATURE = 'data-fra-signature';
export const STAMP_ATTR_INSTANCE = 'data-fra-instance';
export const STAMP_ATTR_TYPE = 'data-fra-type';
export const STAMP_ATTR_SECTION = 'data-fra-section';
export const STAMP_ATTR_SCOPE = 'data-fra-scope';
export const STAMP_ATTR_FIXED = 'data-fra-fixed';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function elementSelector(elementId: string): string {
  return `[${STAMP_ATTR_ELEMENT}="${elementId}"]`;
}

export type StampFailure =
  | 'off-screen' // the box centre is outside the viewport after scrolling it into view
  | 'no-element-at-box' // nothing at the point corresponds (IoU < 0.5) to the box — occluded or gone
  | 'identity-mismatch' // the element found there is not the candidate (different tag or text)
  | 'owned-by-other-element' // that element is already stamped for findings that are a different element's
  | 'stamp-not-unique'; // the id would not resolve to exactly one connected element — rolled back

export interface StampOutcome {
  stamped: boolean;
  /** The id that now resolves to the element: the new id, or the existing one when merged. Null when not stamped. */
  elementId: string | null;
  /** True when the finding was added to an element that was already stamped (many findings, one element). */
  merged: boolean;
  reason: StampFailure | null;
  /** On `owned-by-other-element`: the id that element already carries. */
  conflictsWith?: string | null;
}

/**
 * Re-locates the exact element a `LiveCandidate` already identified (same box, moments
 * earlier) and writes `data-fra-*` attributes on it. Guarantees, checked in the page:
 *   - identity: the element found at the box has the candidate's tag and text — a hit-test that
 *     lands on something else (an off-screen/hidden menu item whose box overlaps page content)
 *     never stamps or merges into that other element;
 *   - merge: an element already stamped by the SAME identity gets the finding appended and its
 *     existing id returned (§6.4's "many findings per element");
 *   - uniqueness: an id is written only if no other element carries it, and after writing it
 *     resolves to exactly one connected element — otherwise the write is rolled back.
 */
export async function stampElementDetailed(
  page: Page,
  candidate: LiveCandidate,
  attrs: { elementId: string; findingId: string; signature: string | null; instanceIndex: number | null; productionType: string },
): Promise<StampOutcome> {
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 200)), candidate.box.y);
  await page.waitForTimeout(30);
  return page.evaluate(
    ({ box, cand, attrs: a, elAttr, findAttr, sigAttr, instAttr, typeAttr }) => {
      const fail = (reason: string, conflictsWith: string | null = null) => ({ stamped: false, elementId: null, merged: false, reason, conflictsWith });
      const vx = box.x + box.width / 2 - window.scrollX;
      const vy = box.y + box.height / 2 - window.scrollY;
      if (vx < 0 || vy < 0 || vx > window.innerWidth || vy > window.innerHeight) return fail('off-screen');
      const stack = document.elementsFromPoint(vx, vy);
      let best: Element | null = null;
      let bestScore = -1;
      for (const el of stack) {
        if (['HTML', 'BODY', 'SCRIPT', 'STYLE', 'HEAD'].includes(el.tagName)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const liveBox = { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
        const ix = Math.max(0, Math.min(box.x + box.width, liveBox.x + liveBox.width) - Math.max(box.x, liveBox.x));
        const iy = Math.max(0, Math.min(box.y + box.height, liveBox.y + liveBox.height) - Math.max(box.y, liveBox.y));
        const inter = ix * iy;
        const union = box.width * box.height + liveBox.width * liveBox.height - inter;
        const score = union > 0 ? inter / union : 0;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (!best || bestScore < 0.5) {
        // Something covers the point (an overlay or pointer-transparent layer). Fall back to the element's own identity: the ONE element with this tag
        // and exact text whose box corresponds to the candidate's. Several or none → still unresolved, never guessed.
        const twins = Array.from(document.querySelectorAll(cand.tagName)).filter((el) => {
          if (((el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)) !== cand.text) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const lx = r.x + window.scrollX, ly = r.y + window.scrollY;
          const ix = Math.max(0, Math.min(box.x + box.width, lx + r.width) - Math.max(box.x, lx));
          const iy = Math.max(0, Math.min(box.y + box.height, ly + r.height) - Math.max(box.y, ly));
          const inter = ix * iy;
          const union = box.width * box.height + r.width * r.height - inter;
          return union > 0 && inter / union >= 0.5;
        });
        if (twins.length !== 1) return fail('no-element-at-box');
        best = twins[0]!;
      }
      const text = (best.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      if (best.tagName.toLowerCase() !== cand.tagName || text !== cand.text) return fail('identity-mismatch');
      const existingId = best.getAttribute(elAttr);
      const existing = best.getAttribute(findAttr);
      if (existingId) {
        // already stamped: same identity (checked above) → merge the finding, keep the id
        const ids = (existing ?? '').split(' ').filter(Boolean);
        if (!ids.includes(a.findingId)) best.setAttribute(findAttr, [...ids, a.findingId].join(' '));
        if (document.querySelectorAll(`[${elAttr}="${existingId}"]`).length !== 1) return fail('stamp-not-unique', existingId);
        return { stamped: true, elementId: existingId, merged: true, reason: null, conflictsWith: null };
      }
      if (existing) return fail('owned-by-other-element', null); // findings without an id: inconsistent stamp, never extend it
      if (document.querySelector(`[${elAttr}="${a.elementId}"]`)) return fail('stamp-not-unique', a.elementId);
      best.setAttribute(elAttr, a.elementId);
      best.setAttribute(findAttr, a.findingId);
      if (a.signature) best.setAttribute(sigAttr, a.signature);
      if (a.instanceIndex !== null) best.setAttribute(instAttr, String(a.instanceIndex));
      best.setAttribute(typeAttr, a.productionType);
      const nodes = document.querySelectorAll(`[${elAttr}="${a.elementId}"]`);
      if (nodes.length !== 1 || !best.isConnected) {
        for (const n of Array.from(nodes)) [elAttr, findAttr, sigAttr, instAttr, typeAttr].forEach((x) => n.removeAttribute(x));
        return fail('stamp-not-unique', a.elementId);
      }
      return { stamped: true, elementId: a.elementId, merged: false, reason: null, conflictsWith: null };
    },
    { box: candidate.box, cand: { tagName: candidate.tagName, text: candidate.text }, attrs, elAttr: STAMP_ATTR_ELEMENT, findAttr: STAMP_ATTR_FINDINGS, sigAttr: STAMP_ATTR_SIGNATURE, instAttr: STAMP_ATTR_INSTANCE, typeAttr: STAMP_ATTR_TYPE },
  ) as Promise<StampOutcome>;
}

/** Boolean form of {@link stampElementDetailed}, kept for callers that only need success. */
export async function stampElement(
  page: Page,
  candidate: LiveCandidate,
  attrs: { elementId: string; findingId: string; signature: string | null; instanceIndex: number | null; productionType: string },
): Promise<boolean> {
  return (await stampElementDetailed(page, candidate, attrs)).stamped;
}

/**
 * True when this exact live box already carries a stamp — used to detect "many findings, one
 * element" before creating a second MappingEntry. `elementsFromPoint` at the box's center
 * returns every element painted there, which — because a child normally paints on top of, and
 * is normally contained within, its ancestors — includes every ancestor of whatever is
 * actually at that point. Returning the first STAMPED element found there (with no size check)
 * would treat "some ancestor already has a stamp" as "this exact box is already stamped" —
 * merging a genuinely different, more specific element (e.g. a button nested inside an
 * already-stamped card) into the ancestor's mapping entry. Scored by IoU against the target
 * box instead, at the same 0.5 bar `stampElement`'s own re-locate uses, so only a stamped
 * element that actually corresponds to (not merely contains) this box counts as a match.
 */
export async function stampedElementIdAt(page: Page, box: Box): Promise<string | null> {
  return page.evaluate(
    ({ box: b, elAttr }) => {
      const vx = b.x + b.width / 2 - window.scrollX;
      const vy = b.y + b.height / 2 - window.scrollY;
      if (vx < 0 || vy < 0 || vx > window.innerWidth || vy > window.innerHeight) return null;
      let bestId: string | null = null;
      let bestScore = -1;
      for (const el of document.elementsFromPoint(vx, vy)) {
        const id = el.getAttribute(elAttr);
        if (!id) continue;
        const r = el.getBoundingClientRect();
        const liveBox = { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
        const ix = Math.max(0, Math.min(b.x + b.width, liveBox.x + liveBox.width) - Math.max(b.x, liveBox.x));
        const iy = Math.max(0, Math.min(b.y + b.height, liveBox.y + liveBox.height) - Math.max(b.y, liveBox.y));
        const inter = ix * iy;
        const union = b.width * b.height + liveBox.width * liveBox.height - inter;
        const score = union > 0 ? inter / union : 0;
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }
      return bestScore >= 0.5 ? bestId : null;
    },
    { box, elAttr: STAMP_ATTR_ELEMENT },
  );
}

export function affordancesOf(c: LiveCandidate): Affordances {
  return {
    tagName: c.tagName,
    role: c.role,
    href: c.href,
    type: c.type,
    tabIndex: c.tabIndex,
    ariaExpanded: c.ariaExpanded,
    ariaControls: c.ariaControls,
    ariaHaspopup: c.ariaHaspopup,
    disabled: c.disabled,
    cursor: c.cursor,
    formAssociated: c.formAssociated,
  };
}

/** Re-scores a candidate that was just found, matching against a target box — used only to pick which already-collected candidate to stamp. */
export function bestCandidateFor(candidates: LiveCandidate[], targetBox: Box): LiveCandidate | null {
  let best: LiveCandidate | null = null;
  let bestIou = -1;
  for (const c of candidates) {
    const score = iou(c.box, targetBox);
    if (score > bestIou) {
      bestIou = score;
      best = c;
    }
  }
  return best;
}

// ── Section wrappers (§8.2) ─────────────────────────────────────────────────────────────────

export interface SectionWrapperResult {
  located: boolean;
  stamp: string | null;
  tagName: string | null;
  box: Box | null;
  /** Set when no wrapper could be stamped without overwriting another section's stamp. */
  conflictWith?: string;
  /** Set when the only element that would hold the section is the document itself (`<body>`/`<html>`): that would make it contain every other section. */
  documentRoot?: boolean;
  /** Member elements set aside because the live page renders them outside the section's own wrapper (inside another section); the wrapper holds the rest. */
  outliers?: string[];
}

const SECTIONING_TAGS = new Set(['section', 'article', 'header', 'footer', 'nav', 'aside', 'main']);

/**
 * The lowest common ancestor of a section's already-stamped member elements, widened to the
 * nearest sectioning ancestor (tag or `role`), or — failing that — the nearest direct child
 * of `main`/`body` (§8.2). Stamps the wrapper with `data-fra-section`/`data-fra-scope`.
 *
 * Widening never crosses into another section: it stops below any ancestor that contains a
 * member of a different section (`foreignMemberElementIds`) or already carries another
 * section's stamp, and a wrapper that another section already owns is never overwritten.
 * `<body>` and `<html>` are never a wrapper: such a section is reported as not locatable (`documentRoot`).
 * Without this, sections built from plain divs widened to the page-level container, two
 * sections landed on the same element, and the later stamp silently replaced the earlier one.
 */
export async function locateAndStampSectionWrapper(page: Page, sectionId: string, scope: 'content' | 'excluded' | 'unselected', memberElementIds: string[], foreignMemberElementIds: string[] = []): Promise<SectionWrapperResult> {
  if (memberElementIds.length === 0) return { located: false, stamp: null, tagName: null, box: null };
  return page.evaluate(
    ({ ids, foreignIds, elAttr, secAttr, scopeAttr, sectioningTags, sid, scp }) => {
      const all = ids.map((id) => ({ id, el: document.querySelector(`[${elAttr}="${id}"]`) })).filter((m): m is { id: string; el: Element } => m.el !== null);
      if (all.length === 0) return { located: false, stamp: null, tagName: null, box: null };

      const ancestorsOf = (el: Element): Element[] => {
        const chain: Element[] = [];
        let node: Element | null = el;
        while (node) {
          chain.push(node);
          node = node.parentElement;
        }
        return chain;
      };
      // The LCA is the shallowest element common to every member's chain — walk the first member's own chain (leaf-to-root order) to find the first one still common.
      const lcaOf = (els: Element[]): Element | null => {
        let common = new Set(ancestorsOf(els[0]!));
        for (const m of els.slice(1)) {
          const chain = new Set(ancestorsOf(m));
          for (const a of [...common]) if (!chain.has(a)) common.delete(a);
        }
        for (const a of ancestorsOf(els[0]!)) if (common.has(a)) return a;
        return null;
      };
      const depthOf = (el: Element): number => ancestorsOf(el).length;

      const allEls = all.map((m) => m.el);
      const foreign = foreignIds.map((id) => document.querySelector(`[${elAttr}="${id}"]`)).filter((e): e is Element => e !== null && !allEls.includes(e));
      const owns = (el: Element): string | null => {
        const own = el.getAttribute(secAttr);
        if (own && own !== sid) return own;
        const nested = Array.from(el.querySelectorAll(`[${secAttr}]`)).find((n) => n.getAttribute(secAttr) !== sid);
        return nested ? nested.getAttribute(secAttr) : null;
      };
      const crossesIntoAnother = (el: Element): boolean => foreign.some((f) => el.contains(f)) || owns(el) !== null;

      // Widen the LCA of `members` to the section's wrapper, or say why it cannot be one.
      const wrapperFor = (members: Element[]): { wrapper: Element | null; conflict: string | null } => {
        const lca = lcaOf(members);
        if (!lca) return { wrapper: null, conflict: null };
        let wrapper: Element = lca;
        let blockedBy: string | null = null;
        while (wrapper !== document.documentElement) {
          const tag = wrapper.tagName.toLowerCase();
          const role = wrapper.getAttribute('role');
          if (sectioningTags.includes(tag) || (role && sectioningTags.includes(role))) break;
          const parent: Element | null = wrapper.parentElement;
          if (!parent) break;
          if (parent.tagName.toLowerCase() === 'main' || parent.tagName.toLowerCase() === 'body') break;
          if (crossesIntoAnother(parent)) {
            blockedBy = owns(parent) ?? 'another section';
            break;
          }
          wrapper = parent;
        }
        const conflict = owns(wrapper) ?? (blockedBy && members.includes(wrapper) ? blockedBy : null);
        // A section is never the document: <body>/<html> would structurally contain every other section.
        if (!conflict && (wrapper === document.body || wrapper === document.documentElement)) return { wrapper: null, conflict: null };
        return { wrapper, conflict };
      };

      // Members of a section can sit somewhere else entirely: the audit attributes an element to a section by its own reading of the page, while the live page renders it
      // inside ANOTHER section's markup (FAQ answer items, a neighbour's card headings). A wrapper that has to contain them too is the page, not the section. So when the
      // whole set has no wrapper of its own, the section is the CLUSTER of members under one ancestor — the one holding the most of them (a clear majority, at least 60% and three), that does have a wrapper —
      // and the members outside it are set aside and reported, never silently dropped.
      let members = allEls;
      let result = wrapperFor(members);
      const outliers: string[] = [];
      if (!result.wrapper || result.conflict) {
        const need = Math.max(3, Math.ceil(allEls.length * 0.6)); // a clear majority; two or three scattered members never make a cluster
        const candidates = new Set<Element>();
        for (const e of allEls) for (const a of ancestorsOf(e)) candidates.add(a);
        const ranked = [...candidates]
          .map((a) => ({ a, count: allEls.filter((e) => a.contains(e)).length, depth: depthOf(a) }))
          .filter((c) => c.count >= need && c.count < allEls.length)
          .sort((x, y) => y.count - x.count || y.depth - x.depth);
        for (const c of ranked) {
          const cluster = allEls.filter((e) => c.a.contains(e));
          const r = wrapperFor(cluster);
          if (r.wrapper && !r.conflict) { members = cluster; result = r; break; }
        }
        for (const m of all) if (!members.includes(m.el)) outliers.push(m.id);
      }
      if (!result.wrapper || result.conflict) return { located: false, stamp: null, tagName: null, box: null, ...(result.conflict ? { conflictWith: result.conflict } : { documentRoot: true }) };

      const wrapper = result.wrapper;
      wrapper.setAttribute(secAttr, sid);
      wrapper.setAttribute(scopeAttr, scp);
      const r = wrapper.getBoundingClientRect();
      return {
        located: true,
        stamp: sid,
        tagName: wrapper.tagName.toLowerCase(),
        box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
        ...(outliers.length ? { outliers } : {}),
      };
    },
    { ids: memberElementIds, foreignIds: foreignMemberElementIds, elAttr: STAMP_ATTR_ELEMENT, secAttr: STAMP_ATTR_SECTION, scopeAttr: STAMP_ATTR_SCOPE, sectioningTags: [...SECTIONING_TAGS], sid: sectionId, scp: scope },
  );
}

/**
 * A section none of whose findings could be mapped to a live element has no member to build a wrapper from (the audit's boxes drift on sticky / rotating blocks), so
 * the usual route never even tries it and the section is missing from the output. Its heading is a member the page itself offers: the first heading (not in a
 * landmark header/footer/nav, not inside a section already stamped) whose text is the section's name or the start of it. That heading is used as the member of
 * the ordinary wrapper search (same widening and same "never cross into another section" rules) and carries no stamp afterwards — the section's findings stay
 * unmapped and are reported as such; only its CONTENT is now rendered, complete, as the Selected Sections mode requires.
 */
export async function locateSectionByHeading(page: Page, sectionId: string, sectionName: string, scope: 'content' | 'excluded' | 'unselected', foreignMemberElementIds: string[] = []): Promise<SectionWrapperResult & { headingText?: string }> {
  const memberId = `hs-${sectionId}`;
  const found = await page.evaluate(
    ({ name, elAttr, secAttr, memberId: mid }) => {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.:!?]+$/, '');
      const want = norm(name);
      if (want.length < 3) return null;
      const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'));
      const hit = heads.find((h) => {
        if (h.closest('header, footer, nav, [role="banner"], [role="contentinfo"], [role="navigation"]')) return false;
        if (h.closest(`[${secAttr}]`)) return false;
        const t = norm(h.textContent ?? '');
        return t.length >= 3 && (t === want || (want.startsWith(t) && t.length >= 6) || (t.startsWith(want) && want.length >= 6));
      });
      if (!hit) return null;
      hit.setAttribute(elAttr, mid);
      return (hit.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    },
    { name: sectionName, elAttr: STAMP_ATTR_ELEMENT, secAttr: STAMP_ATTR_SECTION, memberId },
  );
  if (found === null) return { located: false, stamp: null, tagName: null, box: null };
  const result = await locateAndStampSectionWrapper(page, sectionId, scope, [memberId], foreignMemberElementIds);
  // the heading only served as the search member: it is not a mapped element and keeps no stamp
  await page.evaluate(({ elAttr, mid }) => document.querySelector(`[${elAttr}="${mid}"]`)?.removeAttribute(elAttr), { elAttr: STAMP_ATTR_ELEMENT, mid: memberId });
  return { ...result, headingText: found };
}

/** Whether the live page independently agrees a section is global — the document's own banner/contentinfo landmarks (§8.3), cross-checked against the audit's section-name classification. */
export async function landmarkSaysGlobal(page: Page, elementId: string): Promise<'banner' | 'contentinfo' | 'nav-in-banner' | null> {
  return page.evaluate(
    ({ id, elAttr }) => {
      const el = document.querySelector(`[${elAttr}="${id}"]`);
      if (!el) return null;
      const banner = el.closest('header, [role=banner]');
      const contentinfo = el.closest('footer, [role=contentinfo]');
      if (contentinfo) return 'contentinfo';
      if (banner) {
        const nav = el.closest('nav, [role=navigation]');
        return nav && nav !== banner && banner.contains(nav) ? 'nav-in-banner' : 'banner';
      }
      return null;
    },
    { id: elementId, elAttr: STAMP_ATTR_ELEMENT },
  );
}

// ── Capture fingerprint (§6.6) ────────────────────────────────────────────────────────────

interface RawStylesheetInfo {
  url: string | null;
  cssText: string | null;
}

export async function computeCaptureFingerprint(page: Page, renderingPolicy: RenderingPolicy, assetCap = 40): Promise<CaptureFingerprint> {
  const domHtml = await page.content();
  const domHash = sha256(domHtml);

  const sheets: RawStylesheetInfo[] = await page.evaluate(() =>
    Array.from(document.styleSheets).map((s) => {
      let cssText: string | null = null;
      try {
        cssText = Array.from(s.cssRules)
          .map((r) => r.cssText)
          .join('\n');
      } catch {
        cssText = null; // cross-origin sheet — CORS blocks cssRules; recorded as unavailable, never fatal
      }
      return { url: s.href, cssText };
    }),
  );
  const stylesheets = sheets.map((s, i) => ({ url: s.url ?? `inline-${i}`, contentHash: s.cssText !== null ? sha256(s.cssText) : 'unavailable' }));

  const fontSrcUrls = new Set<string>();
  for (const s of sheets) {
    if (!s.cssText) continue;
    const re = /@font-face\s*\{[^}]*?src:([^;]+);/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s.cssText))) {
      const urlRe = /url\(["']?([^"')]+)["']?\)/gi;
      let um: RegExpExecArray | null;
      while ((um = urlRe.exec(m[1] as string))) fontSrcUrls.add(um[1] as string);
    }
  }
  const fontUrls = [...fontSrcUrls].slice(0, assetCap);
  const fontHashes: Record<string, string | null> = await page.evaluate(async (urls) => {
    const out: Record<string, string | null> = {};
    for (const u of urls as string[]) {
      try {
        const buf = await fetch(u, { cache: 'force-cache' }).then((r) => r.arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', buf);
        out[u] = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      } catch {
        out[u] = null;
      }
    }
    return out;
  }, fontUrls);
  const fonts = fontUrls.map((src) => ({ src, contentHash: fontHashes[src] ?? null }));

  const assetUrls: string[] = await page.evaluate((cap) => {
    const urls = new Set<string>();
    for (const img of Array.from(document.images)) {
      const r = img.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (img.currentSrc || img.src)) urls.add(img.currentSrc || img.src);
      if (urls.size >= cap) break;
    }
    return [...urls].slice(0, cap);
  }, assetCap);
  const assetHashes: Record<string, string | null> = await page.evaluate(async (urls) => {
    const out: Record<string, string | null> = {};
    for (const u of urls as string[]) {
      try {
        const buf = await fetch(u, { cache: 'force-cache' }).then((r) => r.arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', buf);
        out[u] = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      } catch {
        out[u] = null;
      }
    }
    return out;
  }, assetUrls);
  const assets = assetUrls.map((url) => ({ url, contentHash: assetHashes[url] ?? null }));

  const renderingPolicyHash = sha256(JSON.stringify(renderingPolicy));

  return { domHash, stylesheets, fonts, assets, viewport: renderingPolicy.viewport, renderingPolicyHash };
}

export { findCandidateElements };
export type { LiveCandidate };
