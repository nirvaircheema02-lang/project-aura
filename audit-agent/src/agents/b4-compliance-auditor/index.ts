import { B4ExpectationsSchema, type B4Expectations } from '../../llm/schemas/b-nodes.ts';
import { contextualTokenMap, effectiveTokenMap, readComponentSource, renderRulesForPrompt, renderTokensForPrompt, ruleIds } from '../../ds/catalog.ts';
import { classify, severityFor } from '../../skills/s5-compliance-classification.ts';
import { bandOf, BANDS, escalationFor, normalizeConfidence } from '../../skills/s8-confidence-escalation-policy.ts';
import { compareToExpected } from '../../t-layer/token-comparator.ts';
import { lengthToPx } from '../../t-layer/computed-style.ts';
import { resolveToken } from '../../ds/d3-tokens/resolve.ts';
import { DECIDED_BY_TEXT, formatPx, NEAREST_TIE_EPSILON_PX } from '../../skills/nearest-typography.ts';
import { policyVersionFor } from '../../graph/run-metadata.ts';
import { normalizeRef } from '../refs.ts';
import { buildFoundationContext, checkFoundationRules, verifiedTextRows, type FoundationContext, type FoundationViolation } from './foundation-rules.ts';
import { assignmentsOf, dsIndex } from '../b3-ds-matcher/deterministic.ts';
import { dimensionLabel, expectationsFor, type ComponentStyleModel } from '../../ds/component-styles.ts';
import type { ExtractedStyle } from '../../t-layer/computed-style.ts';
import type { Finding, Mismatch, Severity } from '../../skills/s0-result-contract.ts';
import type { NodeContext } from '../../graph/engine.ts';
import type { B3Output, B4Output, DetectedComponent, DsMatch, PageSession, TypographyChoice } from '../types.ts';

/**
 * B4 — Compliance Auditor (v1.0 §4). Hybrid by design, and the split is the
 * point (v1.0 §7): something reads the real DS source and says WHICH TOKEN a
 * property must satisfy; code resolves that token from D3's effective layer
 * and does the arithmetic. In anthropic-api mode that "something" is the
 * model (it never asserts "44px != 48px" — it never even sees a verdict to
 * agree with); in no-api mode it is the source itself, read deterministically
 * (src/ds/component-styles.ts), plus the measurable foundation rules
 * (foundation-rules.ts) — Decision Log #31.
 *
 * Consumes B2's stamped element evidence directly (§5.2) — it does not touch
 * the page or resolve any selector of its own.
 *
 * Three guarantees the first real run depends on:
 *  - Batched. One call for a whole page overran the output budget on the
 *    target page (≈12 expectations × 30–60 components, plus thinking).
 *  - A MATCH means something was COMPARED. No expectation, a detached
 *    element, or every expectation unresolvable is NOT_COMPARED — queued for
 *    a human and excluded from the score — never a free MATCH.
 *  - Only real rules. A rule id the DS does not define is dropped (and
 *    noted), never published as a CRITICAL violation.
 */

const SYSTEM = `You are the Compliance Auditor (B4) of a Design System compliance audit.
For each production component (already matched to a DS component), read the DS component's real source and state what its rendered properties MUST be.
Rules:
- Name the DS TOKEN (e.g. "--button-height-md") that each property must equal. Only use a literal when the DS source hardcodes a value rather than using a token.
- Use CSS longhand property names as they appear in the rendered list (e.g. "padding-top", "border-top-left-radius", "background-color").
- Only list properties the DS source actually governs for this variant. Do not pad the list.
- Do NOT compare values or judge compliance. You are supplying the expectation; the comparison is done deterministically by code.
- ruleViolations are for cases where an approved DS solution or rule exists and production did something unapproved (e.g. brand red used somewhere the rules forbid). A property whose value merely differs is NOT a rule violation. Cite only rule ids from the supplied rules.
- Return one entry for EVERY ref you are given. Answer with the bare ref (e.g. "e42").
- Every confidence is a probability between 0 and 1.`;

/** Components per B4 call — bounds the structured output well inside the token budget. */
export const B4_BATCH_SIZE = 10;

/** Confidence given to a component the model never answered for: below MEDIUM, so it always escalates. */
const OMITTED_CONFIDENCE = 0.3;

type Expectation = B4Expectations['components'][number];

function renderComponent(c: DetectedComponent, match: { dsComponent: string | null; dsVariant: string | null; dsFile: string | null } | undefined): string {
  const style = c.style.connected ? c.style.raw : {};
  const rendered = Object.entries(style)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return `ref=${c.ref} dsComponent=${match?.dsComponent} dsVariant=${match?.dsVariant ?? 'unknown'} label="${c.label.slice(0, 60)}" source=${match?.dsFile ?? 'none'} section="${c.sectionName}"\n rendered:\n${rendered}`;
}

/** `R1.2`, `Rule R1.2`, `R1.2 ` → `R1.2`; null when there is no rule-id shape at all. */
export function normalizeRuleId(raw: string): string | null {
  return raw.match(/R\d+(?:\.\d+)+/i)?.[0].toUpperCase() ?? null;
}

/**
 * The defined rule a cited id belongs to. The DS's own sub-rules (R4.1.1 …
 * R4.1.14, the Button rules) are written in RULES.md but registered under
 * their parent, so a correct citation of R4.1.2 resolves to R4.1 rather than
 * being thrown away as "unrecognized".
 */
export function resolveRuleId(cited: string, valid: Set<string>): string | null {
  for (let id = cited; id.includes('.'); id = id.slice(0, id.lastIndexOf('.'))) {
    if (valid.has(id)) return id;
  }
  return valid.has(cited) ? cited : null;
}

/**
 * Precedence: an identified DS component/variant's own exact contract always wins over a
 * foundation rule's generic nearest-scale recommendation (R1.3/R3.5/R3.6, foundation-rules.ts) —
 * never the reverse. `passed`/`mismatches` are what the matched variant's OWN comparison already
 * resolved for this element; a foundation citation for any of those properties is dropped here,
 * whether that resolution was a MATCH (third-pass review F2 — a node using MenuItem's own 8px
 * corner verbatim was published INCORRECT on R3.6 while its own comparison showed that property
 * passed) or a DIFFERENT (the matched variant's specific expected value — e.g. Button primary/md's
 * own `--radius-button` — is the exact contract; a generic "nearest scale step" recommendation for
 * the same property would at best repeat it and at worst, for a variant whose own governed value
 * is not itself a clean scale step, contradict it). A foundation rule only ever speaks for a
 * property nothing more specific already covered.
 *
 * One exception, for a PROHIBITION rather than a scale: R1.2 (brand red is never a border or a
 * decorative fill on a non-CTA element). An element B3 matched only by FAMILY IDENTITY — it IS that
 * family by its type and structure, whatever its styling — does not conform to the variant it was
 * compared with, so that variant's "expected" value for the border/background colour can neither
 * excuse the forbidden colour (a pass against a variant that itself paints red) nor replace its
 * severity (a mismatch against some other variant). `keepProhibitions` keeps the R1.2 citation in
 * that case; for an element that CONFORMS to its component (class fingerprint, confident rule fit)
 * the variant's own contract still decides, exactly as before.
 */
export function filterFoundationViolations(rawViolations: FoundationViolation[], passed: string[], mismatches: Mismatch[], opts: { keepProhibitions?: boolean } = {}): FoundationViolation[] {
  const resolved = new Set([...passed, ...mismatches.map((m) => m.property)]);
  return rawViolations.filter((v) => !resolved.has(v.property) || (opts.keepProhibitions === true && v.ruleId === 'R1.2'));
}

/** Whether B3 matched an element by family identity alone — its styling does not conform to the component it is audited against. */
export function matchedByIdentityOnly(match: DsMatch | undefined): boolean {
  const basis = match?.search?.basis;
  return basis === 'family-identity' || basis === 'single-component-family';
}

/** What comparing one component produced — from model-named or source-derived expectations — before it becomes a finding. */
export interface ComponentEvaluation {
  properties?: NonNullable<Finding['comparison']['properties']>;
  coverageNotes?: string[];
  partial?: boolean;
  mismatches: Mismatch[];
  passed: string[];
  unresolved: Array<{ property: string; reason: string }>;
  ruleViolations: Array<{ ruleId: string; title: string; why: string; severity?: Severity }>;
  ruleNotes: string[];
  ruleConfidences: number[];
  ruleOutOfContract: boolean;
  expectationConfidence: { value: number; outOfContract: boolean };
  /** The model skipped this component even after a follow-up ask (model path only). */
  modelOmitted: boolean;
  /** Why nothing could be compared, used only when nothing was. */
  notComparedWhy: string;
  /** How many expectations there were — for the evidence note. */
  expectationCount: number;
  /**
   * no-api only: which of B3's tied variant assignments was actually
   * published (compareAnyOf's `chosen`) — may differ from B3's own
   * first-listed assignment, so the finding's `dsVariant` label must come
   * from here, not from `match.dsVariant`, or it can name a variant the
   * comparison never actually judged the element against.
   */
  dsVariantOverride?: string | null | undefined;
  /**
   * no-api only: the nearest-DS-size decision behind this element's expected font-size (B3's for a
   * heading level, compareAnyOf's for tied variants) — so the finding can show Actual / Closest DS
   * value / Difference / DS source, and say the element's semantic tag is unchanged.
   */
  typography?: TypographyChoice | undefined;
}

/** The model path: the model names the DS token each property must equal; code compares. */
async function modelEvaluations(session: PageSession, input: B3Output): Promise<Map<string, ComponentEvaluation>> {
  const tokens = effectiveTokenMap(session.registry, 'editorial-light');
  const validRules = ruleIds(session.registry);
  const tokenList = renderTokensForPrompt(session.registry, 'editorial-light', /^--(button|color|semantic|text|font|leading|tracking|typography|radius|shadow|space|spacing|surface|section)/);
  const rules = renderRulesForPrompt(session.registry);

  // The exact file B3 resolved — never a lookup by name.
  const sources = new Map<string, string>();
  for (const component of input.matched) {
    const file = input.matches.get(component.ref)?.dsFile;
    if (!file || sources.has(file)) continue;
    try {
      sources.set(file, await readComponentSource(session.registry, file));
    } catch {
      /* unreadable source — the component gets no source-grounded expectation, and will say so */
    }
  }

  const expectations = new Map<string, Expectation>();
  const askB4 = async (components: DetectedComponent[], followUp: boolean) => {
    const files = [...new Set(components.map((c) => input.matches.get(c.ref)?.dsFile).filter((f): f is string => !!f && sources.has(f)))];
    const { data } = await session.llm.structured({
      nodeId: 'B4',
      system: SYSTEM,
      prompt:
        `Design System tokens currently in effect (editorial-light):\n${tokenList}\n\n` +
        `Design System rules:\n${rules}\n\n` +
        `Design System component sources:\n${files.map((f) => `--- ${f} ---\n${sources.get(f)}`).join('\n\n')}\n\n` +
        `${followUp ? 'These components were missing from a previous answer. ' : ''}Production components to audit:\n${components.map((c) => renderComponent(c, input.matches.get(c.ref))).join('\n\n')}\n\n` +
        `For each ref, list the properties the DS governs and the token each must equal, plus any genuine rule violations.`,
      schema: B4ExpectationsSchema,
      effort: 'high',
    });
    const asked = new Set(components.map((c) => c.ref));
    for (const e of data.components) {
      const ref = normalizeRef(e.ref);
      if (ref && asked.has(ref) && !expectations.has(ref)) expectations.set(ref, e);
    }
  };

  // Batches grouped by source file, so each call carries few DS sources.
  const ordered = [...input.matched].sort((a, b) => (input.matches.get(a.ref)?.dsFile ?? '').localeCompare(input.matches.get(b.ref)?.dsFile ?? ''));
  for (let i = 0; i < ordered.length; i += B4_BATCH_SIZE) await askB4(ordered.slice(i, i + B4_BATCH_SIZE), false);
  const missing = ordered.filter((c) => !expectations.has(c.ref));
  for (let i = 0; i < missing.length; i += B4_BATCH_SIZE) await askB4(missing.slice(i, i + B4_BATCH_SIZE), true);

  const out = new Map<string, ComponentEvaluation>();
  for (const component of input.matched) {
    const expectation = expectations.get(component.ref);
    const style = component.style;
    const rootFontSizePx = style.connected ? style.rootFontSizePx : 16;

    let mismatches: Mismatch[] = [];
    let passed: string[] = [];
    let unresolved: Array<{ property: string; reason: string }> = [];
    if (expectation && style.connected) {
      const result = compareToExpected({
        actual: style.raw,
        expected: expectation.expected.map((e) => ({ property: e.property, token: e.token, literal: e.literal })),
        effectiveTokens: tokens,
        rootFontSizePx,
        box: style.box ?? null,
      });
      mismatches = result.mismatches;
      passed = result.passed;
      unresolved = result.unresolved;
    }

    // Rule violations: only ids the DS actually defines, only above the confidence floor.
    const ruleNotes: string[] = [];
    const ruleConfidences: number[] = [];
    let ruleOutOfContract = false;
    const ruleViolations: Array<{ ruleId: string; title: string; why: string }> = [];
    for (const r of expectation?.ruleViolations ?? []) {
      const cited = normalizeRuleId(r.ruleId);
      const id = cited ? resolveRuleId(cited, validRules) : null;
      if (!cited || !id) {
        ruleNotes.push(`unrecognized rule id "${r.ruleId}" — not a rule in the Design System; ignored`);
        continue;
      }
      const c = normalizeConfidence(r.confidence);
      ruleOutOfContract ||= c.outOfContract;
      if (c.value < BANDS.MEDIUM) continue;
      ruleConfidences.push(c.value);
      const title = id === cited ? r.title : `${r.title} (cited ${cited})`;
      if (!ruleViolations.some((v) => v.ruleId === id)) ruleViolations.push({ ruleId: id, title, why: r.why });
    }

    out.set(component.ref, {
      mismatches,
      passed,
      unresolved,
      ruleViolations,
      ruleNotes,
      ruleConfidences,
      ruleOutOfContract,
      expectationConfidence: expectation ? normalizeConfidence(expectation.confidence) : { value: OMITTED_CONFIDENCE, outOfContract: false },
      modelOmitted: !expectation,
      notComparedWhy: !expectation
        ? 'the model returned no expectation for this component, even after a follow-up ask'
        : !style.connected
          ? 'the element was detached before its styles could be read'
          : expectation.expected.length === 0
            ? 'the model listed no DS-governed properties for it'
            : `none of its ${expectation.expected.length} expectation(s) could be resolved (${[...new Set(unresolved.map((u) => u.reason))].slice(0, 2).join('; ')})`,
      expectationCount: expectation?.expected.length ?? 0,
    });
  }
  return out;
}

/** A no-api MATCH must rest on at least this many compared governed properties (Decision Log #31). */
export const MIN_VERIFIED_PROPERTIES = 3;

/** Confidence of an expectation read straight from the DS source (not a model's reading of it). */
const SOURCE_EXPECTATION_CONFIDENCE = 0.9;
/** Confidence of a foundation-rule breach measured against the DS's own values. */
const MEASURED_RULE_CONFIDENCE = 0.95;

/**
 * Foundation radii (foundation-rules.ts) call anything off ctx.radiiPx
 * "arbitrary" — but several DS components hardcode an off-scale radius
 * themselves (MenuItem 8px, IndustryFocusBanner 12px, the shadcn checkbox
 * 4px). Rendering that component's OWN radius verbatim is not a violation of
 * anything (third-pass review F2); seed the DS's own literal radii into the
 * context once per registry so R3.6 never calls a DS source's own value
 * "arbitrary".
 */
const seededRadii = new WeakSet<FoundationContext>();
function seedDsRadii(ctx: FoundationContext, index: Awaited<ReturnType<typeof dsIndex>>): void {
  if (seededRadii.has(ctx)) return;
  seededRadii.add(ctx);
  for (const c of index.components) {
    for (const r of c.model.rules) {
      if (!/-radius$/.test(r.property) || r.literal === null) continue;
      const px = lengthToPx(r.literal.trim());
      if (px === null || !Number.isFinite(px)) continue;
      const rounded = Math.round(px * 1000) / 1000;
      if (!ctx.radiiPx.includes(rounded)) ctx.radiiPx.push(rounded);
    }
  }
}

// ── Nearest typography match: how a finding SHOWS it (src/skills/nearest-typography.ts) ──
// One wording for the property table, the recommendation and the evidence list, so they never disagree.

/** `31.25px / 1.953rem` (+ the token it came from, when it came from one). */
function closestSizePhrase(t: TypographyChoice): string {
  return `${formatPx(t.closestPx)} / ${t.closestValue}${t.closestToken ? ` (${t.closestToken})` : ''}`;
}

/**
 * The semantic-level reminder — only when the nearest visual variant differs from the one the element's own tag names.
 * A main heading promoted by its ROLE from a non-heading element (a display-size `<p>`) has no heading level to keep,
 * only its tag: the finding names the tag it really has, never the h2 slot the size match used as a tie-break proxy.
 */
function keepTagPhrase(t: TypographyChoice): string | null {
  if (!t.semanticTag) return null;
  if (!/^h[1-6]$/.test(t.semanticTag)) {
    return `The element is a <${t.semanticTag}> that is the section's main heading by its role, and it stays a <${t.semanticTag}> — ${t.variant} is only its closest visual size, not a reason to change its HTML tag.`;
  }
  return !t.followsSemanticLevel
    ? `The element is an ${t.semanticTag} and stays one — ${t.variant} is only its closest visual size, not a reason to change its HTML level.`
    : null;
}

/** The note on the font-size row of the property table (Source / note column). */
function typographyRowNote(t: TypographyChoice, status: 'MATCH' | 'DIFFERENT' | 'UNRESOLVED'): string | null {
  if (status === 'DIFFERENT') {
    return [`Closest DS size: ${closestSizePhrase(t)} (${t.variant}) — ${formatPx(t.differencePx)} from the rendered ${formatPx(t.actualPx)}.`, keepTagPhrase(t)].filter(Boolean).join(' ');
  }
  if (status === 'MATCH' && !t.followsSemanticLevel) return `Matches ${t.variant}, the nearest DS size (${closestSizePhrase(t)}). ${keepTagPhrase(t) ?? ''}`.trim();
  return null;
}

/** The auditable record in the evidence list: what was measured, every size considered, and what settled it. */
function nearestEvidenceNote(t: TypographyChoice): string {
  const considered = t.considered.map((c) => `${c.variant} ${formatPx(c.px)} (${formatPx(c.distancePx)} away)`).join(' · ');
  return `nearest typography match — rendered ${formatPx(t.actualPx)} → ${t.variant} ${closestSizePhrase(t)}, ${formatPx(t.differencePx)} away; considered ${considered}; settled by ${DECIDED_BY_TEXT[t.decidedBy]}.${t.semanticTag ? ` Semantic tag ${t.semanticTag} unchanged.` : ''}`;
}

/**
 * The no-api path (Decision Log #31). Expectations come from the matched DS
 * component's own source (src/ds/component-styles.ts), for every variant
 * assignment B3 found fitting equally well — a property only deviates when it
 * matches NONE of them, so an undeterminable variant is never guessed.
 * Foundation rules are measured, not interpreted (foundation-rules.ts).
 */
export async function deterministicEvaluations(session: PageSession, input: B3Output): Promise<Map<string, ComponentEvaluation>> {
  const ctx = buildFoundationContext(session.registry);
  const index = await dsIndex(session.registry);
  seedDsRadii(ctx, index);
  const viewportWidth = session.page.viewportSize()?.width ?? 1440;
  const out = new Map<string, ComponentEvaluation>();
  for (const component of input.matched) {
    const tokens = contextualTokenMap(session.registry, component.domFacts?.context?.surface);
    const match = input.matches.get(component.ref);
    // The heading SLOT to compare against is whatever B3 actually decided (the Design System level
    // whose size is NEAREST the rendered one, e.g. "level 3" — never re-derived from the DOM tag
    // here: a production <h2> may be nearest the DS's level-3 size, and B3's `visualSlot` is the
    // single source of truth for which visual variant was chosen). Falls back to B3's "level N"
    // label, then to the DOM tag, only if an older match carries no `visualSlot`.
    const headingLevelMatch = match?.contextSlot === 'heading' ? /^level (\d+)$/.exec(match.dsVariant ?? '') : null;
    const headingSlotKey = match?.contextSlot === 'subtitle' ? 'subtitle' : match?.visualSlot ?? (headingLevelMatch ? `h${headingLevelMatch[1]}` : component.domFacts?.tag ?? '');
    const model = match?.contextSlot
      ? match.contextSlot === 'heading' || match.contextSlot === 'subtitle'
        ? index.headingSlots?.get(headingSlotKey)
        : (match.assignments?.length ? index.breadcrumbSlots?.get(match.contextSlot === 'combined-label' ? 'link' : match.contextSlot) : undefined)
      : match?.dsFile ? index.byFile.get(match.dsFile)?.model : undefined;
    const style = match?.contextSlot === 'combined-label' ? component.parts?.label ?? component.style : component.style;
    const subtitleCandidate = match?.contextSlot === 'subtitle';
    const combined = match?.contextSlot === 'combined-label';
    const coverageNotes = subtitleCandidate
      ? ['This descriptive h2 may be a subtitle. Expected values below are a subtitle candidate, not a required correction; confirm the semantic role first.']
      : combined ? ['Label typography compared with the current breadcrumb link. The combined container and arrow have separate observed values; their composition is not yet verified.'] : [];
    let properties: NonNullable<Finding['comparison']['properties']> = [];
    let mismatches: Mismatch[] = [];
    let passed: string[] = [];
    let unresolved: Array<{ property: string; reason: string }> = [];
    let expectationCount = 0;
    let dsVariantOverride: string | null | undefined;
    let typography: TypographyChoice | undefined;
    if (model && style.connected) {
      const merged = compareAnyOf(model, match?.assignments?.length ? match.assignments : assignmentsOf(model).slice(0, 1), style, tokens, viewportWidth);
      mismatches = merged.mismatches;
      passed = merged.passed;
      unresolved = merged.unresolved;
      expectationCount = merged.expectationCount;
      // The nearest-size decision behind the expected font-size: B3's for a heading level, else the
      // one compareAnyOf made among tied variants. A subtitle candidate is only a candidate.
      typography = subtitleCandidate || combined ? undefined : match?.typography ?? merged.typography;
      properties = merged.properties.map(p => {
        const note = typography && p.property === 'font-size' ? typographyRowNote(typography, p.status) : null;
        return { ...p, property: combined ? `label.${p.property}` : p.property, source: match?.dsFile ?? null, ...(note ? { note } : {}),
          ...(subtitleCandidate ? { status: 'UNRESOLVED' as const, note: 'Subtitle candidate only — confirm content role before applying.' } : {}) };
      });
      if (combined) { mismatches = mismatches.map(m => ({...m, property:`label.${m.property}`})); }
      if (subtitleCandidate) { mismatches = []; passed = []; }
      // The variant actually judged, which compareAnyOf may have picked from among several tied
      // ones B3 offered — never labelled with an assignment the comparison did not settle on.
      dsVariantOverride = match?.contextSlot ? match.dsVariant : merged.chosen ? dimensionLabel(model, merged.chosen) || null : null;
    }
    const headingLevel = /^h([1-6])$/.exec(component.domFacts?.tag ?? '')?.[1];
    const rawViolations = subtitleCandidate ? [] : checkFoundationRules({
      componentType: component.componentType,
      headingLevel: headingLevel ? Number(headingLevel) : null,
      hasText: Boolean(component.domFacts?.ownText),
      style,
      ctx,
      role: component.headingRole ?? null,
    });
    // Precedence: the matched DS component/variant's own exact contract wins over a foundation
    // rule's generic nearest-scale recommendation for the same property (filterFoundationViolations
    // above) — whether this node's own comparison found that property MATCHING its expectation
    // (third-pass review F2 — a node using MenuItem's own 8px corner verbatim was published
    // INCORRECT on R3.6 while its own comparison showed that property passed) or DIFFERENT (the
    // matched variant's specific expected value is the exact contract, not a generic scale step).
    const violations = filterFoundationViolations(rawViolations, passed, mismatches, { keepProhibitions: matchedByIdentityOnly(match) });
    // Body text / stat numerals have no DS component to compare against: what a clean result VERIFIED is
    // exactly the foundation properties measured above, so those are recorded as passed (a text element
    // with every foundation check clean is a MATCH on what the DS governs — never a free MATCH on nothing).
    if (match?.foundationOnly) {
      const broken = new Set(violations.map((v) => v.property));
      // What each verified property was verified AGAINST goes into the property table too, as a verified MATCH — the table, the
      // evidence line ("N compared, N passed") and the status must tell ONE story (a verified property is never "Not verified").
      for (const row of verifiedTextRows({ componentType: component.componentType, hasText: Boolean(component.domFacts?.ownText), style, ctx, role: component.headingRole ?? null, broken })) {
        passed.push(row.property);
        properties = properties.filter((p) => p.property !== row.property);
        properties.push({ property: row.property, actual: row.actual, expected: row.expected, expectedToken: row.expectedToken, source: `foundation rule ${row.rule}`, status: 'MATCH', note: row.note });
      }
    }
    out.set(component.ref, {
      properties, coverageNotes, partial: combined || subtitleCandidate,
      mismatches,
      passed,
      unresolved,
      ruleViolations: violations.map((v) => ({ ruleId: v.ruleId, title: v.title, why: v.why, severity: v.severity })),
      ruleNotes: [],
      ruleConfidences: violations.map(() => MEASURED_RULE_CONFIDENCE),
      ruleOutOfContract: false,
      expectationConfidence: { value: SOURCE_EXPECTATION_CONFIDENCE, outOfContract: false },
      modelOmitted: false,
      notComparedWhy: !style.connected
        ? 'the element was detached before its styles could be read'
        : subtitleCandidate ? 'The description is marked h2; its heading-versus-subtitle role must be confirmed before prescribing typography'
        : combined ? 'Only the breadcrumb label has a directly comparable DS slot; verify the combined container and arrow separately'
        : !model
          ? `Expected styles are not resolved for the selected component/slot (${match?.dsFile ?? 'unknown source'})`
          : expectationCount === 0
            ? `${match?.dsFile} sets no root-element property this audit can read deterministically for the matched variant — its styling lives in child elements, runtime state or caller classes`
            : `none of its ${expectationCount} source-derived expectation(s) could be resolved (${[...new Set(unresolved.map((u) => u.reason))].slice(0, 2).join('; ')})`,
      expectationCount,
      dsVariantOverride,
      typography,
    });
  }
  return out;
}

/**
 * Compares against several equally-plausible (tied, per B3) variant
 * assignments — but NEVER unions their passes: an element that fits NO single
 * assignment cleanly is not "MATCH because each property passed under SOME
 * assignment" (third-pass review M1 — that union let a Card mixing one
 * variant's surface with another's border pass at 100%, and let a Button
 * whose padding was one size and gap/min-width the next size publish as a
 * clean MATCH). Each assignment is scored on its own:
 *  - if at least one is CLEAN (zero mismatches, ≥ MIN_VERIFIED_PROPERTIES
 *    compared) that alone justifies MATCH — the one with the most compared
 *    properties is published, so the strongest available evidence wins;
 *  - otherwise no single assignment fits, and the closest one (fewest
 *    mismatches, then smallest total |delta|) is published as-is — its real
 *    mismatches, never a shorter list borrowed from a different assignment.
 * `chosen` is the assignment actually published, so the caller can label the
 * finding with the variant it was actually judged against.
 */
export interface AnyOfComparison {
  mismatches: Mismatch[];
  passed: string[];
  unresolved: Array<{ property: string; reason: string }>;
  expectationCount: number;
  chosen: Record<string, string> | null;
  properties: NonNullable<Finding['comparison']['properties']>;
  /** Set when several variants fitting equally well had DIFFERENT font sizes and the nearest one was published. */
  typography?: TypographyChoice;
}

export function compareAnyOf(
  model: ComponentStyleModel,
  assignments: Array<Record<string, string>>,
  style: Extract<ExtractedStyle, { connected: true }>,
  tokens: Map<string, string>,
  viewportWidth: number,
): AnyOfComparison {
  const evaluated = assignments.map((assignment) => {
    const expected = expectationsFor(model, assignment, { viewportWidth });
    const result = compareToExpected({
      actual: style.raw,
      expected: expected.map((e) => ({ property: e.property, token: e.token, literal: e.literal })),
      effectiveTokens: tokens,
      rootFontSizePx: style.rootFontSizePx,
      box: style.box ?? null,
    });
    const properties: NonNullable<Finding['comparison']['properties']> = expected.map(e => {
      const mismatch = result.mismatches.find(m => m.property === e.property);
      const unresolved = result.unresolved.find(u => u.property === e.property);
      return { property: e.property, actual: style.raw[e.property] ?? null,
        expected: mismatch?.expected ?? (e.token ? resolveToken(e.token, tokens) : e.literal) ?? null,
        expectedToken: e.token, source: null,
        status: unresolved ? 'UNRESOLVED' : mismatch ? 'DIFFERENT' : result.passed.includes(e.property) ? 'MATCH' : 'UNRESOLVED',
        note: unresolved?.reason ?? null };
    });
    return { assignment, properties, expectedCount: expected.length, result, compared: result.passed.length + result.mismatches.length };
  });
  const expectationCount = evaluated.reduce((n, e) => Math.max(n, e.expectedCount), 0);
  if (evaluated.length === 0) return { mismatches: [], passed: [], unresolved: [], expectationCount, chosen: null, properties: [] };

  const clean = evaluated.filter((e) => e.result.mismatches.length === 0 && e.compared >= MIN_VERIFIED_PROPERTIES);
  if (clean.length > 0) {
    const best = clean.reduce((a, b) => (b.compared > a.compared ? b : a));
    return { mismatches: [], passed: best.result.passed, unresolved: best.result.unresolved, expectationCount, chosen: best.assignment, properties: best.properties };
  }

  // Nearest typography (src/skills/nearest-typography.ts): among variants fitting equally well, the
  // one whose font-size is NEAREST the rendered size is published — px after normalisation, never
  // "whichever was listed first". Only the font-size of each variant is measured here, so a
  // typography distance is never added to a colour or layout one.
  const actualPx = lengthToPx(style.raw['font-size'] ?? '', style.rootFontSizePx);
  const sizeOf = (e: (typeof evaluated)[number]) => {
    const row = e.properties.find((p) => p.property === 'font-size');
    const px = row?.expected && actualPx !== null ? lengthToPx(row.expected.trim(), style.rootFontSizePx, actualPx) : null;
    return row && px !== null ? { row, px } : null;
  };
  // Prefer less colour movement only after the count of mismatches and the font-size distance tie;
  // assignments already respect observed state.
  const totalDelta = (e: (typeof evaluated)[number]) => e.result.mismatches.filter(m => /color$/.test(m.property)).reduce((n, m) => n + Math.abs(m.delta ?? 0), 0);
  const best = evaluated.reduce((a, b) => {
    if (b.result.mismatches.length !== a.result.mismatches.length) return b.result.mismatches.length < a.result.mismatches.length ? b : a;
    const sa = sizeOf(a);
    const sb = sizeOf(b);
    if (actualPx !== null && sa && sb) {
      const da = Math.abs(sa.px - actualPx);
      const db = Math.abs(sb.px - actualPx);
      if (Math.abs(da - db) >= NEAREST_TIE_EPSILON_PX) return db < da ? b : a;
    }
    return totalDelta(b) < totalDelta(a) ? b : a;
  });

  // A size was actually CHOSEN (not just read off one variant) only when the equally-fitting
  // variants disagree about it — then the finding says so, with every size considered.
  let typography: TypographyChoice | undefined;
  const chosen = sizeOf(best);
  if (actualPx !== null && chosen && chosen.row.status === 'DIFFERENT') {
    const sizes = new Map<number, { variant: string; px: number; value: string }>();
    for (const e of evaluated.filter((x) => x.result.mismatches.length === best.result.mismatches.length)) {
      const s = sizeOf(e);
      if (s && !sizes.has(Math.round(s.px * 100))) sizes.set(Math.round(s.px * 100), { variant: dimensionLabel(model, e.assignment) || 'default', px: s.px, value: s.row.expected ?? '' });
    }
    if (sizes.size > 1) {
      typography = {
        property: 'font-size',
        actualPx,
        closestPx: chosen.px,
        closestValue: chosen.row.expected ?? '',
        closestToken: chosen.row.expectedToken,
        differencePx: Math.abs(chosen.px - actualPx),
        variant: dimensionLabel(model, best.assignment) || 'default',
        semanticTag: null,
        followsSemanticLevel: true,
        decidedBy: 'distance',
        considered: [...sizes.values()].map((s) => ({ variant: s.variant, px: s.px, value: s.value, distancePx: Math.abs(s.px - actualPx) })).sort((a, b) => a.distancePx - b.distancePx),
      };
    }
  }
  return { mismatches: best.result.mismatches, passed: best.result.passed, unresolved: best.result.unresolved, expectationCount, chosen: best.assignment, properties: best.properties, ...(typography ? { typography } : {}) };
}

export async function runB4(ctx: NodeContext, input: B3Output & { session: PageSession }): Promise<B4Output> {
  const session = input.session;
  const findings: Finding[] = [];
  if (input.matched.length === 0) return { ...input, findings };

  const evaluations = session.aiMode === 'no-api' ? await deterministicEvaluations(session, input) : await modelEvaluations(session, input);

  for (const component of input.matched) {
    const match = input.matches.get(component.ref);
    const evaluation = evaluations.get(component.ref)!;
    findings.push(buildFinding(session, component, match, evaluation));
  }

  return { ...input, findings };
}

/**
 * One component's evaluation (from `deterministicEvaluations`/`modelEvaluations`) → its finding:
 * classification, severity, confidence, recommendation text, evidence. Factored out of `runB4`'s
 * loop so B5's completeness recheck (src/agents/b5-visual-verifier) can build a real, fully
 * consistent finding for a component it captured AFTER B2/B3/B4's first pass — the exact same
 * assembly logic, never a parallel reimplementation that could silently drift from it.
 */
export function buildFinding(session: PageSession, component: DetectedComponent, match: DsMatch | undefined, evaluation: ComponentEvaluation): Finding {
  {
    const { mismatches, passed, unresolved, ruleViolations, ruleNotes, ruleConfidences, expectationConfidence } = evaluation;

    const compared = passed.length + mismatches.length;
    // no-api: a clean result on one or two governed properties is not a proven MATCH — too little
    // of the component was verified (a measured difference, by contrast, is proven on its own).
    const tooFewToVerify = session.aiMode === 'no-api' && mismatches.length === 0 && ruleViolations.length === 0 && compared > 0 && compared < MIN_VERIFIED_PROPERTIES;
    const notCompared = ruleViolations.length === 0 && (compared === 0 || tooFewToVerify || Boolean(evaluation.partial && mismatches.length === 0));
    if (tooFewToVerify) {
      evaluation.notComparedWhy = `only ${compared} of ${match?.dsFile ?? 'the component'}'s governed properties could be compared (${passed.join(', ')} — all passed), too few to verify it as a match`;
    }

    // Nothing compared and no rule broken is UNVERIFIED — never a free MATCH (Decision Logs #23, #31).
    const classification = classify({ hasDsMatch: true, mismatches, ruleViolations, nothingCompared: notCompared });
    const severity = severityFor({ hasDsMatch: true, mismatches, ruleViolations, classification });

    // Confidence is the weakest link in the chain that produced this finding — and a
    // result built partly on unresolvable expectations is proportionally less certain.
    let confidence = Math.min(component.detectionConfidence, match?.confidence ?? 0, expectationConfidence.value, ...ruleConfidences);
    if (compared > 0 && unresolved.length > 0) confidence *= compared / (compared + unresolved.length);
    if (notCompared) confidence = Math.min(confidence, OMITTED_CONFIDENCE);
    confidence = Math.round(confidence * 1000) / 1000;

    // One id per element, whatever the outcome — so a status change reads as a delta, not a new issue.
    const id = component.findingId;

    const escalation = escalationFor({
      findingId: id,
      confidence,
      containsPlaceholderValue: component.containsPlaceholder,
      capturePartiallySettled: !session.capture.renderSettled.settled,
      notCompared,
      modelOmitted: evaluation.modelOmitted,
      outOfContractConfidence: component.confidenceOutOfContract || (match?.confidenceOutOfContract ?? false) || expectationConfidence.outOfContract || evaluation.ruleOutOfContract,
    });

    // The variant the comparison actually judged the element against — the one `component.dsVariant`
    // publishes (M1), so the recommendation never names a variant whose values it does not print.
    const judgedVariant = evaluation.dsVariantOverride !== undefined ? evaluation.dsVariantOverride : (match?.dsVariant ?? null);
    // Nearest typography: when a size was CHOSEN among DS variants, the recommendation quotes the
    // closest DS size and how far it is, and (for a heading) that the element's tag is unchanged.
    const typography = evaluation.typography;
    const keepTag = typography ? keepTagPhrase(typography) : null;
    const mismatchLine = (m: Mismatch) => {
      const line = `${m.property}: ${m.actual} → ${m.expectedToken ?? m.expected}`;
      return typography && m.property === 'font-size' ? `${line} (${formatPx(typography.closestPx)} — the closest DS size, ${formatPx(typography.differencePx)} away)` : line;
    };

    return {
      identity: {
        auditId: session.auditId,
        runId: session.runId,
        findingId: id,
        timestamp: new Date().toISOString(),
        dsRegistryVersion: session.registry.version.dsRegistryVersion,
        policyVersion: policyVersionOf(session),
      },
      location: {
        url: session.url,
        pageId: session.pageId,
        pageName: session.capture.canonical.pageUrl,
        templateFamily: session.templateFamily,
        section: component.sectionName,
        sectionId: component.sectionId,
        captureState: component.captureState,
      },
      component: {
        productionType: component.componentType,
        productionLabel: component.label,
        dsComponent: match?.dsComponent ?? null,
        // The variant the comparison actually judged the element against (M1) — B3's own guess
        // only when the no-api comparator never overrode it (the model path never does).
        dsVariant: evaluation.dsVariantOverride !== undefined ? evaluation.dsVariantOverride : (match?.dsVariant ?? null),
        signature: component.signature,
      },
      classification,
      comparison: { mismatches, ruleViolations, properties: evaluation.properties ?? [], coverageNotes: evaluation.coverageNotes ?? [], ...(match?.foundationOnly ? { basis: 'foundation-only' as const } : match?.dsComponent ? { basis: 'ds-component' as const } : {}) },
      quality: {
        severity,
        confidence,
        confidenceBand: bandOf(confidence),
        escalationStatus: escalation.escalate ? 'QUEUED' : 'NONE',
        escalationReasons: escalation.reasons,
        evidence: [
          ...(component.screenshots.element
            ? [{ kind: 'element-screenshot' as const, ref: component.screenshots.element, note: component.evidenceClipped ? 'clipped to the visible, bounded region — the element is larger than one image' : null, box: component.fingerprint.box }]
            : []),
          ...(component.screenshots.context ? [{ kind: 'context-screenshot' as const, ref: component.screenshots.context, note: null, box: component.fingerprint.box }] : []),
          { kind: 'computed-style' as const, ref: component.elId, note: compared > 0 ? (match?.foundationOnly ? `Foundation checks only — ${compared} verified (${passed.join(', ')}${mismatches.length ? `; ${mismatches.length} did not pass` : ''}); no Design System component was matched or compared` : `${compared} propert${compared === 1 ? 'y' : 'ies'} compared (${passed.length} passed)`) : null },
          ...component.domSignals.filter((sig) => sig.startsWith('heading role')).map((note) => ({ kind: 'ds-source' as const, ref: 'role', note })),
          ...unresolved.map((u) => ({ kind: 'ds-source' as const, ref: u.property, note: `not compared: ${u.reason}` })),
          ...ruleNotes.map((note) => ({ kind: 'ds-source' as const, ref: 'rules', note })),
          ...(match?.rationale ? [{ kind: 'ds-source' as const, ref: match.dsFile ?? 'match', note: `matched: ${match.rationale.slice(0, 300)}` }] : []),
          ...(typography ? [{ kind: 'ds-source' as const, ref: match?.dsFile ?? 'typography', note: nearestEvidenceNote(typography) }] : []),
        ],
        visualVerdict: 'NOT_CHECKED',
      },
      action: {
        recommendation: notCompared
          ? `Comparison incomplete: ${evaluation.notComparedWhy}. Available measurements are shown below. ${match?.contextSlot === 'subtitle' ? 'Confirm whether this copy is a subtitle/paragraph; do not apply heading styles based on the h2 tag alone.' : 'Review the unresolved parts before applying a design change.'}`
          : classification === 'MATCH'
            ? (match?.foundationOnly ? foundationMatchWording(component, passed) : 'No action — implementation matches the Design System.')
            : mismatches.length > 0
              ? `${confidence < 0.5 ? 'Candidate correction — verify the component/variant before applying. ' : ''}Source: ${match?.dsFile ?? 'DS'} (${judgedVariant ?? 'default'}). ${mismatches.map(mismatchLine).join('; ')}. Preserve properties already matching.${keepTag ? ` ${keepTag}` : ''}${ruleViolations.length ? ` ${ruleViolations.map((r) => `${r.ruleId}: ${r.why}`).join(' · ')}` : ''}`
              : [match?.contextSlot ? match.rationale : '', ruleViolations.map((r) => `${r.ruleId}: ${r.why}`).join(' · ') || 'Review against the Design System rules.'].filter(Boolean).join(' '),
        rootCauseRef: null,
        dsCandidateNote: null,
        registryUpdateRef: null,
      },
      history: { previousStatus: null, currentStatus: classification, delta: null, previousRunId: null },
      ...(notCompared
        ? {
            review: {
              status: 'UNVERIFIED' as const,
              reason: evaluation.notComparedWhy,
              node: 'B4',
              signals: component.domSignals,
              possibleMatches: match?.dsComponent && match.dsFile ? [{ dsComponent: match.dsComponent, dsFile: match.dsFile, dsVariant: match.dsVariant, score: match.confidence, why: match.rationale.slice(0, 200) }] : [],
              observed: match?.observed ?? [],
            },
          }
        : {}),
    };
  }
}

/**
 * The honest sentence for a clean text element: FOUNDATION checks passed — which is NOT a Design System component match. Body
 * text, a card title, a label and supporting copy have no component family to compare against; what is verified is exactly the
 * foundation properties measured (colour R1.1/R1.2, size R1.3 — or the card-title contract R4.3.5 —, typeface R1.4).
 */
function foundationMatchWording(component: DetectedComponent, passed: string[]): string {
  const role = component.headingRole;
  const what = role === 'card-title' ? 'a card title' : role === 'label' ? 'a label' : role === 'question' ? 'an FAQ question' : role === 'description' ? 'supporting copy' : 'body text';
  const parts = passed.map((p) => (p === 'font-family' ? 'typeface (R1.4)' : p === 'font-size' ? (role === 'card-title' ? 'size (card-title contract R4.3.5)' : role === 'question' ? 'size (AccordionItem question, --text-sm)' : 'size (R1.3)') : p === 'color' ? 'colour (R1.1 / R1.2)' : p));
  return `No foundation issues found — ${parts.join(', ')} verified. No Design System component applies to ${what}, so no component comparison was made; this is not a component match.`;
}

/** Snapshot of the policy that produced a finding (§2.2) — so a re-audit delta is never confused with a policy change. */
export function policyVersionOf(session: PageSession): string {
  return policyVersionFor(session.capture.renderingPolicy, session.aiMode);
}
