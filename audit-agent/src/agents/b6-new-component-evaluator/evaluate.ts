import { B6EvaluationsSchema, type B6Evaluations } from '../../llm/schemas/b-nodes.ts';
import { effectiveTokenMap, renderTokensForPrompt } from '../../ds/catalog.ts';
import { bandOf, escalationFor, normalizeConfidence } from '../../skills/s8-confidence-escalation-policy.ts';
import { normalizeColor } from '../../t-layer/computed-style.ts';
import { leadingFamily } from '../../t-layer/token-comparator.ts';
import { resolveToken } from '../../ds/d3-tokens/resolve.ts';
import { normalizeRef } from '../refs.ts';
import { proposeRegistryUpdate } from '../../skills/s9-registry-update-governance.ts';
import { policyVersionOf } from '../b4-compliance-auditor/index.ts';
import { severityFor } from '../../skills/s5-compliance-classification.ts';
import { buildFoundationContext, checkFoundationRules } from '../b4-compliance-auditor/foundation-rules.ts';
import type { Classification, Finding, Review, Severity } from '../../skills/s0-result-contract.ts';
import { referenceRoleOf } from '../b3-ds-matcher/reference.ts';
import type { B4Output, DetectedComponent, DsMatch, PageSession } from '../types.ts';

/**
 * B6 — New Component Evaluator (v1.0 §4): when no approved DS component
 * exists, decide New Component vs DS Candidate based on foundation
 * compliance and reuse. Both are NEUTRAL for compliance scoring (v1.0 §13) —
 * absence from the DS never penalizes the site's score. In no-api mode it
 * decides only what it can prove (see `deterministicOutcomes`).
 *
 * Foundation compliance is measured here, not guessed: the element's rendered
 * colors and font family are checked against D3's effective token values.
 *
 * The evaluation lives in THIS module, apart from the graph node (index.ts), because two callers run
 * it: the B6 node, for the components B3 left without a Design System family, and B5's completeness
 * pass, for a component B5 itself recovered that B3 then found no family for. Both go through
 * `evaluateUnmatched` — a recovered element reaches B6 exactly as a first-pass one does, never a
 * parallel path. B6 is for a pattern NO existing family represents; an element whose family exists
 * never reaches it (B3's family search and B5's matching-coverage check see to that).
 */

const SYSTEM = `You are the New Component Evaluator (B6) of a Design System compliance audit.
These production components have no approved Design System equivalent. For each, decide:
- DS_CANDIDATE: it follows the Design System's foundations (tokens/typography/spacing) AND is reusable or repeated enough to deserve governance review.
- NEW_COMPONENT: a valid pattern that is not (yet) DS-worthy, or does not follow the foundations.
You are given a measured foundation-compliance report per component — use it rather than guessing whether tokens were followed.`;

/**
 * Deterministic foundation check: do the rendered values correspond to real
 * DS token values? Token aliases are RESOLVED first — 136 of the DS's tokens
 * are `var()` aliases, and reading them raw meant no aliased color ever
 * counted, and every font stack (which leads with next/font's runtime
 * `var(--font-dm-sans)`) matched nothing at all.
 */
export function foundationCompliance(component: DetectedComponent, tokens: Map<string, string>): {
  usesTokenColors: boolean;
  usesTokenFont: boolean;
  detail: string;
} {
  if (!component.style.connected) return { usesTokenColors: false, usesTokenFont: false, detail: 'element was not connected when measured' };
  const tokenColors = new Set<string>();
  const tokenFamilies = new Set<string>();
  for (const [name] of tokens) {
    if (/color|surface|ink|bg|brand|text/i.test(name)) {
      const resolved = resolveToken(name, tokens);
      const hex = resolved ? normalizeColor(resolved) : null;
      if (hex) tokenColors.add(hex);
    }
    if (/font|sans|serif/i.test(name)) {
      const family = leadingFamily(tokens.get(name) ?? '', tokens);
      if (family) tokenFamilies.add(family);
    }
  }
  const colorProps = ['color', 'background-color', 'border-top-color'];
  const observed = colorProps
    .map((p) => normalizeColor(component.style.connected ? (component.style.raw[p] ?? '') : ''))
    .filter((c): c is string => Boolean(c) && c !== '#00000000');
  const matchedColors = observed.filter((c) => tokenColors.has(c));

  const rendered = component.style.raw['font-family'] ?? '';
  const renderedFamily = leadingFamily(rendered, tokens);
  const usesTokenFont = renderedFamily !== null && tokenFamilies.has(renderedFamily);

  return {
    usesTokenColors: observed.length > 0 && matchedColors.length === observed.length,
    usesTokenFont,
    detail: `colors ${matchedColors.length}/${observed.length} match DS token values; font-family "${rendered.slice(0, 60)}" ${usesTokenFont ? 'matches' : 'does not match'} a DS font token`,
  };
}

type Evaluation = B6Evaluations['evaluations'][number];

/** What B6 decided for one component — by the model or deterministically — before it becomes an S0 finding. */
interface B6Outcome {
  classification: Classification;
  confidence: number;
  recommendation: string;
  dsCandidateNote: string;
  /** File a governance proposal (S9 PROPOSED — a human approves or rejects it; nothing is ever auto-approved). */
  propose: boolean;
  ruleViolations: Array<{ ruleId: string; title: string; why: string; severity?: Severity }>;
  review?: Review;
  modelOmitted: boolean;
  needsReview: boolean;
  outOfContract: boolean;
}

/** What B6 needs to know about the page: every detected component (for reuse counts) and B3's answer for each. */
export type B6Input = Pick<B4Output, 'components' | 'matches'>;

/** The model path: one call (plus a follow-up for skipped refs) classifying NEW_COMPONENT vs DS_CANDIDATE. */
async function modelOutcomes(session: PageSession, input: B6Input, reports: Array<{ component: DetectedComponent; fc: ReturnType<typeof foundationCompliance>; line: string }>): Promise<Map<string, B6Outcome>> {
  const evaluations = new Map<string, Evaluation>();
  const askB6 = async (subset: typeof reports, followUp: boolean) => {
    const { data } = await session.llm.structured({
      nodeId: 'B6',
      system: SYSTEM,
      prompt:
        `Design System foundation tokens:\n${renderTokensForPrompt(session.registry, 'editorial-light', /^--(color|semantic|text|font|radius|space|spacing)/)}\n\n` +
        `${followUp ? 'These components were missing from your previous answer. ' : ''}Unmatched production components:\n${subset.map((r) => r.line).join('\n')}\n\n` +
        `Classify each as NEW_COMPONENT or DS_CANDIDATE. Return one entry for every ref, answering with the bare ref (e.g. "e42").`,
      schema: B6EvaluationsSchema,
      effort: 'high',
    });
    const asked = new Set(subset.map((r) => r.component.ref));
    for (const e of data.evaluations) {
      const ref = normalizeRef(e.ref);
      if (ref && asked.has(ref) && !evaluations.has(ref)) evaluations.set(ref, e);
    }
  };
  await askB6(reports, false);
  const missing = reports.filter((r) => !evaluations.has(r.component.ref));
  if (missing.length > 0) await askB6(missing, true);

  const outcomes = new Map<string, B6Outcome>();
  for (const { component } of reports) {
    const evaluation = evaluations.get(component.ref);
    const match = input.matches.get(component.ref);
    const classification = evaluation?.verdict === 'DS_CANDIDATE' ? 'DS_CANDIDATE' : 'NEW_COMPONENT';
    const evaluated = evaluation ? normalizeConfidence(evaluation.confidence) : { value: 0.4, outOfContract: false };
    // "No DS match" because B3 never ANSWERED is not a confident no-match: the component may
    // well be a real DS Button. Keep it below MEDIUM so a human looks, and file nothing.
    const b3Unanswered = match?.unanswered ?? false;
    let confidence = Math.min(component.detectionConfidence, evaluated.value);
    if (b3Unanswered) confidence = Math.min(confidence, 0.3);
    outcomes.set(component.ref, {
      classification,
      confidence,
      recommendation: evaluation?.recommendation ?? 'Review whether this pattern belongs in the Design System.',
      dsCandidateNote: [
        b3Unanswered ? 'B3 returned no DS match for this ref (even after a follow-up) — it may be an existing DS component; verify before treating as new' : null,
        evaluation ? `${evaluation.foundationNotes} · ${evaluation.reuseRationale}` : 'B6 returned no evaluation for this ref',
      ]
        .filter(Boolean)
        .join(' · '),
      propose: classification === 'DS_CANDIDATE' && bandOf(confidence) !== 'LOW' && !b3Unanswered,
      ruleViolations: [],
      modelOmitted: b3Unanswered || !evaluation,
      needsReview: false,
      outOfContract: component.confidenceOutOfContract || (match?.confidenceOutOfContract ?? false) || evaluated.outOfContract,
    });
  }
  return outcomes;
}

/** Confidence of a breach measured against the DS's own values — the measurement, not the component identity, is what is claimed. */
const MEASURED_CONFIDENCE = 0.9;
/** Below this, a possible DS match is a look-alike, not a reason to doubt a pattern is new (B3's PossibleMatch.score). */
export const PLAUSIBLE_MATCH_SCORE = 0.35;

/**
 * The element's measured values next to what the approved reference pages say (the agreed value, or every page's own
 * when they disagree) — what a reviewer deciding an ambiguous pattern needs to see.
 */
function referenceObserved(component: DetectedComponent, reference: NonNullable<DsMatch['reference']>): NonNullable<Review['observed']> {
  const raw = component.style.connected ? component.style.raw : {};
  const properties = [...Object.keys(reference.agreed), ...reference.differing.map((d) => d.property)];
  return properties.map((property) => {
    const differing = reference.differing.find((d) => d.property === property);
    return {
      property,
      actual: raw[property] ?? 'not readable',
      expected: differing ? `varies: ${differing.values.map((v) => `${v.value} (${v.page})`).join(' / ')}` : (reference.agreed[property] ?? null),
      expectedToken: null,
    };
  });
}

/**
 * The no-api path (Decision Log #31). B3 could not tie these components to a
 * DS component deterministically, so B6 claims only what it can prove:
 *  - a foundation rule measurably broken (typeface, type scale, radius scale,
 *    brand red on a heading) → INCORRECT: those rules govern every element,
 *    whatever component it is;
 *  - a repeated pattern that follows the DS foundations → DS_CANDIDATE, filed
 *    as a PROPOSED governance request — never approved automatically;
 *  - anything else → NEEDS_REVIEW, with the possible DS matches B3 found and
 *    the reason no decision was possible. NEW_COMPONENT ("the DS has nothing
 *    like this") is a judgment no-api mode never makes on its own.
 */
function deterministicOutcomes(session: PageSession, input: B6Input, reports: Array<{ component: DetectedComponent; fc: ReturnType<typeof foundationCompliance> }>, reuseCounts: Map<string, number>): Map<string, B6Outcome> {
  const ctx = buildFoundationContext(session.registry);
  const outcomes = new Map<string, B6Outcome>();
  for (const { component, fc } of reports) {
    const match = input.matches.get(component.ref);
    const instances = reuseCounts.get(component.signature) ?? 1;
    const possibleMatches = match?.possibleMatches ?? [];
    const headingLevel = /^h([1-6])$/.exec(component.domFacts?.tag ?? '')?.[1];
    const violations = checkFoundationRules({
      componentType: component.componentType,
      headingLevel: headingLevel ? Number(headingLevel) : null,
      hasText: Boolean(component.domFacts?.ownText),
      style: component.style,
      ctx,
      role: component.headingRole ?? null,
    });
    const signals = [...component.domSignals, `foundations: ${fc.detail}`, `${instances} instance(s) of this pattern on the page`];
    const identity = match?.undecidedReason ?? `no Design System component resembles this ${component.componentType} closely enough to audit it against`;
    const review = (reason: string, observed: Review['observed'] = match?.observed ?? []): Review => ({
      status: 'NEEDS_REVIEW',
      reason,
      node: 'B6',
      signals,
      possibleMatches,
      observed,
    });

    if (violations.length > 0) {
      outcomes.set(component.ref, {
        classification: 'INCORRECT',
        confidence: MEASURED_CONFIDENCE,
        recommendation: violations.map((v) => `${v.ruleId}: ${v.why}`).join(' · '),
        dsCandidateNote: `DS component not determined (${identity}); the foundation-rule breach stands whatever component this is.`,
        propose: false,
        ruleViolations: violations.map((v) => ({ ruleId: v.ruleId, title: v.title, why: v.why, severity: v.severity })),
        review: review(`${identity} — the DS component is for a human to name; the ${[...new Set(violations.map((v) => v.ruleId))].join(', ')} breach is measured and stands regardless`),
        modelOmitted: false,
        needsReview: false,
        outOfContract: false,
      });
      continue;
    }
    // The Design System was searched first and could not represent this element. What the approved Project Aura
    // pages say about its ROLE comes next (Decision Log #46) — as supporting evidence, never a decision: a pattern
    // they show CONSISTENTLY is a reference-backed Design System candidate; anything less is a question for a human.
    // It is never forced into SectionHeading or any other unrelated component.
    if (match?.reference) {
      const reference = match.reference;
      const role = referenceRoleOf(component);
      const refObserved = referenceObserved(component, reference);
      if (reference.verdict === 'consistent') {
        outcomes.set(component.ref, {
          classification: 'DS_CANDIDATE',
          confidence: 0.7,
          recommendation: `No Design System component defines this ${role}, and the approved Project Aura pages (${reference.pages.join(', ')}) use the same pattern consistently: ${Object.entries(reference.agreed).map(([k, v]) => `${k} ${v}`).join(', ')}. It is a reference-backed pattern — proposed for Design System governance. It is not a violation of any DS component and not a new component; the reference pages are supporting evidence, never a replacement for the Design System.`,
          dsCandidateNote: `reference-backed pattern (not in the DS): ${reference.note}. Measured here: ${refObserved.map((o) => `${o.property} ${o.actual}`).join(', ') || 'not readable'}. Sources: ${reference.sources.join('; ')}. Proposed only — a human approves or rejects it.`,
          propose: true,
          ruleViolations: [],
          modelOmitted: false,
          needsReview: false,
          outOfContract: false,
        });
        continue;
      }
      const why = `${identity}; ${reference.note}. Ambiguous reference evidence is never forced into a component — a human decides which pattern this ${role} follows`;
      outcomes.set(component.ref, {
        classification: 'NEEDS_REVIEW',
        confidence: Math.min(component.detectionConfidence, 0.49),
        recommendation: `Decide which pattern this ${role} follows: the Design System does not define it and the approved reference pages ${reference.verdict === 'single-source' ? 'show it on one page only' : 'do not agree'} (see the observed values). Then re-audit it against that pattern.`,
        dsCandidateNote: why,
        propose: false,
        ruleViolations: [],
        review: review(why, refObserved),
        modelOmitted: false,
        needsReview: true,
        outOfContract: false,
      });
      continue;
    }
    const followsFoundations = fc.usesTokenColors && fc.usesTokenFont;
    // A look-alike this weak (no shared DS classes, most governed properties off) does not make
    // the pattern "an existing DS component": it stays listed for the reviewer, not a veto.
    const plausible = possibleMatches.filter((m) => m.score >= PLAUSIBLE_MATCH_SCORE);
    if (plausible.length === 0 && instances >= 2 && followsFoundations) {
      outcomes.set(component.ref, {
        classification: 'DS_CANDIDATE',
        confidence: 0.6,
        recommendation: `A repeated pattern (${instances} instances) built on Design System foundations with no DS equivalent — proposed for governance review; a human approves or rejects it.`,
        dsCandidateNote: `deterministic: ${fc.detail}; ${instances} identical instances on the page.${possibleMatches.length ? ` Weak look-alikes checked and ruled out: ${possibleMatches.map((m) => `${m.dsComponent} ${m.score.toFixed(2)}`).join(', ')}.` : ''} Proposed only — never approved automatically.`,
        propose: true,
        ruleViolations: [],
        modelOmitted: false,
        needsReview: false,
        outOfContract: false,
      });
      continue;
    }
    const why =
      plausible.length > 0
        ? identity
        : `${identity}; it is ${instances >= 2 ? `repeated (${instances}×) but ${followsFoundations ? 'resembles DS components too loosely to rule them out' : 'does not follow the DS foundations'}` : 'a single instance'} — whether it is an existing DS component, a one-off, or a Design System candidate needs a human`;
    outcomes.set(component.ref, {
      classification: 'NEEDS_REVIEW',
      confidence: Math.min(component.detectionConfidence, possibleMatches[0]?.score ?? 0.4, 0.49),
      recommendation: 'Decide which Design System component this is (or that it is new), then re-audit it against that component.',
      dsCandidateNote: why,
      propose: false,
      ruleViolations: [],
      review: review(why),
      modelOmitted: false,
      needsReview: true,
      outOfContract: false,
    });
  }
  return outcomes;
}

/**
 * Evaluates components that have NO existing Design System family and returns one finding each —
 * exactly the findings the B6 node publishes, whoever asks. The caller supplies the page's component
 * list and B3's answers (for reuse counts and the possible matches shown to a reviewer) and the subset
 * to evaluate; layout checks (B5's `applyDeterministicLayoutChecks`) are the caller's, because where
 * they run depends on the node order.
 */
export async function evaluateUnmatched(session: PageSession, input: B6Input, unmatched: DetectedComponent[]): Promise<Finding[]> {
  if (unmatched.length === 0) return [];
  const tokens = effectiveTokenMap(session.registry, 'editorial-light');
  const reuseCounts = new Map<string, number>();
  for (const c of input.components) reuseCounts.set(c.signature, (reuseCounts.get(c.signature) ?? 0) + 1);

  const reports = unmatched.map((c) => {
    const fc = foundationCompliance(c, tokens);
    return {
      component: c,
      fc,
      line:
        `ref=${c.ref} type=${c.componentType} label="${c.label.slice(0, 50)}" section="${c.sectionName}" ` +
        `instancesOnPage=${reuseCounts.get(c.signature) ?? 1} foundations[${fc.detail}] ` +
        `noMatchReason="${input.matches.get(c.ref)?.rationale.slice(0, 120) ?? 'no DS equivalent'}"`,
    };
  });

  const outcomes = session.aiMode === 'no-api' ? deterministicOutcomes(session, input, reports, reuseCounts) : await modelOutcomes(session, input, reports);

  const findings: Finding[] = [];
  for (const { component, fc } of reports) {
    const outcome = outcomes.get(component.ref)!;
    const id = component.findingId;
    const { classification, confidence } = outcome;

    // A DS Candidate is a governance proposal, deduped by signature across pages and runs (§4.1/S9).
    let registryUpdateRef: string | null = null;
    // A prior REJECTED/APPROVED/MERGED decision for this exact pattern is never re-proposed —
    // the governance gate already decided it (third-pass review CH-2).
    let priorDecisionNote: string | null = null;
    if (outcome.propose) {
      const proposal = proposeRegistryUpdate(session.db, {
        candidateRef: `cand-${component.signature}`,
        signature: component.signature,
        proposedBy: 'B6',
      });
      registryUpdateRef = proposal.candidateRef;
      if (proposal.status === 'REJECTED') priorDecisionNote = 'Already reviewed and REJECTED as a Design System candidate — not re-proposed.';
      else if (proposal.status === 'APPROVED' || proposal.status === 'MERGED') priorDecisionNote = `Already reviewed and ${proposal.status} — see the Design System registry.`;
    }

    const escalation = escalationFor({
      findingId: id,
      confidence,
      containsPlaceholderValue: component.containsPlaceholder,
      capturePartiallySettled: !session.capture.renderSettled.settled,
      modelOmitted: outcome.modelOmitted,
      needsReview: outcome.needsReview,
      outOfContractConfidence: outcome.outOfContract,
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
        sectionId: component.sectionId,
        captureState: component.captureState,
      },
      component: {
        productionType: component.componentType,
        productionLabel: component.label,
        dsComponent: null,
        dsVariant: null,
        signature: component.signature,
      },
      classification,
      comparison: { mismatches: [], ruleViolations: outcome.ruleViolations },
      quality: {
        severity: severityFor({ hasDsMatch: false, mismatches: [], ruleViolations: outcome.ruleViolations, classification }),
        confidence,
        confidenceBand: bandOf(confidence),
        escalationStatus: escalation.escalate ? 'QUEUED' : 'NONE',
        escalationReasons: escalation.reasons,
        evidence: [
          ...(component.screenshots.element ? [{ kind: 'element-screenshot' as const, ref: component.screenshots.element, note: null, box: component.fingerprint.box }] : []),
          ...(component.screenshots.context ? [{ kind: 'context-screenshot' as const, ref: component.screenshots.context, note: null, box: component.fingerprint.box }] : []),
          { kind: 'computed-style' as const, ref: component.elId, note: fc.detail },
        ],
        visualVerdict: 'NOT_CHECKED',
      },
      action: {
        recommendation: outcome.recommendation,
        rootCauseRef: null,
        dsCandidateNote: priorDecisionNote ? `${priorDecisionNote} ${outcome.dsCandidateNote}` : outcome.dsCandidateNote,
        registryUpdateRef,
      },
      history: { previousStatus: null, currentStatus: classification, delta: null, previousRunId: null },
      ...(outcome.review ? { review: outcome.review } : {}),
    });
  }
  return findings;
}
