import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { B2ComponentsSchema, type B2Components } from '../../llm/schemas/b-nodes.ts';
import { COMPONENT_TYPES, componentSignature, isOffDomainUtilityLink } from '../../skills/s3-component-taxonomy.ts';
import { normalizeConfidence } from '../../skills/s8-confidence-escalation-policy.ts';
import { assignElementFindingIds, elementFingerprint, locatorFor, stampRef } from '../../t-layer/element-registry.ts';
import { extractComputedStyle } from '../../t-layer/computed-style.ts';
import { captureContext, captureElement, captureSectionSlices } from '../../t-layer/screenshot.ts';
import { readDomFacts, type DomFacts } from '../../t-layer/dom-facts.ts';
import { classifyCandidate, selectCandidates } from './deterministic.ts';
import { normalizeRef } from '../refs.ts';
import type { AriaElement } from '../../t-layer/element-registry.ts';
import type { LlmImage } from '../../llm/client.ts';
import type { NodeContext } from '../../graph/engine.ts';
import type { B1Output, B2Output, DetectedComponent, PageSession, SectionInfo } from '../types.ts';

/**
 * B2 — Component Detector (v1.0 §4, ARCHITECTURE.md §5.2). Identifies
 * components inside each section and — critically — captures ALL evidence
 * while each element is still resolvable: the stamped reference, the
 * fingerprint, the computed style and the screenshots. B4 and B5 then work
 * from that evidence and never re-derive a selector, which is the validated
 * failure this contract prevents (a naive re-query grabbed a zero-padding
 * wrapper instead of the real button and produced a confident, wrong finding).
 *
 * Detection uses combined DOM + rendered-visual evidence, never role alone:
 * verified on the real site that meaningful controls carry no ARIA role at
 * all (a "Select Industry" dropdown was a bare input; "Sign in"/"Sign up"
 * are `generic [cursor=pointer]` divs). The section's screenshot is SENT —
 * the prompt tells the model it has one.
 */

/** How many instances of one repeated group are audited before sampling kicks in (§2.7 bounded listing sampling). */
export const LISTING_SAMPLE_LIMIT = 5;

/**
 * Lines per B2 call. A section larger than this is split across calls rather
 * than cut: the old 160-line slice silently never showed the model the lower
 * part of any large section.
 */
export const SECTION_CHUNK_LINES = 700;

const SYSTEM = `You are the Component Detector (B2) of a Design System compliance audit.
Given one section of a rendered page — its accessibility-tree lines (each with a ref) and screenshot(s) of the section — identify the UI components inside it.
Rules:
- Use BOTH DOM signals and what the screenshot shows. Never rely on ARIA role alone: this site has meaningful controls with no role (clickable generic divs with cursor=pointer, plain inputs acting as dropdowns).
- Every component you return MUST cite a ref that appears in the supplied lines. Answer with the bare ref (e.g. "e42").
- componentType must be one of the supplied taxonomy values.
- Give repeated, visually identical items the SAME instanceGroupKey (e.g. every report card in a grid). Leave it empty for a one-off component.
- confidence is a probability between 0 and 1.
- Identify components, not every text node. A paragraph of prose is not a component; a card containing it is.`;

export function sectionElements(elements: AriaElement[], section: SectionInfo): AriaElement[] {
  const box = section.box;
  return elements.filter((e) => {
    if (!e.box || !box) return false;
    return e.box.y >= box.y - 4 && e.box.y + e.box.height <= box.y + box.height + 4;
  });
}

type Detection = B2Components['components'][number];

/** The model path: the section's screenshot(s) and its accessibility tree, in chunks, one call per chunk. */
async function detectWithModel(session: PageSession, section: SectionInfo, elements: AriaElement[], truncation: B2Output['coverage']['truncation']): Promise<Detection[]> {
  // The section's own screenshot(s), sliced when it is taller than one readable image.
  const images: LlmImage[] = [];
  try {
    const shot = await captureSectionSlices(session.page, section.rootRef, (i) => join(session.evidenceDir, `${section.id}-section-${i}.png`));
    for (const [i, slice] of shot.slices.entries()) {
      const caption =
        shot.slices.length === 1
          ? `Screenshot of section "${section.name}"`
          : `Section "${section.name}" — strip ${i + 1} of ${shot.slices.length} (page y=${slice.top}..${slice.top + slice.height})`;
      images.push({ png: await readFile(slice.path), caption });
    }
    if (shot.slices.length === 0) {
      // Zero-size or entirely off-canvas (e.g. a closed mobile drawer): nothing visible to photograph.
      truncation.push({ what: `section "${section.name}" screenshot`, detail: 'section is not visible on the page (zero-size or off-canvas) — identified from the accessibility tree only' });
    } else if (shot.truncated) {
      truncation.push({ what: `section "${section.name}" screenshot`, detail: `${shot.slices.length} strips cover the top ${shot.slices.reduce((n, s) => n + s.height, 0)}px of ${shot.totalHeight}px; the rest was identified from the accessibility tree only` });
    }
  } catch (err) {
    // Not photographable (zero-size, detached, hidden): detect from the DOM, say so in the
    // prompt, and record it — a section judged without its picture is a stated boundary.
    truncation.push({ what: `section "${section.name}" screenshot`, detail: `not capturable (${err instanceof Error ? (err.message.split('\n')[0] ?? '').slice(0, 100) : 'unknown'}) — identified from the accessibility tree only` });
  }

  const detections: Detection[] = [];
  for (let start = 0; start < elements.length; start += SECTION_CHUNK_LINES) {
    const chunk = elements.slice(start, start + SECTION_CHUNK_LINES);
    const part = elements.length > SECTION_CHUNK_LINES ? ` — part ${start / SECTION_CHUNK_LINES + 1} of ${Math.ceil(elements.length / SECTION_CHUNK_LINES)}` : '';
    const { data, omittedImages } = await session.llm.structured({
      nodeId: 'B2',
      system: SYSTEM,
      prompt:
        `Section: "${section.name}" (kind: ${section.kind}${section.isListing ? ', large listing — expect repeated items' : ''})${part}\n\n` +
        (images.length === 0 ? 'NOTE: no screenshot could be captured for this section — identify from the accessibility tree only, and say so in visualSignals.\n\n' : '') +
        `Component taxonomy: ${COMPONENT_TYPES.join(', ')}\n\n` +
        `Accessibility tree for this section:\n${chunk.map((e) => e.line).join('\n')}\n\nIdentify the components.`,
      ...(start === 0 ? { images } : {}),
      schema: B2ComponentsSchema,
      effort: 'medium',
    });
    for (const omitted of omittedImages ?? []) truncation.push({ what: `section "${section.name}" screenshot`, detail: `${omitted} — not sent to the model` });
    detections.push(...data.components);
  }
  return detections;
}

/**
 * The no-api path (Decision Log #31): candidates from the section's own
 * accessibility tree (controls, headings, clickable elements), each typed from
 * its role and its OWN computed style — a link painted as a button is a
 * button — with a confidence that says how certain that typing is. Nothing is
 * inferred from pixels.
 */
async function detectDeterministically(
  session: PageSession,
  section: SectionInfo,
  elements: AriaElement[],
  allElements: AriaElement[],
  state: {
    factsByRef: Map<string, DomFacts>;
    unresolvable: Set<string>;
    claimedRefs: Set<string>;
    droppedRefs: B2Output['coverage']['droppedRefs'];
    offCanvas: Set<string>;
    visuallyHidden: Set<string>;
    merged: Map<string, string>;
  },
): Promise<Detection[]> {
  const viewportWidth = session.page.viewportSize()?.width ?? 1440;
  const { candidates, offCanvas, visuallyHidden, merged } = selectCandidates(elements, { viewportWidth, allElements });
  for (const el of offCanvas) state.offCanvas.add(el.ref);
  for (const el of visuallyHidden) state.visuallyHidden.add(el.ref);
  for (const m of merged) state.merged.set(m.ref, m.reason);
  const byRef = new Map(allElements.map((e) => [e.ref, e]));
  const inNavigation = (el: AriaElement): boolean => {
    for (let ref = el.parentRef; ref; ref = byRef.get(ref)?.parentRef ?? null) {
      if (byRef.get(ref)?.role === 'navigation') return true;
    }
    return false;
  };

  // Off-canvas elements (inactive carousel slides, closed drawers) ARE on the page — only not in
  // view at this instant. They are audited from their computed styles like any other element, so
  // the audited set does not depend on which slide happened to be showing (a slide that rotated
  // out would otherwise read as RESOLVED on the next run); they just cannot be pictured.
  const offCanvasRefs = new Set(offCanvas.map((el) => el.ref));
  const detections: Detection[] = [];
  for (const el of [...candidates, ...offCanvas]) {
    // An overlapping section already decided this element.
    if (state.claimedRefs.has(el.ref) || state.unresolvable.has(el.ref)) continue;
    let facts = state.factsByRef.get(el.ref);
    if (!facts) {
      try {
        facts = await readDomFacts(session.page.locator(`aria-ref=${el.ref}`));
      } catch (err) {
        state.unresolvable.add(el.ref);
        state.droppedRefs.push({ node: 'B2', ref: el.ref, reason: `"${el.name.slice(0, 40)}" (${el.role}) could not be read at capture time (${err instanceof Error ? (err.message.split('\n')[0] ?? '').slice(0, 80) : 'unknown'})` });
        continue;
      }
      state.factsByRef.set(el.ref, facts);
    }
    const typed = classifyCandidate(el, facts, { inNavigation: inNavigation(el) });
    if (!typed) continue;
    if (offCanvasRefs.has(el.ref)) typed.domSignals.push('off-canvas (inactive carousel slide / closed drawer) — measured from computed styles, not pictured');
    detections.push({ ref: el.ref, ...typed });
  }
  return detections;
}

export async function runB2(ctx: NodeContext, input: B1Output & { session: PageSession }): Promise<B2Output> {
  const session = input.session;
  const components: Array<Omit<DetectedComponent, 'findingId'>> = [];
  const sampledListings: B2Output['coverage']['sampledListings'] = [];
  const droppedRefs = [...input.coverage.droppedRefs];
  const truncation = [...input.coverage.truncation];
  let excludedOffDomain = 0;
  const auditedOrigin = new URL(session.url).origin;

  // Idempotent under retry (§2.4): a failed attempt leaves its data-audit-el stamps in
  // the live DOM, and a retry that assigns the same id to a different element would
  // then match two elements and fail on a strict-mode violation.
  await session.page.evaluate(() => document.querySelectorAll('[data-audit-el]').forEach((el) => el.removeAttribute('data-audit-el')));

  // A section map is semantic, not a partition: an outer section and one nested
  // inside it legitimately overlap, so the same element can be offered twice.
  // First detection wins — otherwise one element yields duplicate components,
  // duplicate findings and a double-counted compliance denominator.
  const claimedRefs = new Set<string>();
  // Refs that already failed to resolve: an overlapping section offering one again must not
  // retry it (another 2s timeout) or record the same drop twice.
  const unresolvable = new Set<string>();
  // Refs already excluded (off-domain) or sampled out: an overlapping section offering them
  // again must not re-count the exclusion or restart the listing sample.
  const excludedRefs = new Set<string>();
  const sampledOutRefs = new Set<string>();
  // Listing sampling counts per (section, model group key): the key is the model's free
  // text from separate per-section calls, so two sections' "service-card" groups are not
  // the same group. The ref sets above still stop an OVERLAPPING section from re-counting
  // or re-auditing the same elements.
  const groupCounts = new Map<string, number>();
  const modelGroups = new Map<string, { section: string; key: string; example: string }>();
  const byRef = new Map(input.ariaElements.map((e) => [e.ref, e]));
  // no-api: each candidate's DOM facts, read once at detection and kept as evidence.
  const factsByRef = new Map<string, DomFacts>();
  const offCanvas = new Set<string>();
  const visuallyHidden = new Set<string>();
  const merged = new Map<string, string>();

  for (const section of input.sections) {
    // §2.7: personalized sections are audited in their cold-start form only, so they are
    // explicitly out of compliance scope rather than judged as if they were typical.
    if (section.personalized) continue;

    const elements = sectionElements(input.ariaElements, section);
    if (elements.length === 0) continue;
    const offered = new Set(elements.map((e) => e.ref));

    // Where this section's detections come from: the model reading the section's tree and
    // picture, or — in no-api mode (Decision Log #31) — the deterministic detector reading
    // each candidate's own DOM facts. Everything after this point is shared.
    const detections =
      session.aiMode === 'no-api'
        ? await detectDeterministically(session, section, elements, input.ariaElements, { factsByRef, unresolvable, claimedRefs, droppedRefs, offCanvas, visuallyHidden, merged })
        : await detectWithModel(session, section, elements, truncation);

    for (const detected of detections) {
      const ref = normalizeRef(detected.ref);
      const aria = ref ? byRef.get(ref) : undefined;
      if (!ref || !aria) {
        droppedRefs.push({ node: 'B2', ref: detected.ref, reason: `"${detected.label.slice(0, 40)}" cites a ref that is not in the page's snapshot` });
        continue;
      }
      if (!offered.has(ref)) {
        droppedRefs.push({ node: 'B2', ref, reason: `"${detected.label.slice(0, 40)}" cites a ref outside section "${section.name}"` });
        continue;
      }
      // Already handled via an overlapping section: first decision wins, nothing is re-counted.
      if (claimedRefs.has(ref) || unresolvable.has(ref) || excludedRefs.has(ref) || sampledOutRefs.has(ref)) continue;

      const href = aria.url ?? null;
      if (isOffDomainUtilityLink({ href, auditedOrigin, componentType: detected.componentType, label: detected.label })) {
        excludedRefs.add(ref);
        excludedOffDomain++;
        continue;
      }

      // Bounded listing sampling applies to REPEATED groups only. An empty key means a
      // one-off: it gets its own group, so unique components are never capped.
      const modelKey = detected.instanceGroupKey.trim();
      const groupKey = modelKey ? `${section.id}::${modelKey}` : `unique:${ref}`;
      if ((groupCounts.get(groupKey) ?? 0) >= LISTING_SAMPLE_LIMIT) {
        groupCounts.set(groupKey, (groupCounts.get(groupKey) ?? 0) + 1);
        sampledOutRefs.add(ref);
        continue;
      }

      const elId = `${section.id}-${components.length}`;
      let fingerprint;
      let style;
      try {
        await stampRef(session.page, ref, elId);
        const locator = locatorFor(session.page, elId);
        fingerprint = await elementFingerprint(locator);
        style = await extractComputedStyle(locator);
      } catch (err) {
        // Fail closed per element: the ref no longer resolves (or detached mid-read).
        // Never fall back to a homegrown selector — and never fail the whole node for one element.
        unresolvable.add(ref);
        droppedRefs.push({ node: 'B2', ref, reason: `"${detected.label.slice(0, 40)}" (${detected.componentType}) no longer resolvable at capture time (${err instanceof Error ? (err.message.split('\n')[0] ?? '').slice(0, 80) : 'unknown'})` });
        continue;
      }
      claimedRefs.add(ref);
      groupCounts.set(groupKey, (groupCounts.get(groupKey) ?? 0) + 1);
      if (modelKey && !modelGroups.has(groupKey)) modelGroups.set(groupKey, { section: section.name, key: modelKey, example: detected.label });
      const locator = locatorFor(session.page, elId);

      const elementPath = join(session.evidenceDir, `${elId}-element.png`);
      const contextPath = join(session.evidenceDir, `${elId}-context.png`);
      let elementShot: string | null = null;
      let contextShot: string | null = null;
      let evidenceClipped = false;
      try {
        evidenceClipped = (await captureElement(locator, elementPath)).clipped;
        elementShot = elementPath;
      } catch {
        // A component that cannot be photographed (zero-size, off-canvas) still audits on its measured values.
      }
      try {
        await captureContext(session.page, locator, contextPath);
        contextShot = contextPath;
      } catch {
        /* same */
      }

      const containsPlaceholder = await locator
        .evaluate((el) => el.matches('[data-audit-placeholder]') || el.querySelector('[data-audit-placeholder]') !== null)
        .catch(() => false);

      const styleFacts: Record<string, string> = style.connected
        ? {
            display: style.raw.display ?? '',
            'font-family': style.raw['font-family'] ?? '',
            'border-top-left-radius': style.raw['border-top-left-radius'] ?? '',
          }
        : {};

      const confidence = normalizeConfidence(detected.confidence);
      components.push({
        elId,
        ref,
        sectionId: section.id,
        sectionName: section.name,
        captureState: 'default+expanded-disclosures',
        componentType: detected.componentType,
        label: detected.label,
        domSignals: detected.domSignals,
        visualSignals: detected.visualSignals,
        instanceGroupKey: groupKey,
        detectionConfidence: confidence.value,
        confidenceOutOfContract: confidence.outOfContract,
        fingerprint,
        style,
        signature: componentSignature({
          componentType: detected.componentType,
          structuralPath: fingerprint.structuralPath,
          role: fingerprint.role,
          styleFacts,
        }),
        containsPlaceholder,
        screenshots: { element: elementShot, context: contextShot },
        evidenceClipped,
        href,
        domFacts: factsByRef.get(ref) ?? (await readDomFacts(locator).catch(() => null)),
      });
    }
  }

  // Controls rendered only for assistive tech (sr-only) have no visual design to audit.
  if (visuallyHidden.size > 0) {
    truncation.push({ what: 'visually hidden controls', detail: `${visuallyHidden.size} control(s) rendered for assistive technology only (clipped to ~1px) — no visual design to audit` });
  }
  // The same control rendered twice (a pointer wrapper around a link, coinciding boxes) is audited once.
  if (merged.size > 0) {
    truncation.push({ what: 'merged duplicate controls', detail: `${merged.size} element(s) were the same control as another candidate and were audited once, as that candidate (e.g. ${[...merged.values()][0]})` });
  }
  // Inactive carousel slides and closed drawers sit off-canvas: audited from computed styles, not pictured (§2.7).
  if (offCanvas.size > 0) {
    truncation.push({
      what: 'off-canvas elements',
      detail: `${offCanvas.size} element(s) were entirely outside the ${session.page.viewportSize()?.width ?? 1440}px viewport (inactive carousel slides, closed drawers) — audited from their computed styles; no screenshot of them could be taken`,
    });
  }

  // Only model-declared repeated groups are "sampled listings" (a one-off never is), each reported once.
  for (const [groupKey, group] of modelGroups) {
    const count = groupCounts.get(groupKey) ?? 0;
    // A deterministic group key is a class hash — name the group by its first member instead.
    const name = session.aiMode === 'no-api' ? `${group.key.split(':')[0]} like "${group.example.slice(0, 40)}"` : group.key;
    if (count > LISTING_SAMPLE_LIMIT) sampledListings.push({ section: `${group.section} · ${name}`, sampled: LISTING_SAMPLE_LIMIT, totalObserved: count });
  }

  // Finding ids are assigned once, over the whole page, so two elements never share one.
  const { ids, collisions } = assignElementFindingIds(session.pageId, components.map((c) => c.fingerprint));
  if (collisions > 0) {
    truncation.push({
      what: 'element identity',
      detail: `${collisions} element(s) were indistinguishable from another by structure, role and text — told apart by document order, so their re-audit history follows position`,
    });
  }

  return {
    ...input,
    components: components.map((c, i) => ({ ...c, findingId: ids[i]! })),
    coverage: {
      ...input.coverage,
      componentsDetected: components.length,
      excludedOffDomain,
      sampledListings,
      droppedRefs,
      truncation,
    },
  };
}
