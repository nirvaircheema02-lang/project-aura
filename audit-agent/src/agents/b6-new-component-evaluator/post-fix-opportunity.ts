import { PLAUSIBLE_MATCH_SCORE } from './index.ts';
import type { Finding } from '../../skills/s0-result-contract.ts';

/**
 * Post-Fix Component Opportunity — a SEPARATE inference layered on top of B6's current-state
 * classification, never a change to it. B6 answers "is this element, as measured right now, a
 * NEW_COMPONENT / DS_CANDIDATE / NEEDS_REVIEW". This answers a different question: "if the
 * findings already known for this repeated pattern were corrected, would it become a reusable DS
 * candidate?" Computed entirely at render time from already-persisted `data.json` findings — no
 * re-audit, no model call, no new graph node.
 *
 * Scope is deliberately narrow, to avoid ever turning "unmatched" into "new component" by default:
 * only B6-authored INCORRECT findings qualify, because those are the only ones carrying a
 * structured, already-known "what's wrong" (`comparison.ruleViolations`, from
 * `checkFoundationRules` — typeface/type-scale/radius-scale/brand-color rules that govern every
 * element regardless of identity). A repeated pattern is proposed only when fixing those specific,
 * known violations is plausible — never when a real DS component was already found close enough
 * that the same fix would just make it conform to that existing component instead.
 */
export interface PostFixOpportunity {
  signature: string;
  productionType: string;
  productionLabel: string;
  section: string;
  /** How many findings on this run share this component's signature — B6's own repetition bar. */
  instances: number;
  representativeFindingId: string;
  relatedFindingIds: string[];
  /** One line per distinct rule breach across the group's B6 findings — the known, expected fix. */
  whatToFixFirst: string[];
  /** The closest DS component B3 considered and ruled out (too weak a match), when one exists. */
  ruledOutDsComponent: string | null;
  confidence: 'HIGH' | 'MEDIUM';
  reason: string;
}

export function computePostFixOpportunities(findings: Finding[]): PostFixOpportunity[] {
  const bySignature = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = bySignature.get(f.component.signature);
    if (list) list.push(f);
    else bySignature.set(f.component.signature, [f]);
  }

  const opportunities: PostFixOpportunity[] = [];
  for (const [signature, group] of bySignature) {
    if (group.length < 2) continue; // same repetition bar B6 itself requires for a real DS_CANDIDATE
    if (group.some((f) => f.classification === 'MATCH')) continue; // an existing DS component already fits this pattern
    if (group.some((f) => f.classification === 'DS_CANDIDATE' || f.classification === 'NEW_COMPONENT')) continue; // already surfaced today — never duplicate

    const b6Incorrect = group.filter((f) => f.classification === 'INCORRECT' && f.review?.node === 'B6' && f.comparison.ruleViolations.length > 0);
    if (b6Incorrect.length === 0) continue; // no structured "what's wrong" data to reason from without re-auditing

    // A plausible existing look-alike anywhere in the group means the same fix would just make
    // the pattern conform to that DS component — not create a new one. Reuses B6's own threshold.
    const allPossibleMatches = group.flatMap((f) => f.review?.possibleMatches ?? []);
    const plausible = allPossibleMatches.filter((m) => m.score >= PLAUSIBLE_MATCH_SCORE);
    if (plausible.length > 0) continue;

    const whatToFixFirst = [...new Set(b6Incorrect.flatMap((f) => f.comparison.ruleViolations.map((v) => `${v.title}: ${v.why}`)))];
    const representative = b6Incorrect[0]!;
    const relatedFindingIds = group.map((f) => f.identity.findingId).filter((id) => id !== representative.identity.findingId);

    const ruleIdKey = (f: Finding) => f.comparison.ruleViolations.map((v) => v.ruleId).sort().join(',');
    const consistentAcrossInstances = b6Incorrect.every((f) => ruleIdKey(f) === ruleIdKey(representative));
    const confidence: PostFixOpportunity['confidence'] = group.length >= 3 && consistentAcrossInstances ? 'HIGH' : 'MEDIUM';

    const closest = [...allPossibleMatches].sort((a, b) => b.score - a.score)[0] ?? null;
    const ruledOutDsComponent = closest?.dsComponent ?? null;

    opportunities.push({
      signature,
      productionType: representative.component.productionType,
      productionLabel: representative.component.productionLabel,
      section: representative.location.section,
      instances: group.length,
      representativeFindingId: representative.identity.findingId,
      relatedFindingIds,
      whatToFixFirst,
      ruledOutDsComponent,
      confidence,
      reason:
        `${group.length} instances of this ${representative.component.productionType} share the same pattern and the same ${whatToFixFirst.length === 1 ? 'measured violation' : 'measured violations'}; ` +
        (ruledOutDsComponent
          ? `the closest existing DS component (${ruledOutDsComponent}) was checked and is too weak a match to treat this as that component`
          : `no existing DS component resembled this pattern at all`) +
        ` — correcting the violation${whatToFixFirst.length === 1 ? '' : 's'} below would make it eligible as a Design System candidate.`,
    });
  }
  return opportunities;
}
