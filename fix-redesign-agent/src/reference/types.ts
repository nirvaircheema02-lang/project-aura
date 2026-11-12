import { z } from 'zod';
import type { ColourMapping, StateName } from '../resolution/schema.ts';
import { canonicalKind } from './element-kind.ts';

/**
 * Approved reference projects — a READ-ONLY allowlist owned by this agent.
 *
 * When the Design System has no suitable implementation for something an authorized change needs
 * (resolution order step 3), the Resolver may consult ONLY the projects named here. A project is
 * identified by its exact name and its exact source folder; a similarly named folder, a copy elsewhere
 * in the workspace, or a draft/experiment is NOT approved and is rejected. Localhost URLs are inspection
 * conveniences, not identities: what is recorded as provenance is the source path plus file/project
 * hashes. Nothing here reads the DS as authoritative about the projects, and nothing writes to them.
 *
 * Project approval does not make every hardcoded value in a project official DS guidance. A pattern is
 * reusable only after `verifyPattern` has checked purpose, surface/states, DS grounding, token existence
 * and viewport; the result is recorded as an "approved project pattern" or a "proposed local variant",
 * never as an official DS component.
 */

export const PATTERN_CATEGORIES = ['card-separation', 'subtle-border', 'accordion', 'tabs', 'form-field', 'table', 'badge', 'navigation', 'other'] as const;
export const PatternCategorySchema = z.enum(PATTERN_CATEGORIES);
export type PatternCategory = z.infer<typeof PatternCategorySchema>;

/**
 * A pattern fits component CATEGORIES (card, panel, accordion, …), never a tag or an ARIA role: `div` fits nothing and would silently never match,
 * so the registry fails loudly instead. Aliases (`Cards`, `faq-row`) are canonicalised.
 */
const PatternElementKindSchema = z.string().transform((raw, ctx) => {
  const kind = canonicalKind(raw);
  if (kind === null) {
    ctx.addIssue({ code: 'custom', message: `"${raw}" is not a component category (a tag or ARIA role is evidence, not a kind): use one of card, panel, callout, section, row, strip, accordion, input, …` });
    return z.NEVER;
  }
  return kind;
});

export const ApprovedPatternSchema = z.object({
  /** Unique within its project. */
  id: z.string(),
  category: PatternCategorySchema,
  /** What the treatment is for, e.g. "light separation between a section and its cards without a heavy outline". */
  purpose: z.string(),
  description: z.string(),
  source: z.object({
    /** Relative to the project's source folder. */
    file: z.string(),
    kind: z.enum(['css-rule', 'css-tokens', 'tsx-classes', 'html-style']),
    /** A CSS selector, or a component/class name, that locates the pattern inside `file`. */
    locator: z.string(),
  }),
  /** CSS property → value as DECLARED in the source (may contain var(--token)). Verified against the file at use time. */
  declarations: z.record(z.string(), z.string()),
  appliesTo: z.object({
    surfaces: z.array(z.enum(['light', 'dark'])),
    viewports: z.array(z.enum(['any', 'desktop', 'mobile'])),
    /** Component categories this pattern fits, e.g. 'card', 'section', 'panel', 'input' (see `element-kind.ts`). */
    elementKinds: z.array(PatternElementKindSchema),
  }),
  whenNotToUse: z.string(),
});
export type ApprovedPattern = z.infer<typeof ApprovedPatternSchema>;

export const ApprovedProjectSchema = z.object({
  /** The exact project name. Matching is exact and case-sensitive; no fuzzy or prefix match, ever. */
  name: z.string(),
  /** Relative to `referenceProjectsRoot`. The folder's own basename must equal `name`. */
  relativeDir: z.string(),
  kind: z.enum(['react-vite', 'next', 'static-html', 'docs-and-specs', 'legacy-readonly']),
  /** An inspection convenience only (never an identity). */
  inspectionUrl: z.string().nullable(),
  role: z.string(),
  /** Categories this project is the PREFERRED reference for (consulted first). */
  preferredFor: z.array(PatternCategorySchema),
  notes: z.array(z.string()),
  patterns: z.array(ApprovedPatternSchema),
});
export type ApprovedProject = z.infer<typeof ApprovedProjectSchema>;

export const ApprovedRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string(),
  approvedBy: z.string(),
  approvedOn: z.string(),
  /** Absolute folder that `relativeDir`s are resolved against (the workspace's `projects` folder). Overridable by config/tests. */
  referenceProjectsRoot: z.string(),
  projects: z.array(ApprovedProjectSchema),
});
export type ApprovedRegistry = z.infer<typeof ApprovedRegistrySchema>;

// ── runtime results ─────────────────────────────────────────────────────────────────────────

export type ServerStatus = 'reachable' | 'unreachable' | 'not-checked';

export interface ProjectResolution {
  name: string;
  status: 'approved-available' | 'approved-source-missing' | 'rejected';
  /** Why — always a sentence a reviewer can act on. */
  reason: string;
  /** Absolute realpath of the project's source folder; null unless `approved-available`. */
  sourcePath: string | null;
  /** sha256 over (relative path + file sha256) of the project's source files; null unless available. */
  projectHash: string | null;
  fileCount: number;
  kind: ApprovedProject['kind'] | null;
  inspectionUrl: string | null;
  serverStatus: ServerStatus;
}

/** A DS token definition found in the configured Design System (see resolution/ds-evidence.ts). */
export interface DsTokenDef {
  token: string;
  value: string;
  /** Selector scope the definition lives under, e.g. `[data-variant="cinematic-dark"]`; null = unscoped (base / :root). */
  scope: string | null;
  /** DS file the definition was read from, relative to the DS root. */
  file: string;
}

/** The only thing the reference module needs from the DS: does a token exist, and where. Injected, so the module has no hidden DS dependency. */
export interface DsTokenLookup {
  lookup(token: string): DsTokenDef[];
}

/**
 * What colour mapping needs from the DS beyond "does a token exist": every token's resolved value in a scope. `DsTokenIndex` (resolution/ds-evidence.ts)
 * satisfies it; a lookup-only double does not, and a pattern whose colours cannot be mapped then fails closed instead of passing silently.
 */
export interface DsColourSource extends DsTokenLookup {
  all(): DsTokenDef[];
  resolve(token: string, scope: string | null): { value: string | null; chain: string[]; scope: string | null; file: string | null };
}

/** How a need's colours are judged: in which state, over which backdrop, and which property the change is for. */
export interface PatternColourQuery {
  /** The state the target is for. A non-default state is mapped only when the reference declares that state (`:hover`, `:focus-visible`) in the same file. Default: 'default'. */
  state?: StateName;
  /** The opaque backdrops (CSS colours) the colour is drawn over, as measured in the page. Absent: the DS section backgrounds of the surface's scope. */
  backdrops?: string[];
  backdropSource?: 'measured' | 'ds-section-tokens';
  /** The text colour that sits on a fill being mapped, when known. */
  textColour?: string | null;
  /**
   * The CSS property the authorized change is for. Only declarations that can supply it must map; a declaration that cannot is DROPPED from `applied` when its
   * colour has no DS mapping (never applied raw) instead of failing the pattern. Absent: every declaration is required.
   */
  property?: string;
}

export interface PatternQuery {
  category: PatternCategory;
  /** Free text of the purpose the authorized change needs; matched against the pattern's `purpose`/`description` tokens. */
  purpose: string;
  surface: 'light' | 'dark';
  viewport: 'any' | 'desktop' | 'mobile';
  /**
   * The component categories the element was classified as (see `element-kind.ts`), strongest first. NOT a tag or a role: a raw `div` is dropped.
   * Empty means nothing could be established, which fits no pattern.
   */
  elementKinds: string[];
  /** How the kinds were reached, for messages and provenance only — never used to decide compatibility. */
  elementEvidence?: { tag: string | null; role: string | null; productionType: string | null; summary: string };
  /** The CSS properties the authorized change needs; a pattern must declare ALL of them to apply. */
  properties: string[];
  colour?: PatternColourQuery;
}

export interface PatternCheck {
  id: 'project-approved' | 'source-available' | 'declarations-present' | 'purpose-matches' | 'surface-compatible' | 'viewport-applicable' | 'element-kind-compatible' | 'ds-grounded' | 'tokens-exist' | 'colours-mapped';
  ok: boolean;
  detail: string;
}

export interface PatternVerification {
  ok: boolean;
  checks: PatternCheck[];
  project: ProjectResolution;
  pattern: ApprovedPattern | null;
  /** The declarations as they currently stand in the source file (not as the registry remembers them). */
  declarationsFound: Record<string, string>;
  fileSha256: string | null;
  tokens: Array<{ token: string; existsInDs: boolean; dsScope: string | null }>;
  /** The element kinds that fit: which of the query's kinds the pattern lists, which kinds the query had, and how they were reached. */
  elementKinds: { matched: string[]; inferred: string[]; evidence: string };
  /** `approved-project-pattern`: used as found (every colour an EXACT DS equivalent) and fully DS-grounded. `proposed-local-variant`: a colour was mapped to the nearest token, or a length is hardcoded. Null when `ok` is false. */
  classification: 'approved-project-pattern' | 'proposed-local-variant' | null;
  /** The declarations to apply: every colour is a DS `var(--token)` (or a keyword) chosen by the colour mapper; lengths that exist only in the reference are flagged in `hardcoded`. */
  applied: Record<string, string>;
  /** Every reference colour that was read, with the DS token it was mapped to (exact or nearest) or the gap that refused it. */
  colours: ColourMapping[];
  /** Properties (and project tokens) that `@media`/`@supports`/`@container` blocks also set, and whether the block was read for this need: the value used is the base rule's unless the block applies to the need's surface and viewport. */
  conditioned: string[];
  hardcoded: string[];
  reasons: string[];
}
