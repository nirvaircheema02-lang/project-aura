import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentSpec, L3Output } from '../library/types.ts';
import type { MappingConflict } from '../mapping/types.ts';
import { readJsonFileOrNull, type RedesignPaths, type ScopeRecord } from '../output/redesign-store.ts';
import { sourceHashOf } from '../preview/scaffold.ts';
import { fingerprintOf, sha256OfFile } from './fingerprint.ts';
import type { Gate } from './types.ts';

/**
 * §11.3 — every approval fingerprint must be reproducible from ON-DISK ARTIFACTS ALONE: the
 * `decide` CLI command that RECORDS an approval's fingerprint runs as a separate process
 * invocation from the `redesign` run that CHECKS whether a fingerprint is reusable, with no
 * shared in-memory state between the two. Each function here is therefore the single source
 * of truth for one gate's fingerprint, called identically from both `pipeline.ts` (to check
 * reuse) and `cli/index.ts`'s `decide` command (to record what was actually approved) — this
 * replaces an earlier bug where `decide` computed a fingerprint over `{gate, unit, timestamp}`
 * (never the approved content), which could never match the pipeline's own recomputation and
 * silently made every G1/G2/G4/G5 approval permanently unreusable.
 *
 * Each returns `null` when the gate hasn't actually been reached yet (the artifacts it would
 * fingerprint don't exist on disk) — callers treat `null` as "not reusable", never as a match.
 */

async function hashFileOrNull(path: string): Promise<string | null> {
  return existsSync(path) ? sha256OfFile(path) : null;
}

/**
 * Keys that change on every run without changing what was produced: clocks and durations, and the correction budget's effort counters
 * (`verifications` and the `budget` block of correction-log.json: how much was spent, not what was found). They never decide whether an approval still stands.
 */
const VOLATILE_KEYS = new Set(['generatedAt', 'capturedAt', 'updatedAt', 'resolvedAt', 'startedAt', 'durationMs', 'elapsedMs', 'at', 'verifications', 'budget']);

/** A JSON artifact's CONTENT hash, ignoring clocks: re-running an unchanged pipeline reproduces it, any real change (a target, a measurement, a regression) does not. */
async function stableJsonHashOrNull(path: string | undefined): Promise<string | null> {
  if (!path || !existsSync(path)) return null;
  const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !VOLATILE_KEYS.has(k)).map(([k, x]) => [k, strip(x)])) : v);
  try {
    return fingerprintOf(strip(JSON.parse(await readFile(path, 'utf8'))));
  } catch {
    return sha256OfFile(path);
  }
}

/** G1 — §5.2a's resolved scope plus §6.1's outstanding acknowledgement-requiring conflicts. */
export async function computeG1Fingerprint(paths: Pick<RedesignPaths, 'scopeJson' | 'conflictsJson'>): Promise<string | null> {
  const scope = await readJsonFileOrNull<ScopeRecord>(paths.scopeJson);
  const conflicts = (await readJsonFileOrNull<MappingConflict[]>(paths.conflictsJson)) ?? [];
  if (!scope && conflicts.length === 0) return null;
  const needsAck = conflicts.filter((c) => c.requiresAcknowledgement).map((c) => c.description).sort();
  return fingerprintOf({ sectionIds: [...(scope?.sectionIds ?? [])].sort(), conflicts: needsAck });
}

/** G2 — §11.3: "the exported documents and the validation results," by CONTENT, not by their (constant, per-run) path strings. */
export async function computeG2Fingerprint(paths: Pick<RedesignPaths, 'redesignContentHtml' | 'sectionsDir' | 'validationResultsJson' | 'previewVerificationJson' | 'previewAppDir'> & Partial<Pick<RedesignPaths, 'resolvedTargetsJson' | 'designBaselineJson' | 'fidelityReportJson' | 'correctionLogJson'>>): Promise<string | null> {
  const contentHash = await hashFileOrNull(paths.redesignContentHtml);
  const validationHash = await hashFileOrNull(paths.validationResultsJson);
  if (!contentHash || !validationHash) return null;
  const sectionFiles = existsSync(paths.sectionsDir) ? (await readdir(paths.sectionsDir)).sort() : [];
  const sectionHashes: Record<string, string> = {};
  for (const f of sectionFiles) sectionHashes[f] = await sha256OfFile(join(paths.sectionsDir, f));
  // the React preview is the primary deliverable: its verification AND its generated source are part of what G2 approves
  // ... and so are the design targets it was measured against, the immutable baseline of the original, the fidelity comparison and the
  // correction outcome: a changed target, evidence or verified result invalidates the approval; a bare re-run (new timestamps) does not.
  const previewVerification = await stableJsonHashOrNull(paths.previewVerificationJson);
  const previewSource = existsSync(paths.previewAppDir) ? await sourceHashOf(paths.previewAppDir) : null;
  const resolvedTargets = await stableJsonHashOrNull(paths.resolvedTargetsJson);
  const designBaseline = await stableJsonHashOrNull(paths.designBaselineJson);
  const fidelityReport = await stableJsonHashOrNull(paths.fidelityReportJson);
  const correctionLog = await stableJsonHashOrNull(paths.correctionLogJson);
  return fingerprintOf({ redesignContentHtml: contentHash, sections: sectionHashes, validationResultsJson: validationHash, previewVerification, previewSource, resolvedTargets, designBaseline, fidelityReport, correctionLog });
}

/** G3 — §11.3: "the exported selection, plus the upstream plan if used." (Recorded automatically by the pipeline itself, per §10a — never through `decide` — but exposed here for consistency/tests.) */
export async function computeG3Fingerprint(paths: Pick<RedesignPaths, 'componentSelectionJson'>, upstreamPlanPath: string | null): Promise<string | null> {
  const selectionHash = await hashFileOrNull(paths.componentSelectionJson);
  if (!selectionHash) return null;
  const upstreamHash = upstreamPlanPath ? await hashFileOrNull(upstreamPlanPath) : null;
  return fingerprintOf({ selection: selectionHash, upstream: upstreamHash });
}

/** G4, per component — §11.3: "that component's own built files, its previews, and its acceptance results." */
export async function computeG4Fingerprint(paths: Pick<RedesignPaths, 'specsDir' | 'acceptanceJson' | 'previewsDir'>, dsRepoPath: string | null, componentId: string): Promise<string | null> {
  const spec = await readJsonFileOrNull<ComponentSpec>(join(paths.specsDir, `${componentId}.json`));
  if (!spec) return null;
  const builtFiles: Record<string, string | null> = {};
  if (dsRepoPath) {
    for (const relPath of spec.writeSet) builtFiles[relPath] = await hashFileOrNull(join(dsRepoPath, relPath));
  }
  const acceptance = ((await readJsonFileOrNull<L3Output[]>(paths.acceptanceJson)) ?? []).find((a) => a.componentId === componentId) ?? null;
  const previewFiles = existsSync(paths.previewsDir) ? (await readdir(paths.previewsDir)).filter((f) => f === `${componentId}.html` || f.startsWith(`${componentId}-`)).sort() : [];
  const previews: Record<string, string> = {};
  for (const f of previewFiles) previews[f] = await sha256OfFile(join(paths.previewsDir, f));
  return fingerprintOf({ builtFiles, acceptance, previews });
}

/** G5 — §11.3: "branch, remote, base branch, and every (path, blob hash) in the package — including shared files." */
export async function computeG5Fingerprint(paths: Pick<RedesignPaths, 'packageJson'>, remote: string | null, baseBranch: string | null): Promise<string | null> {
  const packageHash = await hashFileOrNull(paths.packageJson);
  if (!packageHash) return null;
  return fingerprintOf({ packageHash, remote, baseBranch });
}

export interface GateFingerprintContext {
  dsRepoPath: string | null;
  dsRepoRemote: string | null;
  dsRepoBaseBranch: string | null;
  /** The upstream New Component Plan's path, for G3 — null when only the checklist export was used. */
  upstreamPlanPath: string | null;
}

/**
 * The single dispatch point `decide` (cli/index.ts) uses to compute a NEW decision's
 * fingerprint — kept here, not inlined in the CLI action, precisely so it is a plain function a
 * test can call directly without spinning up commander/a subprocess (this is the exact logic
 * that was broken: see this module's own header comment for what "broken" meant here).
 */
export async function computeGateFingerprint(gate: Gate, paths: RedesignPaths, ctx: GateFingerprintContext, unitId: string | null): Promise<string | null> {
  switch (gate) {
    case 'G0':
      return null; // §11.3: G0 has no fingerprinted content
    case 'G1':
      return computeG1Fingerprint(paths);
    case 'G2':
      return computeG2Fingerprint(paths);
    case 'G3':
      return computeG3Fingerprint(paths, ctx.upstreamPlanPath);
    case 'G4':
      return unitId ? computeG4Fingerprint(paths, ctx.dsRepoPath, unitId) : null;
    case 'G5':
      return computeG5Fingerprint(paths, ctx.dsRepoRemote, ctx.dsRepoBaseBranch);
  }
}
