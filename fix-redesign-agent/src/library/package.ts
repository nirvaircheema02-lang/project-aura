import { join } from 'node:path';
import { sha256OfFile } from '../session/fingerprint.ts';
import type { AssembledPackage, ComponentSpec, L2Output, PackageFile } from './types.ts';

/**
 * §11.4 — the approved-only publish package. Assembled from APPROVED components only: their
 * own files, plus the shared-file state derived from exactly that subset (barrel entries and
 * token additions from approved specs only — never from a rejected or still-pending one).
 */
export async function assemblePackage(dsRepoPath: string, branch: string, approvedComponentIds: string[], specs: ComponentSpec[], buildResults: L2Output[], barrelFilesTouched: string[], tokenStylesheetTouched: string | null): Promise<AssembledPackage> {
  const approvedSet = new Set(approvedComponentIds);
  const approvedBuilds = buildResults.filter((b) => approvedSet.has(b.componentId) && b.writeSetRespected);
  const approvedSpecFiles = new Set(approvedBuilds.flatMap((b) => b.filesWritten));

  // Shared files are included only when an APPROVED spec actually declared a change to them.
  const approvedSpecs = specs.filter((s) => approvedSet.has(s.componentId));
  const relevantBarrels = new Set(approvedSpecs.flatMap((s) => s.declaredSharedChanges.barrelEntries.map((e) => e.barrelFile)));
  const includeTokenStylesheet = approvedSpecs.some((s) => s.declaredSharedChanges.tokenAdditions.length > 0);

  const paths = [...approvedSpecFiles, ...barrelFilesTouched.filter((f) => [...relevantBarrels].some((b) => f.endsWith(b.replace(/^core-v2\/src\//, '')))), ...(includeTokenStylesheet && tokenStylesheetTouched ? [tokenStylesheetTouched] : [])];

  const files: PackageFile[] = [];
  for (const p of new Set(paths)) {
    const abs = p.startsWith('/') ? p : join(dsRepoPath, p);
    files.push({ path: abs, blobSha256: await sha256OfFile(abs) });
  }
  return { approvedComponentIds, files, branch };
}
