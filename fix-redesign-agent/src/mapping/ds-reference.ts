import type { Finding } from '../audit-link/index.ts';
import { readComponentSource, resolveCatalogEntry, type CatalogComponent } from '../ds/catalog.ts';
import type { DsRegistry } from '../ds/d2-registry/index.ts';
import type { DsReference } from './types.ts';

const SOURCE_EXCERPT_CHARS = 2000;

/**
 * §6.2/§6.1 — for every DS component a finding names or plausibly matches, the component's
 * REAL source text, read verbatim from the DS tree (never invented). Priority: the audit's
 * own `component.dsComponent` match (finding-match) first, then the top plausible match at or
 * above `plausibilityBar` (plausible-match), else none.
 */
export async function resolveDsReference(registry: DsRegistry, catalog: CatalogComponent[], finding: Finding, plausibilityBar: number): Promise<DsReference> {
  const excerptOf = async (file: string): Promise<string | null> => {
    try {
      const full = await readComponentSource(registry, file);
      return full.length > SOURCE_EXCERPT_CHARS ? `${full.slice(0, SOURCE_EXCERPT_CHARS)}\n/* excerpt truncated for the mapping record — full source is read again by R3/L1 when needed */` : full;
    } catch {
      return null;
    }
  };

  if (finding.component.dsComponent) {
    const entry = resolveCatalogEntry(catalog, finding.component.dsComponent);
    if (entry) {
      return { dsComponent: entry.name, dsFile: entry.file, dsVariant: finding.component.dsVariant, sourceExcerpt: await excerptOf(entry.file), basis: 'finding-match' };
    }
  }

  const top = [...(finding.review?.possibleMatches ?? [])].sort((a, b) => b.score - a.score)[0];
  if (top && top.score >= plausibilityBar) {
    const entry = resolveCatalogEntry(catalog, top.dsComponent);
    if (entry) {
      return { dsComponent: entry.name, dsFile: entry.file, dsVariant: top.dsVariant, sourceExcerpt: await excerptOf(entry.file), basis: 'plausible-match' };
    }
  }

  return { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' };
}
