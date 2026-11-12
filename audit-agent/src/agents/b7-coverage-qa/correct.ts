import { captureComponent, LISTING_SAMPLE_LIMIT } from '../b2-component-detector/index.ts';
import { classifyCandidateOutcome } from '../b2-component-detector/deterministic.ts';
import type { CandidateClassification } from '../b2-component-detector/deterministic.ts';
import { decideMatch, dsIndex, pageTypographyOf } from '../b3-ds-matcher/deterministic.ts';
import { attachReference } from '../b3-ds-matcher/reference.ts';
import { LISTING_MIN_ITEMS } from '../b1-page-analyzer/deterministic.ts';
import { applyDeterministicLayoutChecks } from '../b5-visual-verifier/index.ts';
import {
  MAX_CORRECTIVE_LOOPS,
  markNeedsReview,
  recheckPropertyCompleteness,
  rerouteComponent,
  routeCapturedComponents,
  verifyMatchingCoverage,
  type CapturedForRouting,
  type VerificationReport,
} from '../b5-visual-verifier/completeness.ts';
import { readDomFacts } from '../../t-layer/dom-facts.ts';
import { extractComputedStyles } from '../../t-layer/computed-style.ts';
import type { CoverageAction, CoverageProgress, CoverageRoute, Finding } from '../../skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent, PageSession, SectionInfo } from '../types.ts';
import { reconcileDuplicates, type MergedElement } from './identity.ts';
import { liveStamps, readLiveOwner, resolveOwner, type OwnerResolution } from './ownership.ts';
import { markUnowned, UNSECTIONED } from './regions.ts';
import { itemKey, linkTwins, syntheticAria, type ItemRecord, type Settled } from './reconcile.ts';
import type { RawManifestItem } from './manifest.ts';
import { isShown, revealItem, type RevealOutcome } from './states.ts';

/**
 * B7's CORRECTIVE PASSES. A gap is routed to the stage that owns it — never fixed by a parallel rule of B7's
 * own — and then B7 verifies again (the loop is `index.ts`; this file is one pass of it):
 *
 *   missing element           → B2   classify + capture it with the section's COMPLETE text hierarchy,
 *                                    then B3 searches the DS family, then B4 audits it or B6 evaluates it
 *   wrong semantic / text role → B2/B3 re-classify it, B3 re-searches the family for the corrected type,
 *                                    then B4 | B6 rebuild the finding (same finding id — history continues)
 *   wrong DS family / variant → B3   B5's own family verifier, re-asked
 *   missed property           → B4   fresh style readings, foundation rules + the matched variant's contract
 *   no existing DS family     → B6   (reached through `routeCapturedComponents` / `rerouteComponent`)
 *   missing dynamic content   → a targeted state pass (reveal it), then the normal flow above
 *
 * Every stage call is the stage's OWN exported function, the same ones B5's completeness pass uses.
 */

/** Attempts per ITEM: an item B7 has looked at twice and still cannot account for is settled into an explicit state. */
export const B7_MAX_PASSES = MAX_CORRECTIVE_LOOPS;
/**
 * The recovery LOOP's safety limits — it normally ends long before them, by convergence (nothing left to try, or a
 * round that changed nothing). They exist so a pathological page can never loop forever: a round re-reconciles the
 * rebuilt manifest, so the work is cut into rounds; the whole loop has a count, a wall-clock and a capture ceiling.
 */
export const B7_MAX_ROUNDS = 12;
/** At most this many elements B7 captures on one page across ALL rounds. */
export const B7_MAX_RECOVERIES = 2_000;
/** B7's wall-clock allowance for corrections on one page, across all rounds. */
export const B7_TIME_BUDGET_MS = 900_000;
/** One round's slice: the manifest is rebuilt and reconciled at least this often, so progress is real and visible. */
export const B7_ROUND_RECOVERIES = 250;
export const B7_ROUND_TIME_MS = 240_000;

export interface B7Ops {
  /** B3's decision for one element (default: `decideMatch`). */
  decide?: typeof decideMatch;
  /** Reveals content that is not painted by default (default: the real state pass, `states.ts`). Injectable so every outcome is testable. */
  reveal?: (item: RawManifestItem) => Promise<RevealOutcome>;
  /** Captures one element's evidence (default: B2's own `captureComponent`). Injectable so a capture that keeps failing is testable. */
  capture?: typeof captureComponent;
  /** `maxRecoveries` / `deadlineMs` bound the whole loop; `roundRecoveries` / `roundMs` bound one round of it. */
  budget?: { maxRecoveries?: number; deadlineMs?: number; roundRecoveries?: number; roundMs?: number };
  /** Called once the page has gaps and after every recovery round — the live "rechecking" state (the CLI prints it). */
  onProgress?: (progress: CoverageProgress) => void;
}

export interface PassContext {
  session: PageSession;
  ops: B7Ops;
  /** The route log the shared B5 routines write into (routed to B4 / B6, re-matched, unresolved property coverage). */
  report: VerificationReport;
  actions: CoverageAction[];
  /** What B7 itself settled, keyed by `itemKey` so it survives a manifest rebuild. */
  settled: Map<string, Settled>;
  /** Items B7 settled into an explicit state (counted for the ledger's recovery summary). */
  settledKeys: Set<string>;
  /** What B7 captured for an item (`itemKey` → component `elId`) — an exact link that survives a lost DOM stamp. */
  linked: Map<string, string>;
  recovered: { count: number };
  /** Elements captured in the CURRENT round (the round's own ceiling). */
  roundRecovered: { count: number };
  /** The components a round captured, re-classified or re-routed: the next round re-verifies THESE, not the whole page again. */
  touched: Set<string>;
  /** The items B7 actually looked at in a round — only these spend one of their attempts (an item skipped for lack of budget has spent none). */
  examined: Set<string>;
  /** Recovered components whose owning section could not be determined from the page's structure (an overlay nothing owns) — their finding says a human must confirm where they belong. */
  unowned?: Set<string>;
  allRecords: () => ItemRecord[];
  /** The whole loop's wall-clock end … */
  deadline: number;
  /** … and the current round's. */
  roundDeadline: number;
}

const labelOf = (r: ItemRecord) => (r.raw.text.length > 60 ? `${r.raw.text.slice(0, 59)}…` : r.raw.text) || `(${r.raw.kind})`;

function log(pc: PassContext, pass: number, route: CoverageRoute, rec: ItemRecord, outcome: CoverageAction['outcome'], reason: string): void {
  pc.actions.push({ pass, route, itemId: rec.raw.id, label: labelOf(rec), outcome, reason });
}

/** The WHOLE loop is out of room: no further round can start. */
export function globalLimitReached(pc: PassContext): boolean {
  return pc.recovered.count >= (pc.ops.budget?.maxRecoveries ?? B7_MAX_RECOVERIES) || Date.now() > pc.deadline;
}

/** This ROUND is out of room: it ends here, the manifest is rebuilt, and the next round carries on with whatever was not yet examined. */
function outOfBudget(pc: PassContext): boolean {
  return globalLimitReached(pc) || pc.roundRecovered.count >= (pc.ops.budget?.roundRecoveries ?? B7_ROUND_RECOVERIES) || Date.now() > pc.roundDeadline;
}

/** The section an item belongs to, as B2 names it — or a stated catch-all for content no section's range holds. */
function sectionFor(state: B4Output, rec: ItemRecord): Pick<SectionInfo, 'id' | 'name'> {
  const found = rec.sectionId ? state.sections.find((s) => s.id === rec.sectionId) : undefined;
  return found ?? { ...UNSECTIONED };
}

/**
 * The owner of a recovered element, decided AGAIN from the live element right before its finding is written.
 *
 * The manifest was read with everything closed and the page at the top; this element is now revealed, possibly with the
 * page scrolled somewhere else entirely, and its box is wherever the overlay happens to sit — so its owner is read from
 * the page's structure (its section's subtree, the control that opened it, its Header / Footer region), not from the
 * geometry it had when the manifest was built. Falls back to the manifest's own evidence when the element cannot be read.
 */
async function revalidateOwner(pc: PassContext, state: B4Output, rec: ItemRecord, selector: string): Promise<OwnerResolution> {
  const live = await readLiveOwner(pc.session.page, selector);
  const adopted = rec.aria ? state.sections.find((s) => s.adoptedRefs?.includes(rec.aria?.ref ?? '')) : undefined;
  // The live read is authoritative for what the element is in NOW; the manifest keeps what only the closed page showed
  // (the hover host that opens a layer, the control's label), so neither source is thrown away.
  const before = rec.raw.owner;
  const merged = live && before
    ? { ...before, ...live, triggerSectionStamp: live.triggerSectionStamp ?? before.triggerSectionStamp, triggerLandmark: live.triggerLandmark ?? before.triggerLandmark ?? null, ...(before.menu ? { menu: before.menu } : {}) }
    : live ?? before;
  return resolveOwner({ ...rec.raw, ...(merged ? { owner: merged } : {}) }, state.sections, { adopted });
}

/**
 * ONE finding per physical element. Reconciles every audited component that is the same element as an earlier one
 * (same DOM path, role, words and — in the final validation — section), folds the later finding's evidence into the
 * earlier finding, re-points B7's own records and the page's stamp at the surviving component, and says so in the action log.
 */
export async function reconcileCanonical(pc: PassContext, state: B4Output, pass: number, opts: { requireSameSection: boolean }): Promise<{ state: B4Output; merged: MergedElement[] }> {
  const live = await liveStamps(pc.session.page);
  const result = reconcileDuplicates(state, { requireSameSection: opts.requireSameSection, liveElIds: live });
  for (const m of result.merged) {
    for (const [key, elId] of pc.linked) if (elId === m.dropped.elId) pc.linked.set(key, m.kept.elId);
    if (!live.has(m.kept.elId)) {
      await pc.session.page
        .evaluate(([drop, keep]) => document.querySelectorAll(`[data-audit-el="${drop}"]`).forEach((e) => e.setAttribute('data-audit-el', keep as string)), [m.dropped.elId, m.kept.elId])
        .catch(() => {});
    }
    pc.touched.delete(m.dropped.elId);
    pc.actions.push({ pass: Math.max(pass, 1), route: 'B2', itemId: m.dropped.elId, label: m.label.slice(0, 60), outcome: 'resolved', reason: `the same element as finding ${m.kept.findingId.slice(0, 8)} (same DOM path, role and words) — merged into it, not audited a second time` });
  }
  return result;
}

/** A component with the type B7 found for it — everything else about the captured element stays as captured. */
export function withClassification(component: DetectedComponent, c: CandidateClassification): DetectedComponent {
  const { structural: _s, headingRole: _h, ...rest } = component;
  const keep = component.domSignals.filter((s) => !s.startsWith('heading role:') && !s.includes('→ stat') && !s.includes('→ paragraph'));
  return {
    ...rest,
    componentType: c.componentType,
    domSignals: [...new Set([...keep, ...c.domSignals.filter((s) => s.startsWith('heading role:') || s.includes('→ stat') || s.includes('→ paragraph') || s.includes('→ badge'))])],
    detectionConfidence: c.confidence,
    instanceGroupKey: `${component.sectionId}::${c.instanceGroupKey}`,
    ...(c.structural ? { structural: true } : {}),
    ...(c.headingRole ? { headingRole: c.headingRole } : {}),
  };
}

/** The hidden-layer an item belongs to: every member of ONE hover layer / tab panel is revealed by the same interaction. */
function layersOf(records: ItemRecord[]): ItemRecord[][] {
  const layers = new Map<string, ItemRecord[]>();
  for (const r of records) {
    const rv = r.raw.reveal;
    const key = rv.kind === 'hover' && rv.hostSelector ? `hover|${rv.hostSelector}` : rv.controlSelector ? `${rv.kind}|${rv.controlSelector}` : `item|${itemKey(r.raw)}`;
    const list = layers.get(key);
    if (list) list.push(r);
    else layers.set(key, [r]);
  }
  return [...layers.values()];
}

/** Findings merged by their identity: a recovered finding REPLACES the one it supersedes — recovery never duplicates a finding. */
function mergeFindings(existing: Finding[], incoming: Finding[]): Finding[] {
  const byId = new Map(existing.map((f) => [f.identity.findingId, f]));
  for (const f of incoming) byId.set(f.identity.findingId, f);
  return [...byId.values()];
}

/**
 * A. missing elements and missing states → B2, then B3 → B4 | B6 (`routeCapturedComponents`).
 *
 * Cheap, deterministic recoveries first (a missing element needs a capture and nothing else); content only an
 * interaction reveals second, a LAYER at a time — revealed once, every member of it captured while it is open — so
 * a hidden layer that nothing opens costs one failed attempt, not one per item, and can never starve the rest.
 */
async function recoverItems(pc: PassContext, state: B4Output, gaps: ItemRecord[], pass: number): Promise<B4Output> {
  if (gaps.length === 0) return state;
  const { session } = pc;
  // The bounded-listing policy B2 applies: only a repeated LISTING is sampled, and the members already audited count.
  const auditedInGroup = new Map<string, number>();
  for (const c of state.components) auditedInGroup.set(c.instanceGroupKey, (auditedInGroup.get(c.instanceGroupKey) ?? 0) + 1);
  const groupSizes = new Map<string, number>();
  for (const r of pc.allRecords()) {
    const c = r.independent?.classification;
    if (c && r.sectionId) groupSizes.set(`${r.sectionId}::${c.instanceGroupKey}`, (groupSizes.get(`${r.sectionId}::${c.instanceGroupKey}`) ?? 0) + 1);
  }

  const captured: CapturedForRouting[] = [];
  const restores: Array<() => Promise<void>> = [];

  const settle = (rec: ItemRecord, settled: Settled): void => {
    pc.settled.set(itemKey(rec.raw), settled);
    pc.settledKeys.add(itemKey(rec.raw));
  };

  /** One item through B2's own classifier and capture — exactly the first pass's route. `how` is the reveal that made it visible. */
  const recoverOne = async (rec: ItemRecord, how?: string): Promise<void> => {
    const raw = rec.raw;
    // An element only the accessibility tree listed is reached through its aria ref; every other item through the stamp B7 gave it.
    const selector = raw.source === 'a11y' && rec.aria ? `aria-ref=${rec.aria.ref}` : `[data-audit-b7="${raw.id}"]`;
    try {
      // The audit may already hold this very element (its stamp lost, or captured earlier in this round): never audit it twice.
      const twin = linkTwins([raw], [...state.components, ...captured.map((c) => c.component)], pc.linked).get(raw.id);
      if (twin) {
        pc.linked.set(itemKey(raw), twin.elId);
        log(pc, pass, 'B2', rec, 'resolved', 'already audited — the audit holds this element (its trace on the page was lost); linked, not re-audited');
        return;
      }
      const facts = await readDomFacts(session.page.locator(selector));
      const el = rec.aria ?? syntheticAria({ ...raw, facts });
      const clickable = raw.role === 'link' || raw.role === 'button' || raw.facts.cursor === 'pointer';
      const outcome = classifyCandidateOutcome(el, facts, {
        inNavigation: raw.place.inNavigation,
        inFooter: raw.place.inFooter,
        ...(raw.kind === 'card' && !clickable ? { repeatedBlock: true } : {}),
        ...(rec.typeContext ? { typeContext: rec.typeContext } : {}),
        context: { inNavigation: raw.place.inNavigation, inFooter: raw.place.inFooter, clickableAncestor: null, repeatedUnit: null, insideOwner: raw.place.insideOwner },
      });
      if ('excluded' in outcome) {
        settle(rec, { state: 'EXCLUDED_WITH_REASON', reason: outcome.excluded });
        log(pc, pass, 'B2', rec, 'resolved', `B2's classifier declined it: ${outcome.excluded}`);
        return;
      }
      // Revalidate the owner NOW, from the live element (see `revalidateOwner`): never the geometry the manifest had.
      const owner = await revalidateOwner(pc, state, rec, selector);
      const section = owner.section ? { id: owner.section.id, name: owner.section.name } : sectionFor(state, { ...rec, sectionId: null });
      const elId = `${section.id}-recovered-b7-${pc.recovered.count}`;
      if (owner.basis === 'unowned-overlay') (pc.unowned ??= new Set()).add(elId);
      const groupKey = `${section.id}::${outcome.instanceGroupKey}`;
      const isListing = Boolean(state.sections.find((s) => s.id === section.id)?.isListing) || (groupSizes.get(groupKey) ?? 0) >= LISTING_MIN_ITEMS;
      if (isListing && (auditedInGroup.get(groupKey) ?? 0) >= LISTING_SAMPLE_LIMIT) {
        settle(rec, { state: 'EXCLUDED_WITH_REASON', reason: `a member of a repeated listing — bounded listing sampling audits the first ${LISTING_SAMPLE_LIMIT} per group and counts the rest (§2.7)` });
        log(pc, pass, 'B2', rec, 'resolved', 'sampled out of a repeated listing (the same bounded-listing policy B2 applies)');
        return;
      }
      const component = await (pc.ops.capture ?? captureComponent)(session, section, elId, rec.aria?.ref ?? raw.id, outcome, { groupKey, href: rec.aria?.url ?? null, facts, selector, ...(how ? { captureState: `revealed: ${how}` } : {}) });
      if (!component) throw new Error('evidence capture failed (the element changed or detached while being captured)');
      pc.recovered.count++;
      pc.roundRecovered.count++;
      auditedInGroup.set(groupKey, (auditedInGroup.get(groupKey) ?? 0) + 1);
      captured.push({ component, section, loop: pass });
      pc.linked.set(itemKey(raw), component.elId);
      pc.touched.add(component.ref);
      log(pc, pass, 'B2', rec, 'resolved', `classified as ${outcome.componentType}${outcome.headingRole ? ` (${outcome.headingRole})` : ''} and captured under "${section.name}" (${owner.basis}) — the audit's first pass never offered it`);
    } catch (err) {
      const reason = `evidence capture failed: ${err instanceof Error ? (err.message.split('\n')[0] ?? '').slice(0, 120) : 'unknown'}`;
      log(pc, pass, 'B2', rec, 'failed', reason);
      // a technical failure twice in a row is a recorded CAPTURE_FAILED, never a silent drop
      if (rec.passes + 1 >= B7_MAX_PASSES) settle(rec, { state: 'CAPTURE_FAILED', reason });
    }
  };

  // 1. missing elements — B2 classifies and captures them
  for (const rec of gaps.filter((r) => r.gap?.type === 'missing')) {
    if (rec.passes >= B7_MAX_PASSES) continue; // out of attempts: settled after the loop
    if (outOfBudget(pc)) break; // not examined — carried to the next round
    pc.examined.add(itemKey(rec.raw));
    await recoverOne(rec);
  }

  // 2. content only an interaction reveals — one reveal per LAYER, every member captured while it is open
  const reveal = pc.ops.reveal ?? ((item: RawManifestItem) => revealItem(session.page, session.observer, session.url, item));
  for (const layer of layersOf(gaps.filter((r) => r.gap?.type === 'state'))) {
    const members = layer.filter((r) => r.passes < B7_MAX_PASSES);
    if (members.length === 0) continue;
    if (outOfBudget(pc)) break;
    const lead = members[0] as ItemRecord;
    const outcome = await reveal(lead.raw);
    if (!outcome.ok) {
      for (const m of members) {
        pc.examined.add(itemKey(m.raw));
        pc.settled.set(`reveal:${itemKey(m.raw)}`, { state: 'NEEDS_REVIEW', reason: outcome.reason });
      }
      log(pc, pass, 'state', lead, 'needs_review', `${outcome.reason}${members.length > 1 ? ` — ${members.length} items in the same hidden layer` : ''}`);
      continue;
    }
    restores.push(outcome.restore);
    log(pc, pass, 'state', lead, 'resolved', `revealed (${outcome.how})${members.length > 1 ? ` — ${members.length} items in the layer are captured while it is open` : ''} — handed to the normal audit flow`);
    for (const m of members) {
      if (outOfBudget(pc)) break;
      pc.examined.add(itemKey(m.raw));
      // capturing the previous member may have closed the layer again: put the reveal back (an injected reveal vouches for itself)
      if (!pc.ops.reveal && !(await isShown(session.page, `[data-audit-b7="${m.raw.id}"]`))) {
        await outcome.reapply?.();
        if (!(await isShown(session.page, `[data-audit-b7="${m.raw.id}"]`))) {
          const reason = 'its hidden layer closed again before this item could be captured';
          pc.settled.set(`reveal:${itemKey(m.raw)}`, { state: 'NEEDS_REVIEW', reason });
          log(pc, pass, 'state', m, 'needs_review', reason);
          continue;
        }
      }
      await recoverOne(m, outcome.how);
    }
  }
  for (const restore of restores.reverse()) await restore().catch(() => {});
  if (captured.length === 0) return state;

  const recovered = await routeCapturedComponents(session, state, captured, pc.report, pc.ops.decide ? { decide: pc.ops.decide } : {});
  const measured = session.aiMode === 'no-api' ? await applyDeterministicLayoutChecks(session, recovered.findings, [...state.components, ...recovered.components]) : recovered.findings;
  const unownedFindingIds = new Set(recovered.components.filter((c) => pc.unowned?.has(c.elId)).map((c) => c.findingId));
  const layout = unownedFindingIds.size === 0 ? measured : measured.map((f) => (unownedFindingIds.has(f.identity.findingId) ? markUnowned(f) : f));
  for (const c of captured) {
    const component = recovered.components.find((rc) => rc.elId === c.component.elId);
    const f = layout.find((x) => x.identity.findingId === component?.findingId);
    if (!component || !f) continue;
    const match = recovered.matches.get(component.ref);
    const viaB4 = recovered.matched.some((m) => m.elId === component.elId);
    const how = match?.foundationOnly
      ? 'audited against the foundation rules (body text has no Design System component family)'
      : f.component.dsComponent
        ? `audited against ${f.component.dsComponent}${f.component.dsVariant ? ` (${f.component.dsVariant})` : ''}`
        : f.classification === 'DS_CANDIDATE' ? 'no existing family — proposed as a Design System candidate' : 'no existing family — evaluated by B6';
    pc.actions.push({ pass, route: viaB4 ? 'B4' : 'B6', itemId: component.elId, label: component.label.slice(0, 60), outcome: f.classification === 'NEEDS_REVIEW' ? 'needs_review' : 'resolved', reason: `${f.classification} — ${how}` });
  }
  const written: B4Output = {
    ...state,
    components: [...state.components, ...recovered.components],
    matches: new Map([...state.matches, ...recovered.matches]),
    matched: [...state.matched, ...recovered.matched],
    findings: mergeFindings(state.findings, layout),
  };
  // Reconcile against what the audit already holds BEFORE the recovered findings are kept: an element captured a second
  // time (its stamp lost, or moved past the twin lookup's box tolerance) is the SAME element — one finding, not two.
  return (await reconcileCanonical(pc, written, pass, { requireSameSection: false })).state;
}

/**
 * B5's deterministic layout check (text cut off by its own box, a target below the WCAG minimum) over the findings a
 * re-route just PRODUCED — measured once, by whichever stage produced them (the B6 node does the same for its own).
 */
async function withLayout(pc: PassContext, before: B4Output, after: B4Output): Promise<B4Output> {
  if (pc.session.aiMode !== 'no-api') return after;
  const known = new Set(before.findings.map((f) => f.identity.findingId));
  const fresh = after.findings.filter((f) => !known.has(f.identity.findingId));
  if (fresh.length === 0) return after;
  const measured = await applyDeterministicLayoutChecks(pc.session, fresh, after.components);
  return { ...after, findings: [...after.findings.filter((f) => known.has(f.identity.findingId)), ...measured] };
}

/** B. A component was captured but no finding came out of it → B3 → B4 | B6. */
async function evaluateOrphans(pc: PassContext, state: B4Output, gaps: ItemRecord[], pass: number): Promise<B4Output> {
  let s = state;
  if (gaps.length === 0) return s;
  const index = await dsIndex(pc.session.registry);
  const decide = pc.ops.decide ?? decideMatch;
  const viewportWidth = pc.session.page.viewportSize()?.width ?? 1440;
  for (const rec of gaps) {
    const component = rec.component;
    if (!component || rec.passes >= B7_MAX_PASSES) continue;
    pc.examined.add(itemKey(rec.raw));
    pc.touched.add(component.ref);
    const answer = s.matches.get(component.ref) ?? attachReference(decide(component, index, pc.session.registry, viewportWidth, pageTypographyOf(s.components, component)), component, pc.session.references);
    s = await withLayout(pc, s, await rerouteComponent(pc.session, s, component, answer, pc.report, pass, { evaluateUnmatchedNow: true }));
    log(pc, pass, 'B3', rec, 'resolved', `the element had no finding — B3 answered (${answer.dsComponent ?? 'no existing family'}) and it was routed on`);
  }
  return s;
}

/** C. Audited under the wrong role → B2/B3 re-classify, then B4 | B6 rebuild the finding. */
async function reclassify(pc: PassContext, state: B4Output, gaps: ItemRecord[], pass: number): Promise<B4Output> {
  let s = state;
  if (gaps.length === 0) return s;
  const index = await dsIndex(pc.session.registry);
  const decide = pc.ops.decide ?? decideMatch;
  const viewportWidth = pc.session.page.viewportSize()?.width ?? 1440;
  for (const rec of gaps) {
    const classification = rec.independent?.classification;
    const component = rec.component;
    if (!classification || !component || rec.passes >= B7_MAX_PASSES) continue;
    pc.examined.add(itemKey(rec.raw));
    pc.touched.add(component.ref);
    const updated = withClassification(component, classification);
    s = { ...s, components: s.components.map((c) => (c.elId === component.elId ? updated : c)) };
    const answer = attachReference(decide(updated, index, pc.session.registry, viewportWidth, pageTypographyOf(s.components, updated)), updated, pc.session.references);
    s = await withLayout(pc, s, await rerouteComponent(pc.session, s, updated, answer, pc.report, pass, { evaluateUnmatchedNow: true }));
    log(pc, pass, 'B2', rec, 'resolved', `${rec.gap?.detail ?? 'role corrected'} — re-classified as ${classification.componentType}${classification.headingRole ? ` (${classification.headingRole})` : ''}`);
    log(pc, pass, 'B3', rec, 'resolved', `family re-searched for the corrected type: ${answer.dsComponent ? `${answer.dsFile}${answer.dsVariant ? ` (${answer.dsVariant})` : ''}` : 'no existing Design System family'}`);
  }
  return s;
}

/** D. Wrong DS family / variant → B3, through B5's own family verifier. `scope` = only these components (a later round re-verifies what it just recovered, not the whole page again); null = every component. */
async function rematchFamilies(pc: PassContext, state: B4Output, pass: number, scope: ReadonlySet<string> | null): Promise<B4Output> {
  const touched = new Set<string>();
  const before = pc.report.rematched.length;
  const next = await verifyMatchingCoverage(pc.session, state, pc.report, pass, scope, new Set(), touched, pc.ops.decide ?? decideMatch);
  for (const item of pc.report.rematched.slice(before)) pc.actions.push({ pass, route: 'B3', itemId: item.ref, label: item.ref, outcome: 'resolved', reason: item.reason });
  return next;
}

/** E. A missed property or rule → B4, from FRESH style readings (not the style B2 captured earlier). */
async function repairProperties(pc: PassContext, state: B4Output, pass: number, scope: ReadonlySet<string> | null): Promise<B4Output> {
  const ids = state.components.filter((c) => c.style.connected && (!scope || scope.has(c.ref))).map((c) => c.elId);
  if (ids.length === 0) return state;
  const fresh = await extractComputedStyles(pc.session.page, ids);
  const components = state.components.map((c) => {
    const style = fresh[c.elId];
    return style?.connected ? { ...c, style } : c;
  });
  const touched = new Set<string>();
  const corrected = pc.report.propertiesCorrected;
  const findings = await recheckPropertyCompleteness(pc.session, { ...state, components }, pc.report, { scope, loop: pass, touched });
  const n = pc.report.propertiesCorrected - corrected;
  if (n > 0) pc.actions.push({ pass, route: 'B4', itemId: `properties`, label: `${touched.size} element(s)`, outcome: 'resolved', reason: `${n} governed propert${n === 1 ? 'y' : 'ies'} missing from a finding were found on a fresh reading of the element and re-audited by B4` });
  return { ...state, components, findings };
}

export interface PassResult { state: B4Output; propertiesCorrected: number }

/**
 * One recovery round over every kind of gap. `scope` is the set of components the round's verification covers: null on
 * the first round (every finding is verified once), then only what the previous round touched — those specific items.
 */
export async function correctGaps(pc: PassContext, state: B4Output, records: ItemRecord[], pass: number, scope: ReadonlySet<string> | null = null): Promise<PassResult> {
  const gaps = records.filter((r) => r.gap !== null);
  let s = state;
  s = await recoverItems(pc, s, gaps.filter((r) => r.gap?.type === 'missing' || r.gap?.type === 'state'), pass);
  s = await evaluateOrphans(pc, s, gaps.filter((r) => r.gap?.type === 'no-finding'), pass);
  s = await reclassify(pc, s, gaps.filter((r) => r.gap?.type === 'role'), pass);
  // what THIS round touched is verified now as well (a recovered element's family and properties), on top of the carried scope
  const verifyScope = scope === null ? null : new Set([...scope, ...pc.touched]);
  s = verifyScope !== null && verifyScope.size === 0 ? s : await rematchFamilies(pc, s, pass, verifyScope);
  const before = pc.report.propertiesCorrected;
  s = verifyScope !== null && verifyScope.size === 0 ? s : await repairProperties(pc, s, pass, verifyScope);
  return { state: s, propertiesCorrected: pc.report.propertiesCorrected - before };
}

/**
 * After the recovery loop: whatever is STILL a gap is settled into an explicit, reasoned state — never retried a third
 * time, never guessed, never dropped, and never left to read as "unaccounted":
 *
 *   - an item B7 has looked at twice (or, once the loop has CONVERGED, any item no further round could change) that
 *     is still open becomes NEEDS_REVIEW with its reason — and, when the audit holds a finding for it, that finding
 *     is marked for review too (`markNeedsReview`); an item that was never captured has no finding to mark, so its
 *     state lives in the Coverage ledger (a long list of "nothing revealed it" stubs would only bury the real findings);
 *   - a technical capture failure was already settled as CAPTURE_FAILED, an intentional exclusion as EXCLUDED_WITH_REASON.
 *
 * An item B7 never got to examine because the loop hit its SAFETY LIMIT (`exhaustAll: false`) is NOT settled here: it
 * stays UNACCOUNTED and the gate says so — running out of room is not an answer about the item.
 */
export function settleGaps(pc: PassContext, state: B4Output, records: ItemRecord[], opts: { exhaustAll: boolean } = { exhaustAll: false }): B4Output {
  const findings = [...state.findings];
  const byFindingId = new Map(findings.map((f, i) => [f.identity.findingId, i]));
  const mark = (findingId: string | undefined, reason: string): boolean => {
    const i = findingId !== undefined ? byFindingId.get(findingId) : undefined;
    if (i === undefined) return false;
    findings[i] = markNeedsReview(findings[i] as Finding, reason, 'B7');
    return true;
  };
  // property coverage that would not stabilise
  const components = new Map(state.components.map((c) => [c.ref, c]));
  for (const item of pc.report.unresolvedRefs.filter((u) => u.kind === 'property')) mark(components.get(item.ref)?.findingId, item.reason);

  for (const rec of records) {
    if (!rec.gap) continue;
    const key = itemKey(rec.raw);
    if (rec.gap.type === 'role') {
      mark(rec.component?.findingId, `${rec.gap.detail} — B7 re-classified it twice and the audited role still disagrees`);
      pc.settled.set(key, { state: 'NEEDS_REVIEW', reason: rec.gap.detail });
      pc.settledKeys.add(key);
      continue;
    }
    const exhausted = rec.passes >= B7_MAX_PASSES;
    if (!exhausted && !opts.exhaustAll) continue; // not examined enough: stays a gap (the gate reports it)
    const why = pc.settled.get(`reveal:${key}`)?.reason ?? rec.reason;
    const reason = exhausted ? why : `B7's recovery converged without being able to re-audit it — ${why}`;
    if (rec.gap.type === 'no-finding' && rec.component) mark(rec.component.findingId, reason);
    pc.settled.set(key, { state: 'NEEDS_REVIEW', reason });
    pc.settledKeys.add(key);
    pc.actions.push({ pass: Math.max(rec.passes, 1), route: rec.gap.type === 'state' ? 'state' : 'B2', itemId: rec.raw.id, label: labelOf(rec), outcome: 'needs_review', reason: `${exhausted ? `unresolved after ${B7_MAX_PASSES} attempts` : 'recovery converged'} — ${why}` });
  }
  return { ...state, findings };
}
