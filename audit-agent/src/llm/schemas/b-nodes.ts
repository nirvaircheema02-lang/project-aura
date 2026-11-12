import { z } from 'zod';

/**
 * Output schemas for every AI node in the B graph. These are sent to the API
 * VERBATIM (via z.toJSONSchema — see llm/client.ts `wireSchema`), so they must
 * stay inside the JSON-Schema subset structured outputs accepts: no recursion,
 * no numeric/string constraints (`.min()`, `.max()`, `.int()`, `.length()`,
 * `.regex()` would reach the API and 400). `test/unit/llm-schemas.test.ts`
 * enforces that. `enum`s ARE supported and ARE enforced on the wire. Ranges
 * (confidence 0..1) are stated in `.describe()` and checked in code after
 * parsing (S8 `normalizeConfidence`).
 */

export const B1SectionsSchema = z.object({
  sections: z.array(
    z.object({
      name: z.string().describe('Human-readable section name, e.g. "Hero", "Stats strip", "Footer"'),
      kind: z
        .enum(['hero', 'nav', 'stats', 'cards', 'content', 'form', 'cta', 'listing', 'footer', 'testimonial', 'chart', 'other'])
        .describe('Coarse section kind'),
      rootRef: z.string().describe('The aria ref (e.g. "e42") of the element that roots this section'),
      personalized: z
        .boolean()
        .describe('True if this section is personalized per visitor (e.g. "Recommended for you"), which puts it out of DS-compliance scope'),
      isListing: z
        .boolean()
        .describe('True if this section is a large/paginated repeating listing that should be sampled rather than enumerated'),
      note: z.string().describe('Short reasoning for the classification; empty string if none'),
    }),
  ),
});
export type B1Sections = z.infer<typeof B1SectionsSchema>;

export const B2ComponentsSchema = z.object({
  components: z.array(
    z.object({
      ref: z.string().describe('The aria ref of the component root element'),
      componentType: z.string().describe('Canonical component type from the supplied taxonomy'),
      label: z.string().describe('Visible label or short description'),
      domSignals: z.array(z.string()).describe('DOM evidence used (role, tag, cursor, attributes)'),
      visualSignals: z.string().describe('What the screenshot shows that supports this identification'),
      instanceGroupKey: z
        .string()
        .describe('Stable key shared by visually identical repeated instances (e.g. "report-card"); empty string if unique'),
      confidence: z.number().describe('0..1 confidence in this identification'),
    }),
  ),
});
export type B2Components = z.infer<typeof B2ComponentsSchema>;

export const B3MatchesSchema = z.object({
  matches: z.array(
    z.object({
      ref: z.string(),
      dsComponent: z.string().nullable().describe('Design System component name, or null when nothing in the DS corresponds'),
      dsVariant: z.string().nullable().describe('DS variant/size if identifiable, else null'),
      confidence: z.number().describe('0..1 confidence in the match'),
      rationale: z.string(),
    }),
  ),
});
export type B3Matches = z.infer<typeof B3MatchesSchema>;

export const B4ExpectationsSchema = z.object({
  components: z.array(
    z.object({
      ref: z.string(),
      expected: z
        .array(
          z.object({
            property: z.string().describe('CSS property name as it appears in the supplied computed styles'),
            token: z.string().nullable().describe('DS token name like "--button-height-md" whose value this property must equal'),
            literal: z.string().nullable().describe('Literal expected value, only when the DS source hardcodes it rather than using a token'),
            why: z.string().describe('Where in the DS source this expectation comes from'),
          }),
        )
        .describe('Properties this component must satisfy. Name the TOKEN, never a computed number — values are resolved and compared by code.'),
      ruleViolations: z
        .array(
          z.object({
            ruleId: z.string().describe('Rule id from the supplied DS rules, e.g. "R1.2"'),
            title: z.string(),
            why: z.string().describe('Why the observed implementation violates it'),
            confidence: z.number().describe('0..1 probability; 0.5 = coin flip'),
          }),
        )
        .describe('Only genuine rule violations — an approved DS solution exists and production did something unapproved'),
      confidence: z.number().describe('0..1 probability; 0.5 = coin flip'),
    }),
  ),
});
export type B4Expectations = z.infer<typeof B4ExpectationsSchema>;

export const B5VerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      ref: z.string(),
      verdict: z
        .enum(['CONFIRMED', 'FALSE_POSITIVE', 'UNCERTAIN'])
        .describe('Does the measured issue hold up visually? FALSE_POSITIVE if the measurement describes something the screenshot contradicts'),
      confidence: z.number().describe('0..1 probability; 0.5 = coin flip'),
      reasoning: z.string(),
    }),
  ),
  additionalIssues: z
    .array(
      z.object({
        ref: z.string().describe('Component ref the issue belongs to'),
        issueType: z.enum(['alignment', 'wrapping', 'overlap', 'hierarchy', 'optical-spacing', 'contrast', 'truncation', 'other']),
        description: z.string(),
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
        confidence: z.number().describe('0..1 probability; 0.5 = coin flip'),
      }),
    )
    .describe('Visual-only problems DOM/CSS measurement cannot see'),
});
export type B5Verdicts = z.infer<typeof B5VerdictsSchema>;

export const B6EvaluationsSchema = z.object({
  evaluations: z.array(
    z.object({
      ref: z.string(),
      verdict: z
        .enum(['NEW_COMPONENT', 'DS_CANDIDATE'])
        .describe('DS_CANDIDATE only when it follows DS foundations AND is reusable/repeated enough to deserve governance review'),
      followsDsFoundations: z.boolean(),
      foundationNotes: z.string().describe('Which foundations it does/does not follow'),
      reuseRationale: z.string(),
      recommendation: z.string(),
      confidence: z.number().describe('0..1 probability; 0.5 = coin flip'),
    }),
  ),
});
export type B6Evaluations = z.infer<typeof B6EvaluationsSchema>;
