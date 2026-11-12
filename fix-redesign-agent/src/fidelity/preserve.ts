import type { Exemption, ResolutionFile, ResolvedTarget } from '../resolution/schema.ts';
import { BOX_ABS_TOL, BOX_REL_TOL, coveredProperties, explainBox, indexFindingParts, isUnder, keysForPart, partTruncation, type PartIndex } from './compare.ts';
import { CANONICAL_PROPERTIES } from './lib.ts';
import type { CapturedElement, DesignBaseline, ElementEvidence, FidelityReport, FidelityViewportName, PreserveResult, SectionDesign, StateEvidence } from './types.ts';

/**
 * Preservation is proven by POSITIVE evidence. A preserve decision is `preserved-verified` only when the same element, part, property,
 * state and viewport were compared on both pages and agree. Precedence: failed > unverified > preserved-verified, where
 *   failed      = a measured difference no target authorizes, or a CONFIRMED removal (the output section is located and uncapped, and no
 *                 element carrying the finding id exists anywhere in it — also when a sibling slid into the removed element's position);
 *   unverified  = anything short of evidence: an element that moved, changed tag or text, a capped or skipped section, a part the capture cut,
 *                 a state that was not captured (or only on an ancestor), a theme that is not emulated, a property the verifier does not
 *                 measure, a baseline without the evidence, a change an authorized target explains.
 * Presence comes FIRST: an element that is gone fails every decision about it, measurable or not; the measurability gates apply to what is there.
 */

const CANONICAL = new Set<string>(CANONICAL_PROPERTIES);

type Measure =
  | { kind: 'style'; props: string[]; differenceProps: string[] }
  | { kind: 'box'; axis: 'w' | 'h'; differenceProps: string[] }
  | { kind: 'none' };

/** What evidence a target's property can be judged on. Anything not listed here is NOT measured by the fidelity verifier. */
export function measuredPropertiesOf(property: string): Measure {
  const p = property.trim().toLowerCase();
  // only the property that DEFINES the used box is judged from it: min-/max-width, flex-basis and min-/max-height can change without the used box moving
  if (p === 'width') return { kind: 'box', axis: 'w', differenceProps: ['width-ratio'] };
  if (p === 'height') return { kind: 'box', axis: 'h', differenceProps: [] };
  const props = [...coveredProperties(p)].filter((x) => CANONICAL.has(x));
  if (props.length === 0) return { kind: 'none' };
  return { kind: 'style', props, differenceProps: p === 'text-align' ? ['text-alignment'] : p === 'justify-content' || p === 'align-items' ? ['horizontal-alignment'] : [] };
}

type Verdict = 'ok' | 'failed' | 'unverified';
interface Tuple { verdict: Verdict; reason: string; detail: string; sectionId: string; viewport: FidelityViewportName; elementKey: string; outcome: PreserveResult['evidence'][number]['outcome'] }

export interface PreserveInput {
  resolution: ResolutionFile | null;
  report: FidelityReport;
  baseline: DesignBaseline | null;
  /** The authorizations in force: a box change is explained only by an authorized layout-affecting change. */
  exemptions: Exemption[];
  overrideSectionIds?: ReadonlySet<string>;
}

const STATE_OF: Record<string, 'default' | 'hover' | 'focus-visible' | undefined> = { default: 'default', hover: 'hover', focus: 'focus-visible', 'focus-visible': 'focus-visible' };

export function evaluatePreserveTargets(input: PreserveInput): PreserveResult[] {
  if (!input.resolution) return [];
  return input.resolution.targets.filter((t) => t.outcome === 'preserve-existing').map((t) => evaluateOne(t, input));
}

function evaluateOne(t: ResolvedTarget, input: PreserveInput): PreserveResult {
  const { baseline, report } = input;
  const done = (verification: PreserveResult['verification'], reason: string, detail: string, evidence: PreserveResult['evidence'] = []): PreserveResult =>
    ({ targetId: t.id, findingId: t.findingId, property: t.property, state: t.state, verification, reason, detail: verification === 'preserved-verified' ? detail : `${reason}: ${detail}`, evidence: evidence.slice(0, 8) });
  const unverified = (reason: string, detail: string) => done('unverified', reason, detail);

  if (!baseline || (report.verdict === 'not-checked' && report.summary.elementsCompared === 0)) return unverified('no comparison available', 'the design baseline could not be compared with the preview');
  const cov = report.coverage;
  if (!cov) return unverified('no comparison available', 'the fidelity report predates per-element evidence, so nothing proves this property was compared');
  const state = STATE_OF[t.state];
  const measure = measuredPropertiesOf(t.property);
  // what the verifier cannot measure is decided PER ELEMENT in `judge`, after presence: a removed element fails the decision whatever the property or state
  const stateOnlyDesktop = state !== undefined && state !== 'default';

  // ── which elements, in which sections and viewports, must have been compared
  const wanted: FidelityViewportName[] = stateOnlyDesktop && t.viewport.name === 'any' ? ['desktop'] : t.viewport.name === 'any' ? ['desktop', 'mobile'] : [t.viewport.name];
  const sectionIds = [...new Set(baseline.sections.filter((s) => s.located && indexFindingParts(s).has(t.findingId)).map((s) => s.sectionId))].sort();
  if (sectionIds.length === 0) return unverified('element not in the baseline', 'the element of this finding is not in the design baseline');
  const partKnown = (idx: PartIndex) => t.part === 'self' || t.part === 'label' || t.part === 'descendants' || t.part in idx.named;
  const tuples: Tuple[] = [];
  const presentOn = new Set<FidelityViewportName>();
  const uncaptured = new Set<string>(); // members of the part that are not captured elements (role-less wrappers such as an <li> around a link): a stated limit, not a missing comparison
  for (const sectionId of sectionIds) {
    for (const vp of wanted) {
      const sb = baseline.sections.find((s) => s.sectionId === sectionId && s.viewport === vp);
      const idx = sb?.located ? indexFindingParts(sb).get(t.findingId) : undefined;
      if (!sb || !sb.located) { tuples.push(skipTuple(sectionId, vp, 'section not located on the original', `${sectionId} (${vp}) could not be located on the original`)); continue; }
      if (!idx) {
        // an element that exists on the other viewport only is simply not required here — unless the baseline section was capped, when its absence proves nothing
        if (sb.capped) tuples.push(skipTuple(sectionId, vp, 'element not in the baseline', `${sectionId} (${vp}) was captured with an element cap and the element is not in it`));
        continue;
      }
      if (!partKnown(idx)) return unverified('part cannot be mapped', `the part "${t.part}" cannot be mapped to a captured element, so it is not claimed as preserved`);
      const members = [...new Set(keysForPart(idx, t.part))];
      // evidence is required for the CAPTURED members of the part only. A member the element cap DROPPED is a real element nobody compared (never proven); only a wrapper with no text, design or role
      // (or one that is not rendered) is not an element the verifier measures, and is disclosed below
      const keys = members.filter((k) => sb.elements.some((e) => e.key === k));
      // (a capped baseline from before the capture recorded the cap's losses cannot tell the two apart: every uncaptured member of its parts counts as possibly dropped)
      const unknownLoss = !!sb.capped && !sb.capLossRecorded;
      const dropped = members.filter((k) => !keys.includes(k) && (unknownLoss || idx.capDropped.includes(k)));
      for (const k of members) if (!keys.includes(k) && !dropped.includes(k)) uncaptured.add(k);
      const droppedNote = `${dropped.length} member(s) of the part "${t.part}" were dropped by the ${baseline.limits.maxElements}-element cap of the capture and were never compared, so the part is not claimed as preserved (the cap is baked into the stored, write-once baseline: raising fidelity.maxElementsPerSection alone changes nothing, clearing it needs a deliberate recapture — remove design-baseline.json — with a higher fidelity.maxElementsPerSection)`;
      if (keys.length === 0 && dropped.length > 0) { tuples.push(skipTuple(sectionId, vp, 'part capped', `${sectionId} (${vp}): ${droppedNote}`)); continue; }
      if (keys.length === 0) { tuples.push(skipTuple(sectionId, vp, 'part cannot be mapped', `${sectionId} (${vp}): ${members.length ? `none of the ${members.length} member(s) of the part "${t.part}" of this finding is a captured element` : `no captured element carries the part "${t.part}" of this finding`}`)); continue; }
      presentOn.add(vp);
      if (dropped.length > 0) tuples.push(skipTuple(sectionId, vp, 'part capped', `${sectionId} (${vp}): ${droppedNote}`));
      // a part whose member list the capture cut (80 descendants / 40 labels / the walk limit) is never proven: the members it did not record were never compared
      const cut = partTruncation(idx, t.part);
      if (cut > 0) tuples.push(skipTuple(sectionId, vp, 'part capped', `${sectionId} (${vp}): the part "${t.part}" has ${cut} more member(s) than the capture records, so those were never compared and the part is not claimed as preserved`));
      for (const key of keys) tuples.push(judge(t, input, measure, state, sb, vp, key));
    }
  }
  if (tuples.length === 0) return unverified('element not in the baseline', 'the element of this finding is not in the design baseline');

  const evidence: PreserveResult['evidence'] = tuples.map((x) => ({ sectionId: x.sectionId, viewport: x.viewport, elementKey: x.elementKey, state: state ?? t.state, outcome: x.outcome, reason: x.reason }));
  const failed = tuples.filter((x) => x.verdict === 'failed');
  if (failed.length) return done('failed', failed[0]!.reason, `${failed.slice(0, 3).map((x) => x.detail).join(' | ')}${failed.length > 3 ? ` | and ${failed.length - 3} more` : ''}`, evidence);
  const open = tuples.filter((x) => x.verdict === 'unverified');
  if (open.length) return done('unverified', open[0]!.reason, `${open.slice(0, 2).map((x) => x.detail).join(' | ')}${open.length > 2 ? ` | and ${open.length - 2} more` : ''}`, evidence);

  const bySection = new Map<string, FidelityViewportName[]>();
  for (const x of tuples) bySection.set(x.sectionId, [...new Set([...(bySection.get(x.sectionId) ?? []), x.viewport])].sort());
  const where = [...bySection].map(([s, vps]) => `${s} (${vps.join(', ')})`).join('; ');
  const notes = [
    stateOnlyDesktop ? 'hover and keyboard focus are captured on desktop only (mobile: not applicable)' : t.viewport.name === 'any' && presentOn.size === 1 ? `${[...presentOn][0]} only: the element is not in the ${[...presentOn][0] === 'desktop' ? 'mobile' : 'desktop'} baseline` : '',
    state === 'focus-visible' && t.state === 'focus' ? 'plain :focus is approximated by keyboard :focus-visible' : '',
    uncaptured.size ? `${uncaptured.size} role-less wrapper member(s) of the part (no text, design or role of their own, or not rendered) are not captured elements and were not compared` : '',
  ].filter(Boolean);
  const tol = measure.kind === 'box' ? `box tolerance ${BOX_ABS_TOL}px or ${BOX_REL_TOL * 100}%` : 'tolerance: colours ΔE ≤ 2, lengths 0.5px';
  return done('preserved-verified', 'preserved-verified', `${t.property}${t.part === 'self' ? '' : ` (${t.part})`} compared equal on ${tuples.length} element(s) in the ${state ?? t.state} state: ${where}; ${tol}${notes.length ? `; ${notes.join('; ')}` : ''}`, evidence);
}

function skipTuple(sectionId: string, viewport: FidelityViewportName, reason: string, detail: string): Tuple {
  return { verdict: 'unverified', reason, detail, sectionId, viewport, elementKey: '', outcome: 'not-compared' };
}

function judge(t: ResolvedTarget, input: PreserveInput, measure: Measure, state: 'default' | 'hover' | 'focus-visible' | undefined, sb: SectionDesign, vp: FidelityViewportName, key: string): Tuple {
  const cov = input.report.coverage!;
  const at = `${sb.sectionId} (${vp})`;
  const mk = (verdict: Verdict, reason: string, detail: string, outcome: Tuple['outcome']): Tuple => ({ verdict, reason, detail, sectionId: sb.sectionId, viewport: vp, elementKey: key, outcome });
  const sectionEv = cov.sections.find((s) => s.sectionId === sb.sectionId && s.viewport === vp);
  if (input.overrideSectionIds?.has(sb.sectionId) || sectionEv?.outcome === 'override') return mk('unverified', 'hand-authored section', `${at} is a hand-authored section: its own checks cover it, this verifier did not compare it`, 'not-compared');
  if (!sectionEv) return mk('unverified', 'no comparison available', `${at} was not part of the comparison`, 'not-compared');
  if (sectionEv.outcome === 'baseline-not-located') return mk('unverified', 'section not located on the original', `${at} could not be located on the original`, 'not-compared');
  if (sectionEv.outcome === 'capture-stopped') return mk('unverified', 'capture stopped by the verification budget', `${at} was not captured before the verification budget ran out`, 'not-compared');
  const eb = sb.elements.find((e) => e.key === key);
  const label = `<${eb?.tag ?? '?'}> "${(eb?.label ?? '').slice(0, 30)}"`;
  if (sectionEv.outcome === 'output-not-rendered') return mk('failed', 'element removed', `element removed: ${label} exists on the original at ${at} and the section is not rendered in the output`, 'removed');
  const ev = cov.elements.find((e) => e.sectionId === sb.sectionId && e.viewport === vp && e.elementKey === key);
  if (!ev) return mk('unverified', 'no comparison available', `${at}: no per-element evidence was recorded for ${label}`, 'not-compared');

  switch (ev.outcome) {
    case 'removed': return mk('failed', 'element removed', `element removed: ${label} exists on the original at ${at} and nothing carrying finding ${t.findingId} or identical text exists in the output section`, 'removed');
    case 'moved': return mk('unverified', 'element moved to another position', `${label} at ${at} is not at the same position in the output (found at ${ev.relocatedTo ?? 'another position'}), so it was not compared`, 'not-compared');
    case 'tag-changed': return mk('unverified', 'element tag changed', `${label} at ${at} changed its tag in the output, so it was not compared`, 'not-compared');
    case 'text-changed': return mk('unverified', 'element text changed', `the text of ${label} at ${at} differs in the output, so its design was not compared`, 'not-compared');
    case 'capped-output': return mk('unverified', 'output section capped', `the output section at ${at} exceeded the element cap, so ${label} was not captured`, 'not-compared');
    case 'inside-component': return mk('unverified', 'inside a design-system component', `${label} at ${at} sits inside a mounted design-system component, which owns its own design`, 'not-compared');
    default: break;
  }
  // identity: the output element at this position must still carry the finding it was named by (a stamp lost or moved is not "the same element")
  if (eb && eb.findingIds.length && ev.observedFindingIds && !eb.findingIds.some((f) => ev.observedFindingIds!.includes(f))) return mk('unverified', 'element identity not confirmed', `${label} at ${at}: the element at this position in the output has the same tag and text but does not carry finding ${eb.findingIds.join(', ')}, so it is not confirmed to be the same element`, 'not-compared');

  // ── what the verifier cannot measure is decided only now, for an element that IS there
  if (!state) return mk('unverified', 'state not captured by the verifier', `the ${t.state} state is not captured by the verifier (only default, hover and keyboard focus are), so it is not claimed as preserved`, 'not-compared');
  if (measure.kind === 'none') return mk('unverified', 'not measured by the verifier', `${t.property} is not one of the properties the fidelity verifier measures, so its preservation cannot be proven`, 'not-compared');
  if (measure.kind === 'box' && state !== 'default') return mk('unverified', 'not measured by the verifier', `${t.property} is measured from the laid-out box at rest only, not in the ${t.state} state`, 'not-compared');
  if (state !== 'default' && vp === 'mobile') return mk('unverified', 'state not captured by the verifier', `${t.state} is captured on the desktop viewport only (touch devices have no hover), so a mobile ${t.state} target cannot be verified`, 'not-compared');
  if (t.theme !== 'inherit') return mk('unverified', 'theme not captured by the verifier', `the target is scoped to the ${t.theme} theme, but the verifier captures the page as rendered and does not emulate a theme, so ${t.property} under it was not compared`, 'not-compared');

  if (measure.kind === 'box') return judgeBox(t, input, measure, sb, vp, key, ev, label, mk);

  // ── style evidence, in the requested state
  let recordKeys: string[] | null;
  if (state === 'default') recordKeys = eb ? Object.keys(eb.style) : null;
  else {
    const holder = stateHolder(sb, key, state, t.findingId);
    if (holder && holder.ancestorOnly) return mk('unverified', 'state captured on an ancestor only', `the ${state} state of ${label} at ${at} was captured with an ancestor (${holder.el.tag} "${holder.el.label.slice(0, 24)}") hovered/focused, not ${label} itself, so its own ${state} rules were never exercised`, 'not-compared');
    if (!holder) return mk('unverified', 'state not captured on the original', `the ${state} state of ${label} at ${at} was not captured on the original${eb?.stateAttempt?.[state] === 'unsettled' ? ' (it kept changing)' : ''}, so it is not claimed as preserved`, 'not-compared');
    const hev = cov.elements.find((e) => e.sectionId === sb.sectionId && e.viewport === vp && e.elementKey === holder.el.key);
    if (!hev || hev.outcome !== 'compared') return mk('unverified', 'state not captured on the output', `the ${state} state holding ${label} at ${at} was not compared (its element was not compared)`, 'not-compared');
    const se: StateEvidence = hev.states[state];
    if (se === 'not-captured-in-output') return mk('unverified', 'state not captured on the output', `the ${state} state of ${label} at ${at} could not be captured on the output, so it is not claimed as preserved`, 'not-compared');
    if (se === 'focus-visible-mismatch') return mk('unverified', 'focus-visible mismatch', `keyboard focus on ${label} at ${at} matched :focus-visible differently on the two sides, so its focus styles were not compared`, 'not-compared');
    if (se !== 'compared') return mk('unverified', 'state not captured on the original', `the ${state} state of ${label} at ${at} was not compared (${se})`, 'not-compared');
    if (hev.stateSkipped?.[state]?.includes(holder.rel)) return mk('unverified', 'state not captured on the output', `${label} at ${at} was not part of the output's ${state} capture, so its ${state} styles were not compared`, 'not-compared');
    recordKeys = Object.keys(holder.el.states[state]!.subtree[holder.rel] ?? {});
  }
  const props = measure.props.filter((p) => recordKeys?.includes(p));
  if (props.length === 0) return mk('unverified', 'not measured by the verifier', `${t.property} is not in the baseline's ${state} record of ${label} at ${at}`, 'not-compared');
  const diffs = input.report.differences.filter((d) => d.sectionId === sb.sectionId && d.viewport === vp && d.elementKey === key && d.state === state && d.property !== null && (props.includes(d.property) || measure.differenceProps.includes(d.property)));
  const bad = diffs.find((d) => d.classification === 'regression');
  if (bad) return mk('failed', 'property changed', `${t.property} changed although it was preserved: ${label} at ${at}${state === 'default' ? '' : `, ${state}`}: ${bad.detail}`, 'changed');
  const auth = diffs.find((d) => d.classification === 'intentional');
  if (auth) return mk('unverified', 'changed under another authorized target', `${t.property} of ${label} at ${at} actually changed under the authorized target ${auth.exemptionTargetId ?? 'of another decision'}, so it is not preserved (and not a failure)`, 'changed');
  return mk('ok', 'compared-equal', 'compared equal', 'compared-equal');
}

function judgeBox(t: ResolvedTarget, input: PreserveInput, measure: Extract<Measure, { kind: 'box' }>, sb: SectionDesign, vp: FidelityViewportName, key: string, ev: ElementEvidence, label: string, mk: (verdict: Verdict, reason: string, detail: string, outcome: Tuple['outcome']) => Tuple): Tuple {
  const at = `${sb.sectionId} (${vp})`;
  const bx = ev.box;
  if (!bx?.baseline) return mk('unverified', 'no box evidence in the baseline', `the original baseline has no box measurements for ${label} at ${at} (it was captured before box evidence existed; recapturing means deliberately removing design-baseline.json)`, 'not-compared');
  if (!bx.equal) return mk('unverified', 'no box evidence in the output', `the output capture has no box measurement for ${label} at ${at}`, 'not-compared');
  const axis = measure.axis;
  const b = bx.baseline[axis];
  const same = bx.equal[axis];
  const name = axis === 'w' ? 'width' : 'height';
  // the evidence keeps the verdict and the baseline, never the raw observed box (it would flap the hashed report); a changed axis carries its observed size bucketed to 8px
  const now = bx.changedTo?.[axis];
  // the width-ratio comparison is part of the global check: a regression on this element is already a measured, unauthorized change
  const ratio = input.report.differences.find((d) => d.sectionId === sb.sectionId && d.viewport === vp && d.elementKey === key && measure.differenceProps.includes(d.property ?? '') && d.classification === 'regression');
  const change = `the used ${name} of ${label} at ${at} changed from ${b}px to about ${now ?? '?'}px`;
  if (ratio) return mk('failed', 'box changed', `${same ? `the ${name} of ${label} at ${at} changed` : change}: ${ratio.detail}`, 'changed');
  if (same) return mk('ok', 'compared-equal', 'compared equal', 'compared-equal');
  const wrapDriven = axis === 'h' && !bx.equal.w;
  const why = explainBox(sb, key, input.exemptions, vp, input.report.coverage!.sections.find((s) => s.sectionId === sb.sectionId && s.viewport === vp)?.islandKeys ?? []);
  if (why) return mk('unverified', 'layout change explains the box change', `${change}, and ${why}; the change is neither failed nor preserved`, 'changed');
  if (wrapDriven) return mk('unverified', 'layout change explains the box change', `${change} after its width changed (${bx.baseline.w}px to about ${bx.changedTo?.w ?? '?'}px), so the height follows the wrapping and is not attributable`, 'changed');
  return mk('failed', 'box changed', `${change} with no authorized layout-affecting change on it, around it or in its section`, 'changed');
}

/**
 * The element whose captured hover/focus state holds `key`'s styles: the element itself; else the FINDING element the decision is about (hovering it
 * exercises its parts' rules); else only a mere ancestor — whose state says nothing about `key`'s own `:hover` / `:focus` rules (`ancestorOnly`).
 */
function stateHolder(sb: SectionDesign, key: string, state: 'hover' | 'focus-visible', findingId: string): { el: CapturedElement; rel: string; ancestorOnly: boolean } | null {
  let best: { el: CapturedElement; rel: string; ancestorOnly: boolean } | null = null;
  const rank = (el: CapturedElement) => (el.key === key ? 3 : el.findingIds.includes(findingId) ? 2 : 1);
  for (const e of sb.elements) {
    const cap = e.states[state];
    if (!cap || !isUnder(key, e.key)) continue;
    const rel = key === e.key ? '' : e.key === '' ? key : key.slice(e.key.length + 1);
    if (!(rel in cap.subtree)) continue;
    if (!best || rank(e) > rank(best.el) || (rank(e) === rank(best.el) && e.key.length > best.el.key.length)) best = { el: e, rel, ancestorOnly: rank(e) === 1 };
  }
  return best;
}
