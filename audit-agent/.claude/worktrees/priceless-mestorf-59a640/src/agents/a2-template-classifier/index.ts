import { z } from 'zod';
import type { LlmClient } from '../../llm/client.ts';
import type { AiMode } from '../../llm/provider.ts';
import type { SiteMap } from '../a1-site-mapper/index.ts';

/**
 * A2 — Template Classifier (v1.0 §3): group URLs into page/template families
 * (Report Detail, Consulting, Survey, Article/POV, …). This is where AI
 * reasoning earns its place per the spec; the grouping then drives A3's
 * batching and every template-level metric in the report.
 *
 * Reads prior root-cause clusters when available (§4.3) so classification
 * improves across runs rather than starting cold every time.
 */

export const TemplateMapSchema = z.object({
  families: z.array(
    z.object({
      name: z.string().describe('Human-readable family name, e.g. "Report Detail"'),
      urlPattern: z.string().describe('The path shape that defines this family, e.g. "/industry-reports/*"'),
      urls: z.array(z.string()).describe('URLs from the supplied inventory that belong to this family'),
      rationale: z.string(),
    }),
  ),
});
export type TemplateMap = z.infer<typeof TemplateMapSchema>;

export interface ClassifiedUrl {
  url: string;
  templateFamily: string;
}

const SYSTEM = `You are the Template Classifier (A2) of a Design System compliance audit.
Group the supplied URLs into page/template families — pages that share a layout and therefore share design-system usage.
Rules:
- Every URL you place in a family must come from the supplied inventory, verbatim.
- Prefer a handful of meaningful families over many near-duplicates.
- Family membership should be predictable from the URL shape; say so in urlPattern.
- Do not invent URLs and do not drop any: anything you cannot place goes in a family named "Unclassified".`;

/**
 * no-api strategy (Decision Log #31): families from URL SHAPE — the part of
 * the model's job that is predictable by construction. Two URLs share a
 * family when they share their first path segment and their depth (every
 * three-level consulting page, e.g. /consulting/strategy/market-entry), which
 * is how this site's templates are routed. It never claims two different
 * shapes share a layout; a reviewer merges families at the Scope Gate if so.
 */
export function deterministicTemplateMap(siteMap: SiteMap): TemplateMap {
  const families = new Map<string, { name: string; urlPattern: string; urls: string[] }>();
  for (const { url } of siteMap.urls) {
    let segments: string[];
    try {
      segments = new URL(url).pathname.split('/').filter(Boolean);
    } catch {
      segments = [];
    }
    const head = segments[0];
    const depth = segments.length;
    const key = head ? `${head}:${depth}` : 'home';
    const title = head ? head.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Home';
    const urlPattern = !head ? '/' : `/${head}${'/*'.repeat(depth - 1)}`;
    const name = !head ? 'Home' : depth === 1 ? title : `${title} (${urlPattern})`;
    const family = families.get(key) ?? { name, urlPattern, urls: [] };
    family.urls.push(url);
    families.set(key, family);
  }
  return {
    families: [...families.values()]
      .sort((a, b) => b.urls.length - a.urls.length || a.urlPattern.localeCompare(b.urlPattern))
      .map((f) => ({ ...f, rationale: `deterministic: every URL shaped ${f.urlPattern} (same first path segment, same depth)` })),
  };
}

async function modelTemplateMap(siteMap: SiteMap, llm: LlmClient, priorRootCauses: string[]): Promise<TemplateMap> {
  const { data } = await llm.structured({
    nodeId: 'A2',
    system: SYSTEM,
    prompt:
      `Site root: ${siteMap.root}\n\n` +
      (priorRootCauses.length > 0
        ? `Root causes found in the previous audit (use them to anticipate which families matter):\n${priorRootCauses.slice(0, 20).join('\n')}\n\n`
        : '') +
      `URL inventory (${siteMap.urls.length}):\n${siteMap.urls.map((u) => u.url).join('\n')}\n\nGroup them into template families.`,
    schema: TemplateMapSchema,
    effort: 'medium',
  });
  return data;
}

export async function classifyTemplates(
  siteMap: SiteMap,
  llm: LlmClient,
  aiMode: AiMode,
  priorRootCauses: string[] = [],
): Promise<{ map: TemplateMap; classified: ClassifiedUrl[] }> {
  const data = aiMode === 'no-api' ? deterministicTemplateMap(siteMap) : await modelTemplateMap(siteMap, llm, priorRootCauses);

  const known = new Set(siteMap.urls.map((u) => u.url));
  const classified: ClassifiedUrl[] = [];
  const placed = new Set<string>();
  for (const family of data.families) {
    for (const url of family.urls) {
      // A model-invented URL is never audited — the inventory is the source of truth.
      if (!known.has(url) || placed.has(url)) continue;
      placed.add(url);
      classified.push({ url, templateFamily: family.name });
    }
  }
  // Nothing silently disappears: anything unplaced is still audited.
  for (const u of siteMap.urls) {
    if (!placed.has(u.url)) classified.push({ url: u.url, templateFamily: 'Unclassified' });
  }
  return { map: data, classified };
}
