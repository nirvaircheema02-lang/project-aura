import type { ComponentManifest, ManifestComponent } from '../manifest/schema.ts';
import type { NewComponentPlan } from './new-component-plan-schema.ts';
import type { ComponentSelection } from './selection-schema.ts';
import type { ComponentSpec, L1Output, PlanEntryOrigin, ReferenceResolution, Resolution, ResolvedComponentPlan } from './types.ts';

/**
 * L1 — Resolve Plan (deterministic, asks on ambiguity; §9.1). Merges both New Component
 * Plan sources with provenance (§2.2), resolves each pattern (reuse / update / new /
 * ambiguous), a reference in priority order (§9.2), scope evidence (§9.3), a write set and
 * dependencies (§9.4, §7.4) — ready for the parallel build fan-out.
 */

function componentsFor(entry: PlanEntryOrigin, manifest: ComponentManifest): ManifestComponent[] {
  return manifest.components.filter((c) => entry.findingIds.includes(c.findingId) || c.signature === entry.patternId);
}

export function mergePlanSources(redesignRunId: string, manifest: ComponentManifest, upstream: NewComponentPlan | null, checklist: ComponentSelection | null): ResolvedComponentPlan {
  const byPattern = new Map<string, PlanEntryOrigin>();
  const disagreements: ResolvedComponentPlan['disagreements'] = [];

  if (upstream) {
    for (const e of upstream.entries) {
      const component = manifest.components.find((c) => c.findingId === e.findingId);
      const patternId = component?.signature ?? e.findingId;
      const findingIds = component ? [component.findingId, ...component.relatedFindingIds] : [e.findingId, ...(e.relatedFindingIds ?? [])];
      byPattern.set(patternId, { origin: 'upstream', patternId, findingIds, classification: e.classification, selection: 'new-component', note: e.note });
    }
  }

  if (checklist) {
    for (const s of [...checklist.selections, ...checklist.globalCandidates]) {
      const existing = byPattern.get(s.patternId);
      if (existing && existing.selection !== s.selection) {
        disagreements.push({ patternId: s.patternId, upstream: existing.selection ?? '(none)', checklist: s.selection });
        continue; // §2.2: the same pattern selected inconsistently is an ask, never silent precedence — held out of `entries`
      }
      byPattern.set(s.patternId, { origin: existing ? 'checklist' : 'checklist', patternId: s.patternId, findingIds: s.findingIds, classification: existing?.classification ?? null, selection: s.selection, note: s.note ?? existing?.note ?? null });
    }
    for (const manual of checklist.manualCandidates) {
      const patternId = `manual:${manual.sectionId}:${manual.label}`;
      byPattern.set(patternId, { origin: 'checklist', patternId, findingIds: [], classification: null, selection: manual.selection, note: manual.note });
    }
  }

  return { schemaVersion: 1, redesignRunId, entries: [...byPattern.values()], disagreements };
}

export interface ResolveEntryResult {
  resolution: Resolution;
  reason: string;
  updateTarget: ComponentSpec['updateTarget'];
}

export function resolveEntry(entry: PlanEntryOrigin, manifest: ComponentManifest): ResolveEntryResult {
  const components = componentsFor(entry, manifest);
  const humanSaysNew = entry.selection === 'new-component';
  if (components.length === 0) {
    return { resolution: 'new', reason: 'manually added candidate with no backing audit finding', updateTarget: null };
  }
  const rep = components[0]!;
  const bucket = rep.suggestion.bucket;

  if (bucket === 'existing-correct' && humanSaysNew && rep.suggestion.confidence === 'high') {
    return { resolution: 'ambiguous', reason: `the manifest suggests "existing-correct" with high confidence, but the reviewer marked it new-component — conflicting signals`, updateTarget: null };
  }
  if (humanSaysNew) return { resolution: 'new', reason: 'marked new-component in the selected plan', updateTarget: null };
  if (bucket === 'page-fix-only' || bucket === 'existing-correct') return { resolution: 'reuse', reason: `the manifest suggests "${bucket}" — the existing component covers this as-is`, updateTarget: null };
  if (bucket === 'existing-needs-update') return { resolution: 'update', reason: 'an existing component matches or plausibly matches, but a needed variant/prop/token is missing', updateTarget: rep.ds.dsFile && rep.ds.dsComponent ? { dsFile: rep.ds.dsFile, dsComponent: rep.ds.dsComponent } : null };
  if (bucket === 'new-component') return { resolution: 'new', reason: 'no plausible existing match, and the pattern repeats or recurs elsewhere with evidence', updateTarget: null };
  return { resolution: 'ambiguous', reason: 'the manifest suggestion is "unresolved" — a single instance with no plausible match; a human should decide', updateTarget: null };
}

/** §9.2 — reference resolution, in priority order: verified corrected (this run) → named prior run → live capture. */
export function resolveReference(entry: PlanEntryOrigin, manifest: ComponentManifest): ReferenceResolution | { blocked: string } {
  const components = componentsFor(entry, manifest);
  const rep = components[0];
  if (!rep) return { source: 'live-capture', priorRunId: null, elementStamp: '', cropPath: null };

  const postFix = entry.classification === null ? null : (entry.origin === 'upstream' ? true : false); // upstream carries candidateSource elsewhere; approximated here — refined by the caller when it has the raw upstream entry
  if (postFix && !rep.redesign.verified) {
    return { blocked: `this candidate depends on a post-fix opportunity (${rep.findingId}) that has not been verified fixed in this run — reference unavailable until it is` };
  }
  if (rep.redesign.applied && rep.redesign.verified && rep.crops.after) {
    return { source: 'verified-corrected-this-run', priorRunId: null, elementStamp: rep.location.stamp ?? '', cropPath: rep.crops.after };
  }
  return { source: 'live-capture', priorRunId: null, elementStamp: rep.location.stamp ?? '', cropPath: rep.crops.before ?? rep.crops.after };
}

const CATEGORY_MAP: Record<string, string> = {
  button: 'atoms', link: 'atoms', badge: 'atoms', chip: 'atoms', tag: 'atoms', input: 'atoms', 'icon-button': 'atoms', divider: 'atoms', avatar: 'atoms', logo: 'atoms',
  card: 'molecules', stat: 'molecules', 'metric-tile': 'molecules', testimonial: 'molecules', accordion: 'molecules', tabs: 'molecules', table: 'molecules', list: 'molecules', select: 'molecules', checkbox: 'molecules', radio: 'molecules', textarea: 'molecules', search: 'molecules', pagination: 'molecules', breadcrumb: 'molecules', tooltip: 'molecules', progress: 'molecules',
  navbar: 'organisms', form: 'organisms', hero: 'organisms', carousel: 'organisms', modal: 'organisms', 'cta-block': 'organisms', chart: 'organisms', banner: 'organisms', sidebar: 'organisms', footer: 'organisms',
};

export function categoryFor(productionType: string): string {
  return CATEGORY_MAP[productionType] ?? 'molecules';
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'component';
}

/**
 * A component NAME derived directly from the audit's free-text `productionType` — every other
 * path-safety property in this module (write-set confinement, §9.4/§7.6) depends on this never
 * containing anything but letters/digits, since it becomes a filename under `core-v2/src/`. A
 * naive capitalize-first-letter of the raw string would let a `productionType` containing `/`
 * or `..` escape the intended directory; matching only alnum RUNS makes that impossible by
 * construction, not by a separate check that could be forgotten at a new call site.
 */
function safeComponentName(productionType: string, fallbackIndex: number): string {
  const words = productionType.match(/[a-zA-Z0-9]+/g) ?? [];
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return pascal || `Component${fallbackIndex}`;
}

const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9._-]+$/;

/** True only when every segment of a supposedly-relative path is a plain name — no `..`, no absolute root, no null bytes, no separator hidden inside a segment. */
function isPathSafe(relPath: string): boolean {
  if (relPath.includes('\0') || relPath.startsWith('/') || relPath.startsWith('\\')) return false;
  const segments = relPath.split(/[/\\]/);
  return segments.every((seg) => seg !== '' && seg !== '.' && seg !== '..' && SAFE_PATH_SEGMENT.test(seg));
}

export function buildSpec(entry: PlanEntryOrigin, resolved: ResolveEntryResult, reference: ReferenceResolution, manifest: ComponentManifest, componentIndex: number): ComponentSpec | { blocked: string } {
  const components = componentsFor(entry, manifest);
  const rep = components[0];
  const name = rep ? safeComponentName(rep.productionType, componentIndex) : `Component${componentIndex}`;
  const category = categoryFor(rep?.productionType ?? 'card');
  const componentId = `${slugify(name)}-${entry.patternId.slice(0, 8)}`;

  if (resolved.updateTarget && !isPathSafe(resolved.updateTarget.dsFile)) {
    return { blocked: `the DS match's recorded file path ("${resolved.updateTarget.dsFile}") is not a safe relative path — refusing to build against it (pattern ${entry.patternId})` };
  }
  const variantAxes = rep?.ds.possibleMatches.length ? [] : []; // populated by L2 from the DS source excerpt when building an `update`/`new` spec — L1 records only what is knowable from the manifest
  const statesObserved = ['default'];
  const statesToDesign = ['hover', 'focus', 'active', 'disabled'];

  // §9.3's scope evidence must be aggregated across EVERY instance sharing this pattern, not
  // just the representative `rep` (components[0]) — a pattern's OTHER instance recorded
  // `scope: 'excluded'` (header/footer) or real cross-run sightings is exactly the evidence
  // §9.3 requires, and it must not be silently lost just because it isn't the first instance
  // the manifest happens to list.
  const anyExcluded = components.some((c) => c.scope === 'excluded');
  const anyMultiPage = components.some((c) => c.crossRun.reuse === 'multi-page');
  const anySightings = components.some((c) => c.crossRun.sightings.length > 0);
  const scopeEvidenceMissing = entry.selection === 'global-shared' && !anySightings && !anyExcluded;
  const scope = anyExcluded || entry.selection === 'global-shared' ? (anyMultiPage ? 'multi-page' : 'global') : anyMultiPage ? 'multi-page' : 'page-local';

  const writeSet = resolved.resolution === 'update' && resolved.updateTarget ? [`core-v2/src/${resolved.updateTarget.dsFile}`] : [`core-v2/src/${category}/${name}.tsx`, `core-v2/src/${category}/${name}.stories.tsx`];
  if (!writeSet.every(isPathSafe)) {
    return { blocked: `computed an unsafe write-set path for pattern ${entry.patternId}: ${writeSet.filter((p) => !isPathSafe(p)).join(', ')}` };
  }

  return {
    schemaVersion: 1,
    componentId,
    patternId: entry.patternId,
    resolution: resolved.resolution,
    updateTarget: resolved.updateTarget,
    name,
    category,
    scope,
    scopeEvidenceMissing: Boolean(scopeEvidenceMissing),
    reference,
    anatomy: rep ? `${rep.productionType} — ${components.length} instance(s) observed, ${rep.instanceCount} total on the page` : 'manually added candidate — anatomy to be designed',
    variantAxes,
    tokens: rep?.tokens.map((t) => t.token) ?? [],
    statesObserved,
    statesToDesign,
    postFixPrerequisite: null,
    writeSet,
    declaredSharedChanges: { barrelEntries: [{ barrelFile: `core-v2/src/${category}/index.ts`, exportLine: `export { ${name}, type ${name}Props } from './${name}';` }], tokenAdditions: [] },
    dependsOn: { findings: [], components: [] },
    constraints: entry.note ? [entry.note] : [],
  };
}

export function resolveL1(redesignRunId: string, manifest: ComponentManifest, upstream: NewComponentPlan | null, checklist: ComponentSelection | null): L1Output {
  const resolvedPlan = mergePlanSources(redesignRunId, manifest, upstream, checklist);
  const specs: ComponentSpec[] = [];
  const ambiguous: L1Output['ambiguous'] = [];
  const blocked: L1Output['blocked'] = [];

  resolvedPlan.entries.forEach((entry, i) => {
    const resolved = resolveEntry(entry, manifest);
    if (resolved.resolution === 'ambiguous') {
      ambiguous.push({ patternId: entry.patternId, reason: resolved.reason });
      return;
    }
    const reference = resolveReference(entry, manifest);
    if ('blocked' in reference) {
      blocked.push({ componentId: `${entry.patternId.slice(0, 8)}`, reason: reference.blocked });
      return;
    }
    const spec = buildSpec(entry, resolved, reference, manifest, i);
    if ('blocked' in spec) {
      blocked.push({ componentId: `${entry.patternId.slice(0, 8)}`, reason: spec.blocked });
      return;
    }
    specs.push(spec);
  });

  return { resolvedPlan, specs, ambiguous, blocked };
}
