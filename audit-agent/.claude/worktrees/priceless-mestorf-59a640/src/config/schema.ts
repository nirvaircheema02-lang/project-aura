import { z } from 'zod';

/**
 * Decision Log #17 (ARCHITECTURE.md): config file + AUDIT_AGENT_* env override,
 * never a hardcoded path. Fail fast with a readable error on an invalid/missing
 * value — same posture §0 takes on a missing `mode`.
 */
export const ConfigSchema = z.object({
  designSystemPath: z
    .string()
    .min(1, 'designSystemPath must not be empty')
    .describe('D1 DS Reader source — never vendored into this repo (ARCHITECTURE.md §6)'),
  figmaTeamPlanKey: z
    .string()
    .regex(/^(team|organization)::\d+$/, 'figmaTeamPlanKey must look like "team::<digits>" or "organization::<digits>"')
    .describe('Decision Log #16 — which Figma team/org owns created audit files'),
  anthropicModel: z.string().min(1).default('claude-opus-5'),
  /**
   * Decision Log #31 — execution mode. `no-api` (default) runs every AI node's
   * deterministic strategy with zero model calls; `anthropic-api` must be
   * chosen explicitly. The `AI_MODE` env var overrides this (llm/provider.ts).
   */
  aiMode: z.enum(['no-api', 'anthropic-api']).default('no-api'),
  dashboardPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(4173)
    .describe('Decision Log #20 — fixed port for the single long-running C4 dashboard server'),
  /**
   * IMPLEMENTATION-PLAN.md §12 open decision #4 — CLOSED at build step 11:
   * the engine is locked to Playwright's bundled Chromium (full build,
   * new-headless; pinned by the exact playwright version), set explicitly in
   * audit-agent.config.json, and its exact build is recorded per run in
   * policy_version and runs.rendering_policy_json.
   */
  browserChannel: z.enum(['chromium', 'chromium-headless-shell']).default('chromium'),
  /**
   * First-class politeness budget toward the production origin (grounding
   * risk: per-context cold caches multiply real request volume by page
   * count). Conservative defaults; open decision #3 (coordinate with the
   * site's analytics owners) still applies before the first full-site run.
   */
  politeness: z
    .object({
      minNavigationIntervalMs: z.number().int().min(0).default(2000),
      maxConcurrentContexts: z.number().int().min(1).default(3),
      userAgentProduct: z.string().min(1).default('KenResearchDSAudit/0.1'),
      /** Optional `From:` header for traffic attribution — opt-in only, never defaulted to anyone's address. */
      contactEmail: z.string().min(3).optional(),
    })
    .default({
      minNavigationIntervalMs: 2000,
      maxConcurrentContexts: 3,
      userAgentProduct: 'KenResearchDSAudit/0.1',
    }),
});

export type Config = z.infer<typeof ConfigSchema>;
