import { buildTypeContext, classifyCandidateOutcome, selectCandidates } from '../b2-component-detector/deterministic.ts';
import type { CandidateClassification, SelectedCandidate, TypeContext } from '../b2-component-detector/deterministic.ts';
import type { VerificationReport } from '../b5-visual-verifier/completeness.ts';
import type { AriaElement } from '../../t-layer/element-registry.ts';
import type { CoverageItemKind, CoverageItemState, CoverageTextRole, Finding } from '../../skills/s0-result-contract.ts';
import type { B2Decision, DetectedComponent, SectionInfo } from '../types.ts';
import type { RawManifestItem } from './manifest.ts';
import { resolveOwner, sectionByGeometry, type OwnerBasis } from './ownership.ts';

/**
 * B7's RECONCILIATION — pure, no page, no model. For every item of the independent manifest it answers one
 * question: where did the audit account for it?
 *
 *   AUDITED               a finding exists for the element (or for the control/heading that owns its words)
 *   EXCLUDED_WITH_REASON  a stage decided not to audit it and said why (sampling, off-domain link, merged
 *                         duplicate, visually hidden, personalised section, not an audit candidate…)
 *   NEEDS_REVIEW          a finding says a human must decide
 *   CAPTURE_FAILED        a stage tried and could not capture or resolve it
 *   UNACCOUNTED           none of the above — a GAP
 *
 * It also decides whether an AUDITED item was audited under the right ROLE, by classifying it again from the
 * whole section hierarchy with B2's OWN classifier over the COMPLETE manifest (including every text B2 never
 * offered), so the check shares B2's rules instead of re-implementing them and can disagree only because it
 * sees more of the page.
 */

export type GapType = 'missing' | 'role' | 'no-finding' | 'family' | 'state';
export interface Gap { type: GapType; detail: string }

export interface IndependentRole {
  /** B2's classification of the item from the complete hierarchy, or null when it is not an audit candidate. */
  classification: CandidateClassification | null;
  /** Why it is not a candidate (B2's own stated reason), when it is not. */
  excluded: string | null;
}

export interface ItemRecord {
  raw: RawManifestItem;
  /** The section's complete text hierarchy this item was classified against — reused when B7 captures the item. */
  typeContext?: TypeContext | undefined;
  sectionId: string | null;
  sectionName: string;
  /** HOW the section was decided (see `ownership.ts`) — the audit's own account of why this item sits where it does. */
  ownerBasis?: OwnerBasis | undefined;
  /** The accessibility-tree element this item is, when the tree lists it. */
  aria: AriaElement | null;
  component: DetectedComponent | null;
  finding: Finding | null;
  independent: IndependentRole | null;
  state: CoverageItemState;
  reason: string;
  gap: Gap | null;
  /** Corrective passes already spent on this item. */
  passes: number;
}

export interface ReconcileState {
  components: DetectedComponent[];
  findings: Finding[];
  ariaElements: AriaElement[];
  sections: SectionInfo[];
  decisions: Record<string, B2Decision>;
  verification?: VerificationReport | undefined;
  viewportWidth: number;
  /** Judge each audited item's ROLE against the whole hierarchy (no-api: the deterministic classifier is what typed it). Default true. */
  checkRoles?: boolean | undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/…$/, '').trim();
const textOfAria = (el: AriaElement): string => norm(el.name || /\]:\s*(.+)$/.exec(el.line)?.[1] || '');

/** Items that have no box (collapsed behind a disclosure) cannot be placed by geometry; everything else sits inside the page's sections. */
export function sectionOf(box: { x: number; y: number; width: number; height: number }, sections: SectionInfo[]): SectionInfo | null {
  return sectionByGeometry(box, sections);
}

/** The accessibility-tree element that is this item: same words, same place. Null when the tree does not list it. */
export function matchAria(item: RawManifestItem, aria: AriaElement[], byBucket: Map<number, AriaElement[]>): AriaElement | null {
  if (item.visibility === 'collapsed' || item.box.width <= 0) return null;
  const text = norm(item.text);
  const bucket = Math.floor(item.box.y / 64);
  let best: { el: AriaElement; score: number } | null = null;
  for (const b of [bucket - 1, bucket, bucket + 1]) {
    for (const el of byBucket.get(b) ?? []) {
      if (!el.box) continue;
      const dx = Math.abs(el.box.x - item.box.x);
      const dy = Math.abs(el.box.y - item.box.y);
      const dw = Math.abs(el.box.width - item.box.width);
      const dh = Math.abs(el.box.height - item.box.height);
      if (dx > 8 || dy > 8 || dw > 12 || dh > 12) continue;
      const at = textOfAria(el);
      const sameText = text !== '' && at !== '' && (at === text || at.startsWith(text.slice(0, 40)) || text.startsWith(at.slice(0, 40)));
      if (!sameText && !(item.kind === 'form-field' || text === '')) continue;
      const score = dx + dy + dw + dh;
      if (!best || score < best.score) best = { el, score };
    }
  }
  return best?.el ?? null;
}

export function bucketAria(aria: AriaElement[]): Map<number, AriaElement[]> {
  const out = new Map<number, AriaElement[]>();
  for (const el of aria) {
    if (!el.box) continue;
    const b = Math.floor(el.box.y / 64);
    const list = out.get(b);
    if (list) list.push(el);
    else out.set(b, [el]);
  }
  return out;
}

/** A synthetic accessibility-tree element for an item the tree does not list — enough for B2's classifier, which reads role, name, line and box. */
export function syntheticAria(item: RawManifestItem): AriaElement {
  const named = item.kind === 'heading' || item.kind === 'control' || item.kind === 'form-field' || item.kind === 'card';
  const box = `[box=${Math.round(item.box.x)},${Math.round(item.box.y)},${Math.round(item.box.width)},${Math.round(item.box.height)}]`;
  const pointer = item.kind !== 'heading' && item.kind !== 'text' && item.facts.cursor === 'pointer' && !['link', 'button', 'tab', 'textbox'].includes(item.role) ? ' [cursor=pointer]' : '';
  const level = item.kind === 'heading' ? ` [level=${/^h([1-6])$/.exec(item.tag)?.[1] ?? '2'}]` : '';
  const line = named
    ? `- ${item.role}${item.text ? ` "${item.text.replace(/"/g, '\\"').slice(0, 120)}"` : ''}${level} [ref=${item.id}] ${box}${pointer}`
    : `- ${item.role} [ref=${item.id}] ${box}${pointer}: ${item.text}`;
  return { ref: item.id, role: item.role, name: named ? item.text.slice(0, 120) : '', box: item.box, line, depth: 0, parentRef: null };
}

const TEXT_KINDS: ReadonlySet<CoverageItemKind> = new Set(['heading', 'text', 'badge']);

/**
 * The component the audit captured FOR THIS ITEM, read from the stamps it left on the DOM — never a lookup in B2's
 * candidate list. An item's own element always counts. For WORDS (a heading, a text block, a badge) so does an
 * element inside that carries most of them, and an enclosing heading or control that owns them; a card or a
 * section around the words says nothing about them, and a container (a card, a control) is accounted for only by
 * its own stamp — never by something that happens to sit inside it.
 */
export function stampedComponent(item: Pick<RawManifestItem, 'kind' | 'text' | 'stamps'>, byElId: Map<string, DetectedComponent>): DetectedComponent | undefined {
  const pick = (ids: string[]) => ids.map((id) => byElId.get(id)).find((c): c is DetectedComponent => c !== undefined);
  const own = pick(item.stamps.self);
  if (own || !TEXT_KINDS.has(item.kind)) return own;
  const words = item.text.length;
  return pick(item.stamps.inner.filter((i) => words === 0 || i.textLength >= words * 0.6).map((i) => i.id)) ?? pick(item.stamps.owner.filter((o) => o.ownerLike).map((o) => o.id));
}

/** What a component says, as a comparable prefix (the same prefix rule the accessibility-tree match uses). */
const sayKey = (text: string): string => norm(text).slice(0, 24);

/**
 * The audited component an item IS, found by what it says and where it sits — for an element whose DOM stamp is gone
 * (the page re-rendered the node after B2 stamped it), so an audited element, a `MATCH` included, can never be
 * reported as unaccounted just because its trace was lost; and so recovery never re-audits (duplicates) an element
 * the audit already holds. Words must agree and the box must sit where the component was captured (page-absolute,
 * a few px of animation / rounding slack). One-to-one: a component is the twin of at most one item, the closest
 * one, and a component an item already owns by its stamp is never offered — so two "Blog" labels never claim the
 * same finding.
 */
export function linkTwins(items: RawManifestItem[], components: DetectedComponent[], linked: ReadonlyMap<string, string> = new Map()): Map<string, DetectedComponent> {
  const byElId = new Map(components.map((c) => [c.elId, c]));
  const owned = new Set<string>();
  const stampless: RawManifestItem[] = [];
  for (const item of items) {
    const stamped = stampedComponent(item, byElId);
    if (stamped) owned.add(stamped.elId);
    else stampless.push(item);
  }
  const out = new Map<string, DetectedComponent>();
  // B7's own record of what it captured for an item comes first — it is exact, not inferred.
  for (const item of stampless) {
    const elId = linked.get(itemKey(item));
    const c = elId ? byElId.get(elId) : undefined;
    if (c && !owned.has(c.elId)) {
      out.set(item.id, c);
      owned.add(c.elId);
    }
  }
  const byText = new Map<string, DetectedComponent[]>();
  for (const c of components) {
    if (owned.has(c.elId)) continue;
    const key = sayKey(c.label);
    if (!key) continue;
    const list = byText.get(key);
    if (list) list.push(c);
    else byText.set(key, [c]);
  }
  if (byText.size === 0) return out;
  const pairs: Array<{ item: RawManifestItem; component: DetectedComponent; score: number }> = [];
  for (const item of stampless) {
    if (out.has(item.id) || item.box.width <= 0 || item.box.height <= 0) continue;
    const key = sayKey(item.text);
    for (const component of byText.get(key) ?? []) {
      const box = component.domFacts?.box ?? component.fingerprint.box;
      const dx = Math.abs(box.x - item.box.x);
      const dy = Math.abs(box.y - item.box.y);
      const dw = Math.abs(box.width - item.box.width);
      const dh = Math.abs(box.height - item.box.height);
      if (dx > 12 || dy > 12 || dw > 16 || dh > 16) continue;
      pairs.push({ item, component, score: dx + dy + dw + dh });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  for (const { item, component } of pairs) {
    if (out.has(item.id) || owned.has(component.elId)) continue;
    out.set(item.id, component);
    owned.add(component.elId);
  }
  // Tier 3 — CANONICAL IDENTITY. An element the page moved (a layout shift, an expanded disclosure above it) is no longer
  // where it was captured, so the box test above cannot find it — but it is still the SAME element: the same DOM path,
  // the same DOM role and the same words. Without this a re-discovered element was captured and audited a second time
  // under a second finding id. Look-alikes sharing a path (shadow roots) are told apart by the box, closest first; a
  // component an item already owns by its stamp or by tier 1–2 is never offered.
  const byCanon = new Map<string, DetectedComponent[]>();
  for (const c of components) {
    const fp = c.fingerprint as DetectedComponent['fingerprint'] | undefined; // a captured component always has one
    if (owned.has(c.elId) || !fp?.structuralPath) continue;
    const words = sayKey(fp.textPrefix || c.label);
    if (!words) continue;
    const key = `${fp.structuralPath}|${fp.role.toLowerCase()}|${words}`;
    const list = byCanon.get(key);
    if (list) list.push(c);
    else byCanon.set(key, [c]);
  }
  if (byCanon.size > 0) {
    const canon: Array<{ item: RawManifestItem; component: DetectedComponent; score: number }> = [];
    for (const item of stampless) {
      if (out.has(item.id) || !item.path) continue;
      const key = `${item.path}|${(item.facts.roleAttr ?? item.tag).toLowerCase()}|${sayKey(item.facts.text || item.text)}`;
      for (const component of byCanon.get(key) ?? []) {
        const box = component.domFacts?.box ?? component.fingerprint.box;
        canon.push({ item, component, score: Math.abs(box.x - item.box.x) + Math.abs(box.y - item.box.y) });
      }
    }
    canon.sort((a, b) => a.score - b.score);
    for (const { item, component } of canon) {
      if (out.has(item.id) || owned.has(component.elId)) continue;
      out.set(item.id, component);
      owned.add(component.elId);
    }
  }
  return out;
}

/**
 * B2's classification of every manifest item from the COMPLETE section hierarchy. The text context of each
 * section is built from ALL its text items — not only the ones B2 offered — which is what lets B7 notice a
 * dominant `<p>` heading B2 never saw, or an eyebrow that was judged against an incomplete hierarchy.
 */
export function classifyIndependently(items: RawManifestItem[], state: ReconcileState, aria: Map<string, AriaElement | null>, sectionIdOf: Map<string, string | null>): { roles: Map<string, IndependentRole>; contextOf: (itemId: string) => TypeContext | undefined } {
  // B2's own selection contexts (repeated unit, clickable ancestor, inside-owner) for every element the tree lists.
  const selected = new Map<string, SelectedCandidate>();
  if (state.ariaElements.length > 0) {
    for (const c of selectCandidates(state.ariaElements.filter((e) => e.box), { viewportWidth: state.viewportWidth, allElements: state.ariaElements }).candidates) selected.set(c.ref, c);
  }
  const elFor = (item: RawManifestItem): AriaElement => aria.get(item.id) ?? syntheticAria(item);
  const bySection = new Map<string, Array<{ item: RawManifestItem; el: AriaElement }>>();
  for (const item of items) {
    if (!TEXT_KINDS.has(item.kind) || item.visibility === 'collapsed') continue;
    const key = sectionIdOf.get(item.id) ?? '(none)';
    const list = bySection.get(key);
    const row = { item, el: elFor(item) };
    if (list) list.push(row);
    else bySection.set(key, [row]);
  }
  const contexts = new Map<string, TypeContext>();
  for (const [key, rows] of bySection) {
    contexts.set(key, buildTypeContext(rows.map(({ item, el }, order) => ({ el, facts: item.facts, order, owned: item.place.insideOwner && item.kind !== 'heading' }))));
  }
  const out = new Map<string, IndependentRole>();
  const contextOf = (itemId: string): TypeContext | undefined => contexts.get(sectionIdOf.get(itemId) ?? '(none)');
  for (const item of items) {
    // Content that is not painted right now (collapsed behind a disclosure, in a faded hover / scroll-in layer)
    // cannot be classified from its own style — it is a state gap until something reveals it.
    if (item.visibility === 'collapsed' || item.visibility === 'faded') continue;
    const el = elFor(item);
    const selection = selected.get(el.ref);
    const typeContext = TEXT_KINDS.has(item.kind) ? contextOf(item.id) : undefined;
    const clickable = item.role === 'link' || item.role === 'button' || item.facts.cursor === 'pointer';
    const outcome = classifyCandidateOutcome(selection ?? el, item.facts, {
      inNavigation: item.place.inNavigation,
      inFooter: item.place.inFooter,
      // A card that is not itself a control is a repeated block: B2/B5's rule — a card only when it has a visible surface.
      ...(item.kind === 'card' && !clickable ? { repeatedBlock: true } : {}),
      ...(typeContext ? { typeContext } : {}),
      ...(selection ? {} : { context: { inNavigation: item.place.inNavigation, inFooter: item.place.inFooter, clickableAncestor: null, repeatedUnit: null, insideOwner: item.place.insideOwner } }),
    });
    out.set(item.id, 'excluded' in outcome ? { classification: null, excluded: outcome.excluded } : { classification: outcome, excluded: null });
  }
  return { roles: out, contextOf };
}

/** The independent ROLE of a text item, in the words a reviewer uses. */
export function roleOf(item: RawManifestItem, independent: IndependentRole | undefined): CoverageTextRole | undefined {
  if (!TEXT_KINDS.has(item.kind)) return undefined;
  const c = independent?.classification;
  if (!c) return item.kind === 'heading' ? 'heading' : undefined;
  if (c.componentType === 'eyebrow') return 'eyebrow';
  if (c.componentType === 'stat') return 'stat';
  if (c.componentType === 'section-heading') return c.headingRole === 'main' ? 'main-heading' : 'heading';
  if (c.componentType === 'paragraph') return c.headingRole === 'description' ? 'description' : c.headingRole === 'card-title' ? 'card-title' : c.headingRole === 'label' ? 'label' : c.headingRole === 'question' ? 'question' : 'paragraph';
  if (c.componentType === 'badge') return 'label';
  return undefined;
}

/** Does the audited component's type/role agree with what the whole hierarchy says it is? */
export function roleDisagreement(component: DetectedComponent, independent: IndependentRole | undefined): string | null {
  const c = independent?.classification;
  if (!c) return null; // nothing independent to compare with: B7 only objects to a role it can name
  const textTypes = new Set(['section-heading', 'eyebrow', 'paragraph', 'stat', 'badge']);
  if (!textTypes.has(component.componentType) || !textTypes.has(c.componentType)) return null;
  if (component.componentType === c.componentType && (component.headingRole ?? null) === (c.headingRole ?? null)) return null;
  const was = describeRole(component.componentType, component.headingRole);
  const is = describeRole(c.componentType, c.headingRole);
  if (was === is) return null;
  return `audited as ${was}, but from the whole section it is ${is}`;
}

function describeRole(type: string, headingRole?: string): string {
  if (type === 'eyebrow') return 'a supporting heading (eyebrow)';
  if (type === 'section-heading') return headingRole === 'main' ? 'the main section heading' : 'a section heading';
  if (type === 'paragraph') return headingRole === 'description' ? 'description / supporting copy' : headingRole === 'card-title' ? 'a card title' : headingRole === 'label' ? 'a label' : headingRole === 'question' ? 'an FAQ question' : 'body text';
  if (type === 'stat') return 'a stat numeral';
  if (type === 'badge') return 'a badge';
  return type;
}

/** How an item is looked up across rebuilds of the manifest (ids shift when a state pass reveals more content). */
export function itemKey(item: Pick<RawManifestItem, 'kind' | 'tag' | 'text' | 'box'>): string {
  return `${item.kind}|${item.tag}|${norm(item.text).slice(0, 48)}|${Math.round(item.box.x / 8)}|${Math.round(item.box.y / 8)}`;
}

/** A state B7 itself settled for an item (an exclusion it decided, a capture it could not make) — keyed by `itemKey`, so it survives a manifest rebuild. */
export interface Settled { state: CoverageItemState; reason: string }

/**
 * Where does the audit account for each item? One pass, pure. `memo` carries the corrective passes already
 * spent on an item across rebuilds; `settled` the states B7 itself decided.
 */
export function reconcile(items: RawManifestItem[], state: ReconcileState, memo: Map<string, number> = new Map(), settled: Map<string, Settled> = new Map(), linked: ReadonlyMap<string, string> = new Map()): ItemRecord[] {
  const aria = new Map<string, AriaElement | null>();
  const buckets = bucketAria(state.ariaElements);
  const ariaByRef = new Map(state.ariaElements.map((e) => [e.ref, e]));
  const componentByElId = new Map(state.components.map((c) => [c.elId, c]));
  // An element whose stamp was lost is still the audited component it was (see `linkTwins`).
  const twins = linkTwins(items, state.components, linked);
  const sectionIdOf = new Map<string, string | null>();
  const sectionNameOf = new Map<string, string>();
  const ownerBasisOf = new Map<string, OwnerBasis>();
  for (const item of items) {
    // A stamped element is exactly the component B2/B5 captured, whose aria ref is exact — geometry is only the fallback.
    const stamped = stampedComponent(item, componentByElId) ?? twins.get(item.id);
    const el = (stamped ? ariaByRef.get(stamped.ref) : undefined) ?? matchAria(item, state.ariaElements, buckets);
    aria.set(item.id, el);
    // WHO owns the item is decided from the page's structure, in a fixed order (see `ownership.ts`): the section the
    // audit already holds it in, the one B1 adopted it into by DOM ancestry, the section whose DOM subtree holds it, the
    // owner of the control that reveals it, its Header / Footer / Navigation region — and geometry only for an item in
    // the normal flow. A mega-menu revealed over the hero is never the hero's.
    const adopted = el ? state.sections.find((s) => s.adoptedRefs?.includes(el.ref)) : undefined;
    const { section, basis } = resolveOwner(item, state.sections, { component: stamped, adopted });
    sectionIdOf.set(item.id, section?.id ?? null);
    sectionNameOf.set(item.id, section?.name ?? '(outside any section)');
    ownerBasisOf.set(item.id, basis);
  }
  const { roles: independent, contextOf } = classifyIndependently(items, state, aria, sectionIdOf);
  const byElId = new Map(state.components.map((c) => [c.elId, c]));
  const findingById = new Map(state.findings.map((f) => [f.identity.findingId, f]));
  const findingBySignature = new Map(state.findings.map((f) => [f.component.signature, f]));
  const sectionById = new Map(state.sections.map((s) => [s.id, s]));
  const verification = state.verification;
  const failedRefs = new Map([...(verification?.captureFailures ?? []), ...(verification?.unresolvedRefs ?? [])].map((i) => [i.ref, i.reason]));
  const excludedRefs = new Map((verification?.excluded ?? []).map((i) => [i.ref, i.reason]));

  return items.map((raw): ItemRecord => {
    const el = aria.get(raw.id) ?? null;
    const sectionId = sectionIdOf.get(raw.id) ?? null;
    const base = { raw, sectionId, sectionName: sectionNameOf.get(raw.id) ?? '(outside any section)', ownerBasis: ownerBasisOf.get(raw.id), aria: el, independent: independent.get(raw.id) ?? null, typeContext: contextOf(raw.id), passes: memo.get(itemKey(raw)) ?? 0 };
    const done = (st: CoverageItemState, reason: string, extra: Partial<ItemRecord> = {}): ItemRecord => ({ ...base, component: null, finding: null, state: st, reason, gap: null, ...extra });

    // 1. A stamped element: the audit's own trace on the DOM (see `stampedComponent`) — or, when the page re-rendered
    //    it and the stamp is gone, the component that says the same words in the same place (see `linkTwins`).
    const component = stampedComponent(raw, byElId) ?? twins.get(raw.id) ?? null;
    if (component) {
      const finding = findingById.get(component.findingId) ?? null;
      if (!finding) return done('UNACCOUNTED', `the element was captured as a ${component.componentType} but no finding was produced for it`, { component, gap: { type: 'no-finding', detail: 'captured, never evaluated' } });
      if (finding.classification === 'NEEDS_REVIEW' || finding.classification === 'UNVERIFIED') {
        return done('NEEDS_REVIEW', finding.review?.reason ?? (finding.classification === 'UNVERIFIED' ? 'audited, but nothing could be compared' : 'a human must decide'), { component, finding });
      }
      const disagreement = state.checkRoles === false ? null : roleDisagreement(component, base.independent ?? undefined);
      return done('AUDITED', `${component.componentType}${component.headingRole ? ` (${component.headingRole})` : ''} → ${finding.component.dsComponent ?? 'foundation rules'} · finding ${finding.identity.findingId.slice(0, 8)}`, {
        component, finding, ...(disagreement ? { gap: { type: 'role' as const, detail: disagreement } } : {}),
      });
    }

    // 2. A stage's recorded decision about the accessibility-tree element it is.
    if (el) {
      const failed = failedRefs.get(el.ref);
      if (failed) {
        const review = state.findings.find((f) => f.component.signature === `unresolved:${el.ref}`);
        return done(review ? 'NEEDS_REVIEW' : 'CAPTURE_FAILED', review ? (review.review?.reason ?? failed) : failed, review ? { finding: review } : {});
      }
      const decision = state.decisions[el.ref];
      // "Not painted" is a valid exclusion for something nothing can ever show — but content in a faded
      // (hover / scroll-in) layer or behind a disclosure IS shown by an interaction, so it is a state gap, not an exclusion.
      const revealable = raw.visibility === 'faded' || raw.visibility === 'collapsed';
      if (decision && !(revealable && decision.kind === 'not-candidate')) return done(decision.kind === 'unresolvable' ? 'CAPTURE_FAILED' : 'EXCLUDED_WITH_REASON', decision.reason);
      const excluded = excludedRefs.get(el.ref);
      if (excluded && !revealable) return done('EXCLUDED_WITH_REASON', excluded);
      const stub = findingBySignature.get(`unresolved:${el.ref}`);
      if (stub) return done('NEEDS_REVIEW', stub.review?.reason ?? 'could not be audited', { finding: stub });
    }

    // 2b. B7's own decision (a policy exclusion it settled, a capture it could not make, a state nothing revealed).
    const own = settled.get(itemKey(raw));
    if (own) {
      const stub = state.findings.find((f) => f.component.signature === `unresolved:${raw.id}`);
      return done(own.state, own.reason, stub ? { finding: stub } : {});
    }
    const b7Stub = state.findings.find((f) => f.component.signature === `unresolved:${raw.id}`);
    if (b7Stub) return done('NEEDS_REVIEW', b7Stub.review?.reason ?? 'could not be audited', { finding: b7Stub });

    // 3. Policy decisions B7 can state from the item itself.
    const section = sectionId ? sectionById.get(sectionId) : undefined;
    if (section?.personalized) return done('EXCLUDED_WITH_REASON', `inside the personalised section "${section.name}" — audited in its cold-start form only, out of compliance scope (§2.7)`);
    if (raw.visibility === 'sr-only') return done('EXCLUDED_WITH_REASON', 'visually hidden — a box of ≤ 2px (rendered for assistive technology only), no visual design to audit');
    const verdict = base.independent;
    if (verdict && verdict.classification === null && verdict.excluded) return done('EXCLUDED_WITH_REASON', verdict.excluded);

    // 4. Nothing accounts for it: a gap.
    const hidden = raw.visibility === 'collapsed' || raw.visibility === 'faded';
    return done('UNACCOUNTED', hidden ? `${raw.visibility === 'faded' ? 'in a faded (hover / scroll-in) layer' : `collapsed behind ${raw.reveal.kind ?? 'a control'}`} — never revealed, so never audited` : 'no finding, no recorded decision and no stamp — the audit never reached it', {
      gap: { type: hidden ? 'state' : 'missing', detail: hidden ? `revealed by ${raw.reveal.kind ?? 'interaction'}` : 'a meaningful element nothing accounted for' },
    });
  });
}
