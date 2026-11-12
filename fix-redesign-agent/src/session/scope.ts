import type { Finding } from '../audit-link/index.ts';
import type { ScopeRecord } from '../output/redesign-store.ts';
import type { DesignMode } from './types.ts';

/**
 * §5.2a — section scope. Verified against BOTH upstream schemas before writing this: neither
 * `fix-plan.json` nor `new-component-plan.json` has any field for a reviewer's section
 * selection. Section membership is not stored anywhere upstream — only derivable, by grouping
 * each authorized finding on its own `data.json → location.section` string.
 */

const GLOBAL_SECTION_NAMES = new Set(['header', 'footer']);

/** A section id derived from the audit's own section name — the label the reviewer already saw — slugified, collision-suffixed. */
export function sectionIdFor(name: string, usedIds: ReadonlySet<string>): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  if (!usedIds.has(base)) return base;
  let n = 2;
  while (usedIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export interface SectionCandidate {
  sectionId: string;
  name: string;
  isGlobal: boolean;
  findingIds: string[];
}

/**
 * Every distinct `location.section` among the given (already-authorized) findings, in
 * first-seen order, with stable ids. §8.3: a section is global when the audit named it
 * Header/Footer (landmark cross-check happens later, at C2, once the live wrapper is known).
 */
export function deriveSectionCandidates(findings: Finding[]): SectionCandidate[] {
  const usedIds = new Set<string>();
  const byName = new Map<string, SectionCandidate>();
  for (const f of findings) {
    const name = f.location.section;
    let candidate = byName.get(name);
    if (!candidate) {
      const sectionId = sectionIdFor(name, usedIds);
      usedIds.add(sectionId);
      candidate = { sectionId, name, isGlobal: GLOBAL_SECTION_NAMES.has(name.trim().toLowerCase()), findingIds: [] };
      byName.set(name, candidate);
    }
    candidate.findingIds.push(f.identity.findingId);
  }
  return [...byName.values()];
}

/** The default candidate set for Selected Sections mode: every non-global section containing an authorized finding (§5.2a). */
export function defaultCandidateSectionIds(candidates: SectionCandidate[]): string[] {
  return candidates.filter((c) => !c.isGlobal).map((c) => c.sectionId);
}

export type ScopeDecision = { kind: 'auto'; record: ScopeRecord; reason: string };

/**
 * §5.2a scope resolution — redesign-only-scope default (2026-09-28): Selected Sections mode
 * ALWAYS derives its scope automatically from every non-global section containing a Fix-decision
 * finding. It never pauses at G1 merely because fix-plan.json (or new-component-plan.json) has no
 * separate section-selection field — neither ever will (verified against both upstream schemas,
 * see the module comment above), so asking about that would be asking a question the input can
 * never answer. `previous` is accepted for signature stability with existing callers but no
 * longer changes the outcome: the derivation is a pure function of the current candidate set, so
 * re-deriving is always identical to reusing, and there is nothing left to compare against.
 *
 * This is a different concern from a finding that cannot be reliably MAPPED to a live element —
 * that is C2's job, surfaced separately via G1's acknowledgement half in pipeline.ts. Section
 * membership itself is never ambiguous: it comes straight off each finding's own
 * `location.section` string, with no element-matching involved.
 *
 * Full Page mode never needed this distinction — it has no per-section choice (§8.1) — so it
 * keeps its own branch below unchanged.
 */
export function resolveScope(mode: DesignMode, candidates: SectionCandidate[], _previous: ScopeRecord | null): ScopeDecision {
  const excludedSectionIds = candidates.filter((c) => c.isGlobal).map((c) => c.sectionId);

  if (mode === 'full-page') {
    const sectionIds = candidates.filter((c) => !c.isGlobal).map((c) => c.sectionId).sort();
    const record: ScopeRecord = { mode, sectionIds, excludedSectionIds, candidateSectionIds: sectionIds, resolvedAt: new Date(0).toISOString() };
    return { kind: 'auto', record, reason: 'Full Page mode has no per-section choice — every content section is in scope.' };
  }

  const sectionIds = defaultCandidateSectionIds(candidates);
  const record: ScopeRecord = { mode, sectionIds, excludedSectionIds, candidateSectionIds: sectionIds, resolvedAt: new Date(0).toISOString() };
  const reason = sectionIds.length === 0
    ? 'No non-global section contains a Fix-decision finding — nothing is in scope for this run.'
    : `Derived from every non-global section containing a Fix-decision finding: ${sectionIds.join(', ')}.`;
  return { kind: 'auto', record, reason };
}
