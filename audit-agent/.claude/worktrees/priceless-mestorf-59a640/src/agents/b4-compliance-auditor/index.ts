import { B4ExpectationsSchema, type B4Expectations } from '../../llm/schemas/b-nodes.ts';
import { effectiveTokenMap, readComponentSource, renderRulesForPrompt, renderTokensForPrompt, ruleIds } from '../../ds/catalog.ts';
import { classify, severityFor } from '../../skills/s5-compliance-classification.ts';
import { bandOf, BANDS, escalationFor, normalizeConfidence } from '../../skills/s8-confidence-escalation-policy.ts';
import { compareToExpected } from '../../t-layer/token-comparator.ts';
import { lengthToPx } from '../../t-layer/computed-style.ts';
import { policyVersionFor } from '../../graph/run-metadata.ts';
import { normalizeRef } from '../refs.ts';
import { buildFoundationContext, checkFoundationRules, type FoundationContext } from './foundation-rules.ts';
import { assignmentsOf, dsIndex } from '../b3-ds-matcher/deterministic.ts';
import { dimensionLabel, expectationsFor, type ComponentStyleModel } from '../../ds/component-styles.ts';
import type { ExtractedStyle } from '../../t-layer/computed-style.ts';
import type { Finding, Mismatch, Severity } from '../../skills/s0-result-contract.ts';
import type { NodeContext } from '../../graph/engine.ts';
import type { B3Output, B4Output, DetectedComponent, PageSession } from '../types.ts';

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

/** What comparing one component produced — from model-named or source-derived expectations — before it becomes a finding. */
interface ComponentEvaluation {
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

/**
 * The no-api path (Decision Log #31). Expectations come from the matched DS
 * component's own source (src/ds/component-styles.ts), for every variant
 * assignment B3 found fitting equally well — a property only deviates when it
 * matches NONE of them, so an undeterminable variant is never guessed.
 * Foundation rules are measured, not interpreted (foundation-rules.ts).
 */
async function deterministicEvaluations(session: PageSession, input: B3Output): Promise<Map<string, ComponentEvaluation>> {
  const tokens = effectiveTokenMap(session.registry, 'editorial-light');
  const ctx = buildFoundationContext(session.registry);
  const index = await dsIndex(session.registry);
  seedDsRadii(ctx, index);
  const viewportWidth = session.page.viewportSize()?.width ?? 1440;
  const out = new Map<string, ComponentEvaluation>();
  for (const component of input.matched) {
    const match = input.matches.get(component.ref);
    const model = match?.dsFile ? index.byFile.get(match.dsFile)?.model : undefined;
    const style = component.style;
    let mismatches: Mismatch[] = [];
    let passed: string[] = [];
    let unresolved: Array<{ property: string; reason: string }> = [];
    let expectationCount = 0;
    let dsVariantOverride: string | null | undefined;
    if (model && style.connected) {
      const merged = compareAnyOf(model, match?.assignments?.length ? match.assignments : assignmentsOf(model).slice(0, 1), style, tokens, viewportWidth);
      mismatches = merged.mismatches;
      passed = merged.passed;
      unresolved = merged.unresolved;
      expectationCount = merged.expectationCount;
      // The variant actually judged, which compareAnyOf may have picked from among several tied
      // ones B3 offered — never labelled with an assignment the comparison did not settle on.
      dsVariantOverride = merged.chosen ? dimensionLabel(model, merged.chosen) || null : null;
    }
    const headingLevel = /^h([1-6])$/.exec(component.domFacts?.tag ?? '')?.[1];
    const rawViolations = checkFoundationRules({
      componentType: component.componentType,
      headingLevel: headingLevel ? Number(headingLevel) : null,
      hasText: Boolean(component.domFacts?.ownText),
      style,
      ctx,
    });
    // A foundation rule must never contradict what this very node just proved: the matched DS
    // component's own comparison already found this property EQUAL to its expectation (third-pass
    // review F2 — a node using MenuItem's own 8px corner verbatim was published INCORRECT on R3.6
    // while its own comparison showed that property passed).
    const violations = rawViolations.filter((v) => !passed.includes(v.property));
    out.set(component.ref, {
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
        : !model
          ? `the Design System source for ${match?.dsFile ?? 'this component'} could not be read into governed properties`
          : expectationCount === 0
            ? `${match?.dsFile} sets no root-element property this audit can read deterministically for the matched variant — its styling lives in child elements, runtime state or caller classes`
            : `none of its ${expectationCount} source-derived expectation(s) could be resolved (${[...new Set(unresolved.map((u) => u.reason))].slice(0, 2).join('; ')})`,
      expectationCount,
      dsVariantOverride,
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
function compareAnyOf(
  model: ComponentStyleModel,
  assignments: Array<Record<string, string>>,
  style: Extract<ExtractedStyle, { connected: true }>,
  tokens: Map<string, string>,
  viewportWidth: number,
): { mismatches: Mismatch[]; passed: string[]; unresolved: Array<{ property: string; reason: string }>; expectationCount: number; chosen: Record<string, string> | null } {
  const evaluated = assignments.map((assignment) => {
    const expected = expectationsFor(model, assignment, { viewportWidth });
    const result = compareToExpected({
      actual: style.raw,
      expected: expected.map((e) => ({ property: e.property, token: e.token, literal: e.literal })),
      effectiveTokens: tokens,
      rootFontSizePx: style.rootFontSizePx,
      box: style.box ?? null,
    });
    return { assignment, expectedCount: expected.length, result, compared: result.passed.length + result.mismatches.length };
  });
  const expectationCount = evaluated.reduce((n, e) => Math.max(n, e.expectedCount), 0);
  if (evaluated.length === 0) return { mismatches: [], passed: [], unresolved: [], expectationCount, chosen: null };

  const clean = evaluated.filter((e) => e.result.mismatches.length === 0 && e.compared >= MIN_VERIFIED_PROPERTIES);
  if (clean.length > 0) {
    const best = clean.reduce((a, b) => (b.compared > a.compared ? b : a));
    return { mismatches: [], passed: best.result.passed, unresolved: best.result.unresolved, expectationCount, chosen: best.assignment };
  }

  const totalDelta = (e: (typeof evaluated)[number]) => e.result.mismatches.reduce((n, m) => n + Math.abs(m.delta ?? 0), 0);
  const best = evaluated.reduce((a, b) => {
    if (b.result.mismatches.length !== a.result.mismatches.length) return b.result.mismatches.length < a.result.mismatches.length ? b : a;
    return totalDelta(b) < totalDelta(a) ? b : a;
  });
  return { mismatches: best.result.mismatches, passed: best.result.passed, unresolved: best.result.unresolved, expectationCount, chosen: best.assignment };
}

export async function runB4(ctx: NodeContext, input: B3Output & { session: PageSession }): Promise<B4Output> {
  const session = input.session;
  const findings: Finding[] = [];
  if (input.matched.length === 0) return { ...input, findings };

  const evaluations = session.aiMode === 'no-api' ? await deterministicEvaluations(session, input) : await modelEvaluations(session, input);

  for (const component of input.matched) {
    const match = input.matches.get(component.ref);
    const evaluation = evaluations.get(component.ref)!;
    const { mismatches, passed, unresolved, ruleViolations, ruleNotes, ruleConfidences, expectationConfidence } = evaluation;

    const compared = passed.length + mismatches.length;
    // no-api: a clean result on one or two governed properties is not a proven MATCH — too little
    // of the component was verified (a measured difference, by contrast, is proven on its own).
    const tooFewToVerify = session.aiMode === 'no-api' && mismatches.length === 0 && ruleViolations.length === 0 && compared > 0 && compared < MIN_VERIFIED_PROPERTIES;
    const notCompared = ruleViolations.length === 0 && (compared === 0 || tooFewToVerify);
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

    findings.push({
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
      comparison: { mismatches, ruleViolations },
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
          { kind: 'computed-style' as const, ref: component.elId, note: compared > 0 ? `${compared} propert${compared === 1 ? 'y' : 'ies'} compared (${passed.length} passed)` : null },
          ...unresolved.map((u) => ({ kind: 'ds-source' as const, ref: u.property, note: `not compared: ${u.reason}` })),
          ...ruleNotes.map((note) => ({ kind: 'ds-source' as const, ref: 'rules', note })),
          ...(match?.rationale ? [{ kind: 'ds-source' as const, ref: match.dsFile ?? 'match', note: `matched: ${match.rationale.slice(0, 300)}` }] : []),
        ],
        visualVerdict: 'NOT_CHECKED',
      },
      action: {
        recommendation: notCompared
          ? `Not verified — ${evaluation.notComparedWhy}. Needs human review; excluded from the compliance score.`
          : classification === 'MATCH'
            ? 'No action — implementation matches the Design System.'
            : mismatches.length > 0
              ? `Align ${mismatches.map((m) => m.property).join(', ')} with ${mismatches.map((m) => m.expectedToken ?? m.expected).join(', ')}.${ruleViolations.length ? ` ${ruleViolations.map((r) => `${r.ruleId}: ${r.why}`).join(' · ')}` : ''}`
              : (ruleViolations.map((r) => `${r.ruleId}: ${r.why}`).join(' · ') || 'Review against the Design System rules.'),
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
    });
  }

  return { ...input, findings };
}

/** Snapshot of the policy that produced a finding (§2.2) — so a re-audit delta is never confused with a policy change. */
export function policyVersionOf(session: PageSession): string {
  return policyVersionFor(session.capture.renderingPolicy, session.aiMode);
}
