import { z } from 'zod';

/**
 * Output schemas for the two model-calling nodes. These go to the API VERBATIM (via
 * `wireSchema` in ../client.ts), so they must stay inside the JSON-Schema subset structured
 * outputs accepts: no recursion, no `.min()/.max()/.int()/.length()/.regex()` (those would
 * reach the API and 400). `test/unit/llm-schemas.test.ts` enforces that. Enums ARE enforced
 * on the wire. Ranges (confidence 0..1) are stated in `.describe()` and checked in code.
 */

export const TARGETED_EDIT_KINDS = ['style', 'attribute', 'text', 'class', 'component-swap'] as const;
export type TargetedEditKind = (typeof TARGETED_EDIT_KINDS)[number];

/**
 * R3 — Redesign Plan. ONE batched call across ALL fix-decision findings (chunked beyond
 * a bound, never one call per finding). Every edit is TARGETED: selector → property → value.
 * R4 can only ever touch what an edit here explicitly names — that narrowness is the
 * structural guarantee of content/functionality preservation (Q7), not a stated policy.
 */
export const TargetedEditSchema = z.object({
  findingId: z.string().describe('The finding this edit addresses — exactly one of the supplied findingIds, verbatim'),
  selector: z.string().describe('A CSS selector that resolves on the supplied live DOM to the element(s) to change — derived from the DOM given, never invented'),
  expectedMatches: z.number().describe('How many elements the selector should match on the live page: 1 unless the finding covers repeated identical instances'),
  kind: z.enum(TARGETED_EDIT_KINDS).describe('style: set one CSS property · attribute: set one attribute · text: replace text content · class: add/remove classes · component-swap: re-render as a DS component (resolved by code from the catalog)'),
  property: z.string().nullable().describe('kind=style: the CSS property · kind=attribute: the attribute name · otherwise null'),
  value: z.string().describe('The new value: CSS value / attribute value / text / space-separated class list to ADD / component instruction'),
  removeValue: z.string().nullable().describe('kind=class only: space-separated class list to REMOVE; otherwise null'),
  dsComponent: z.string().nullable().describe('kind=component-swap only: the Design System component name exactly as listed in the catalog; otherwise null'),
  dsVariant: z.string().nullable().describe('kind=component-swap only: the variant exactly as listed for that component; otherwise null'),
  dsToken: z.string().nullable().describe('The DS token the value comes from (e.g. "--button-px-md") when it comes from one; otherwise null'),
  rationale: z.string().describe('Which mismatch / rule violation / recommendation of the finding this edit closes, in one sentence'),
  confidence: z.number().describe('0..1 probability that this edit is the right correction'),
});
export type TargetedEdit = z.infer<typeof TargetedEditSchema>;

export const RedesignPlanSchema = z.object({
  edits: z.array(TargetedEditSchema),
  unaddressed: z
    .array(z.object({ findingId: z.string(), reason: z.string() }))
    .describe('Findings for which no safe, targeted edit exists on this DOM — stated explicitly, never silently dropped'),
});
export type RedesignPlan = z.infer<typeof RedesignPlanSchema>;

/**
 * R5 — Compare, vision sub-step. ONE batched call: before/after screenshots + what was
 * supposed to change. Mirrors audit-agent B5's CONFIRMED / FALSE_POSITIVE / UNCERTAIN
 * structured-verdict pattern. The deterministic re-measurement is NOT here — it is code.
 */
export const CompareVerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      findingId: z.string(),
      verdict: z.enum(['FIXED', 'NOT_FIXED', 'UNCERTAIN']).describe('Does the AFTER picture show this finding corrected as intended? UNCERTAIN if the picture cannot settle it'),
      confidence: z.number().describe('0..1 probability; 0.5 = coin flip'),
      reasoning: z.string(),
    }),
  ),
  regressions: z
    .array(
      z.object({
        description: z.string(),
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
        confidence: z.number().describe('0..1 probability; 0.5 = coin flip'),
      }),
    )
    .describe('Anything the redesign broke or degraded that only the picture shows: overlap, wrapping, lost content, broken alignment, hierarchy'),
  overall: z.enum(['CONFIRMED', 'UNCERTAIN', 'REJECTED']).describe('CONFIRMED: after matches the intended changes with no regression · REJECTED: the page regressed or the changes did not land · UNCERTAIN otherwise'),
});
export type CompareVerdicts = z.infer<typeof CompareVerdictsSchema>;
