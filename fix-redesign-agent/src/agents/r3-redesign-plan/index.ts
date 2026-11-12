import type { Finding } from '../../audit-link/index.ts';
import { lengthToPx } from '../../t-layer/computed-style.ts';
import { coveredProperties, valuesEqual } from '../../fidelity/compare.ts';
import type { PlannerFeedbackItem } from '../../fidelity/types.ts';
import { buildComponentCatalog, renderRulesForPrompt, type CatalogComponent } from '../../ds/catalog.ts';
import type { LlmClient } from '../../llm/client.ts';
import { RedesignPlanSchema, type RedesignPlan, type TargetedEdit } from '../../llm/schemas/r-nodes.ts';
import { TerminalError } from '../../retry.ts';
import { POLICY_REFUSAL, REDESIGN_RULES, redesignPolicyViolation } from '../../redesign-policy.ts';
import { roleForProperty } from '../../resolution/ds-colours.ts';
import { buildDsTokenIndex, type DsTokenIndex } from '../../resolution/ds-evidence.ts';
import { stateOfEdit } from '../../resolution/progress.ts';
import type { ResolutionFile, ResolvedTarget, StateName } from '../../resolution/schema.ts';
import { inScopeFindings } from '../../session/in-scope.ts';
import type { R3Input, R3Output } from '../types.ts';

/**
 * R3 — Redesign Planner (ai, §8.6). One batched structured call over the authorized,
 * in-scope findings still needing work (chunked beyond a bound, never one call per finding).
 * Edits address STAMPED elements (§6.4's `data-fra-element`) — the model is given each
 * finding's stamp selector directly, never asked to derive one itself; a supplied `selector`
 * on a `TargetedEdit` may only reach a DESCENDANT of that stamp.
 */

export const R3_STATUS = 'implemented' as const;

/** Mirrors audit-agent B5's own per-page batching discipline (MAX_VERIFIED_FINDINGS) — never one call per finding. */
export const CHUNK_SIZE = 15;

export interface R3Deps {
  llm: LlmClient;
  /** the DS root: lets the edit guard accept a `var(--alias)` that resolves to the target's colour (without it, such an alias is refused). */
  designSystemPath?: string;
  log?: (line: string) => void;
}

const SYSTEM_PROMPT = `You are the Redesign Planner of a Design System compliance auto-fix pipeline.
You are given a batch of already-authorized findings on a live page, each already resolved to a stamped element via a CSS attribute selector — you never invent a selector for the finding's own element, only optionally a DESCENDANT selector under it.
For each finding, produce ONE OR MORE targeted edits that close it, following this priority strictly:
 1. If the finding has measured mismatches (property/actual/expected/expectedToken given), emit a "style" edit per mismatch using the EXACT expected value and, when given, the expectedToken.
 2. Else if it has rule violations with an expected value derivable from the DS rules shown, emit a rule-driven "style"/"attribute"/"class" edit.
 3. Else if a DS component match is given (dsComponent/dsFile/source excerpt), emit a "component-swap" edit to that exact component (name exactly as listed), choosing a variant from the ones the catalog lists for it.
 4. Else if a plausible DS match is given (marked "plausible, not confirmed"), emit a "component-swap" edit to it, and say so plainly in the rationale.
 5. Otherwise put the finding in "unaddressed" with a clear reason — NEVER invent a fix with no basis.
Rules:
 - Every edit's "selector" MUST be exactly the finding's given stamp selector, or that selector followed by a descendant combinator (e.g. space, >, a class) — never a bare tag/class selector, never document-wide.
 - "expectedMatches" is 1 unless the finding explicitly covers repeated identical instances.
 - Never touch an element outside the given stamp — that is the structural guarantee this whole pipeline relies on.
 - For "component-swap" edits: "value" must be the space-separated Tailwind utility classes (drawn from the DS component's own cva/variant conventions shown to you) to ADD to the element so it visually matches that DS component and variant. This is a class-level alignment, not a markup rewrite — never invent a class not grounded in the DS source shown.
 - A finding whose two mismatches conflict (impossible to satisfy both) — pick the one with the clearer expectedToken and put the OTHER in "unaddressed" naming the conflict; never silently drop it without a reason.
 - The edits are applied to the PRODUCTION page, which does not define the Design System's custom properties. A value written as var(--ds-token) resolves to nothing there and makes the WHOLE declaration invalid (the element silently keeps its old value). Write the literal value (for a font stack: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif or 'Noto Serif', Georgia, 'Times New Roman', serif) and name the token only in "dsToken".
 - Text is often inside a descendant that sets its own font family or colour: if an edit on the stamped element does not reach the visible text, the next iteration must target that descendant.
 - When constraints from a rejected prior preview are given, treat them as hard requirements for this iteration.
 - When a finding lists "resolved targets", they are the ONLY properties you may change with "style" edits, each with its exact value (and state): use the value verbatim and name the token in "dsToken". A property listed under "not to be changed" was resolved as preserve-existing or unresolved: never edit it. Resolved targets supersede the mismatch list for deciding WHICH properties may change; the mismatch list stays the audit's own measurements.
 - A target for a hover/focus state is an edit whose selector is the stamp selector followed by :hover, :focus or :focus-visible (e.g. [data-fra-element="e1"]:hover) — set expectedMatches to 1.
 - When a finding carries "preview feedback", the rendered React preview contradicts what was measured on the live page: edit ONLY the listed property (and its longhands) in the listed state, keep every other edit as it is (do not re-emit it), and for a "keep the original value" item emit exactly one edit of that property whose value is the original value verbatim. A corrected edit replaces the earlier edit of that property on the stamp itself, on its own selector or on an ancestor of its selector; an edit on a sibling element is not replaced, so correct each failing element.`;

const norm = (v: string | null | undefined): string => (v ?? '').replace(/\s*!important\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
/**
 * Length-like properties the verifier compares as TEXT (it has no tolerance for them): `px` and a bare `0` are normalised so `16px` and `16.0px` are one value,
 * per whitespace-separated token (`margin: 0 16px`). `rem` / `em` are NOT converted (see `RELATIVE_LENGTH`) and `%` depends on the element, so those stay text.
 * Unlike the verifier's own LENGTH set there is NO 0.5px tolerance here: for these properties `16.3px` and `16px` are different values, as they are for the verifier.
 */
const LENGTH_LIKE = /^(margin(-(top|right|bottom|left|block|inline)(-start|-end)?)?|width|height|(min|max)-(width|height)|top|right|bottom|left|inset(-(block|inline)(-start|-end)?)?)$/;
const canonLength = (v: string): string => v.split(' ').map((t) => (/^-?(\d+\.?\d*|\.\d+)px$|^0$/i.test(t) ? `${Number((lengthToPx(t) ?? 0).toFixed(3))}px` : t)).join(' ');
/**
 * A rem / em length computes from the page's root or the element's font size, which R3 is not given (the measured `rootFontSizePx` stops at the capture): a 16px root
 * is a guess that is wrong on a page with `html { font-size: 62.5% }`, where `1rem` is 10px. Such a value equals another spelling only VERBATIM, so a restore written
 * `1rem` is not taken for the 16px original and a 16px edit is not taken for the `1rem` already in force. R8 measures the real result either way.
 */
const RELATIVE_LENGTH = /[\d.](rem|em)\b/i;
/**
 * The same value however it is spelled: the verifier's own comparison (colours by ΔE, the LENGTH set in px WITH its 0.5px tolerance, so a 28.4px edit beside the
 * 28px in force counts as the same edit — the verifier itself calls them equal), the length-like properties above by normalised px, else the text.
 * The baseline is a COMPUTED value (`rgb(255, 255, 255)`), the edit is whatever the model wrote (`#fff`, `16.0px`).
 */
const sameValue = (property: string, a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  if (RELATIVE_LENGTH.test(x) || RELATIVE_LENGTH.test(y)) return false;
  const p = property.trim().toLowerCase();
  return valuesEqual(p, x, y) || (LENGTH_LIKE.test(p) && canonLength(x) === canonLength(y));
};
/** Feedback that asks for the ORIGINAL value back: the only acceptable edit restores exactly that value. */
const isRestore = (i: PlannerFeedbackItem): boolean => i.kind === 'default-regression' || i.kind === 'preserve-broken';
const stateText = (s: StateName): string => (s === 'default' ? 'default state' : `${s} state`);

/** Feedback no style edit can satisfy: reported with the reason instead of being sent to the model. */
function unactionable(i: PlannerFeedbackItem): string | null {
  if (i.viewport === 'mobile') return `the rendered preview fails ${i.property} at the mobile viewport (expected ${i.expected ?? 'the original value'}, observed ${i.observed ?? 'a different value'}); a targeted edit has no per-viewport form and would also change the desktop page, so it is reported, not planned`;
  if (isRestore(i) && i.expected === null) return `the rendered preview breaks ${i.property}, which must keep the original value, but that original value is not recorded for this decision, so an edit cannot restore it; the edit that changed it has to be retracted`;
  return null;
}

/** An edit is within the preview feedback only for the property (or a longhand of it) and the state it names; a restore item accepts only the original value. */
function inFeedbackScope(edit: TargetedEdit, items: PlannerFeedbackItem[]): boolean {
  if (edit.kind !== 'style' || !edit.property) return false;
  const property = edit.property.trim().toLowerCase();
  const state = stateOfEdit(edit);
  return items.some((i) => i.state === state && (isRestore(i) ? property === i.property.trim().toLowerCase() && sameValue(property, edit.value, i.expected) : coveredProperties(i.property).has(property)));
}

function findingContext(
  finding: Finding,
  stampSelector: string,
  dsExcerpt: { dsComponent: string | null; dsFile: string | null; sourceExcerpt: string | null; basis: string } | null,
  catalog: CatalogComponent[],
  note: string | null,
  targets: ResolvedTarget[],
  feedback: PlannerFeedbackItem[] = [],
  inForce: TargetedEdit[] = [],
): string {
  const mismatches = finding.comparison.mismatches.map((m) => `    - ${m.property}: actual="${m.actual}" expected="${m.expected}"${m.expectedToken ? ` token=${m.expectedToken}` : ''} (compare by ${m.comparison})`).join('\n');
  const rules = finding.comparison.ruleViolations.map((r) => `    - ${r.ruleId} ${r.title}: ${r.why}`).join('\n');
  const catalogEntry = dsExcerpt?.dsFile ? catalog.find((c) => c.file === dsExcerpt.dsFile) : null;
  const variants = catalogEntry ? catalogEntry.variants.map((v) => `${v.typeName}=[${v.values.join('|')}]`).join(' ') : '';
  const stateOf = (t: ResolvedTarget) => (t.state === 'default' ? '' : ` [${t.state}]`);
  const resolved = targets.filter((t) => t.outcome === 'resolved-target' && t.target).map((t) => `    - ${t.property}${stateOf(t)} = ${t.target!.value}${t.target!.token ? ` (token ${t.target!.token})` : ''} — ${t.provenance.kind}: ${t.decisionReason}`).join('\n');
  const notChanged = targets.filter((t) => t.outcome !== 'resolved-target').map((t) => `    - ${t.property}: ${t.outcome} (${t.reason})`).join('\n');
  const forEdit = (e: TargetedEdit) => `${e.kind}${e.property ? ` ${e.property} = ${e.value}` : ''} on ${e.selector}`;
  const feedbackBlock = feedback.length === 0 ? '' : [
    '  preview feedback (HARD REQUIREMENT: the rendered React preview contradicts the result measured on the live page):',
    ...feedback.map((i) => `    - [${i.kind}] ${i.property} on "${i.elementLabel.slice(0, 40)}" (${i.part ? `${i.part}, ` : ''}${stateText(i.state)}, ${i.viewport === 'any' ? 'any viewport' : `${i.viewport} viewport`}): ${isRestore(i) ? `the ORIGINAL value ${i.expected} must be kept; the rendered preview shows ${i.observed}` : `expected ${i.expected}; the rendered preview measures ${i.observed}`}`),
    `  edits currently in force for this finding (replayed into the preview):${inForce.length ? `\n${inForce.map((e) => `    - ${forEdit(e)}`).join('\n')}` : ' none'}`,
    `  Emit edits ONLY for the property listed above (and its longhands) in the stated state; ${feedback.some(isRestore) ? 'a "keep the original value" item accepts exactly one edit of that property whose value is the original value verbatim; ' : ''}every other edit is kept as it is, do not re-emit it. An edit on the stamped element that is right on the live page but does not produce the expected result in the preview does not reach the visible element: use the stamp selector followed by a descendant combinator, or say in "unaddressed" that no selector can.`,
  ].join('\n');
  return [
    `findingId=${finding.identity.findingId}`,
    `stampSelector=[data-fra-element="${stampSelector}"]`,
    `section="${finding.location.section}" type=${finding.component.productionType} label="${finding.component.productionLabel}" classification=${finding.classification}`,
    mismatches ? `  mismatches:\n${mismatches}` : '  mismatches: none',
    rules ? `  ruleViolations:\n${rules}` : '  ruleViolations: none',
    dsExcerpt?.dsComponent ? `  dsMatch (${dsExcerpt.basis}): ${dsExcerpt.dsComponent} (${dsExcerpt.dsFile})${variants ? ` variants: ${variants}` : ''}` : '  dsMatch: none',
    targets.length ? (resolved ? `  resolved targets (the ONLY properties you may change):\n${resolved}` : '  resolved targets: none — no property of this finding may be changed with a style edit') : '',
    notChanged ? `  not to be changed (resolved as preserve-existing/unresolved):\n${notChanged}` : '',
    feedbackBlock,
    note ? `  reviewerNote: ${note}` : '',
    finding.action.recommendation ? `  recommendation: ${finding.action.recommendation}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runR3(deps: R3Deps, input: R3Input): Promise<R3Output> {
  const log = deps.log ?? (() => {});
  const { r1, session, iteration, previous, acknowledgedConstraints, mode, sectionIds } = input;
  const resolution: ResolutionFile | null = input.resolution ?? null;
  const targetsFor = (id: string): ResolvedTarget[] => (resolution ? resolution.targets.filter((t) => t.findingId === id) : []);
  const mapping = session.mapping;
  if (!mapping) throw new TerminalError('R3: session.mapping is not set — C2 must run before R3.');
  let dsIndex: DsTokenIndex | null = null;
  if (deps.designSystemPath) {
    try { dsIndex = buildDsTokenIndex(deps.designSystemPath); } catch (err) { log(`R3 · DS token index unavailable (${(err as Error).message}): a var() alias of a target colour is refused`); }
  }

  const catalog = buildComponentCatalog(r1.registry);
  const inScope = inScopeFindings(r1.fixFindings, mapping, mode, sectionIds);
  const idOf = (f: Finding) => f.identity.findingId;

  // Rendered-preview feedback REOPENS a finding whatever R5 measured on the live page; one for a finding outside this run's scope is ignored.
  const inScopeIds = new Set(inScope.map(idOf));
  const itemsFor = new Map<string, PlannerFeedbackItem[]>();
  for (const item of input.feedback ?? []) {
    for (const id of item.findingIds) {
      if (!inScopeIds.has(id)) { log(`R3 · preview feedback ${item.id} names finding ${id}, which is outside this run's scope: ignored`); continue; }
      itemsFor.set(id, [...(itemsFor.get(id) ?? []), item]);
    }
  }
  // A finding reopened by the previous pass whose edit R3 refused is recorded by R5 as a PLANNER REPORT (fixed:false, NOTHING measured): `unaddressed: <reason>` for what
  // R3 listed as unaddressed, the policy refusal's own text for an edit the project policy refused. That is not a failure measured on the live page, so it must neither be
  // retried as one nor widen the finding's scope again. Recognised by what R5 wrote (r5-compare), never by the absence of a mismatch row: a vision downgrade of a
  // measured-fixed check is also fixed:false with every measured row matching, and IS a live-page failure.
  const reopenedBefore = new Set((previous?.reopened ?? []).map((r) => r.findingId));
  const plannerReport = (c: { detail: string }): boolean => c.detail.startsWith('unaddressed:') || c.detail.startsWith(POLICY_REFUSAL);
  const unfixedByR5 = (id: string): boolean => {
    const check = previous?.validation.checks.find((c) => c.findingId === id);
    return check?.fixed === false && !(reopenedBefore.has(id) && plannerReport(check));
  };
  /** Reopened only by the preview: R5 is satisfied with it, so ONLY the feedback's property and state may change. */
  const feedbackOnly = (id: string): boolean => !!previous && itemsFor.has(id) && !unfixedByR5(id);
  const target = previous ? inScope.filter((f) => unfixedByR5(idOf(f)) || itemsFor.has(idOf(f))) : inScope;

  if (target.length === 0) {
    log('R3 · nothing left to plan — every in-scope finding is already fixed or excluded');
    return { iteration, plan: { edits: [], unaddressed: [] }, chunks: 0, usage: null };
  }
  if (itemsFor.size > 0) log(`R3 · ${itemsFor.size} finding(s) reopened by rendered-preview feedback: ${[...itemsFor.keys()].join(', ')}`);

  const edits: TargetedEdit[] = [];
  const unaddressed: RedesignPlan['unaddressed'] = [];
  const forModel: Finding[] = [];
  /** The feedback of each finding that a style edit can act on (the rest is reported, never sent to the model). */
  const actionable = new Map<string, PlannerFeedbackItem[]>();

  for (const finding of target) {
    const entry = mapping.entries.find((e) => e.findingIds.includes(finding.identity.findingId))!;
    const hasMismatches = finding.comparison.mismatches.length > 0;
    const hasRules = finding.comparison.ruleViolations.length > 0;
    const hasDsTarget = entry.dsReference.basis !== 'none';
    const mine = targetsFor(finding.identity.findingId);
    const authorized = mine.filter((t) => t.outcome === 'resolved-target');
    // §8.8's last row: no measurable mismatch, no rule, no DS target AND no resolved target — pre-empted here rather than
    // wasting a model call. A finding the Resolver gave a target is NOT filtered out: the Resolver decides, R3 plans.
    if (!hasMismatches && !hasRules && !hasDsTarget && authorized.length === 0) {
      const preserved = mine.filter((t) => t.outcome === 'preserve-existing'), open = mine.filter((t) => t.outcome === 'unresolved');
      const tally = (ts: ResolvedTarget[]) => [...ts.reduce((m, t) => m.set(t.reason, (m.get(t.reason) ?? 0) + 1), new Map<string, number>())].map(([r, n]) => `${r} ×${n}`).join(', ');
      unaddressed.push({ findingId: finding.identity.findingId, reason: mine.length > 0
        ? `the Resolver found nothing to change: ${preserved.length} propert(y/ies) preserved (${tally(preserved) || '—'}), ${open.length} unresolved (${tally(open) || '—'}); no mismatch, rule or DS target either`
        : 'no measurable mismatch, no rule violation and no DS target (confirmed or plausible) — needs a human answer at G1: which DS component should this become?' });
      continue;
    }
    if (entry.resolution.confidence === 'ambiguous' || entry.resolution.confidence === 'absent') {
      unaddressed.push({ findingId: finding.identity.findingId, reason: `mapping confidence is "${entry.resolution.confidence}" — never edited without a confirmed or acknowledged-probable mapping` });
      continue;
    }
    const id = finding.identity.findingId;
    const usable: PlannerFeedbackItem[] = [];
    for (const item of itemsFor.get(id) ?? []) {
      const why = unactionable(item);
      if (why) unaddressed.push({ findingId: id, reason: why });
      else usable.push(item);
    }
    actionable.set(id, usable);
    if (feedbackOnly(id) && usable.length === 0) continue;
    forModel.push(finding);
  }

  const r5Properties = (id: string): Set<string> => new Set((previous?.validation.checks.find((c) => c.findingId === id)?.measured ?? []).filter((m) => !m.matches).map((m) => m.property.replace(/\s*\[[^\]]*\]\s*$/, '').trim().toLowerCase()));
  const sameInForce = (e: TargetedEdit): boolean => (input.editsInForce ?? []).some((x) => x.findingId === e.findingId && x.kind === 'style' && e.kind === 'style' && x.selector.trim() === e.selector.trim() && norm(x.property) === norm(e.property) && sameValue(x.property ?? '', x.value, e.value));
  const alreadyInForce = (items: PlannerFeedbackItem[]): string => `the edit already in force sets this value on this selector, yet the rendered preview shows ${items.map((i) => i.observed).filter(Boolean).join(' / ') || 'a different result'}: the cause is not the plan (the preview generator or the cascade), so planning the same edit again cannot fix it`;
  /** Why a model edit is refused by the preview feedback of its finding; null when it is inside (or the finding has no feedback). `inForce`: it only repeats an edit the preview already replays. */
  const scopeViolation = (edit: TargetedEdit): { reason: string; inForce: boolean } | null => {
    const items = actionable.get(edit.findingId) ?? [];
    if (items.length === 0) return null;
    if (inFeedbackScope(edit, items)) return sameInForce(edit) ? { reason: alreadyInForce(items), inForce: true } : null;
    // a finding R5 also left unfixed keeps the properties R5 measured wrong; with nothing measured there is no extra restriction
    const measured = r5Properties(edit.findingId);
    if (!feedbackOnly(edit.findingId) && (measured.size === 0 || (edit.kind === 'style' && edit.property && [...measured].some((p) => coveredProperties(p).has(edit.property!.trim().toLowerCase()))))) return null;
    return { reason: `outside the preview feedback scope (property/state): the rendered preview failed ${items.map((i) => `${i.property} (${stateText(i.state)})`).join(', ')}${items.some(isRestore) ? ' and wants the original value back' : ''}; ${edit.kind === 'style' ? `${edit.property} in the ${stateText(stateOfEdit(edit))}` : `a ${edit.kind} edit`}${items.some(isRestore) ? ' with this value' : ''} is not one of them, and the earlier edits stay in force`, inForce: false };
  };
  /** Edits the model repeated although they are already in force: redundant beside an accepted edit that covers the same property and state, otherwise a report (the preview still fails it). */
  const repeated: Array<{ findingId: string; reason: string; edit: TargetedEdit }> = [];

  /** An accepted style edit of the same finding that sets the same property (or a shorthand of it) in the same state as `edit`: whatever selector it uses, it is the correction that replaces it. */
  const supersedes = (accepted: TargetedEdit, edit: TargetedEdit): boolean => accepted.findingId === edit.findingId && accepted.kind === 'style' && !!accepted.property && !!edit.property && stateOfEdit(accepted) === stateOfEdit(edit) && coveredProperties(accepted.property).has(edit.property.trim().toLowerCase());

  const fixEntryNote = new Map(r1.fixEntries.map((e) => [e.findingId, e.note] as const));
  let chunks = 0;
  let usage: R3Output['usage'] = null;

  for (let i = 0; i < forModel.length; i += CHUNK_SIZE) {
    const batch = forModel.slice(i, i + CHUNK_SIZE);
    chunks++;
    const context = batch
      .map((f) => {
        const entry = mapping.entries.find((e) => e.findingIds.includes(f.identity.findingId))!;
        const id = f.identity.findingId;
        return findingContext(f, entry.element, entry.dsReference, catalog, fixEntryNote.get(id) ?? null, targetsFor(id), actionable.get(id) ?? [], (input.editsInForce ?? []).filter((e) => e.findingId === id));
      })
      .join('\n\n');
    const rules = renderRulesForPrompt(r1.registry);
    // iteration ≥ 2: what R5 MEASURED on the live page after the previous edits, per finding, so a retry can fix what actually failed
    const retry = previous
      ? batch
          .map((f) => {
            const c = previous.validation.checks.find((x) => x.findingId === f.identity.findingId);
            if (!c || !unfixedByR5(f.identity.findingId)) return null;
            const props = c.measured.filter((m) => !m.matches).slice(0, 8).map((m) => `${m.property}: measured "${m.actual}", expected "${m.expected}"`);
            return `findingId=${f.identity.findingId}: not fixed by the previous iteration — ${c.detail}${props.length ? `\n    measured on the live page: ${props.join('; ')}` : ''}`;
          })
          .filter((l): l is string => l !== null)
      : [];
    const retryBlock = retry.length > 0 ? `\n\nWhat the previous iteration measured on the live page (an edit that did not reach the visible element is not a fix; to reach a descendant use the finding's stamp selector followed by a descendant combinator and set expectedMatches to the number of elements that selector will match; if only a rule-forbidden or impossible target remains, say so in "unaddressed"):\n${retry.join('\n')}` : '';
    // feedback that is shown next to ITS finding is not repeated as a global constraint beside unrelated findings
    const shown = new Set((input.feedback ?? []).map((i) => i.constraint));
    const globalConstraints = acknowledgedConstraints.filter((c) => !shown.has(c));
    const constraints = globalConstraints.length > 0 ? `\n\nConstraints from a rejected prior preview (hard requirements this iteration):\n${globalConstraints.map((c) => `- ${c}`).join('\n')}` : '';
    log(`R3 · iteration ${iteration} · chunk ${chunks} · ${batch.length} finding(s)`);
    const res = await deps.llm.structured({
      nodeId: 'R3',
      system: `${SYSTEM_PROMPT}\n\nThe following project rules override conflicting audit targets and the priorities above:\n${REDESIGN_RULES}`,
      prompt: `Project rules (persistent user instructions):\n${REDESIGN_RULES}\n\nDesign System rules:\n${rules}\n\nFindings to plan edits for:\n\n${context}${retryBlock}${constraints}`,
      schema: RedesignPlanSchema,
      effort: 'high',
    });
    for (const edit of res.data.edits) {
      const finding = batch.find((f) => f.identity.findingId === edit.findingId);
      const entry = mapping.entries.find((e) => e.findingIds.includes(edit.findingId));
      const policy = finding ? redesignPolicyViolation(edit, finding, entry, resolution, { dsIndex }) : 'Project redesign policy: edit does not belong to this authorized batch.';
      if (policy) { unaddressed.push({ findingId: edit.findingId, reason: policy }); continue; }
      const scope = scopeViolation(edit);
      if (!scope) edits.push(edit);
      else if (scope.inForce) repeated.push({ findingId: edit.findingId, reason: scope.reason, edit });
      else unaddressed.push({ findingId: edit.findingId, reason: scope.reason });
    }
    unaddressed.push(...res.data.unaddressed);
    usage = usage
      ? { inputTokens: usage.inputTokens + res.usage.inputTokens, outputTokens: usage.outputTokens + res.usage.outputTokens, cacheReadTokens: usage.cacheReadTokens + res.usage.cacheReadTokens }
      : res.usage;
  }

  // ── targets the planner model did not cover: derived from the TARGET (its value is never the model's), then recorded onto each target's implementation status
  const targetNotes: NonNullable<R3Output['targetNotes']> = [];
  let synthesizedEdits = 0;
  if (resolution) {
    const STATE_SUFFIX: Partial<Record<StateName, string>> = { hover: ':hover', focus: ':focus', 'focus-visible': ':focus-visible', active: ':active' };
    for (const f of forModel) {
      const id = f.identity.findingId;
      const entry = mapping.entries.find((e) => e.findingIds.includes(id))!;
      const stamp = `[data-fra-element="${entry.element}"]`;
      // the targets the preview failed for this finding; a finding reopened ONLY by the preview is derived for no others (its other targets were met and are left as they are)
      const failedByPreview = new Set((actionable.get(id) ?? []).flatMap((i) => (i.targetId ? [i.targetId] : [])));
      const failedTargets = feedbackOnly(id) ? failedByPreview : null;
      for (const t of targetsFor(id).filter((x) => x.outcome === 'resolved-target' && x.target && (!failedTargets || failedTargets.has(x.id)))) {
        const stateSel = STATE_SUFFIX[t.state];
        const covered = edits.some((e) => e.findingId === id && e.kind === 'style' && e.property === t.property && (t.state === 'default' ? !/:(hover|focus|focus-visible|active)\b/.test(e.selector) : stateSel ? e.selector.includes(stateSel) : false));
        if (covered) { targetNotes.push({ targetId: t.id, implementation: 'planned', detail: null }); continue; }
        // the model repeated the edit already in force for this target and nothing accepted replaces it: the preview still fails it, whatever else was planned for the finding
        const repeat = failedByPreview.has(t.id) ? repeated.find((r) => r.findingId === id && !edits.some((e) => supersedes(e, r.edit)) && stateOfEdit(r.edit) === t.state && (coveredProperties(t.property).has(r.edit.property!.trim().toLowerCase()) || coveredProperties(r.edit.property!).has(t.property.trim().toLowerCase()))) : undefined;
        if (repeat) { targetNotes.push({ targetId: t.id, implementation: 'blocked', detail: repeat.reason }); continue; }
        // a colour target is derived from its value like any other (a colour edit the guard refused sits in `unaddressed`, never in `edits`, so it cannot make the target "planned");
        // only a non-colour audit target can be met through the finding's component/class edit
        const isColour = t.target!.comparison === 'color-deltaE' || roleForProperty(t.property) !== 'unknown';
        if (t.provenance.kind === 'audit-expected' && !isColour) {
          const viaOther = edits.some((e) => e.findingId === id);
          targetNotes.push(viaOther ? { targetId: t.id, implementation: 'planned', detail: 'addressed through the finding\'s component/class edit' } : { targetId: t.id, implementation: 'blocked', detail: unaddressed.find((u) => u.findingId === id)?.reason ?? 'the planner emitted no edit for this audit target' });
          continue;
        }
        if (t.part !== 'self' || (t.state !== 'default' && !stateSel)) {
          targetNotes.push({ targetId: t.id, implementation: 'blocked', detail: `a ${t.part === 'self' ? '' : `${t.part}-part `}${t.state} target has no reliable live-DOM selector (only the element itself, in default/hover/focus/active, is representable); it is measured in the rendered preview and reported` });
          continue;
        }
        const edit: TargetedEdit = { findingId: id, selector: `${stamp}${stateSel ?? ''}`, expectedMatches: 1, kind: 'style', property: t.property, value: t.target!.value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: t.target!.token, rationale: `resolved target (${t.provenance.kind}): ${t.decisionReason}`.slice(0, 400), confidence: 1 };
        const violation = redesignPolicyViolation(edit, f, entry, resolution, { dsIndex });
        if (violation) { targetNotes.push({ targetId: t.id, implementation: 'blocked', detail: violation }); unaddressed.push({ findingId: id, reason: violation }); continue; }
        // the same edit is already replayed and the preview still fails it (whether or not R5 also left the finding unfixed): claiming it "planned" again would be a fake correction
        if (failedByPreview.has(t.id) && sameInForce(edit)) {
          const why = alreadyInForce(actionable.get(id) ?? []);
          targetNotes.push({ targetId: t.id, implementation: 'blocked', detail: why });
          if (!unaddressed.some((u) => u.findingId === id && u.reason === why)) unaddressed.push({ findingId: id, reason: why });
          continue;
        }
        edits.push(edit);
        synthesizedEdits++;
        targetNotes.push({ targetId: t.id, implementation: 'planned', detail: 'derived from the resolved target (the model did not cover it)' });
      }
    }
  }

  for (const r of repeated) if (!edits.some((e) => supersedes(e, r.edit)) && !unaddressed.some((u) => u.findingId === r.findingId && u.reason === r.reason)) unaddressed.push({ findingId: r.findingId, reason: r.reason });

  return { iteration, plan: { edits, unaddressed }, chunks, usage, ...(resolution ? { targetNotes, synthesizedEdits } : {}) };
}
