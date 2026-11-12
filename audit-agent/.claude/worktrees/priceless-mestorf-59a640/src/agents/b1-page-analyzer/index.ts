import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { B1SectionsSchema } from '../../llm/schemas/b-nodes.ts';
import { expandSafely, findDisclosureCandidates } from '../../t-layer/disclosure.ts';
import { takePageSnapshot } from '../../t-layer/element-registry.ts';
import { captureOverviewTiles } from '../../t-layer/screenshot.ts';
import { normalizeRef } from '../refs.ts';
import { deterministicSections } from './deterministic.ts';
import { RepairableError } from '../../graph/retry.ts';
import type { AriaElement } from '../../t-layer/element-registry.ts';
import type { LlmImage } from '../../llm/client.ts';
import type { NodeContext } from '../../graph/engine.ts';
import type { B1Output, PageSession, SectionInfo } from '../types.ts';

/**
 * B1 — Page Analyzer (v1.0 §4): render the page, understand hierarchy, break
 * it into sections. Deterministic work first (disclosure expansion, tiles,
 * DOM hash, aria snapshot), then the section map: one AI call in
 * anthropic-api mode, the DOM's section spine in no-api mode (Decision Log #31).
 *
 * Disclosure policy (§2.7): non-exclusive controls (accordions, <details>,
 * "Read More") are expanded before capture because they only ADD content.
 * Tabs are mutually exclusive — selecting one hides another — so they are
 * recorded as unexpanded states rather than silently flattened. That is a
 * named coverage boundary, not a silent blind spot.
 */

const NON_EXCLUSIVE = new Set(['accordion', 'details', 'read-more']);

/** Height below which an element is too small to be a section's container (it is a heading or a strip inside one). */
export const SECTION_MIN_HEIGHT = 120;

/**
 * The outline is cheap (a long report page is ~6k tokens against a 1M
 * context), so the cap is generous — the old 220-line cap silently dropped
 * more than half of the long templates. Whatever is still cut is reported.
 */
export const OUTLINE_MAX_LINES = 2000;

/**
 * Viewport tiles sent to B1. 12 × 900px covers ~10,800px — the target page is
 * 8,886px, and 6 tiles left its lower 40% unpictured. Staying at or under 20
 * images keeps the API's normal 8000px per-image limit (not the stricter
 * many-image one); each tile is ~1.7k visual tokens.
 */
export const B1_MAX_TILES = 12;

/** Compacts a full aria snapshot to the structural spine an LLM needs to find sections. */
export function compactOutline(
  elements: AriaElement[],
  opts: { minHeight?: number; maxLines?: number; viewportWidth?: number } = {},
): { text: string; sent: number; total: number; lastY: number | null } {
  const minHeight = opts.minHeight ?? SECTION_MIN_HEIGHT;
  const maxLines = opts.maxLines ?? OUTLINE_MAX_LINES;
  const viewportWidth = opts.viewportWidth ?? 1440;
  const kept = elements.filter((e) => {
    if (!e.box) return false;
    // Structural candidates: big enough to be a section, a landmark/heading that names
    // one, or a full-width band (a 100px header wrapper is a section the model must be
    // able to cite — without it, the only header ref offered was the nav inside it).
    return (
      e.box.height >= minHeight ||
      ['heading', 'navigation', 'banner', 'contentinfo', 'main', 'region', 'form'].includes(e.role) ||
      (e.box.width >= viewportWidth * 0.9 && e.box.height >= 40)
    );
  });
  const sent = kept.slice(0, maxLines);
  return {
    text: sent.map((e) => `${e.ref} ${e.role}${e.name ? ` "${e.name.slice(0, 60)}"` : ''} [y=${Math.round(e.box!.y)} h=${Math.round(e.box!.height)}]`).join('\n'),
    sent: sent.length,
    total: kept.length,
    lastY: sent.at(-1)?.box ? Math.round(sent.at(-1)!.box!.y) : null,
  };
}

/** Roles that NAME a section rather than contain it — the only roots worth promoting. */
const TEXT_LEVEL_ROLES = new Set(['heading', 'paragraph', 'text', 'strong', 'emphasis', 'img']);

/**
 * A section rooted at its HEADING would give B2 only the heading's own
 * vertical box, so everything under it would never be detected. Such a root
 * is promoted to its nearest real ANCESTOR (from the snapshot hierarchy) that
 * is section-sized — never to the page root or anything taller than half the
 * page, and never for a landmark or structural element, whatever its height:
 * a 60px nav is a legitimate section, and promoting it by geometry turned the
 * target page's header into the whole 9,516px page. When no suitable ancestor
 * exists the cited root is kept as-is, not dropped.
 */
export function promoteToContainer(root: AriaElement, elements: AriaElement[], pageHeight: number): AriaElement {
  if (!root.box || !TEXT_LEVEL_ROLES.has(root.role)) return root;
  const byRef = new Map(elements.map((e) => [e.ref, e]));
  for (let ref = root.parentRef; ref; ref = byRef.get(ref)?.parentRef ?? null) {
    const ancestor = byRef.get(ref);
    if (!ancestor?.box || ancestor.depth === 0) break;
    if (ancestor.box.height > pageHeight * 0.5) break;
    if (ancestor.box.height >= SECTION_MIN_HEIGHT) return ancestor;
  }
  return root;
}

const SYSTEM = `You are the Page Analyzer (B1) of a Design System compliance audit.
You are given a structural outline of a rendered page (accessibility tree refs with geometry) and screenshots of it.
Your job is ONLY to divide the page into its top-level sections. Do not audit anything.
Rules:
- Every section must be rooted at a ref that appears in the outline. Answer with the bare ref (e.g. "e42").
- rootRef must be the CONTAINER element that spans the whole section (use the y/h geometry), not the section's heading.
- Mark personalized=true for sections whose content differs per visitor (e.g. "Recommended for you"), because those are out of compliance scope.
- Mark isListing=true for large repeating result/listing grids that should be sampled rather than fully enumerated.
- Prefer 5-15 meaningful sections. Do not emit one section per paragraph.`;

export async function runB1(ctx: NodeContext, session: PageSession): Promise<B1Output> {
  const { page, observer, capture } = session;

  // ── Deterministic: expand non-exclusive disclosures, then re-snapshot ──
  const candidates = await findDisclosureCandidates(page);
  const unexpandedStates: B1Output['coverage']['unexpandedStates'] = [];
  for (const candidate of candidates) {
    if (!NON_EXCLUSIVE.has(candidate.kind)) {
      unexpandedStates.push({
        kind: candidate.kind,
        label: candidate.label,
        reason: candidate.safe
          ? 'mutually exclusive state (selecting it hides another) — not audited in this capture'
          : `unsafe to activate: ${candidate.unsafeReason ?? 'unknown'}`,
      });
      continue;
    }
    if (!candidate.safe) {
      unexpandedStates.push({ kind: candidate.kind, label: candidate.label, reason: `unsafe to activate: ${candidate.unsafeReason ?? 'unknown'}` });
      continue;
    }
    const outcome = await expandSafely(page, observer, candidate, session.url);
    if (!outcome.expanded) {
      unexpandedStates.push({ kind: candidate.kind, label: candidate.label, reason: outcome.reason });
    }
  }

  // The snapshot must be taken AFTER expansion (refs are bound to the current DOM) and at
  // scroll 0 with page-absolute boxes: capture's placeholder settling leaves the page
  // scrolled, and viewport-relative boxes then put a sticky header over whatever content
  // sits behind it.
  const { elements: ariaElements } = await takePageSnapshot(page);
  const html = await page.content();
  const domHash = createHash('sha256').update(html).digest('hex');

  const { tiles, totalHeight, truncated } = await captureOverviewTiles(page, (i) => join(session.evidenceDir, `page-tile-${i}.png`), { maxTiles: B1_MAX_TILES });

  // ── AI: section map ────────────────────────────────────────────────────
  // The tiles ARE sent: the prompt tells the model it has screenshots, and a
  // section map drawn from the outline alone misses purely visual boundaries
  // (a colour band, a divider) that the outline cannot show.
  const images: LlmImage[] = [];
  if (session.aiMode !== 'no-api') {
    for (const [i, tile] of tiles.entries()) {
      images.push({ png: await readFile(tile.path), caption: `Screenshot tile ${i + 1} of ${tiles.length} — page y=${tile.scrollY}..${tile.scrollY + tile.height}` });
    }
  }
  const outline = compactOutline(ariaElements, { viewportWidth: page.viewportSize()?.width ?? 1440 });
  const truncation: B1Output['coverage']['truncation'] = [];
  if (truncated) truncation.push({ what: 'page screenshots', detail: `${tiles.length} tiles cover the top ${tiles.length * (page.viewportSize()?.height ?? 900)}px of a ${totalHeight}px page` });
  if (session.aiMode !== 'no-api' && outline.sent < outline.total) {
    truncation.push({ what: 'B1 outline', detail: `${outline.sent} of ${outline.total} structural lines sent; nothing below y=${outline.lastY} was offered for sectioning` });
  }

  // no-api (Decision Log #31): the section map comes from the DOM's own structure — the
  // section spine under the page's wrappers — instead of a model reading the outline.
  const { data, omittedImages } =
    session.aiMode === 'no-api'
      ? { data: { sections: deterministicSections(ariaElements, { pageHeight: totalHeight, viewportWidth: page.viewportSize()?.width ?? 1440 }) }, omittedImages: [] }
      : await session.llm.structured({
          nodeId: 'B1',
          system: SYSTEM,
          prompt:
            `URL: ${session.url}\n\nPage height ${totalHeight}px; the screenshot tiles above cover it top to bottom${truncated ? ' (TRUNCATED — the lower part of the page is not pictured, use the outline for it)' : ''}.\n\n` +
            `Structural outline (ref role "name" [y=top h=height]):\n${outline.text}\n\nDivide this page into its top-level sections.`,
          images,
          schema: B1SectionsSchema,
          effort: 'medium',
        });

  for (const omitted of omittedImages ?? []) truncation.push({ what: 'B1 screenshot', detail: `${omitted} — not sent to the model` });

  const byRef = new Map(ariaElements.map((e) => [e.ref, e]));
  const droppedRefs: B1Output['coverage']['droppedRefs'] = [];
  const sections: SectionInfo[] = [];
  for (const s of data.sections) {
    const ref = normalizeRef(s.rootRef);
    const cited = ref ? byRef.get(ref) : undefined;
    if (!ref || !cited) {
      droppedRefs.push({ node: 'B1', ref: s.rootRef, reason: `section "${s.name}" rooted at a ref that is not in the page's snapshot` });
      continue;
    }
    const root = promoteToContainer(cited, ariaElements, totalHeight);
    const existing = sections.find((x) => x.rootRef === root.ref);
    if (existing) {
      // Two answers resolved to the same container (e.g. two headings inside one block) — one section, both names kept.
      existing.note = `${existing.note ? `${existing.note} · ` : ''}also named "${s.name}"`;
      continue;
    }
    sections.push({
      id: `s${sections.length}`,
      name: s.name,
      kind: s.kind,
      rootRef: root.ref,
      personalized: s.personalized,
      isListing: s.isListing,
      note: root === cited ? s.note : `${s.note ? `${s.note} · ` : ''}root promoted from ${cited.role} ${ref} to its container ${root.ref}`,
      box: root.box,
    });
  }

  // A section map that resolves to nothing is a malformed answer, not an empty
  // page: retry it (§2.4 REPAIRABLE) instead of completing an audit of nothing.
  if (data.sections.length > 0 && sections.length === 0) {
    throw new RepairableError(`B1: none of the ${data.sections.length} sections the model returned resolved to an element on the page`);
  }

  return {
    sections,
    ariaElements,
    domHash,
    tiles: tiles.map((t) => ({ path: t.path, scrollY: t.scrollY })),
    coverage: {
      sectionsAnalyzed: sections.length,
      componentsDetected: 0,
      excludedPersonalized: sections.filter((s) => s.personalized).length,
      excludedOffDomain: 0,
      sampledListings: [],
      unexpandedStates,
      droppedRefs,
      truncation,
    },
  };
}
