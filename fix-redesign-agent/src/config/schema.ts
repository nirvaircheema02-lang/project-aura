import { z } from 'zod';

/**
 * Runtime configuration — the same mechanism audit-agent uses (its Decision Log #17,
 * ours #2): a schema-validated JSON file plus per-field `FIX_REDESIGN_AGENT_*` env-var
 * overrides. Fail fast with a field-specific error; never fall back to a wrong default.
 *
 * Cross-repo linkage follows the ONE precedent this ecosystem has — audit-agent's
 * `designSystemPath`, a plain absolute filesystem path in runtime config pointing into a
 * sibling repo. `auditAgentRepoRoot` is that same idiom pointed at audit-agent itself.
 */
export const ConfigSchema = z.object({
  auditAgentRepoRoot: z
    .string()
    .min(1, 'auditAgentRepoRoot must not be empty')
    .describe('Absolute path of the audit-agent repo. Read-only: its CLI resolves runs (`find-run`) and its run folders supply data.json + fix-plan.json. Never written to.'),
  designSystemPath: z
    .string()
    .min(1, 'designSystemPath must not be empty')
    .describe('Design System source for the vendored D1–D6 loader — read-only, never vendored (same value audit-agent uses, or independently set).'),
  anthropicModel: z.string().min(1).default('claude-opus-5'),
  /**
   * Who performs C2/R3/R5/L2/L3's judgment. `claude-session` (the default): no external model
   * API, no ANTHROPIC_API_KEY — the pipeline writes a pending judgment bundle and checkpoints;
   * the Session Agent (the Claude Code instance the run was started from) reads it, judges,
   * and submits the result via `judgment submit`. `anthropic-api`: the original behavior,
   * calling the Anthropic API directly and requiring a credential.
   */
  judgmentProvider: z.enum(['claude-session', 'anthropic-api']).default('claude-session'),
  /**
   * Answer RV/R3/R5/C2 from the prompt itself (src/judgment/deterministic.ts) instead of pausing for a Session Agent: R3 applies each resolved target verbatim,
   * R5 reports UNCERTAIN (R8's measurement is the verdict), RV adds no decision, C2 leaves ambiguous findings unmapped. Never invents a design decision.
   */
  deterministicJudgments: z.boolean().default(false),
  /** Same engine lock as audit-agent (its Decision Log #22): Playwright's bundled Chromium only. */
  browserChannel: z.enum(['chromium', 'chromium-headless-shell']).default('chromium'),
  /** Cap on the R3→R4→R5 loop (ARCHITECTURE.md Q8/Q9). Exits early on the first PASS. */
  maxIterations: z.number().int().min(1).max(10).default(3),
  /** Same politeness budget toward the production origin that audit-agent's capture already honours. */
  politeness: z
    .object({
      minNavigationIntervalMs: z.number().int().min(0).default(2000),
      maxConcurrentContexts: z.number().int().min(1).default(1),
      userAgentProduct: z.string().min(1).default('KenResearchDSRedesign/0.1'),
      /** Optional `From:` header for traffic attribution — opt-in only. */
      contactEmail: z.string().min(3).optional(),
    })
    .default({
      minNavigationIntervalMs: 2000,
      maxConcurrentContexts: 1,
      userAgentProduct: 'KenResearchDSRedesign/0.1',
    }),
  /**
   * ARCHITECTURE.md §9.0/§4 — where Workflow B writes and, after an explicit push approval,
   * pushes. `remote`/`baseBranch` may stay null until §19.1 is decided; L5 refuses to push
   * without them, but a local commit never needs them. `path` is checked ONCE, up front, for
   * an actual `.git` directory before any branch or commit operation (never assumed).
   */
  dsRepo: z
    .object({
      path: z.string().min(1),
      branchPrefix: z.string().min(1).default('fix-redesign-agent'),
      remote: z.string().min(1).nullable().default(null),
      baseBranch: z.string().min(1).nullable().default(null),
    })
    .optional(),
  /** ARCHITECTURE.md §6.4 — minimum `possibleMatches.score` counted as plausible; mirrors audit-agent's own bar (`PLAUSIBLE_MATCH_SCORE`). */
  plausibilityBar: z.number().min(0).max(1).default(0.35),
  /** ARCHITECTURE.md §8.9/§9.5 — validation and preview viewports beyond the audit's own; additional widths yield `proposed`, not `observed`, results. */
  viewports: z.array(z.object({ width: z.number().int().min(1), height: z.number().int().min(1) })).default([]),
  /** ARCHITECTURE.md §6.4 — objective mapping check thresholds. */
  mapping: z
    .object({
      iouFloor: z.number().min(0).max(1).default(0.6),
      textSimilarityFloor: z.number().min(0).max(1).default(0.6),
    })
    .default({ iouFloor: 0.6, textSimilarityFloor: 0.6 }),
  /** ARCHITECTURE.md §7.5/§11.1 — rejection rounds per gate before a unit closes `blocked`. */
  maxReviewRounds: z.number().int().min(1).max(10).default(2),
  /** ARCHITECTURE.md §7.4 — parallel component builds, bounded before the browser pool is asked to render that many at once. */
  buildConcurrency: z.number().int().min(1).max(16).default(2),
  /**
   * ARCHITECTURE.md §8c — the React Preview is the default deliverable of every run and cannot be
   * switched off; these only tune how it is produced. `behaviorProbes: false` skips probing the
   * production page (one extra, read-only page load); interaction parity is then reported as NOT
   * verified at G2, never as passed.
   */
  preview: z
    .object({
      basePort: z.number().int().min(1024).max(65000).default(4400),
      islands: z.boolean().default(true),
      behaviorProbes: z.boolean().default(true),
      /**
       * DS-first (user instruction 2026-10-14): where the page has a design-system component for an element (Button for a CTA, SectionHeading, …),
       * the component REPLACES the element and its own design wins. Without this a mounted component counts as a regression for every property
       * the audit did not name, so the correction loop threw it away and kept the production markup with CSS patches.
       */
      dsFirst: z.boolean().default(false),
      /**
       * After the preview is built and verified, write `<run>/figma-export/` (scripts/figma-export): the exact-copy Figma bundle of the rendered preview. It only prepares
       * files (about 20 s, no pipeline rerun); a session with the Figma tools pushes it (FIGMA_EXPORT.md). A failure here never fails the run.
       */
      figmaExport: z.boolean().default(true),
    })
    .default({ basePort: 4400, islands: true, behaviorProbes: true, dsFirst: false, figmaExport: true }),
  /**
   * ARCHITECTURE.md §8d — design & state fidelity verification and the correction loop that follows it. The loop has ONE budget:
   * verification runs, preview-generator corrections and planner re-plans all draw from it, so independent retries cannot multiply.
   * The verifier itself cannot be switched off (a skipped check is never a pass); only its bounds are tunable.
   * `maxDurationMinutes` is ACTIVE time (verification / correction work and fresh planner passes) summed over every invocation of the same run and plan;
   * waiting between invocations (a judgment pause, a human gate) is not counted, and a resume or `preview --regenerate` never restarts it.
   */
  fidelity: z
    .object({
      maxCorrectionCycles: z.number().int().min(0).max(6).default(2),
      maxVerifications: z.number().int().min(1).max(10).default(3),
      maxDurationMinutes: z.number().min(1).max(180).default(15),
      maxElementsPerSection: z.number().int().min(20).max(600).default(160),
      maxHoverTargets: z.number().int().min(0).max(80).default(20),
      maxFocusTargets: z.number().int().min(0).max(80).default(16),
    })
    .default({ maxCorrectionCycles: 2, maxVerifications: 3, maxDurationMinutes: 15, maxElementsPerSection: 160, maxHoverTargets: 20, maxFocusTargets: 16 }),
  /** Approved reference projects (a read-only allowlist owned by this agent). `registryPath`/`referenceProjectsRoot` override the shipped registry's defaults; servers are probed only when asked (inspection convenience, never identity). */
  references: z
    .object({
      registryPath: z.string().min(1).optional(),
      referenceProjectsRoot: z.string().min(1).optional(),
      checkServers: z.boolean().default(false),
    })
    .default({ checkServers: false }),
  /** ARCHITECTURE.md §6.3/§16 — extra interaction states to probe beyond `default`; empty by default (observe affordances, never fabricate). */
  captureStates: z.array(z.enum(['hover', 'focus', 'active', 'disabled'])).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
