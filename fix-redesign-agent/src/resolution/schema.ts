import { z } from 'zod';
import { SEMANTIC_KINDS } from '../reference/element-kind.ts';
import { fingerprintOf } from '../session/fingerprint.ts';

/**
 * The RESOLVED-TARGETS contract — `context/resolved-targets.json`.
 *
 * The audit's `data.json` stays immutable. Where the audit left a property unresolved
 * (`expected: null`, status UNRESOLVED), where a finding is NEEDS_REVIEW / UNVERIFIED, or where the
 * DS has no suitable implementation, the Resolver stage (RV) records what it DECIDED here — a derived
 * design target, never a fabricated audit measurement. The same file is then read by every stage
 * that acts on a finding:
 *
 *   RV  writes it            R3  plans edits only for authorized targets
 *   R4  refuses an edit that no target authorizes
 *   R5  measures every resolved target on the live page
 *   R8  measures every resolved target in the rendered preview and the fidelity verifier derives
 *       its exemptions from it (an intentional change is exempt per finding + property + state only)
 *
 * A free-text recommendation, or a file nothing reads, is not a target. A record is only meaningful
 * when a stage consumes it, and each stage writes back its own status (design / implementation /
 * verification) so a finding is never reported fixed while a required target is still open.
 */

export const RESOLUTION_SCHEMA_VERSION = 1 as const;

/** Why an expected value was missing or uncertain — the audit's note, understood, not guessed. */
export const UNRESOLVED_REASONS = [
  'audit-expected-present', // not unresolved: the audit supplied an expected value
  'inherited-context', // the value is inherited/cascaded from an ancestor; the DS states no requirement at this element
  'variant-or-theme-context', // the token/value only exists under a DS variant or theme scope (e.g. cinematic-dark)
  'state-context', // depends on an interaction state the audit did not capture
  'responsive-context', // depends on a viewport / breakpoint the audit did not capture
  'layout-measurement-required', // the comparison needs rendered layout measurements (keyword values: normal / auto)
  'uncertain-component-identity', // it is not clear which DS component/part this element is
  'no-ds-requirement', // the DS states no requirement for this property/part
  'missing-ds-treatment', // the DS has no suitable treatment for this purpose
  'capture-capability-gap', // evidence or tooling cannot settle it
  'policy-conflict', // the audit target conflicts with a persistent project rule (e.g. black primary CTA)
] as const;
export const UnresolvedReasonSchema = z.enum(UNRESOLVED_REASONS);
export type UnresolvedReason = z.infer<typeof UnresolvedReasonSchema>;

export const TARGET_OUTCOMES = ['resolved-target', 'preserve-existing', 'unresolved'] as const;
export const TargetOutcomeSchema = z.enum(TARGET_OUTCOMES);
export type TargetOutcome = z.infer<typeof TargetOutcomeSchema>;

export const STATES = ['default', 'hover', 'focus', 'focus-visible', 'active', 'disabled', 'selected', 'expanded', 'error'] as const;
export const StateSchema = z.enum(STATES);
export type StateName = z.infer<typeof StateSchema>;

export const THEMES = ['inherit', 'light', 'dark'] as const;
export const ThemeSchema = z.enum(THEMES);
export type ThemeName = z.infer<typeof ThemeSchema>;

export const VIEWPORT_NAMES = ['any', 'desktop', 'mobile'] as const;
export const ViewportSchema = z.object({ name: z.enum(VIEWPORT_NAMES), width: z.number().nullable() });
export type ViewportRef = z.infer<typeof ViewportSchema>;

/** How a measured value is compared with a target. `rendered-length-px` compares the USED (laid-out) value, for keyword inputs like `normal`/`auto`. */
export const COMPARISONS = ['exact', 'color-deltaE', 'length-px', 'rendered-length-px'] as const;
export const ComparisonSchema = z.enum(COMPARISONS);
export type ComparisonMethod = z.infer<typeof ComparisonSchema>;

export const PROVENANCE_KINDS = [
  'audit-expected', // the audit's own measured expectation
  'ds-token', // a DS token, resolved in the right variant/theme scope
  'ds-component', // a DS component/variant's own source
  'ds-rule', // a documented DS rule
  'approved-project-pattern', // adapted from an approved reference project (NOT an official DS component)
  'proposed-local-variant', // composed locally from valid DS tokens (a proposal, not a DS component)
  'original-baseline', // keep what the original page does
  'rendered-measurement', // resolved from a measurement of the rendered page
  'recorded-decision', // a decision recorded by the user/session in design-decisions.json
] as const;
export const ProvenanceKindSchema = z.enum(PROVENANCE_KINDS);
export type ProvenanceKind = z.infer<typeof ProvenanceKindSchema>;

export const COLOUR_ROLES = ['border', 'fill', 'text', 'icon', 'shadow', 'unknown'] as const;
export type ColourRoleName = (typeof COLOUR_ROLES)[number];
export const COLOUR_TIERS = ['semantic', 'role', 'primitive', 'component'] as const;

const RenderedColourSchema = z.object({
  /** `not-run`: nothing measured it yet. `unverified`: it was measured but the backdrop could not be (gradient, image, translucent ancestor). Never a pass. */
  status: z.enum(['not-run', 'passed', 'failed', 'unverified']),
  measuredBy: z.enum(['R5', 'R8']).nullable(),
  /** The composited colour the element is actually drawn over, as measured in the rendered page. */
  backdrop: z.string().nullable(),
  /** ΔE2000 between the rendered colour (composited) and that backdrop. */
  strength: z.number().nullable(),
  detail: z.string().nullable(),
});

/**
 * One reference colour and what became of it: the colour as the reference project actually has it (alpha included), the DS token chosen for the SAME role on the
 * SAME surface (exact or nearest), why, and the checks that were run on the result. A reference colour is never used raw: `unmapped` means no DS token was
 * suitable and the pattern is refused for it.
 */
export const ColourMappingSchema = z.object({
  /** The CSS property of the pattern's declaration this colour sits in (`border`, `box-shadow`, `--border-on-dark`, ...). */
  property: z.string(),
  declaration: z.string(),
  /** The colour as written in the declaration (`var(--faq-border)`, `rgba(0,0,0,.08)`) and what it resolves to in the reference project. */
  referenceValue: z.string(),
  referenceResolved: z.string(),
  referenceRgba: z.object({ r: z.number(), g: z.number(), b: z.number(), alpha: z.number() }),
  referenceToken: z.string().nullable(),
  referenceChain: z.array(z.string()),
  role: z.enum(COLOUR_ROLES),
  state: StateSchema,
  theme: z.enum(['light', 'dark']),
  /** The backdrops the mapping had to hold on (opaque colours) and where they came from. */
  backdrops: z.array(z.string()),
  backdropSource: z.enum(['measured', 'ds-section-tokens']),
  outcome: z.enum(['exact', 'nearest', 'unmapped']),
  /** The reference token has the same NAME as the DS token chosen (and the same value). */
  sameName: z.boolean(),
  /** The reference token shares a DS token's name but not its value: the DS token was NOT used by name. */
  nameCollision: z.object({ referenceValue: z.string(), dsValue: z.string() }).nullable(),
  dsToken: z.string().nullable(),
  dsValue: z.string().nullable(),
  dsScope: z.string().nullable(),
  dsFile: z.string().nullable(),
  tier: z.enum(COLOUR_TIERS).nullable(),
  /** Set for a colour that needs no token (`transparent`). */
  keyword: z.enum(['transparent']).nullable(),
  distance: z.object({ deltaE: z.number(), perBackdrop: z.array(z.number()), alphaDelta: z.number(), strengthRatio: z.number().nullable() }).nullable(),
  reason: z.string(),
  /** The closest candidates that were NOT chosen, and the constraint each failed (or why it ranked lower). */
  rejected: z.array(z.object({ token: z.string(), value: z.string(), deltaE: z.number(), why: z.string() })),
  verification: z.object({
    designTime: z.object({
      polarityOk: z.boolean(),
      strengthOk: z.boolean(),
      contrastOk: z.boolean().nullable(),
      stateDistinct: z.boolean().nullable(),
      /** For a hover/focus colour: ΔE between the default and the state colour in the reference, after mapping, and the least the mapped pair had to keep. */
      stateDelta: z.object({ reference: z.number(), mapped: z.number(), required: z.number() }).nullable().default(null),
    }),
    rendered: RenderedColourSchema,
  }),
});
export type ColourMapping = z.infer<typeof ColourMappingSchema>;

export const ReferenceProvenanceSchema = z.object({
  project: z.string(),
  pattern: z.string(),
  /** Absolute source folder of the approved project as found when the pattern was verified. */
  sourcePath: z.string(),
  /** The file (relative to sourcePath) the pattern was read from. */
  file: z.string(),
  fileSha256: z.string(),
  /** Hash over the project's source files at verification time — "which version of the project". */
  projectHash: z.string(),
  /** An adapted implementation is an approved project pattern or a proposed local variant — never an official DS component. */
  classification: z.enum(['approved-project-pattern', 'proposed-local-variant']),
  /** Every var() the pattern relies on was found in the configured DS (otherwise the hardcoded value is NOT official DS guidance). */
  dsGrounded: z.boolean(),
  tokens: z.array(z.object({ token: z.string(), existsInDs: z.boolean(), dsScope: z.string().nullable() })),
  /** `server-reachable`: the localhost inspection URL answered; `source-only`: only the source was inspected. */
  renderingEvidence: z.enum(['server-reachable', 'source-only']),
  note: z.string().nullable(),
  /** The component categories the element was classified as and which of them the pattern fits (optional: files written before the semantic matching still parse). */
  elementKinds: z.object({ matched: z.array(z.string()), inferred: z.array(z.string()), evidence: z.string() }).optional(),
  /** Every colour the target relies on, as read from the reference and mapped to a DS token (files written before the colour mapper default to none). */
  colours: z.array(ColourMappingSchema).default([]),
  /** Properties/project tokens that conditional blocks (`@media`, `@supports` ...) also set, so the value is not the default at every surface and viewport. Absent when there are none. */
  conditioned: z.array(z.string()).optional(),
});
export type ReferenceProvenance = z.infer<typeof ReferenceProvenanceSchema>;

export const ProvenanceSchema = z.object({
  kind: ProvenanceKindSchema,
  ds: z
    .object({
      file: z.string().nullable(),
      component: z.string().nullable(),
      variant: z.string().nullable(),
      token: z.string().nullable(),
      /** The variant/theme scope the value was resolved in, e.g. `[data-variant="cinematic-dark"]`; null = unscoped (base). */
      scope: z.string().nullable(),
      registryVersion: z.string().nullable(),
    })
    .nullable(),
  reference: ReferenceProvenanceSchema.nullable(),
  /** Paths inside the run folder, audit note text, DS file paths: what the decision rests on. */
  evidence: z.array(z.string()),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const AUDIT_STATUSES = ['DIFFERENT', 'MATCH', 'UNRESOLVED', 'NOT-LISTED'] as const;
/** What the audit itself recorded for this property — copied, never modified. `NOT-LISTED`: the audit never considered this property. */
export const AuditObservationSchema = z.object({
  status: z.enum(AUDIT_STATUSES),
  actual: z.string().nullable(),
  expected: z.string().nullable(),
  expectedToken: z.string().nullable(),
  note: z.string().nullable(),
  source: z.string().nullable(),
});
export type AuditObservation = z.infer<typeof AuditObservationSchema>;

export const AcceptanceCheckSchema = z.object({
  /**
   * `colour-visible`: the rendered colour must also be visible on the backdrop it is drawn over (`expected` = `<role>:<minimum>`, e.g. `border:1.5`).
   * `state-distinct`: a hover/focus colour must differ from the default state by at least `expected` ΔE.
   */
  kind: z.enum(['property-equals', 'property-unchanged', 'state-preserved', 'colour-visible', 'state-distinct']),
  property: z.string(),
  state: StateSchema,
  viewport: z.enum(VIEWPORT_NAMES),
  comparison: ComparisonSchema.nullable(),
  expected: z.string().nullable(),
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export const DESIGN_STATUSES = ['resolved', 'preserved', 'unresolved'] as const;
export const IMPLEMENTATION_STATUSES = ['not-started', 'planned', 'applied', 'not-applicable', 'blocked'] as const;
/**
 * `verified-original-target`: measured against the AUDIT's own expected value.
 * `verified-resolved-target`: measured against a separately resolved design target.
 * `preserved-verified`: a preserve decision, and the rendered value still equals the original's.
 * `failed` / `unverified`: never reported as fixed.
 */
export const VERIFICATION_STATUSES = ['not-run', 'verified-original-target', 'verified-resolved-target', 'preserved-verified', 'failed', 'unverified'] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export type ImplementationStatusValue = (typeof IMPLEMENTATION_STATUSES)[number];

export const TargetStatusSchema = z.object({
  design: z.enum(DESIGN_STATUSES),
  implementation: z.enum(IMPLEMENTATION_STATUSES),
  verification: VerificationStatusSchema,
  /** Evidence for the last implementation / verification status written (never a bare flag). */
  implementationDetail: z.string().nullable(),
  verificationDetail: z.string().nullable(),
});
export type TargetStatus = z.infer<typeof TargetStatusSchema>;

export const ROUTES = ['css-edit', 'island', 'override', 'none'] as const;
export const RouteSchema = z.enum(ROUTES);
export type TargetRoute = z.infer<typeof RouteSchema>;

export const ResolvedTargetSchema = z.object({
  /** Stable: derived from findingId + part + property + viewport + theme + state (see `targetIdFor`). */
  id: z.string(),
  findingId: z.string(),
  /** A CSS property name (kebab-case). */
  property: z.string(),
  /** 'self' (the stamped element) | 'label' (its text node holder) | `descendant:<css selector relative to the stamped element>`. */
  part: z.string(),
  viewport: ViewportSchema,
  theme: ThemeSchema,
  state: StateSchema,
  audit: AuditObservationSchema,
  reason: UnresolvedReasonSchema,
  outcome: TargetOutcomeSchema,
  /** The value the output must have. Null unless `outcome` is `resolved-target`. */
  target: z.object({ value: z.string(), comparison: ComparisonSchema, token: z.string().nullable() }).nullable(),
  provenance: ProvenanceSchema,
  /** Why this property is changed, preserved or left unresolved — a sentence a reviewer can check. */
  decisionReason: z.string(),
  route: RouteSchema,
  acceptance: z.array(AcceptanceCheckSchema),
  status: TargetStatusSchema,
});
export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;

const SemanticKindSchema = z.enum(SEMANTIC_KINDS);

/**
 * How a residual finding's element was classified by purpose (`reference/element-kind.ts`): the kinds accepted, every kind considered and why it was
 * accepted, vetoed or left below the line, and the raw tag/role/type that were only evidence. Booleans and enums only — it does not change with a pixel.
 */
export const ElementKindRecordSchema = z.object({
  findingId: z.string(),
  rulesVersion: z.string(),
  kinds: z.array(z.object({ kind: SemanticKindSchema, confidence: z.enum(['high', 'medium']), score: z.number(), evidence: z.array(z.string()) })),
  considered: z.array(z.object({ kind: SemanticKindSchema, score: z.number(), status: z.enum(['accepted', 'below-threshold', 'vetoed', 'conflict']), evidence: z.array(z.string()), vetoes: z.array(z.string()) })),
  raw: z.object({ tag: z.string().nullable(), role: z.string().nullable(), productionType: z.string().nullable() }),
  partOf: SemanticKindSchema.nullable(),
  context: z.array(z.string()),
  sources: z.array(z.enum(['audit', 'mapping', 'structure'])),
  summary: z.string(),
  /** The page width class the structure was read at; null when no page was read (optional: files written before it still parse). A resumed run on the same viewport reproduces the classification. */
  viewport: z.enum(['desktop', 'mobile']).nullable().optional(),
  /** What became of the rendered-structure read: `read`; `not-found` (the selector matched nothing), `failed` (it threw), `no-page` (no live page), `not-mapped` (the finding has no element). Anything but `read` means `sources` has no `structure` and says why in the notes. */
  structureProbe: z.enum(['read', 'not-found', 'failed', 'no-page', 'not-mapped']).optional(),
});
export type ElementKindRecord = z.infer<typeof ElementKindRecordSchema>;

export const ResolutionFileSchema = z.object({
  schemaVersion: z.literal(RESOLUTION_SCHEMA_VERSION),
  sourceRun: z.object({ runId: z.string(), projectName: z.string(), dataJsonSha256: z.string().nullable(), fixPlanSha256: z.string().nullable() }),
  generatedAt: z.string(),
  dsRegistryVersion: z.string().nullable(),
  /** The approved-reference registry the resolution consulted (null when nothing was looked up). */
  referenceRegistry: z.object({ version: z.string(), sha256: z.string(), approvedProjects: z.array(z.string()) }).nullable(),
  targets: z.array(ResolvedTargetSchema),
  /** Findings with no per-property target at all (nothing to resolve), listed so "no target" is never mistaken for "fixed". */
  noTargetFindings: z.array(z.object({ findingId: z.string(), reason: z.string() })),
  notes: z.array(z.string()),
  /** Per residual finding: what its element was classified as (optional: files written before the semantic matching still parse). */
  elementKinds: z.array(ElementKindRecordSchema).optional(),
});
export type ResolutionFile = z.infer<typeof ResolutionFileSchema>;

export function targetIdFor(t: { findingId: string; part: string; property: string; viewport: ViewportRef; theme: ThemeName; state: StateName }): string {
  return fingerprintOf({ f: t.findingId, p: t.part, pr: t.property, v: t.viewport.name, vw: t.viewport.width, th: t.theme, s: t.state }).slice(0, 16);
}

/** A finding's own state-of-work, derived from its targets — never stored, never optimistic. */
export interface FindingRollup {
  findingId: string;
  targets: number;
  resolved: number;
  preserved: number;
  unresolved: number;
  verifiedOriginal: number;
  verifiedResolved: number;
  preservedVerified: number;
  /** Preserve decisions whose property changed (or whose element was removed). */
  preservedFailed: number;
  /** Preserve decisions with no positive evidence (unverified, or never evaluated). */
  preservedUnverified: number;
  failed: number;
  unverified: number;
  /** True only when EVERY resolved target is verified and every preserve decision was verified unchanged; unresolved targets never block a "fixed" claim for the rest, but are reported. */
  allRequiredVerified: boolean;
  /** A resolved-target not yet verified or failed. */
  openRequired: number;
}

export function rollupFinding(file: ResolutionFile, findingId: string): FindingRollup {
  const ts = file.targets.filter((t) => t.findingId === findingId);
  const count = (f: (t: ResolvedTarget) => boolean) => ts.filter(f).length;
  const required = ts.filter((t) => t.outcome === 'resolved-target');
  const openRequired = required.filter((t) => t.status.verification !== 'verified-original-target' && t.status.verification !== 'verified-resolved-target').length;
  return {
    findingId,
    targets: ts.length,
    resolved: count((t) => t.outcome === 'resolved-target'),
    preserved: count((t) => t.outcome === 'preserve-existing'),
    unresolved: count((t) => t.outcome === 'unresolved'),
    verifiedOriginal: count((t) => t.status.verification === 'verified-original-target'),
    verifiedResolved: count((t) => t.status.verification === 'verified-resolved-target'),
    preservedVerified: count((t) => t.status.verification === 'preserved-verified'),
    preservedFailed: count((t) => t.outcome === 'preserve-existing' && t.status.verification === 'failed'),
    preservedUnverified: count((t) => t.outcome === 'preserve-existing' && t.status.verification !== 'preserved-verified' && t.status.verification !== 'failed'),
    failed: count((t) => t.status.verification === 'failed'),
    unverified: count((t) => t.status.verification === 'unverified' || t.status.verification === 'not-run'),
    openRequired,
    allRequiredVerified: required.length > 0 && openRequired === 0 && count((t) => t.outcome === 'preserve-existing' && t.status.verification !== 'preserved-verified') === 0,
  };
}

/**
 * The properties of a finding's ELEMENT that a stage may CHANGE: resolved targets of the element itself (part `self`) only. A property whose
 * outcome is `preserve-existing` or `unresolved` is explicitly NOT changeable. A target for the label or a descendant is a different element's
 * property: it never authorizes (or blocks) an edit of the finding's own element.
 */
export function authorizedProperties(file: ResolutionFile | null, findingId: string): Set<string> {
  const out = new Set<string>();
  if (!file) return out;
  for (const t of file.targets) if (t.findingId === findingId && t.part === 'self' && t.outcome === 'resolved-target') out.add(t.property);
  return out;
}

export function blockedProperties(file: ResolutionFile | null, findingId: string): Map<string, { outcome: 'preserve-existing' | 'unresolved'; reason: UnresolvedReason; why: string }> {
  const out = new Map<string, { outcome: 'preserve-existing' | 'unresolved'; reason: UnresolvedReason; why: string }>();
  if (!file) return out;
  for (const t of file.targets) {
    if (t.findingId !== findingId || t.part !== 'self' || t.outcome === 'resolved-target') continue;
    // a property that is changeable in another state is not blocked outright
    const changeableElsewhere = file.targets.some((o) => o.findingId === findingId && o.part === 'self' && o.property === t.property && o.outcome === 'resolved-target');
    if (!changeableElsewhere) out.set(t.property, { outcome: t.outcome, reason: t.reason, why: t.decisionReason });
  }
  return out;
}

/** One intentional change: only this finding, this property, this part, this state may differ from the original. */
export interface Exemption {
  findingId: string;
  property: string;
  part: string;
  state: StateName | '*';
  viewport: ViewportRef['name'];
  targetId: string;
  reason: string;
}

export function exemptionsFrom(file: ResolutionFile | null): Exemption[] {
  if (!file) return [];
  return file.targets
    .filter((t) => t.outcome === 'resolved-target')
    .map((t) => ({ findingId: t.findingId, property: t.property, part: t.part, state: t.state, viewport: t.viewport.name, targetId: t.id, reason: t.decisionReason }));
}
