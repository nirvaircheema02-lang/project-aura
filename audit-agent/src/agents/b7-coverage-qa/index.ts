import { emptyVerificationReport, type VerificationReport } from '../b5-visual-verifier/completeness.ts';
import { readDomFacts } from '../../t-layer/dom-facts.ts';
import type { NodeContext } from '../../graph/engine.ts';
import type { CoverageAction, CoverageLedger, CoverageProgress, CoverageRecovery } from '../../skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent, PageSession } from '../types.ts';
import { B7_MAX_PASSES, B7_MAX_ROUNDS, B7_ROUND_TIME_MS, B7_TIME_BUDGET_MS, correctGaps, globalLimitReached, reconcileCanonical, settleGaps, type B7Ops, type PassContext } from './correct.ts';
import { buildLedger } from './ledger.ts';
import { collectDomManifest, type RawManifestItem } from './manifest.ts';
import { stampSectionRoots } from './ownership.ts';
import { annotateRegions, rehomeToRegions } from './regions.ts';
import { itemKey, linkTwins, reconcile, type ItemRecord, type ReconcileState, type Settled } from './reconcile.ts';
import { scrollThrough } from './states.ts';

export { coverageLine, describeGate, gateIsConsistent, gateOf, type CoverageStatus } from './ledger.ts';
export { B7_MAX_PASSES, type B7Ops } from './correct.ts';

/**
 * B7 — Final Audit Coverage & QA (Decision Log #45). The last node of the page graph:
 *
 *   B1 → B2 → B3 → B4 → B5 → B6 → B7
 *
 * An independent final checker whose one job is that nothing meaningful on the page silently disappeared from
 * the audit. It builds its OWN manifest of the rendered page (manifest.ts — DOM, accessibility tree, visible
 * text, computed style, geometry, interaction state; never B2's candidate list), reconciles every item to the
 * ONE state it ended in (reconcile.ts), routes every gap to the stage that owns it and verifies again
 * (correct.ts, at most 2 corrective passes), settles whatever is still unresolved as NEEDS_REVIEW, and
 * publishes the ledger and the Coverage Gate (ledger.ts). No guessing, no new rule of its own: it reuses B2's
 * classifier, B3's matcher, B4's evaluation and B6's evaluation through the same functions B5's completeness
 * pass uses.
 *
 * This is 100% ACCOUNTING, not a claim of 100% correctness: the gate passes when `unaccounted = 0`.
 */

const SOURCES = ['dom', 'accessibility-tree', 'visible-text', 'computed-style', 'geometry', 'state-probes'];

/** What kind of manifest item an audited component's type corresponds to. */
function kindOf(type: string): RawManifestItem['kind'] {
  if (type === 'section-heading' || type === 'eyebrow') return 'heading';
  if (type === 'paragraph' || type === 'stat' || type === 'quote') return 'text';
  if (type === 'badge' || type === 'tag' || type === 'chip') return 'badge';
  if (type === 'card') return 'card';
  if (['input', 'search', 'select', 'textarea', 'checkbox', 'radio', 'slider'].includes(type)) return 'form-field';
  return 'control';
}

/** The kind of an item only the accessibility tree listed, from its role. */
function kindOfRole(role: string): RawManifestItem['kind'] {
  if (role === 'heading') return 'heading';
  if (role === 'link' || role === 'button' || role === 'tab') return 'control';
  if (role === 'textbox' || role === 'checkbox' || role === 'radio') return 'form-field';
  return 'text';
}

const iou = (a: RawManifestItem['box'], b: RawManifestItem['box']): number => {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = x * y;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
};

export interface Manifest {
  items: RawManifestItem[];
  notes: string[];
  truncated: boolean;
  /** Items only the accessibility tree listed that could not be read — recorded as capture failures, never dropped. */
  unreadable: Map<string, string>;
}

/**
 * The manifest: the DOM scan, plus what ONLY the accessibility tree lists, plus any audited element the scan did
 * not classify as a meaningful item (so the manifest is never SMALLER than what the audit already covered).
 */
export async function buildCoverageManifest(session: PageSession, state: B4Output, linked: ReadonlyMap<string, string> = new Map()): Promise<Manifest> {
  // Page-absolute boxes depend on the scroll position for a sticky or fixed element, and the accessibility
  // snapshot every ref belongs to was taken at the top of the page: read the DOM from the same place.
  // Evidence capture scrolls elements into view, and that includes `overflow: hidden` containers (a sticky stage,
  // a carousel track) — leaving their contents shifted. Put every scrolled element back where the snapshot saw it.
  await session.page.evaluate(() => new Promise<void>((resolve) => {
    for (const el of Array.from(document.querySelectorAll('*'))) if (el.scrollTop !== 0 || el.scrollLeft !== 0) { el.scrollTop = 0; el.scrollLeft = 0; }
    window.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  // Mark B1's section roots in the DOM first, so the scan can say which section's SUBTREE holds each element: section
  // ownership is a question about the page's structure, never about where a box sits when it is measured (ownership.ts).
  const anchoring = await stampSectionRoots(session.page, state.sections);
  const dom = await collectDomManifest(session.page);
  // A page whose section roots were only PARTLY located cannot say that an unstamped element is outside every section.
  const items = anchoring.failed > 0 ? dom.items.map((i) => (i.owner ? { ...i, owner: { ...i.owner, anchored: false } } : i)) : [...dom.items];
  const notes: string[] = [];
  if (anchoring.failed > 0) notes.push(`${anchoring.failed} of ${state.sections.length} section root(s) could not be located in the DOM — an item no stamped root owns is placed by its position on the page instead`);
  const unreadable = new Map<string, string>();
  if (dom.notRevealable > 0) notes.push(`${dom.notRevealable} text block(s) sit under display:none with no tab, disclosure or carousel that reveals them — content no visitor can see, so not part of the manifest`);
  if (dom.iframes > 0) notes.push(`${dom.iframes} embedded frame(s) — each is a separate document outside this page's DOM and is not enumerated`);

  // The accessibility tree's own text-bearing elements that no DOM item overlaps.
  const present = items.filter((i) => i.box.width > 0);
  let a11yOnly = 0;
  for (const el of state.ariaElements) {
    if (!el.box || el.box.width <= 2 || el.box.height <= 2) continue;
    const text = (el.name || /\]:\s*(.+)$/.exec(el.line)?.[1] || '').replace(/\s+/g, ' ').trim();
    if (!text || !['heading', 'paragraph', 'link', 'button', 'generic', 'textbox', 'tab', 'checkbox', 'radio'].includes(el.role)) continue;
    if (state.ariaElements.some((o) => o.parentRef === el.ref)) continue; // a container: its leaves are the items
    if (present.some((i) => iou(i.box, el.box as RawManifestItem['box']) >= 0.3 || (Math.abs(i.box.x - el.box!.x) < 10 && Math.abs(i.box.y - el.box!.y) < 10))) continue;
    try {
      const facts = await readDomFacts(session.page.locator(`aria-ref=${el.ref}`), 1_500);
      items.push({
        id: `b7-a${a11yOnly++}`, kind: kindOfRole(el.role), role: el.role, tag: facts.tag,
        text: text.slice(0, 400), box: el.box, facts, visibility: 'visible', where: [], reveal: { kind: null, hostSelector: null, controlSelector: null },
        place: { inNavigation: false, inFooter: false, insideOwner: false, ownerText: null }, stamps: { self: [], inner: [], owner: [] }, source: 'a11y',
      });
    } catch {
      const id = `b7-a${a11yOnly++}`;
      unreadable.set(id, `listed by the accessibility tree (${el.ref}) but could not be read from the page`);
      items.push({
        id, kind: kindOfRole(el.role), role: el.role, tag: 'generic', text: text.slice(0, 400), box: el.box,
        facts: { tag: 'generic', classes: [], roleAttr: null, cursor: 'auto', text, hasSvg: false, hasImg: false, ownText: true, childElementCount: 0, style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: '', fontWeight: '', display: '', opacity: '1', visibility: 'visible', textTransform: '', letterSpacing: '' }, box: el.box },
        visibility: 'visible', where: [], reveal: { kind: null, hostSelector: null, controlSelector: null }, place: { inNavigation: false, inFooter: false, insideOwner: false, ownerText: null }, stamps: { self: [], inner: [], owner: [] }, source: 'a11y',
      });
    }
  }

  // Audited elements the scan did not turn into an item: the manifest keeps them (an audited element is always accounted for).
  // One whose stamp was lost but whose twin the scan DID find (same words, same place) is that item — never counted twice.
  const stamped = new Set(items.flatMap((i) => [...i.stamps.self, ...i.stamps.inner.map((s) => s.id), ...i.stamps.owner.map((o) => o.id)]));
  for (const c of linkTwins(items, state.components, linked).values()) stamped.add(c.elId);
  let b2Only = 0;
  for (const c of state.components) {
    if (stamped.has(c.elId)) continue;
    items.push(itemOfComponent(c, b2Only++));
  }
  if (b2Only > 0) notes.push(`${b2Only} audited element(s) were not classified as meaningful items by B7's own scan (e.g. a role-less clickable) — kept in the manifest as audited`);
  return { items, notes, truncated: dom.truncated, unreadable };
}

function itemOfComponent(c: DetectedComponent, n: number): RawManifestItem {
  const facts = c.domFacts ?? {
    tag: 'generic', classes: [], roleAttr: null, cursor: 'auto', text: c.label, hasSvg: false, hasImg: false, ownText: true, childElementCount: 0,
    style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: '', fontWeight: '', display: '', opacity: '1', visibility: 'visible', textTransform: '', letterSpacing: '' },
    box: c.fingerprint.box,
  };
  return {
    id: `b7-c${n}`, kind: kindOf(c.componentType), role: c.fingerprint.role, tag: facts.tag, text: c.label.slice(0, 400), box: c.fingerprint.box, facts,
    visibility: 'visible', where: [], reveal: { kind: null, hostSelector: null, controlSelector: null },
    place: { inNavigation: false, inFooter: false, insideOwner: false, ownerText: null }, stamps: { self: [c.elId], inner: [], owner: [] }, source: 'b2',
  };
}

function reconcileState(state: B4Output & { verification?: VerificationReport | undefined }, viewportWidth: number, checkRoles: boolean): ReconcileState {
  return {
    components: state.components, findings: state.findings, ariaElements: state.ariaElements, sections: state.sections,
    decisions: state.decisions ?? {}, verification: state.verification, viewportWidth, checkRoles,
  };
}

export interface CoverageResult {
  state: B4Output;
  ledger: CoverageLedger;
  records: ItemRecord[];
}

/** Which items are gaps, and what is audited — a string that changes exactly when a recovery round changed something. */
function signatureOf(records: ItemRecord[], state: B4Output): string {
  const gaps = records.filter((r) => r.gap !== null).map((r) => `${itemKey(r.raw)}:${r.gap?.type}:${r.state}`).sort();
  return `${gaps.join('|')}#${state.findings.length}#${state.components.length}`;
}

/**
 * The whole B7 procedure for one page, with every page-touching or stage-calling step injectable (`ops`) so each
 * outcome — a gap B3 can never settle, content nothing reveals, a capture that keeps failing — can be proven.
 *
 * It is a LOOP, not a report: while anything is unaccounted, exactly those items go back through the stage that owns
 * them (B2 → B3 → B4 | B6, a role fix, a reveal), the manifest is REBUILT and reconciled again, and B7 checks again.
 *
 *      B7 → recover → re-audit → B7 → recover → re-audit → …   until  unaccounted = 0
 *
 * Termination is by convergence, never by hope: an item gets at most `B7_MAX_PASSES` attempts and is then settled
 * into an explicit, reasoned state (excluded · needs review · capture failed); a round that changes nothing, twice,
 * means no further round could either; and a count / time / capture ceiling stops a pathological page. Only an item
 * B7 never got to examine because that ceiling was hit stays UNACCOUNTED — and then the gate fails and says so.
 */
export async function runCoverageQa(session: PageSession, input: B4Output & { verification?: VerificationReport | undefined }, ops: B7Ops = {}): Promise<CoverageResult> {
  const viewportWidth = session.page.viewportSize()?.width ?? 1440;
  const noApi = session.aiMode === 'no-api';
  const deadline = Date.now() + (ops.budget?.deadlineMs ?? B7_TIME_BUDGET_MS);
  const report = emptyVerificationReport(input.sections.length);
  const actions: CoverageAction[] = [];
  const settled = new Map<string, Settled>();
  const settledKeys = new Set<string>();
  const linked = new Map<string, string>();
  const memo = new Map<string, number>();
  const recovered = { count: 0 };
  const roundRecovered = { count: 0 };
  const touched = new Set<string>();
  let state: B4Output & { verification?: VerificationReport | undefined } = input;

  await scrollThrough(session.page);
  let manifest = await buildCoverageManifest(session, state, linked);
  const noteUnreadable = () => {
    for (const item of manifest.items) {
      const why = manifest.unreadable.get(item.id);
      if (why) settled.set(itemKey(item), { state: 'CAPTURE_FAILED', reason: why });
    }
  };
  noteUnreadable();
  const rec = (): ItemRecord[] => reconcile(manifest.items, reconcileState(state, viewportWidth, noApi), memo, settled, linked);
  let records = rec();
  const firstRoleGaps = new Set(records.filter((r) => r.gap?.type === 'role').map((r) => itemKey(r.raw)));
  const checkedRoles = records.filter((r) => r.component && r.independent?.classification).length;
  const foundKeys = new Set(records.filter((r) => r.state === 'UNACCOUNTED').map((r) => itemKey(r.raw)));

  const unaccountedOf = (rs: ItemRecord[]) => rs.filter((r) => r.state === 'UNACCOUNTED').length;
  let lastReported = -1;
  const emit = (round: number) => {
    const remaining = unaccountedOf(records);
    if (remaining === lastReported) return; // a round that left the count where it was has nothing new to say
    lastReported = remaining;
    ops.onProgress?.({ round, discovered: records.length, accounted: records.length - remaining, remaining });
  };

  const examined = new Set<string>();
  const pc: PassContext = { session, ops, report, actions, settled, settledKeys, linked, recovered, roundRecovered, touched, examined, allRecords: () => records, deadline, roundDeadline: deadline };
  let passes = 0;
  let stopped: CoverageRecovery['stopped'] = foundKeys.size === 0 ? 'not-needed' : 'complete';
  if (noApi) {
    let stalls = 0;
    let corrections = 0;
    let carry: ReadonlySet<string> | null = null; // the first round verifies every finding once; later rounds only what they touch
    if (unaccountedOf(records) > 0) emit(0);
    for (let round = 1; round <= B7_MAX_ROUNDS; round++) {
      const gaps = records.filter((r) => r.gap !== null);
      const runnable = gaps.filter((r) => r.passes < B7_MAX_PASSES);
      // nothing left that any further round could try: what is still open is settled below
      if (round > 1 && runnable.length === 0 && corrections === 0) {
        if (gaps.length > 0) stopped = 'converged';
        break;
      }
      if (round > 1 && globalLimitReached(pc)) {
        stopped = 'limit';
        break;
      }
      passes = round;
      examined.clear();
      touched.clear();
      roundRecovered.count = 0;
      pc.roundDeadline = Math.min(deadline, Date.now() + (ops.budget?.roundMs ?? B7_ROUND_TIME_MS));
      const before = signatureOf(records, state);
      const correctionsBefore = report.propertiesCorrected + report.rematched.length;
      const result = await correctGaps(pc, state, records, round, carry);
      state = result.state;
      carry = new Set();
      corrections = report.propertiesCorrected + report.rematched.length - correctionsBefore;
      // only an item B7 actually looked at has spent one of its attempts
      for (const g of gaps) if (examined.has(itemKey(g.raw))) memo.set(itemKey(g.raw), (memo.get(itemKey(g.raw)) ?? 0) + 1);
      manifest = await buildCoverageManifest(session, state, linked); // the manifest is rebuilt after EVERY round …
      noteUnreadable();
      records = rec(); // … and reconciled again
      if (unaccountedOf(records) > 0) emit(round);
      if (records.every((r) => r.gap === null) && corrections === 0) {
        stopped = foundKeys.size === 0 ? 'not-needed' : 'complete';
        break;
      }
      const progressed = signatureOf(records, state) !== before || corrections > 0;
      stalls = progressed ? 0 : stalls + 1;
      if (examined.size === 0 && corrections === 0) {
        stopped = globalLimitReached(pc) ? 'limit' : 'converged';
        break;
      }
      if (stalls >= 2) {
        stopped = 'converged';
        break;
      }
      if (round === B7_MAX_ROUNDS) stopped = 'limit';
    }
  } else {
    // A model-typed audit: B7 accounts for every item and names every gap, but the corrective stages are the
    // deterministic ones (foundation rules exist in no-api evaluation only) — so a gap goes straight to review.
    for (const g of records.filter((r) => r.gap !== null)) memo.set(itemKey(g.raw), B7_MAX_PASSES);
    records = rec();
    if (foundKeys.size > 0) stopped = 'converged';
  }

  state = settleGaps(pc, state, records, { exhaustAll: stopped === 'converged' });
  // GLOBAL CHROME FIRST: a first-pass finding whose element sits in the page's banner / contentinfo landmark belongs to the
  // Global Header / Global Footer section — the hero (or any content section) owns only what is in its own subtree.
  records = rec();
  const rehomed = rehomeToRegions(state, records);
  state = rehomed.state;
  for (const m of rehomed.moved) pc.actions.push({ pass: Math.max(passes, 1), route: 'B2', itemId: m.elId, label: m.label.slice(0, 60), outcome: 'resolved', reason: m.why === 'detached' ? `a detached overlay (outside every section's subtree, opened from none) — moved from "${m.from}" to "${m.to}" and marked for review` : `inside the page's ${/footer/i.test(m.to) ? 'footer' : 'header'} landmark — moved from "${m.from}" to "${m.to}"` });
  // FINAL VALIDATION before the report is generated: one finding per canonical element (same element + role + section).
  // Every audit mode, every run kind; a no-op unless a duplicate slipped through.
  const validated = await reconcileCanonical(pc, state, passes, { requireSameSection: true });
  if (validated.merged.length > 0) {
    state = validated.state;
    manifest = await buildCoverageManifest(session, state, linked);
    noteUnreadable();
  }
  records = rec();
  // STRUCTURAL REGIONS: every section is the Global Header, the Global Footer or page content; a finding carries its
  // region and, in the Global Header, its sub-group (base navigation · a named menu · search · account / user menu).
  state = annotateRegions(state, records);

  const notes = [...manifest.notes];
  if (!noApi) notes.push('anthropic-api mode: B7 accounted for every item and marked each gap for review — the corrective stages (foundation rules, family re-search) are deterministic and run in no-api mode');
  const stillOpen = unaccountedOf(records);
  if (stopped === 'limit' && stillOpen > 0) notes.push(`B7's recovery loop stopped at its safety limit (${passes} round(s), ${recovered.count} element(s) re-audited) with ${stillOpen} item(s) not yet examined — they are reported as unaccounted`);
  if (manifest.truncated) notes.push('the page holds more items than the manifest limit — the rest was not enumerated, so the gate cannot pass');
  const roleStillOpen = records.filter((r) => firstRoleGaps.has(itemKey(r.raw)) && (r.gap?.type === 'role' || (r.state === 'NEEDS_REVIEW' && /audited role still disagrees|disagrees/i.test(r.reason)))).length;

  // what became of every item that was unaccounted when B7 first looked
  const finalState = new Map(records.map((r) => [itemKey(r.raw), r.state]));
  let backAudited = 0;
  let settledInto = 0;
  for (const key of foundKeys) {
    const st = finalState.get(key);
    if (st === 'AUDITED') backAudited++;
    else if (st === undefined) linked.has(key) ? backAudited++ : settledInto++; // its key moved with the layout: B7's own record says which
    else if (st !== 'UNACCOUNTED') settledInto++;
  }
  const recovery: CoverageRecovery = { passes: foundKeys.size > 0 || actions.length > 0 ? passes : 0, found: foundKeys.size, recovered: backAudited, settled: settledInto, remaining: stillOpen, stopped };
  const ledger = buildLedger(records, {
    actions, passes, notes, sources: SOURCES, recovery,
    roleChecks: { checked: checkedRoles, inconsistent: firstRoleGaps.size, corrected: firstRoleGaps.size - roleStillOpen, unresolved: roleStillOpen },
  });
  if (manifest.truncated) {
    ledger.gate = { ...ledger.gate, passed: false, discovered: ledger.gate.discovered + 1, unaccounted: ledger.gate.unaccounted + 1 };
    ledger.unaccounted.push({ id: 'b7-truncated', kind: 'text', label: '(manifest limit reached — the rest of the page was not enumerated)', section: '(whole page)', box: { x: 0, y: 0, width: 0, height: 0 }, where: [], state: 'UNACCOUNTED', reason: 'the page holds more meaningful items than the manifest limit', passes: 0 });
    if (ledger.recovery) ledger.recovery.remaining += 1;
  }
  return { state, ledger, records };
}

export type B7Output = B4Output & { verification?: VerificationReport | undefined };

/** The graph node. */
export async function runB7(_ctx: NodeContext, input: B4Output & { session: PageSession; verification?: VerificationReport | undefined }): Promise<B7Output> {
  const { session, ...rest } = input;
  const { state, ledger, records } = await runCoverageQa(session, rest, session.onCoverageProgress ? { onProgress: session.onCoverageProgress } : {});
  // A capture failure is a coverage error, exactly like B5's: it joins the explicit, counted list of what could not be audited.
  const failures = records.filter((r) => r.state === 'CAPTURE_FAILED').map((r) => ({ node: 'B7', ref: r.raw.id, reason: `${r.raw.text.slice(0, 40) || r.raw.kind}: ${r.reason}` }));
  return {
    ...state,
    coverage: { ...state.coverage, droppedRefs: [...state.coverage.droppedRefs, ...failures], ledger },
    ...(rest.verification ? { verification: rest.verification } : {}),
  };
}
