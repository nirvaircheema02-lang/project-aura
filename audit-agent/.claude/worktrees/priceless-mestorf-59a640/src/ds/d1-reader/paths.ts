import { join } from 'node:path';

/**
 * Every path D1 reads is relative to the configured `designSystemPath`
 * (Decision Log #17) — verified against the real filesystem during this
 * build (2026-09-11), not assumed from the plan's prose. D1 never writes
 * to any of these; read-only, always.
 */
export function dsPaths(designSystemPath: string) {
  return {
    tokensJson: join(designSystemPath, 'tokens/tokens.json'),
    tokensPackageJson: join(designSystemPath, 'tokens/package.json'),
    tokensBuildCss: join(designSystemPath, 'tokens/build/tokens.css'),
    baseCss: join(designSystemPath, 'core-v2/src/styles/base.css'),
    editorialLightCss: join(designSystemPath, 'core-v2/src/styles/editorial-light.css'),
    cinematicDarkCss: join(designSystemPath, 'core-v2/src/styles/cinematic-dark.css'),
    chartThemeTokens: join(designSystemPath, 'core-v2/src/charts/theme/tokens.ts'),
    coreV2PackageJson: join(designSystemPath, 'core-v2/package.json'),
    coreV2SrcRoot: join(designSystemPath, 'core-v2/src'),
    rulesMd: join(designSystemPath, 'core-v2/docs/RULES.md'),
    antiPatternsRoot: join(designSystemPath, 'ANTI_PATTERNS.md'),
    antiPatternsCoreV2: join(designSystemPath, 'core-v2/docs/ANTI_PATTERNS.md'),
    caseStudyRecipe: join(designSystemPath, 'recipes/case-study.md'),
    designMd: join(designSystemPath, 'DESIGN.md'),
    motionSpecMd: join(designSystemPath, 'motion/MOTION_SPEC.md'),
  } as const;
}

/**
 * IMPLEMENTATION-PLAN.md §4's D5 Track A rule-checker scripts do NOT live
 * under `designSystemPath` — verified during this build: they're at the
 * project_aura1-main WORKSPACE ROOT (`scripts/*.mjs`), one directory above
 * `design-system/`, not inside it. This is a genuine discrepancy from the
 * plan's phrasing (which reads as if they were DS-internal) — preserved
 * here as an explicit, derived (not hardcoded-elsewhere) path rather than
 * silently assuming the plan's implied location was right.
 */
export function workspaceCheckerScripts(designSystemPath: string) {
  const workspaceRoot = join(designSystemPath, '..'); // design-system/ is a direct child of the workspace root
  const scriptsDir = join(workspaceRoot, 'scripts');
  return {
    workspaceRoot,
    scriptsDir,
    checkTokens: join(scriptsDir, 'check-tokens.mjs'),
    checkComponents: join(scriptsDir, 'check-components.mjs'),
    checkFontScale: join(scriptsDir, 'check-font-scale.mjs'),
    checkInkRoles: join(scriptsDir, 'check-ink-roles.mjs'),
    verifyCssVars: join(designSystemPath, 'core-v2/scripts/verify-css-vars.mjs'),
    lintSectionAlternation: join(designSystemPath, 'core-v2/scripts/lint-section-alternation.mjs'),
  } as const;
}
