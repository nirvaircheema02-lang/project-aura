import type { ReferenceHooks } from '../resolution/resolve.ts';
import { canonicalKind, type SemanticKind } from './element-kind.ts';
import type { DsTokenLookup, PatternCategory, PatternQuery } from './types.ts';
import { summariseMapping } from '../resolution/ds-colours.ts';
import { TerminalError } from '../retry.ts';
import { loadApprovedRegistry, resolveProject } from './registry.ts';
import { canMapColours, findPatterns, sharedPurposeTerms, toReferenceProvenance, verifyPattern } from './patterns.ts';
import type { ApprovedRegistry } from './types.ts';

/**
 * Connects the approved-reference registry to the Resolver. Only projects in the allowlist can ever be
 * consulted; a claim naming anything else is rejected by `verifyPattern`'s own project-approved check.
 * The Resolver asks for the pattern a judgment NAMED, so the category used for verification is the
 * pattern's own (the purpose and surface/viewport/element checks still apply). Candidates offered by `find` pass the same surface, viewport and
 * element-kind test as `verify` (the query's kinds are the Resolver's semantic classification, never a tag), and its purpose test, so the two cannot disagree.
 */
export interface ReferenceHookOptions {
  registryPath?: string;
  referenceProjectsRoot?: string;
  checkServers?: boolean;
  dsTokens: DsTokenLookup;
  log?: (line: string) => void;
}

/** What a candidate's colours would become, previewed on the DS section backgrounds of the surface (the final mapping uses the backdrop measured in the page). */
interface ColourPreview {
  mappable: boolean;
  gap: string | null;
  lines: string[];
  evidenceOnly: boolean;
}

const LADDER_GAP = 'a token ladder: its custom properties cannot be applied to a CSS property, so it is evidence for choosing a DS token, not a treatment to apply';

/**
 * One verification per catalogued pattern and declared surface, made once when the hooks are built (the projects are resolved once, not per pattern), so
 * `find` can show the judge what each colour maps to — or the gap — before a candidate is named. A DS source without resolved values previews nothing.
 */
async function previewColours(registry: ApprovedRegistry, root: string, ds: DsTokenLookup, log?: (line: string) => void): Promise<Map<string, ColourPreview>> {
  const out = new Map<string, ColourPreview>();
  if (!canMapColours(ds)) return out;
  for (const project of registry.projects.filter((p) => p.patterns.length > 0)) {
    try {
      const resolution = await resolveProject(registry, project.name, { root });
      if (resolution.status !== 'approved-available') continue;
      for (const pattern of project.patterns) {
        for (const surface of pattern.appliesTo.surfaces) {
          const v = await verifyPattern({
            registry, projectName: project.name, patternId: pattern.id, dsTokens: ds, root, projectResolution: resolution,
            query: { category: pattern.category, purpose: pattern.purpose, surface, viewport: 'any', elementKinds: pattern.appliesTo.elementKinds, properties: [] },
          });
          const colourCheck = v.checks.find((c) => c.id === 'colours-mapped');
          const ladder = pattern.source.kind === 'css-tokens';
          out.set(`${project.name}|${pattern.id}|${surface}`, {
            mappable: !ladder && colourCheck?.ok === true,
            gap: ladder ? LADDER_GAP : colourCheck?.ok === false ? colourCheck.detail : null,
            lines: v.colours.map(summariseMapping),
            evidenceOnly: ladder,
          });
        }
      }
    } catch (err) {
      log?.(`colour preview of "${project.name}" unavailable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  return out;
}

/** A category searched IN ADDITION to the need's own because of what the element is: an accordion has an `accordion` pattern whichever property is being changed. */
const KIND_CATEGORY: Partial<Record<SemanticKind, PatternCategory>> = { accordion: 'accordion', input: 'form-field', badge: 'badge' };

export async function buildReferenceHooks(opts: ReferenceHookOptions): Promise<ReferenceHooks | null> {
  let loaded: Awaited<ReturnType<typeof loadApprovedRegistry>>;
  try {
    loaded = await loadApprovedRegistry(opts.registryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    // no registry file: this run simply has no references. A registry that EXISTS but is invalid (a raw tag as an element kind, a bad schema, unreadable) is
    // a broken allowlist: failing loudly beats silently switching every reference off for the run.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      opts.log?.(`approved-reference registry unavailable: ${message} — no reference pattern can be used for this run`);
      return null;
    }
    throw new TerminalError(`approved-reference registry cannot be used: ${message} — fix or remove it; no reference pattern can be used while it is invalid`);
  }
  const { registry, sha256 } = loaded;
  const root = opts.referenceProjectsRoot ?? registry.referenceProjectsRoot;
  const previews = await previewColours(registry, root, opts.dsTokens, opts.log);
  return {
    registry: { version: registry.version, sha256, approvedProjects: registry.projects.map((p) => p.name) },
    find(query: PatternQuery) {
      // the shorthand a pattern declares (e.g. `border`) is not the longhand a need names (`border-top-color`): coverage is resolved at verification
      const byKind = query.elementKinds.flatMap((raw) => { const kind = canonicalKind(raw); const category = kind === null ? undefined : KIND_CATEGORY[kind]; return category ? [category] : []; });
      const categories = [...new Set<PatternCategory>([query.category, 'card-separation', 'subtle-border', ...byKind])];
      const seen = new Set<string>();
      const out: ReturnType<ReferenceHooks['find']> = [];
      for (const category of categories) {
        for (const c of findPatterns(registry, { ...query, category, properties: [] })) {
          // what is offered is what can be verified: a pattern sharing no meaningful word with the need is refused by `verify` on `purpose-matches`, so it would only
          // take one of the judge's few slots (the Resolver keeps six) and its one attempt
          if (sharedPurposeTerms(c.pattern, query.purpose).length === 0) continue;
          const key = `${c.project}|${c.pattern.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const preview = previews.get(`${c.project}|${c.pattern.id}|${query.surface}`);
          out.push({
            project: c.project, pattern: c.pattern.id, purpose: c.pattern.purpose, declarations: c.pattern.declarations, preferred: c.preferred, elementKinds: c.pattern.appliesTo.elementKinds,
            ...(preview ? { mappable: preview.mappable, gap: preview.gap, colourPreview: preview.lines, evidenceOnly: preview.evidenceOnly } : {}),
          });
        }
      }
      return out;
    },
    async verify({ project, pattern, query }) {
      const entry = registry.projects.find((p) => p.name === project)?.patterns.find((p) => p.id === pattern);
      // the need names a longhand (`border-top-color`) the pattern declares as a shorthand, so coverage is not asked of `properties`; the colour check still knows the need
      const needed = query.colour?.property ?? query.properties[0];
      const colour = { ...query.colour, ...(needed !== undefined ? { property: needed } : {}) };
      const v = await verifyPattern({ registry, projectName: project, patternId: pattern, query: { ...query, category: entry?.category ?? query.category, properties: [], colour }, dsTokens: opts.dsTokens, root, checkServer: opts.checkServers ?? false });
      return { ok: v.ok, applied: v.applied, classification: v.classification, provenance: toReferenceProvenance(v), reasons: v.reasons };
    },
  };
}
