import type { Finding } from '../audit-link/index.ts';
import type { AppliedEdit, IterationRecord } from '../agents/types.ts';
import type { TargetedEdit } from '../llm/schemas/r-nodes.ts';
import { coveredProperties } from '../fidelity/compare.ts';
import type { MappingEntry } from '../mapping/types.ts';
import { POLICY_REFUSAL } from '../redesign-policy.ts';
import { stateOfEdit } from '../resolution/progress.ts';
import type { ResolutionFile } from '../resolution/schema.ts';
import type { DesignMode } from '../session/types.ts';
import { planAccordionIslands } from './accordion-islands.ts';
import { planArrowLinkIslands, planBadgeIslands, planCtaButtonIslands } from './structural.ts';
import { ctaStyleFor, surfaceOf } from './cta-variant.ts';
import type { DesignDecisionsFile, ElementLayout, ExpectedScope, ExtractedSection, IslandSpec, PreviewNode } from './types.ts';

/** Pure planning for the React Preview: what must be rendered, which elements become design-system islands, and how each finding is routed. */

const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
const GLOBAL = new Set(['header', 'footer']);

/**
 * The sections a run must render, derived ONLY from the audit data and the Fix Plan — never from
 * the mapper's stamping — so a stamping defect cannot also corrupt the thing used to check it.
 * Ids follow the same slug + first-seen collision rule the mapper uses to stamp wrappers.
 */
export function expectedScope(mode: DesignMode, allFindings: Finding[], fixFindings: Finding[]): ExpectedScope {
  const used = new Set<string>();
  const idByName = new Map<string, string>();
  for (const f of allFindings) {
    const name = f.location.section;
    if (idByName.has(name)) continue;
    let id = slug(name);
    let n = 2;
    while (used.has(id)) id = `${slug(name)}-${n++}`;
    used.add(id);
    idByName.set(name, id);
  }
  const isGlobal = (name: string) => GLOBAL.has(name.trim().toLowerCase());
  const globalSectionIds = [...idByName].filter(([name]) => isGlobal(name)).map(([, id]) => id);
  const fixBySection: Record<string, string[]> = {};
  for (const f of fixFindings) {
    if (isGlobal(f.location.section)) continue;
    const id = idByName.get(f.location.section) ?? slug(f.location.section);
    (fixBySection[id] ??= []).push(f.identity.findingId);
  }
  const contentIds = [...idByName].filter(([name]) => !isGlobal(name)).map(([, id]) => id);
  const expectedSectionIds = mode === 'full-page' ? contentIds : contentIds.filter((id) => (fixBySection[id]?.length ?? 0) > 0);
  const forbiddenSectionIds = [...contentIds.filter((id) => !expectedSectionIds.includes(id)), ...globalSectionIds];
  return { mode, expectedSectionIds, forbiddenSectionIds, fixFindingsBySection: fixBySection, globalSectionIds };
}

export function sectionIdForName(allFindings: Finding[], name: string): string {
  return expectedScope('full-page', allFindings, []).expectedSectionIds.find((id) => id === slug(name)) ?? slug(name);
}

/** One property/state a re-plan pass was asked to fix (`IterationRecord.reopened`). */
type Reopened = NonNullable<IterationRecord['reopened']>[number];

/** The applied style edits of a re-plan pass that correct one reopened item: its finding and state, the item's property or a longhand of it. */
function correctionsFor(it: IterationRecord, r: Reopened): TargetedEdit[] {
  const scope = coveredProperties(r.property);
  return it.applied.applied
    .filter((a) => a.applied && a.edit.findingId === r.findingId && a.edit.kind === 'style' && a.edit.property && stateOfEdit(a.edit) === r.state && scope.has(a.edit.property.trim().toLowerCase()))
    .map((a) => a.edit);
}

const STATE_SUFFIX = /:(hover|focus-visible|focus-within|focus|active)\s*$/;
const BARE_STAMP = /^\[data-fra-element="[^"]*"\]$/;

/**
 * Whether a correction at `corrected` takes the place of an earlier edit at `earlier`: the earlier edit sits on the bare stamp AND the failing target is the
 * element itself (the correction is its descendant-selector cure; for a label or descendant part the stamp edit still satisfies the element's own target and
 * the other children that inherit it), on the very same selector, or on an ancestor of the correction's selector (a descendant or child combinator follows
 * it). An edit on a sibling or a deeper descendant is a different element's edit and stays. The state suffix is compared separately.
 * A failure whose part is NULL (a fidelity regression names none) is NOT the element itself: its restore usually lands on the descendant an inherited property leaked into,
 * while the stamp edit still satisfies the element's own target. Only a restore on the stamp's own selector replaces that edit then. (A record with no `part` field at all
 * predates parts and always meant the element itself.)
 */
function overrides(earlier: string, corrected: string, ownElement: boolean): boolean {
  const e = earlier.trim().replace(STATE_SUFFIX, '').trim();
  const c = corrected.trim().replace(STATE_SUFFIX, '').trim();
  // the bare stamp is an ancestor of every descendant correction, so it is retired by one only when the failing target is the element itself
  if (BARE_STAMP.test(e)) return ownElement || e === c;
  return e === c || (c.startsWith(e) && /^[\s>]/.test(c.slice(e.length)));
}

/**
 * The edits R4 applied that are still in force (later iterations win), ready to be replayed on the stand-in page.
 * A pass that re-planned from rendered-preview feedback (`reopened`) also RETIRES the earlier edits it corrected: an edit of the reopened finding,
 * state and property (or a longhand of it) is superseded by an applied edit of the same pass that covers the property AND overrides it. The usual
 * cure for "does not reach the visible element" is a different (descendant) selector that the same-key rule would never replace, so the correction
 * replaces the bare-stamp edit (when the failing target is the element itself, not a label or descendant part) and the edits on its own selector or an
 * ancestor of it (see `overrides`); the same property on a sibling descendant is a different element and stays. Edits of other properties, states and findings stay too; a correction that was refused or matched nothing
 * retires nothing.
 */
export function finalAppliedEdits(iterations: IterationRecord[]): TargetedEdit[] {
  const byKey = new Map<string, AppliedEdit>();
  for (const it of iterations) {
    for (const r of it.reopened ?? []) {
      const scope = coveredProperties(r.property);
      const corrections = correctionsFor(it, r);
      const ownElement = r.part === undefined || r.part === 'self';
      for (const [key, old] of byKey) {
        const p = old.edit.property?.trim().toLowerCase();
        if (old.edit.findingId !== r.findingId || old.edit.kind !== 'style' || !p || !scope.has(p) || stateOfEdit(old.edit) !== r.state) continue;
        if (corrections.some((c) => coveredProperties(c.property!).has(p) && overrides(old.edit.selector, c.selector, ownElement))) byKey.delete(key);
      }
    }
    for (const a of it.applied.applied) if (a.applied) byKey.set(`${a.edit.findingId}|${a.edit.kind}|${a.edit.selector}|${a.edit.property ?? ''}`, a);
  }
  return [...byKey.values()].map((a) => a.edit);
}

/** The applied style edits of a re-plan pass that correct what the rendered preview failed: the ones that supersede earlier edits. */
export function correctingEdits(it: IterationRecord): TargetedEdit[] {
  return [...new Set((it.reopened ?? []).flatMap((r) => correctionsFor(it, r)))];
}

/**
 * The CSS properties each finding carries besides the edits planned for it: the audit's measured mismatches and the Resolver's targets. The planner's usual
 * conflict gap ("pick one mismatch, put the OTHER in unaddressed") names a property that was deliberately NOT edited, which only these can tell apart from a
 * reason about the finding as a whole.
 */
export function findingProperties(findings: readonly Finding[], resolution: ResolutionFile | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (findingId: string, property: string) => {
    const p = property.trim().toLowerCase();
    if (p) out.set(findingId, [...new Set([...(out.get(findingId) ?? []), p])]);
  };
  for (const f of findings) for (const m of f.comparison.mismatches) add(f.identity.findingId, m.property);
  for (const t of resolution?.targets ?? []) add(t.findingId, t.property);
  return out;
}

/** Whether `reason` names `property` (lower-case) as a whole word, not inside a longer hyphenated run. A literal search: properties of non-style edits are arbitrary strings, never a pattern. */
function mentions(reason: string, property: string): boolean {
  const text = reason.toLowerCase();
  const word = /[\w-]/;
  for (let at = text.indexOf(property); at !== -1; at = text.indexOf(property, at + 1)) {
    if (!word.test(text[at - 1] ?? '') && !word.test(text[at + property.length] ?? '')) return true;
  }
  return false;
}

/**
 * Whether an earlier planner gap still stands after a reopened pass corrected `reopened` for its finding. A project-policy refusal always stands
 * (a correction of another property says nothing about why the policy refused). A reason that names a property is scoped to the properties it names: it stands
 * while ANY of them is neither reopened nor edited (`landed`), and is closed only when every property it names was corrected or addressed. The planner's usual
 * conflict reason names both sides ("margin-top conflicts with padding-left"): the corrected side must not take the explanation of the deliberately unedited one with it.
 * A reason naming none is about the finding's earlier plan as a whole and is closed by the correction.
 * "Names" is a whole-word match against the properties this finding was planned, reopened or measured for (`known`), a shorthand and its longhands counting as one property.
 */
function gapStands(reason: string, reopened: ReadonlySet<string>, landed: ReadonlySet<string>, known: ReadonlySet<string>): boolean {
  if (reason.startsWith(POLICY_REFUSAL)) return true;
  const settled = (q: string) => [...coveredProperties(q)].some((c) => reopened.has(c) || landed.has(c));
  return [...known].some((q) => mentions(reason, q) && !settled(q));
}

/**
 * The planner's recorded conflicts that are still in force: for each finding, the LAST iteration that
 * planned it decides — listed as unaddressed there means a known, explained gap; planned with edits only
 * means the gap was closed. A pass that re-planned from preview feedback and landed a correction for EVERY item it reopened for a finding
 * closes that finding's gap about the reopened properties: whatever it refused beside the correction ("outside the preview feedback scope", a re-emitted edit)
 * must not stay behind to explain away a target that still fails in the preview. Gaps that are also about another, unedited property stay (see `gapStands`), and
 * so does what the pass itself refused for them. A reopened item left uncorrected keeps the pass's reason. One entry per finding; its reasons are joined.
 * `declared` adds the properties a finding carries that no plan edit or reopened item named (see `findingProperties`).
 */
export function finalPlannerGaps(iterations: IterationRecord[], declared: ReadonlyMap<string, readonly string[]> = new Map()): Array<{ findingId: string; reason: string }> {
  const out = new Map<string, string[]>();
  for (const it of iterations) {
    const un = it.plan.plan.unaddressed;
    const reopened = it.reopened ?? [];
    const corrected = new Set(reopened.filter((r) => reopened.filter((x) => x.findingId === r.findingId).every((x) => correctionsFor(it, x).length > 0)).map((r) => r.findingId));
    for (const e of it.plan.plan.edits) if (!corrected.has(e.findingId) && !un.some((u) => u.findingId === e.findingId)) out.delete(e.findingId);
    for (const id of corrected) {
      const reopenedProps = new Set(reopened.filter((r) => r.findingId === id).flatMap((r) => [...coveredProperties(r.property)]));
      const known = new Set([
        ...(declared.get(id) ?? []),
        ...iterations.flatMap((x) => [...x.plan.plan.edits.filter((e) => e.findingId === id && e.kind === 'style').map((e) => e.property), ...(x.reopened ?? []).filter((r) => r.findingId === id).map((r) => r.property)]).flatMap((p) => (p?.trim() ? [p.trim().toLowerCase()] : [])),
      ]);
      // (tolerant of a record without its applied list: only a pass that applied edits can have landed any)
      const landed = new Set(iterations.flatMap((x) => x.applied.applied ?? []).filter((a) => a.applied && a.edit.findingId === id && a.edit.kind === 'style' && a.edit.property).flatMap((a) => [...coveredProperties(a.edit.property!)]));
      const stands = (reason: string) => gapStands(reason, reopenedProps, landed, known);
      const kept = [...new Set([...(out.get(id) ?? []), ...un.filter((u) => u.findingId === id).map((u) => u.reason)].filter(stands))];
      if (kept.length > 0) out.set(id, kept);
      else out.delete(id);
    }
    const replaced = new Map<string, string[]>();
    for (const u of un) if (!corrected.has(u.findingId)) replaced.set(u.findingId, [...new Set([...(replaced.get(u.findingId) ?? []), u.reason])]);
    for (const [id, reasons] of replaced) out.set(id, reasons);
  }
  return [...out].map(([findingId, reasons]) => ({ findingId, reason: reasons.join(' | ') }));
}

// ── Islands ───────────────────────────────────────────────────────────────────────────────

export interface IslandPlan {
  slot: string;
  stamp: string;
  sectionId: string;
  findingIds: string[];
  spec: IslandSpec;
  label: string;
  basis: 'decision' | 'audit-match' | 'structural';
  /** How the replaced element sat in its parent, kept on the island's wrapper so surrounding layout is unchanged. */
  layout: ElementLayout;
  /** AccordionItem: the original answer content, emitted as the component's `answer`. */
  answer?: PreviewNode[];
}

export interface IslandSkip { findingIds: string[]; reason: string }

function parentOf(root: PreviewNode, stamp: string): (PreviewNode & { t: 'el' }) | null {
  if (root.t !== 'el') return null;
  if (root.children.some((c) => c.t === 'el' && c.elementStamp === stamp)) return root;
  for (const c of root.children) { const r = parentOf(c, stamp); if (r) return r; }
  return null;
}
function findNode(root: PreviewNode, stamp: string): (PreviewNode & { t: 'el' }) | null {
  if (root.t !== 'el') return null;
  if (root.elementStamp === stamp) return root;
  for (const c of root.children) { const r = findNode(c, stamp); if (r) return r; }
  return null;
}
const textOf = (n: PreviewNode): string => (n.t === 'text' ? n.v : n.children.map(textOf).join(''));
const hasSvg = (n: PreviewNode): boolean => n.t === 'el' && (n.tag === 'svg' || n.children.some(hasSvg));
const normText = (s: string) => s.replace(/\s+/g, ' ').trim();

const BUTTON_VARIANTS = new Set(['brand', 'secondary', 'ghost']);

export function planIslands(args: { sections: ExtractedSection[]; entries: MappingEntry[]; findings: Finding[]; decisions: DesignDecisionsFile | null; dsFirst?: boolean }): { plans: IslandPlan[]; skipped: IslandSkip[] } {
  const plans: IslandPlan[] = [];
  const skipped: IslandSkip[] = [];
  // DS-first: FAQ rows become the design system's AccordionItem; elements inside a replaced row are not planned again
  const accordion = args.dsFirst ? planAccordionIslands(args.sections) : { plans: [] as IslandPlan[], covered: new Set<string>() };
  plans.push(...accordion.plans);
  const byId = new Map(args.findings.map((f) => [f.identity.findingId, f]));
  let n = 0;
  for (const section of args.sections) {
    for (const fe of section.findingElements) {
      if (!fe.stamp || accordion.covered.has(fe.stamp)) continue;
      const node = findNode(section.tree, fe.stamp);
      if (!node) continue;
      const fids = fe.findingIds.filter((id) => byId.has(id));
      if (fids.length === 0) continue;
      const label = normText(textOf(node));

      // 1) an explicit design decision wins
      const decided = fids.map((id) => args.decisions?.findings[id]?.island).find(Boolean);
      if (decided) {
        plans.push({ slot: `island${++n}`, stamp: fe.stamp, sectionId: section.id, findingIds: fids, spec: decided, label, basis: 'decision', layout: fe.layout });
        continue;
      }
      // a recorded decision to keep the original means: no island
      if (fids.some((id) => args.decisions?.findings[id]?.resolution === 'preserve-existing')) continue;

      // 2) the audit's own verified match, only for the two components whose props are derived deterministically
      const targets = fids.map((id) => byId.get(id)!.component);
      const comps = new Set(targets.map((c) => c.dsComponent));
      if (comps.size !== 1) continue;
      const dsComponent = [...comps][0];
      const dsVariant = targets.find((c) => c.dsVariant)?.dsVariant ?? '';
      if (dsComponent === 'Button') {
        const m = /^(\w+)\s*·\s*(\w+)\s*·\s*(\w+)/.exec(dsVariant);
        if (!m) continue;
        const [, matchedVariant, size, background] = m as unknown as [string, string, string, string];
        // DS-first: the audit's `primary` is the black CTA this project prohibits; the project's own rule is `brand` for a primary action
        const variant = args.dsFirst && matchedVariant === 'primary' && (node.tag === 'a' || node.tag === 'button') ? 'brand' : matchedVariant;
        if (!BUTTON_VARIANTS.has(variant)) { skipped.push({ findingIds: fids, reason: variant === 'primary' ? 'the audit matched Button primary, which is the black CTA this project prohibits; no automatic substitute (use a design decision)' : `Button variant "${variant}" is not one the generator substitutes automatically` }); continue; }
        if (node.tag !== 'a' && node.tag !== 'button') { skipped.push({ findingIds: fids, reason: `the stamped element is <${node.tag}>, not the interactive container, so it is not replaced by a Button` }); continue; }
        if (!label) continue;
        // DS-first: the variant/background come from what the original element IS (see cta-variant.ts), not only from the audit's guess
        const cta = args.dsFirst ? ctaStyleFor(node, byId.get(fids[0]!)!, { variant, background }, surfaceOf(byId.get(fids[0]!)!.location.section, args.findings)) : null;
        const props: Record<string, string | number | boolean> = { variant: cta?.variant ?? variant, size, background: cta?.background ?? background };
        if (node.tag === 'a' && node.attrs['href']) props['href'] = node.attrs['href'];
        if (hasSvg(node)) props['animatedArrow'] = true;
        if (fe.layout.fullWidth) props['fullWidth'] = true;
        plans.push({ slot: `island${++n}`, stamp: fe.stamp, sectionId: section.id, findingIds: fids, spec: { component: 'Button', props }, label, basis: 'audit-match', layout: fe.layout });
      } else if (dsComponent === 'InlineLink' && args.dsFirst) {
        // The audit matched InlineLink, but the DS's own doc reserves InlineLink for links INSIDE a paragraph; a standalone "text + arrow" link
        // ("Read More ↗") is CTALink (atoms/CTALink.md: "Exploratory navigation · Learn more →").
        if (node.tag !== 'a' || !node.attrs['href'] || !label) continue;
        if (!hasSvg(node)) { skipped.push({ findingIds: fids, reason: 'the audit matched InlineLink and the link has no arrow, so it is a text link inside prose: InlineLink is kept as the audit matched it (not mounted)' }); continue; }
        const surface = surfaceOf(byId.get(fids[0]!)!.location.section, args.findings);
        const props: Record<string, string | number | boolean> = { size: 'md', href: node.attrs['href'] };
        if (surface === 'dark') props['onDark'] = true;
        plans.push({ slot: `island${++n}`, stamp: fe.stamp, sectionId: section.id, findingIds: fids, spec: { component: 'CTALink', props }, label, basis: 'audit-match', layout: fe.layout });
      } else if (dsComponent == null && args.dsFirst && byId.get(fids[0]!)!.component.productionType === 'icon-button' && !label && hasSvg(node)) {
        // a carousel's previous/next pair: two icon-only controls side by side. The DS builds that control in ui/carousel; the first is "previous".
        const parent = parentOf(section.tree, fe.stamp);
        const pair = (parent?.children ?? []).filter((c): c is Extract<PreviewNode, { t: 'el' }> => c.t === 'el' && !normText(textOf(c)) && hasSvg(c));
        const at = pair.findIndex((c) => c.elementStamp === fe.stamp);
        if (pair.length !== 2 || at < 0) { skipped.push({ findingIds: fids, reason: 'an icon-only control that is not one of a previous/next pair: no design-system component matches it (the DS has no round step control), the original is kept' }); continue; }
        plans.push({ slot: `island${++n}`, stamp: fe.stamp, sectionId: section.id, findingIds: fids, spec: { component: 'CarouselArrow', props: { direction: at === 0 ? 'prev' : 'next' } }, label: '', basis: 'audit-match', layout: fe.layout });
      } else if (dsComponent === 'SectionHeading') {
        const m = /level\s*(\d)/i.exec(dsVariant);
        if (!m || !/^h[1-6]$/.test(node.tag) || !label) continue;
        const align = fe.textAlign === 'center' ? 'center' : fe.textAlign === 'right' || fe.textAlign === 'end' ? 'right' : 'left';
        plans.push({ slot: `island${++n}`, stamp: fe.stamp, sectionId: section.id, findingIds: fids, spec: { component: 'SectionHeading', props: { level: Number(m[1]), align } }, label, basis: 'audit-match', layout: fe.layout });
      }
    }
  }
  // DS-first: arrow links no finding is mapped to ("Read More ↗") are the DS's CTALink (structural.ts); a mapped link keeps its finding's route above
  if (args.dsFirst) {
    const links = planArrowLinkIslands(args.sections, new Set(plans.map((p) => p.stamp)));
    const ctas = planCtaButtonIslands(args.sections, new Set([...plans.map((p) => p.stamp), ...links.map((p) => p.stamp)]), links.length);
    plans.push(...links, ...ctas, ...planBadgeIslands(args.sections, new Set(plans.map((p) => p.stamp)), links.length + ctas.length));
  }
  return { plans, skipped };
}

// ── Routing ───────────────────────────────────────────────────────────────────────────────

export type Route = 'css-edit' | 'island' | 'override' | 'original' | 'none';

export function routeFindings(args: { fixFindings: Finding[]; entries: MappingEntry[]; edits: TargetedEdit[]; islands: IslandPlan[]; sectionIdByName: (name: string) => string; overrides: Record<string, string> }): Map<string, { route: Route; sectionId: string; stamp: string | null }> {
  const out = new Map<string, { route: Route; sectionId: string; stamp: string | null }>();
  for (const f of args.fixFindings) {
    const id = f.identity.findingId;
    const sectionId = args.sectionIdByName(f.location.section);
    const entry = args.entries.find((e) => e.findingIds.includes(id));
    const stamp = entry?.stamp ?? null;
    let route: Route = 'none';
    if (args.overrides[sectionId]) route = 'override';
    else if (args.islands.some((i) => i.findingIds.includes(id))) route = 'island';
    else if (!entry) route = 'none';
    else if (args.edits.some((e) => e.findingId === id)) route = 'css-edit';
    else route = 'original';
    out.set(id, { route, sectionId, stamp });
  }
  return out;
}
