import { assessReference, type ReferenceCatalog } from '../../ds/reference-patterns.ts';
import type { DetectedComponent, DsMatch } from '../types.ts';

/**
 * The Design System is searched FIRST (`decideMatch`'s family search); the approved Project Aura reference
 * evidence is consulted only for what that search left undecided. This is the one place the two meet:
 *
 *  - the DS answered (a component, a variant, a context slot, or foundation-only text) → the answer is returned
 *    exactly as it was, and the catalog is never read;
 *  - the DS could not represent the element AND the catalog holds evidence for its ROLE → the match gains the
 *    assessment (`reference`) and the reason says so; routing is unchanged (an undecided element still reaches
 *    B6, which reads the verdict — it never makes it a SectionHeading or any other unrelated component);
 *  - no evidence for the role → nothing changes.
 */
export function referenceRoleOf(component: Pick<DetectedComponent, 'componentType' | 'headingRole'>): string {
  if (component.componentType === 'paragraph' && component.headingRole === 'description') return 'description';
  return component.componentType;
}

export function attachReference(match: DsMatch, component: DetectedComponent, references: ReferenceCatalog | undefined): DsMatch {
  if (!references) return match;
  if (match.dsComponent !== null || match.foundationOnly === true) return match; // the Design System answered: first, and final
  if (match.search?.basis !== 'undecided') return match;
  const surface = component.domFacts?.context?.surface ?? 'unknown';
  const assessment = assessReference(references, referenceRoleOf(component), surface);
  if (!assessment) return match;
  return {
    ...match,
    reference: assessment,
    rationale: `${match.rationale} · approved Project Aura reference: ${assessment.note}`,
    undecidedReason: `${match.undecidedReason ?? 'no Design System component represents it'} · approved Project Aura reference: ${assessment.note}`,
  };
}
