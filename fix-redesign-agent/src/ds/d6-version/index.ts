import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import canonicalize from 'canonicalize';
import type { DSRawContent } from '../d1-reader/index.ts';
import { finding, type DSFinding } from '../findings.ts';

// Vendored from audit-agent src/ds/d6-version/index.ts (2026-09-18). Only `isDsRegistryVersionUnchanged(db, …)`
// was removed: it queried audit-agent's own SQLite `runs` table, which this repo has no equivalent of.

/**
 * D6 Version — must be a content hash, not semver (IMPLEMENTATION-PLAN.md
 * §4). Both DS packages are frozen at 0.1.0 across real content changes
 * (verified, 2026-09-11) and `design-system/` is not under git at all — a
 * semver- or mtime-based `ds_registry_version` would produce false
 * re-audit cache hits (§4.4). Canonical-JSON + sha256, same discipline as
 * §2.5 rule 3's content-addressed dedup signature.
 */

export interface D6Result {
  tokensHash: string;
  componentsHash: string;
  /** sha256 over {tokensHash, componentsHash} — the actual ds_registry_version to snapshot per run (§2.2). */
  dsRegistryVersion: string;
  advisory: {
    tokensPackageVersion: string;
    coreV2PackageVersion: string;
  };
  findings: DSFinding[];
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function hashOf(record: Record<string, string>): string {
  const canonical = canonicalize(record);
  if (canonical === undefined) throw new Error('canonicalize() returned undefined for a non-empty record — unexpected');
  return sha256(canonical);
}

/**
 * D1 stores only tsx file *paths* (not content — 289 files' worth of text
 * would otherwise sit duplicated in the shared raw-content object for
 * every module that doesn't need it). D6 is the one place outside D1 that
 * still reads the filesystem directly, to hash that content — read-only,
 * same as everywhere else in this repo.
 */
export async function buildD6(raw: DSRawContent): Promise<D6Result> {
  const findings: DSFinding[] = [];

  const tokenInputs: Record<string, string> = {
    'tokens/tokens.json': raw.tokensJsonRaw.content,
    'tokens/build/tokens.css': raw.tokensBuildCssRaw.content,
    'core-v2/src/styles/base.css': raw.baseCssRaw.content,
    'core-v2/src/styles/editorial-light.css': raw.editorialLightCssRaw.content,
    'core-v2/src/styles/cinematic-dark.css': raw.cinematicDarkCssRaw.content,
    'core-v2/src/charts/theme/tokens.ts': raw.chartThemeTokensRaw.content,
  };
  const tokensHash = hashOf(tokenInputs);

  const componentInputs: Record<string, string> = {};
  for (const f of raw.indexTsFiles) {
    componentInputs[relative(raw.designSystemPath, f.path)] = f.content;
  }
  const tsxContents = await Promise.all(raw.tsxFiles.map((p) => readFile(p, 'utf-8')));
  raw.tsxFiles.forEach((p, i) => {
    componentInputs[relative(raw.designSystemPath, p)] = tsxContents[i] as string;
  });
  const componentsHash = hashOf(componentInputs);

  const dsRegistryVersion = sha256(`${tokensHash}:${componentsHash}`);

  const tokensPkg = JSON.parse(raw.tokensPackageJsonRaw.content) as { version?: string };
  const coreV2Pkg = JSON.parse(raw.coreV2PackageJsonRaw.content) as { version?: string };

  if (tokensPkg.version === '0.1.0' && coreV2Pkg.version === '0.1.0') {
    findings.push(
      finding({
        module: 'D6',
        severity: 'warning',
        summary: 'Both DS package.json versions are frozen at 0.1.0 despite real content changes — never use them as the cache key',
        detail:
          `tokens/package.json and core-v2/package.json both report "0.1.0". Verified real content changes across ` +
          `months of edits to tokens.json, base.css, and charts/theme/tokens.ts while this version string never moved, ` +
          `and design-system/ is not under git (no commit hash available either). dsRegistryVersion above is a content ` +
          `hash specifically because of this — package.json versions are recorded only as advisory metadata.`,
        sources: [
          relative(raw.designSystemPath, raw.tokensPackageJsonRaw.path),
          relative(raw.designSystemPath, raw.coreV2PackageJsonRaw.path),
        ],
      }),
    );
  }

  findings.push(
    finding({
      module: 'D6',
      severity: 'info',
      summary: `Component-hash barrel-file count: ${raw.indexTsFiles.length} index.ts files (plan text says 9; verified 2026-09-11)`,
      detail:
        'Discovered dynamically by walking core-v2/src for every index.ts, not hardcoded — stays correct as categories ' +
        'are added/removed. The plan\'s "9 barrel index.ts files" figure is out of date; preserved as a discrepancy.',
      sources: raw.indexTsFiles.map((f) => relative(raw.designSystemPath, f.path)),
    }),
  );

  return {
    tokensHash,
    componentsHash,
    dsRegistryVersion,
    advisory: {
      tokensPackageVersion: tokensPkg.version ?? 'unknown',
      coreV2PackageVersion: coreV2Pkg.version ?? 'unknown',
    },
    findings,
  };
}
