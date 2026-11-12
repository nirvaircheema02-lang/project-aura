import { z } from 'zod';

/**
 * RV — Resolver judgment. The ONLY thing a model/session may contribute to the resolved targets is a
 * decision about a residual design question (a selected NEEDS_REVIEW / UNVERIFIED finding, or a property
 * the DS leaves open). It is a CLAIM, not a fact: `resolve.ts` re-derives every value from the DS token
 * index / approved reference registry and downgrades a claim it cannot verify to `unresolved`, so a
 * judgment can never smuggle in an invented token, an unapproved reference or a layout change.
 *
 * Wire-safe: no `.min()/.max()/.regex()`; enums are enforced on the wire (see llm/schemas/r-nodes.ts).
 */

export const RV_STATES = ['default', 'hover', 'focus', 'focus-visible', 'active', 'disabled', 'selected', 'expanded', 'error'] as const;
export const RV_SOURCES = ['ds-token', 'proposed-local-variant', 'approved-project-pattern', 'original-baseline'] as const;
export const RV_REASONS = ['inherited-context', 'variant-or-theme-context', 'state-context', 'responsive-context', 'layout-measurement-required', 'uncertain-component-identity', 'no-ds-requirement', 'missing-ds-treatment', 'capture-capability-gap'] as const;

export const ResolutionDecisionSchema = z.object({
  findingId: z.string().describe('Exactly one of the supplied finding ids, verbatim'),
  property: z.string().describe('A CSS property in kebab-case, e.g. "border-color". Composition properties (width, height, display, position, text-align, flex/grid, margin, transform) are never changed from a judgment'),
  part: z.string().describe('"self" (the finding\'s element), "label" (its text) or "descendants"'),
  state: z.enum(RV_STATES).describe('The interaction state this value is for; "default" unless the DS/reference styles a state'),
  outcome: z.enum(['resolved-target', 'preserve-existing', 'unresolved']),
  value: z.string().nullable().describe('For resolved-target: the CSS value, built ONLY from DS tokens as var(--token) (several tokens allowed, e.g. "1px solid var(--border-soft)") or CSS keywords/0. Never a hardcoded colour or length. Null otherwise'),
  source: z.enum(RV_SOURCES).describe('ds-token: the value is a DS token · proposed-local-variant: composed from DS tokens locally · approved-project-pattern: adapted from an approved reference project pattern (name it in `reference`) · original-baseline: keep what the page does'),
  dsToken: z.string().nullable().describe('The primary DS token behind the value (e.g. "--border-soft"); null when none'),
  reference: z.object({ project: z.string(), patternId: z.string() }).nullable().describe('Only for source=approved-project-pattern: the approved project name and pattern id, exactly as offered in the candidates; never any other project'),
  reason: z.string().describe('Why this property is changed, preserved or left unresolved — one checkable sentence grounded in the evidence supplied'),
  unresolvedReason: z.enum(RV_REASONS).nullable().describe('For preserve-existing / unresolved: the specific reason; null for resolved-target'),
});
export type ResolutionDecision = z.infer<typeof ResolutionDecisionSchema>;

export const ResolutionJudgmentSchema = z.object({
  decisions: z.array(ResolutionDecisionSchema),
  notes: z.array(z.string()).describe('Anything the evidence could not settle, stated plainly (never invented)'),
});
export type ResolutionJudgment = z.infer<typeof ResolutionJudgmentSchema>;
