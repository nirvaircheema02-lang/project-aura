// Vendored verbatim from audit-agent src/ds/d1-reader/index.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { dsPaths } from './paths.ts';

/**
 * D1 DS Reader — filesystem mode. Read-only: never writes to, copies, or
 * modifies anything under `designSystemPath` (explicit build instruction).
 * ARCHITECTURE.md §6: D1 reads through a configurable path, never vendored.
 */

export interface RawSource {
  path: string; // absolute
  content: string;
  mtimeMs: number;
}

export interface DSRawContent {
  designSystemPath: string;
  tokensJsonRaw: RawSource;
  tokensPackageJsonRaw: RawSource;
  tokensBuildCssRaw: RawSource;
  baseCssRaw: RawSource;
  editorialLightCssRaw: RawSource;
  cinematicDarkCssRaw: RawSource;
  chartThemeTokensRaw: RawSource;
  coreV2PackageJsonRaw: RawSource;
  rulesMdRaw: RawSource;
  antiPatternsRootRaw: RawSource;
  antiPatternsCoreV2Raw: RawSource;
  caseStudyRecipeRaw: RawSource;
  designMdRaw: RawSource;
  motionSpecMdRaw: RawSource;
  /** Every .tsx file under core-v2/src, absolute paths. */
  tsxFiles: string[];
  /**
   * Every `index.ts` barrel file under core-v2/src (any depth), absolute
   * paths — D6's component-hash input. IMPLEMENTATION-PLAN.md §4 says "9
   * barrel index.ts files"; a full recursive walk finds 12 (atoms, charts,
   * charts/presets, hooks, the top-level src/, lib, molecules, organisms,
   * patterns, templates, types, ui) — discovered dynamically here rather
   * than hardcoded, so this stays correct if more are added, and the count
   * discrepancy from the plan's prose is preserved as a D6 finding, not
   * silently fixed.
   */
  indexTsFiles: RawSource[];
}

async function readSource(path: string): Promise<RawSource> {
  const [content, stats] = await Promise.all([readFile(path, 'utf-8'), stat(path)]);
  return { path, content, mtimeMs: stats.mtimeMs };
}

async function walkFiles(root: string, matches: (fileName: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
      } else if (entry.isFile() && matches(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Reads every source D3/D4/D5/D6 need, once, as raw content — no parsing,
 * no interpretation. Throws with a clear, file-specific error if any
 * expected path is missing, rather than silently treating it as absent
 * (a missing file is itself a finding for the caller to decide how to
 * handle, not something D1 should paper over).
 */
export async function readFilesystemSource(designSystemPath: string): Promise<DSRawContent> {
  const paths = dsPaths(designSystemPath);
  try {
    const [
      tokensJsonRaw,
      tokensPackageJsonRaw,
      tokensBuildCssRaw,
      baseCssRaw,
      editorialLightCssRaw,
      cinematicDarkCssRaw,
      chartThemeTokensRaw,
      coreV2PackageJsonRaw,
      rulesMdRaw,
      antiPatternsRootRaw,
      antiPatternsCoreV2Raw,
      caseStudyRecipeRaw,
      designMdRaw,
      motionSpecMdRaw,
      tsxFiles,
      indexTsFilePaths,
    ] = await Promise.all([
      readSource(paths.tokensJson),
      readSource(paths.tokensPackageJson),
      readSource(paths.tokensBuildCss),
      readSource(paths.baseCss),
      readSource(paths.editorialLightCss),
      readSource(paths.cinematicDarkCss),
      readSource(paths.chartThemeTokens),
      readSource(paths.coreV2PackageJson),
      readSource(paths.rulesMd),
      readSource(paths.antiPatternsRoot),
      readSource(paths.antiPatternsCoreV2),
      readSource(paths.caseStudyRecipe),
      readSource(paths.designMd),
      readSource(paths.motionSpecMd),
      walkFiles(paths.coreV2SrcRoot, (name) => name.endsWith('.tsx')),
      walkFiles(paths.coreV2SrcRoot, (name) => name === 'index.ts'),
    ]);
    const indexTsFiles = await Promise.all(indexTsFilePaths.map(readSource));
    return {
      designSystemPath,
      tokensJsonRaw,
      tokensPackageJsonRaw,
      tokensBuildCssRaw,
      baseCssRaw,
      editorialLightCssRaw,
      cinematicDarkCssRaw,
      chartThemeTokensRaw,
      coreV2PackageJsonRaw,
      rulesMdRaw,
      antiPatternsRootRaw,
      antiPatternsCoreV2Raw,
      caseStudyRecipeRaw,
      designMdRaw,
      motionSpecMdRaw,
      tsxFiles,
      indexTsFiles,
    };
  } catch (err) {
    throw new Error(
      `D1 DS Reader: failed to read the Design System at "${designSystemPath}". ` +
        `Confirm the configured designSystemPath (audit-agent.config.json / AUDIT_AGENT_DESIGN_SYSTEM_PATH) ` +
        `points at a real, current checkout. Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Relative-path helper used by D3–D6 when citing a source in a finding. */
export function relativeToDs(designSystemPath: string, absolutePath: string): string {
  return relative(designSystemPath, absolutePath);
}

/**
 * D1 fallback mode (ARCHITECTURE.md §6 / IMPLEMENTATION-PLAN.md §4's "D1
 * fallback mode" section) — reads the deployed docs site's live computed
 * styles via Playwright when no filesystem checkout is available. NOT
 * implemented in this build pass: it requires the T-layer (Playwright
 * BrowserContext pool), which is build-sequence step 3, after the D-layer.
 * Filesystem mode above is fully implemented and is what every other
 * D-module in this build pass actually uses.
 */
export async function readFallbackSource(_docsSiteUrl: string): Promise<never> {
  throw new Error(
    'D1 fallback mode is not implemented yet — it depends on the T-layer (Playwright BrowserContext pool), ' +
      'build-sequence step 3, which has not been built. Filesystem mode (readFilesystemSource) is complete and in use.',
  );
}
