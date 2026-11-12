import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { normalizeColor } from '../t-layer/computed-style.ts';

/**
 * APPROVED PROJECT AURA REFERENCE PATTERNS — supporting evidence for a role the Design System does not clearly
 * define. The matching order is locked (Decision Log #46):
 *
 *   exact DS component/pattern → closest valid DS family/variant → approved Project Aura reference pattern
 *   → NEEDS_REVIEW → only a genuine no-family / no-pattern case goes to B6
 *
 * So the Design System is ALWAYS searched first (B3's family search); this catalog is consulted only when that
 * search could not represent the element (`attachReference`, b3-ds-matcher/reference.ts), and what it returns is
 * a verdict, never a decision:
 *  - `consistent`    the SAME pattern on at least two approved pages, every property they define agreeing — a
 *                    REFERENCE-BACKED pattern: not a DS component, not a violation of one, surfaced for DS governance.
 *  - `single-source` only one approved page shows it — not enough to call it a pattern: NEEDS_REVIEW.
 *  - `divergent`     the approved pages disagree about it (their own values are listed): NEEDS_REVIEW.
 *  - `none`          no evidence at all for the role (the lookup returns null) — nothing changes.
 * Reference pages are "approved internal reference evidence": how the same semantic role is actually used
 * (font-size, weight, line-height, letter-spacing, text-transform, colour, spacing). They never replace the DS,
 * and a pattern is never forced into SectionHeading or any other unrelated component to fill the gap.
 *
 * The evidence is DATA (`reference/approved-reference-patterns.json`, measured from the approved pages'
 * sources) and is read here with no model, no browser and no network. Its content hash (`version`) travels with
 * every assessment, and the file itself is fingerprinted by the engine-revision guard
 * (test/unit/engine-revision.test.ts) — so changing one observed value cannot ship without a conscious
 * `AUDIT_ENGINE_REVISION` bump, and THAT is what invalidates reuse of findings an older catalog produced.
 */

const ObservationSchema = z.object({
  page: z.string().min(1),
  /** Where the value was measured — a source file and line, or a rendered selector. */
  source: z.string().min(1),
  /** Property → value, as the page's own source resolves it (`font-size: "12.8px"`, `text-transform: "uppercase"`, `color: "#b01f24"`). */
  properties: z.record(z.string(), z.string()),
});
const PatternSchema = z.object({
  /** The semantic ROLE (`eyebrow`, `description`, `stat`, …) — B2's role names, never a component name. */
  role: z.string().min(1),
  surface: z.enum(['light', 'dark', 'any']),
  note: z.string().optional(),
  observations: z.array(ObservationSchema),
});
export const ReferenceCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  evidence: z.string(),
  measuredOn: z.string(),
  pages: z.array(z.object({ id: z.string(), name: z.string(), folder: z.string(), note: z.string().optional() })),
  patterns: z.array(PatternSchema),
});
export type ReferenceCatalogFile = z.infer<typeof ReferenceCatalogSchema>;

export interface ReferenceCatalog extends ReferenceCatalogFile {
  /** A content hash of the evidence: part of the audit policy version, so a changed catalog is a changed comparison. */
  version: string;
}

export type ReferenceVerdict = 'consistent' | 'single-source' | 'divergent';

export interface ReferenceAssessment {
  role: string;
  surface: string;
  verdict: ReferenceVerdict;
  /** The approved pages that show the role, by name. */
  pages: string[];
  /** Property → the value every page that defines it agrees on. */
  agreed: Record<string, string>;
  /** Property → what each page says, for every property the pages DISAGREE on. */
  differing: Array<{ property: string; values: Array<{ page: string; value: string }> }>;
  /** The measured sources, for the finding to cite. */
  sources: string[];
  catalogVersion: string;
  /** One line a reviewer reads. */
  note: string;
}

/** The properties a role is compared on. Others in an observation are kept as evidence and never decide the verdict. */
const GOVERNED = ['font-size', 'font-weight', 'letter-spacing', 'text-transform', 'color', 'font-family', 'line-height'] as const;

const PX_TOLERANCE: Record<string, number> = { 'font-size': 0.5, 'letter-spacing': 0.35 };

const px = (value: string): number | null => {
  const m = /^(-?\d*\.?\d+)px$/.exec(value.trim());
  return m ? Number(m[1]) : null;
};

/** Do two values of one property say the same thing? Lengths within a sub-pixel tolerance, colours as the same painted colour, the rest exactly. */
function sameValue(property: string, a: string, b: string): boolean {
  if (property === 'color') {
    const ca = normalizeColor(a);
    const cb = normalizeColor(b);
    return ca !== null && cb !== null ? ca === cb : a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  const pa = px(a);
  const pb = px(b);
  if (pa !== null && pb !== null) return Math.abs(pa - pb) <= (PX_TOLERANCE[property] ?? 0.01);
  if (property === 'font-family') return a.split(',')[0]!.replace(/['"]/g, '').trim().toLowerCase() === b.split(',')[0]!.replace(/['"]/g, '').trim().toLowerCase();
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * What the approved pages say about a role on a surface — or null when the catalog holds nothing for it (then the
 * element is exactly as undecided as it was). `surface` is the element's measured surface: `unknown` is read as
 * light (the neutral default the locked supporting-heading colour rule uses).
 */
export function assessReference(catalog: ReferenceCatalog | undefined, role: string, surface: 'light' | 'dark' | 'unknown'): ReferenceAssessment | null {
  if (!catalog) return null;
  const want = surface === 'dark' ? 'dark' : 'light';
  const observations = catalog.patterns.filter((p) => p.role === role && (p.surface === want || p.surface === 'any')).flatMap((p) => p.observations);
  if (observations.length === 0) return null;
  const pages = [...new Set(observations.map((o) => o.page))];
  const names = pages.map((id) => catalog.pages.find((p) => p.id === id)?.name ?? id);
  const sources = observations.map((o) => o.source);
  const agreed: Record<string, string> = {};
  const differing: ReferenceAssessment['differing'] = [];
  for (const property of GOVERNED) {
    const defined = observations.filter((o) => o.properties[property] !== undefined && o.properties[property] !== '');
    const byPage = [...new Map(defined.map((o) => [o.page, o.properties[property] as string])).entries()];
    if (byPage.length < 2) continue; // one page's word is not agreement or disagreement
    const [first] = byPage;
    if (byPage.every(([, v]) => sameValue(property, (first as [string, string])[1], v))) agreed[property] = (first as [string, string])[1];
    else differing.push({ property, values: byPage.map(([id, value]) => ({ page: catalog.pages.find((p) => p.id === id)?.name ?? id, value })) });
  }
  const verdict: ReferenceVerdict = pages.length < 2 ? 'single-source' : differing.length === 0 && Object.keys(agreed).length >= 3 ? 'consistent' : 'divergent';
  const note =
    verdict === 'consistent'
      ? `the approved pages (${names.join(', ')}) use this ${role} consistently — ${Object.entries(agreed).map(([k, v]) => `${k} ${v}`).join(', ')} — a reference-backed pattern the Design System does not define`
      : verdict === 'single-source'
        ? `only ${names[0]} shows this ${role} among the approved pages — one page is not a pattern`
        : `the approved pages (${names.join(', ')}) do not agree on this ${role}: ${differing.map((d) => `${d.property} ${d.values.map((v) => `${v.value} (${v.page})`).join(' vs ')}`).join('; ') || 'too few shared properties to call it one pattern'}`;
  return { role, surface: want, verdict, pages: names, agreed, differing, sources, catalogVersion: catalog.version, note };
}

/** Where the catalog lives unless the config says otherwise. */
export const DEFAULT_REFERENCE_CATALOG_PATH = 'reference/approved-reference-patterns.json';

/**
 * Reads the approved reference catalog. A missing file is not an error — there is simply no reference evidence,
 * and every role behaves exactly as it did before (DS, then B6/review). A catalog that EXISTS but is malformed is
 * an error: evidence that cannot be trusted must not be silently ignored.
 */
export function loadReferenceCatalog(path: string | undefined = undefined, root: string = process.cwd()): ReferenceCatalog | undefined {
  const file = resolve(root, path ?? DEFAULT_REFERENCE_CATALOG_PATH);
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, 'utf-8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`audit-agent: the approved reference catalog at ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = ReferenceCatalogSchema.safeParse(json);
  if (!parsed.success) throw new Error(`audit-agent: invalid approved reference catalog at ${file}:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return { ...parsed.data, version: createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex').slice(0, 12) };
}

/** A catalog built in memory (tests, a caller with its own evidence). */
export function referenceCatalogOf(file: ReferenceCatalogFile): ReferenceCatalog {
  return { ...ReferenceCatalogSchema.parse(file), version: createHash('sha256').update(JSON.stringify(file)).digest('hex').slice(0, 12) };
}
