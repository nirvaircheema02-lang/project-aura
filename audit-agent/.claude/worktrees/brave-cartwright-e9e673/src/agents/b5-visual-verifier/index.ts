import { readFile } from 'node:fs/promises';
import { B5VerdictsSchema } from '../../llm/schemas/b-nodes.ts';
import { bandOf, escalationFor, normalizeConfidence } from '../../skills/s8-confidence-escalation-policy.ts';
import { MASK_COLOR } from '../../t-layer/screenshot.ts';
import { locatorFor } from '../../t-layer/element-registry.ts';
import { normalizeRef } from '../refs.ts';
import type { LlmImage } from '../../llm/client.ts';
import type { NodeContext } from '../../graph/engine.ts';
import type { Finding, Severity } from '../../skills/s0-result-contract.ts';
import type { B4Output, B5Output, DetectedComponent, PageSession } from '../types.ts';

/**
 * B5 — Visual Verifier (v1.0 §4): check screenshot-level issues DOM/CSS alone
 * can miss — alignment, wrapping, overlap, hierarchy, optical spacing — and
 * catch false positives.
 *
 * A FALSE_POSITIVE verdict never silently flips a measured finding to MATCH.
 * The measurement and the picture disagreeing is exactly the ambiguous case a
 * human should see, so it escalates (S8) with both sides recorded. Same for
 * UNCERTAIN.
 *
 * Each finding is tied to its EXACT element through the stamped element id B4
 * recorded — never through the component signature, which repeated instances
 * (four identical cards) share by design; looking up by signature showed the
 * model card 1's screenshot for card 3's issue and copied one verdict onto
 * every instance.
 */

const SYSTEM = `You are the Visual Verifier (B5) of a Design System compliance audit.
You are shown screenshots of production components, each in its surrounding context, with the issue measured from its DOM/CSS. Decide whether the issue holds up visually, and report visual-only problems measurement cannot see.
Rules:
- CONFIRMED: the screenshot is consistent with the measured issue.
- FALSE_POSITIVE: the screenshot contradicts it (e.g. the measurement clearly describes a different element than the one pictured).
- UNCERTAIN: the picture cannot settle it.
- Flat grey blocks (${MASK_COLOR}) are redactions applied by the capture tool, not design elements.
- additionalIssues are for problems visible in the image only: overlap, bad wrapping, broken alignment, weak hierarchy, cramped optical spacing, truncation. Only report them for the refs you were shown.
- Answer with the bare ref (e.g. "e42"). Every confidence is a probability between 0 and 1.`;

/** Cap on findings verified per page — vision tokens are the expensive part of this node. */
export const MAX_VERIFIED_FINDINGS = 12;

const SEVERITY_ORDER: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** The element a finding was measured on — from the stamped id in its computed-style evidence. */
export function componentForFinding(finding: Finding, components: DetectedComponent[]): DetectedComponent | undefined {
  const elId = finding.quality.evidence.find((e) => e.kind === 'computed-style')?.ref;
  return elId ? components.find((c) => c.elId === elId) : undefined;
}

/**
 * Interactive types a pointer or finger has to hit — the ones a target-size
 * check applies to. Links are excluded: WCAG 2.5.8 exempts targets inline in a
 * sentence, and whether a link sits in running text is not measurable here.
 */
const TARGET_TYPES = new Set(['button', 'icon-button', 'checkbox', 'radio', 'select', 'input', 'search', 'tabs', 'chip']);

/** WCAG 2.2 SC 2.5.8 (AA) minimum target size, CSS px. */
export const MIN_TARGET_PX = 24;

/**
 * The no-api path (Decision Log #31). Seeing a picture is exactly what no-api
 * mode cannot do, so NO visual verdict is given (every finding stays
 * NOT_CHECKED — measured findings stand on their measurement). What CAN be
 * measured on the live element is attached, the same way a model's visual
 * remark would be: text cut off by its own box, and an interactive target
 * below the WCAG minimum size. Deterministic, so fully trusted — but LOW
 * severity, and never a change of classification.
 *
 * Exported (not just B5-internal) because B6 runs AFTER B5 in the graph
 * (third-pass review F5): its own findings — everything B3 could not match to
 * a DS component — never got this pass otherwise, which is most of a real
 * page. B6 calls this over its own newly-created findings once it has them;
 * B5 calls it over B4's. Each finding is measured once, by whichever of the
 * two node runs actually produced it.
 */
export async function applyDeterministicLayoutChecks(session: PageSession, input: Finding[], components: DetectedComponent[]): Promise<Finding[]> {
  const findings = [...input];
  for (const [index, finding] of findings.entries()) {
    if (finding.classification !== 'DEVIATION' && finding.classification !== 'INCORRECT') continue;
    const component = componentForFinding(finding, components);
    if (!component) continue;
    const measured = await locatorFor(session.page, component.elId)
      .evaluate(
        (el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          // A text node whose nearest wrapper is a11y-hidden (sr-only: 1px box + clip:rect(0,0,0,0);
          // display:none; visibility:hidden; opacity:0; a huge negative text-indent) paints nothing —
          // it is never "cut off", it was never shown (third-pass review F3).
          const suppressed = (node: Element): boolean => {
            const s = getComputedStyle(node);
            if (s.visibility === 'hidden' || s.display === 'none') return true;
            if (parseFloat(s.opacity) === 0) return true;
            const clip = s.clip.replace(/\s+/g, '');
            if (clip && clip !== 'auto' && /^rect\(0[a-z%]*,0[a-z%]*,0[a-z%]*,0[a-z%]*\)$/.test(clip)) return true;
            if (s.clipPath && s.clipPath !== 'none' && (s.clipPath.includes('circle(0') || /inset\(\s*100%/.test(s.clipPath))) return true;
            const indent = parseFloat(s.textIndent);
            if (!Number.isNaN(indent) && indent <= -999) return true;
            const rect = node.getBoundingClientRect();
            return rect.width <= 1 && rect.height <= 1;
          };
          // TEXT cut off by the element's own clipping box — measured on the text itself, so a
          // decorative absolutely-positioned layer (a 200%-wide shimmer) is never mistaken for it.
          const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.textOverflow === 'ellipsis';
          let hidden = 0;
          if (clips) {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const range = document.createRange();
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent?.trim()) continue;
              let hiddenByAncestor = false;
              for (let a: Element | null = node.parentElement; a && a !== el; a = a.parentElement) {
                if (suppressed(a)) {
                  hiddenByAncestor = true;
                  break;
                }
              }
              if (hiddenByAncestor) continue;
              range.selectNodeContents(node);
              for (const t of Array.from(range.getClientRects())) {
                if (t.width === 0 || t.height === 0) continue;
                // Only a rect that actually crosses the element's own edge counts, and never for
                // more than the text node's own size — a coincidentally distant, unrelated text
                // node must never inflate this into thousands of px.
                const overlapsX = t.right > r.left && t.left < r.right;
                const overlapsY = t.bottom > r.top && t.top < r.bottom;
                if (!overlapsX && !overlapsY) continue;
                const overflowRight = Math.min(Math.max(0, t.right - r.right), t.width);
                const overflowLeft = Math.min(Math.max(0, r.left - t.left), t.width);
                const overflowBottom = Math.min(Math.max(0, t.bottom - r.bottom), t.height);
                hidden = Math.max(hidden, overflowRight, overflowLeft, overflowBottom);
              }
            }
          }
          return { hidden, width: r.width, height: r.height, visible: cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0 && r.height > 0 };
        },
        undefined,
        { timeout: 2_000 },
      )
      .catch(() => null);
    if (!measured || !measured.visible) continue;
    const issues: Array<{ issueType: string; description: string }> = [];
    if (measured.hidden > 1) {
      issues.push({ issueType: 'truncation', description: `text is cut off by its own box (${Math.round(measured.hidden)}px of text outside it)` });
    }
    if (TARGET_TYPES.has(component.componentType) && (measured.width < MIN_TARGET_PX || measured.height < MIN_TARGET_PX)) {
      issues.push({ issueType: 'other', description: `target ${Math.round(measured.width)}×${Math.round(measured.height)}px is below the ${MIN_TARGET_PX}×${MIN_TARGET_PX}px minimum (WCAG 2.2 SC 2.5.8)` });
    }
    if (issues.length === 0) continue;
    findings[index] = {
      ...finding,
      comparison: {
        ...finding.comparison,
        mismatches: [
          ...finding.comparison.mismatches,
          ...issues.map((i) => ({ property: `visual:${i.issueType}`, actual: i.description, expected: 'no layout defect', expectedToken: null, comparison: 'unsupported' as const, delta: null })),
        ],
      },
      action: { ...finding.action, recommendation: `${finding.action.recommendation} ${issues.map((i) => `Layout (${i.issueType}): ${i.description}.`).join(' ')}` },
    };
  }
  return findings;
}

export async function runB5(ctx: NodeContext, input: B4Output & { session: PageSession }): Promise<B5Output> {
  const session = input.session;
  if (session.aiMode === 'no-api') {
    const findings = await applyDeterministicLayoutChecks(session, input.findings, input.components);
    return { ...input, findings };
  }
  const candidates = input.findings
    .filter((f) => f.classification === 'DEVIATION' || f.classification === 'INCORRECT')
    .slice(0, MAX_VERIFIED_FINDINGS);
  if (candidates.length === 0) return input;

  const shown = new Map<string, { finding: Finding; component: DetectedComponent; image: string }>(); // ref → what the model saw
  const images: LlmImage[] = [];
  const described: string[] = [];

  for (const finding of candidates) {
    const component = componentForFinding(finding, input.components);
    if (!component || shown.has(component.ref)) continue;
    // Context first: alignment, overlap and hierarchy are judgments about surroundings.
    const path = component.screenshots.context ?? component.screenshots.element;
    if (!path) continue;
    try {
      images.push({ png: await readFile(path), caption: `ref=${component.ref} — ${component.componentType} "${component.label.slice(0, 40)}" (in context)` });
    } catch {
      continue;
    }
    shown.set(component.ref, { finding, component, image: path });
    described.push(
      `ref=${component.ref} classification=${finding.classification} issue="${finding.comparison.mismatches
        .map((m) => `${m.property}: actual ${m.actual} vs expected ${m.expected}`)
        .join('; ')}${finding.comparison.ruleViolations.map((r) => ` rule ${r.ruleId}: ${r.why}`).join('')}"`,
    );
  }
  if (images.length === 0) return input;

  const { data, omittedImages } = await session.llm.structured({
    nodeId: 'B5',
    system: SYSTEM,
    prompt: `Measured issues:\n${described.join('\n')}\n\nFor each ref, give a verdict, and list any visual-only issues you can see.`,
    images,
    schema: B5VerdictsSchema,
    effort: 'high',
  });

  const droppedRefs = [...input.coverage.droppedRefs];
  const truncation = [...input.coverage.truncation];
  // A picture the request could not carry was never seen: no verdict about it is trusted.
  const unseen = new Set<string>();
  for (const omitted of omittedImages ?? []) {
    const ref = omitted.match(/^ref=(e\d+)/)?.[1];
    if (ref) unseen.add(ref);
    truncation.push({ what: 'B5 screenshot', detail: `${omitted} — not sent to the model; its visual check did not happen` });
  }
  const verdictByRef = new Map<string, B5Verdict>();
  for (const v of data.verdicts) {
    const ref = normalizeRef(v.ref);
    if (ref && unseen.has(ref)) continue;
    if (!ref || !shown.has(ref)) {
      droppedRefs.push({ node: 'B5', ref: v.ref, reason: 'verdict for a ref that was not shown' });
      continue;
    }
    if (!verdictByRef.has(ref)) verdictByRef.set(ref, v);
  }

  // Verdicts apply ONLY to the exact finding the model was shown.
  const verifiedIds = new Map([...shown.entries()].map(([ref, s]) => [s.finding.identity.findingId, ref]));
  const findings = input.findings.map((finding) => {
    const ref = verifiedIds.get(finding.identity.findingId);
    const verdict = ref ? verdictByRef.get(ref) : undefined;
    const component = ref ? shown.get(ref)?.component : undefined;
    const image = ref ? shown.get(ref)?.image : undefined;
    if (!verdict || !component) return finding;

    const verdictConfidence = normalizeConfidence(verdict.confidence);
    const confidence = Math.min(finding.quality.confidence, verdictConfidence.value);
    const escalation = escalationFor({
      findingId: finding.identity.findingId,
      confidence,
      visualVerdict: verdict.verdict,
      containsPlaceholderValue: component.containsPlaceholder,
      capturePartiallySettled: !session.capture.renderSettled.settled,
      outOfContractConfidence: verdictConfidence.outOfContract,
    });
    return {
      ...finding,
      quality: {
        ...finding.quality,
        confidence,
        confidenceBand: bandOf(confidence),
        visualVerdict: verdict.verdict,
        escalationStatus: escalation.escalate ? ('QUEUED' as const) : finding.quality.escalationStatus,
        escalationReasons: [...new Set([...finding.quality.escalationReasons, ...escalation.reasons])],
        evidence: [...finding.quality.evidence, { kind: 'context-screenshot' as const, ref: image ?? component.elId, note: `B5 ${verdict.verdict}: ${verdict.reasoning.slice(0, 200)}` }],
      },
    };
  });

  // Visual-only problems — real deviations no computed-style comparison would surface —
  // deduplicated per (element, issue type), then attached to that element's finding below.
  const merged = new Map<string, B5Issue>();
  for (const issue of data.additionalIssues) {
    const ref = normalizeRef(issue.ref);
    if (ref && unseen.has(ref)) continue;
    if (!ref || !shown.has(ref)) {
      droppedRefs.push({ node: 'B5', ref: issue.ref, reason: `visual issue "${issue.issueType}" for a ref that was not shown` });
      continue;
    }
    const key = `${ref}::${issue.issueType}`;
    const prior = merged.get(key);
    merged.set(
      key,
      prior
        ? {
            ...prior,
            description: `${prior.description} · ${issue.description}`,
            severity: SEVERITY_ORDER.indexOf(issue.severity) > SEVERITY_ORDER.indexOf(prior.severity) ? issue.severity : prior.severity,
            confidence: Math.max(prior.confidence, issue.confidence),
          }
        : { ...issue, ref },
    );
  }

  // Each visual-only problem is attached to its element's EXISTING finding — one finding
  // per component. Separate rows put every visual remark into the compliance denominator,
  // so the score depended on how talkative the model was, not on how many components deviate.
  for (const issue of merged.values()) {
    const { finding: base } = shown.get(issue.ref)!;
    const index = findings.findIndex((f) => f.identity.findingId === base.identity.findingId);
    const target = findings[index];
    if (!target) continue;
    const issueConfidence = normalizeConfidence(issue.confidence);
    const doubtful = bandOf(issueConfidence.value) === 'LOW' || issueConfidence.outOfContract;
    const escalationReasons = [
      ...new Set([...target.quality.escalationReasons, ...(doubtful ? (['VISUAL_UNCERTAIN'] as const) : []), ...(issueConfidence.outOfContract ? (['OUT_OF_CONTRACT_CONFIDENCE'] as const) : [])]),
    ];
    // Only a TRUSTED remark may raise the finding's severity — and then the published
    // confidence is capped at the remark's, so a hedged "possible overlap" cannot turn a
    // measured 4px deviation into a CRITICAL at HIGH confidence.
    const raise = !doubtful && SEVERITY_ORDER.indexOf(issue.severity) > SEVERITY_ORDER.indexOf(target.quality.severity);
    const confidence = raise ? Math.min(target.quality.confidence, issueConfidence.value) : target.quality.confidence;
    findings[index] = {
      ...target,
      comparison: {
        ...target.comparison,
        mismatches: [
          ...target.comparison.mismatches,
          { property: `visual:${issue.issueType}`, actual: issue.description, expected: 'no visual defect', expectedToken: null, comparison: 'unsupported', delta: null },
        ],
      },
      quality: {
        ...target.quality,
        severity: raise ? issue.severity : target.quality.severity,
        confidence,
        confidenceBand: bandOf(confidence),
        escalationReasons,
        escalationStatus: escalationReasons.length > 0 ? 'QUEUED' : target.quality.escalationStatus,
      },
      action: { ...target.action, recommendation: `${target.action.recommendation} Visual (${issue.issueType}): ${issue.description}` },
    };
  }

  return { ...input, findings, coverage: { ...input.coverage, droppedRefs, truncation } };
}

type B5Verdict = { ref: string; verdict: 'CONFIRMED' | 'FALSE_POSITIVE' | 'UNCERTAIN'; confidence: number; reasoning: string };
type B5Issue = { ref: string; issueType: string; description: string; severity: Severity; confidence: number };
