import { z } from 'zod';

/**
 * Output schemas for Workflow B's two model-calling nodes (L2 Component Builder, L3's
 * acceptance-review sub-step). Same wire-safety discipline as `r-nodes.ts`: no
 * `.min()/.max()/.regex()` — see `test/unit/llm-schemas.test.ts`.
 */

export const GeneratedFileSchema = z.object({
  /** MUST be exactly one of the spec's own declared write-set paths (each already `core-v2/src/...`-prefixed, relative to `dsRepo.path` — never re-prefixed) — anything else is rejected without touching disk (§9.4, §7.6). */
  path: z.string(),
  content: z.string(),
});

export const ComponentBuildSchema = z.object({
  files: z.array(GeneratedFileSchema),
  /** Confirms or refines the spec's own declared barrel export line — L2b applies it, never L2 itself. */
  barrelExportLine: z.string(),
  tokenAdditions: z.array(z.object({ name: z.string(), value: z.string() })),
  notes: z.string(),
});
export type ComponentBuild = z.infer<typeof ComponentBuildSchema>;

/** L3's acceptance-review sub-step — a vision judgment over the rendered component vs. its reference, per variant/state actually rendered. */
export const AcceptanceReviewSchema = z.object({
  visionVerdict: z.enum(['CONFIRMED', 'UNCERTAIN', 'REJECTED']).describe('Does the rendered component match its reference?'),
  perVariant: z.array(
    z.object({
      variantLabel: z.string(),
      matches: z.boolean(),
      note: z.string(),
    }),
  ),
  regressions: z.array(z.object({ description: z.string(), severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']) })),
});
export type AcceptanceReview = z.infer<typeof AcceptanceReviewSchema>;
