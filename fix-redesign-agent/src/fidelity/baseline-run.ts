import { writeFile } from 'node:fs/promises';
import type { BrowserContext } from 'playwright';
import { openOfflineSnapshot } from '../preview/extract.ts';
import { BaselineImmutableError, DEFAULT_VIEWPORTS, baselineCovers, captureDesign, htmlSha256Of, readBaseline, snapshotTargets, writeBaselineOnce, type CaptureLimits } from './capture.ts';
import type { DesignBaseline, FidelityViewport } from './types.ts';

export interface EnsureBaselineArgs {
  context: BrowserContext;
  /** The run's pre-edit, stamped, standalone snapshot (`original.html`): the immutable original. */
  originalHtml: string;
  sectionIds: string[];
  path: string;
  viewports?: FidelityViewport[];
  limits?: Partial<CaptureLimits>;
  log?: (line: string) => void;
}

export interface EnsureBaselineResult {
  baseline: DesignBaseline | null;
  reused: boolean;
  /** Why there is no baseline (a failed capture is recorded, never papered over: the verifier then reports NOT VERIFIED). */
  error: string | null;
}

/**
 * Captures the original page's design/state/composition baseline BEFORE any edit, from the stamped pre-edit
 * snapshot (offline: no extra request reaches production). Reuses a stored baseline when it is valid, hash-bound,
 * from the same snapshot and covers the whole scope; never replaces a valid one and never silently rewrites a
 * tampered one. A failure is returned, not thrown, so interaction/design verification is reported as not verified
 * instead of failing the run.
 */
export async function ensureDesignBaseline(args: EnsureBaselineArgs): Promise<EnsureBaselineResult> {
  const log = args.log ?? (() => {});
  const viewports = args.viewports ?? DEFAULT_VIEWPORTS;
  const htmlSha = htmlSha256Of(args.originalHtml);
  const existing = await readBaseline(args.path);
  if (existing && baselineCovers(existing, args.sectionIds, viewports, htmlSha)) return { baseline: existing, reused: true, error: null };
  const errorPath = args.path.replace(/\.json$/, '.error.txt');
  // a valid baseline from a different snapshot or scope is immutable: do not even capture a competing one
  if (existing) return { baseline: null, reused: false, error: `a design baseline from a different snapshot or scope already exists at ${args.path}; it is immutable and was not replaced` };
  try {
    const { page, close } = await openOfflineSnapshot(args.context, args.originalHtml, { width: viewports[0]!.width, height: viewports[0]!.height });
    try {
      log(`B1 · capturing the original's design baseline (${args.sectionIds.length} section(s) × ${viewports.length} viewport(s)), offline from the pre-edit snapshot`);
      const capture = await captureDesign({ page, targets: snapshotTargets(args.sectionIds), viewports, source: { kind: 'pre-edit-snapshot', htmlSha256: htmlSha, url: null }, ...(args.limits ? { limits: args.limits } : {}), log });
      const baseline = await writeBaselineOnce(args.path, capture);
      return { baseline, reused: false, error: null };
    } finally { await close(); }
  } catch (err) {
    const message = err instanceof BaselineImmutableError ? err.message : `the design baseline could not be captured: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    await writeFile(errorPath, message).catch(() => undefined);
    return { baseline: null, reused: false, error: message };
  }
}
