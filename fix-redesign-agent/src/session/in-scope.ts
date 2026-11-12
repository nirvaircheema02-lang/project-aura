import type { Finding } from '../audit-link/index.ts';
import type { MappingResult } from '../mapping/types.ts';
import type { DesignMode } from './types.ts';

/**
 * §8.1's content-isolation guarantee, in ONE place so the Resolver and the Planner can never disagree about
 * which findings are in scope. In Selected Sections mode a finding is only in scope when its mapped section is
 * one the reviewer actually selected. Full Page mode has no per-section choice — every content-scope finding is
 * in scope, including one whose section wrapper could not be located (§8.2).
 */
export function inScopeFindings(fixFindings: Finding[], mapping: MappingResult | null, mode: DesignMode, sectionIds: string[]): Finding[] {
  if (!mapping) return [];
  return fixFindings.filter((f) => {
    const entry = mapping.entries.find((e) => e.findingIds.includes(f.identity.findingId));
    if (!entry || entry.scope !== 'content') return false;
    if (mode === 'full-page') return true;
    return entry.sectionId !== null && sectionIds.includes(entry.sectionId);
  });
}
