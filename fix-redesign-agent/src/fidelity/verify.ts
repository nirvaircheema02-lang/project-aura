import type { Browser } from 'playwright';
import type { Exemption, ResolutionFile } from '../resolution/schema.ts';
import { setVerification } from '../resolution/store.ts';
import { captureDesign, hintsFromBaseline, previewTargets } from './capture.ts';
import { compareDesign } from './compare.ts';
import type { BudgetTracker } from './loop.ts';
import { evaluatePreserveTargets } from './preserve.ts';
import type { DesignBaseline, DesignCapture, FidelityReport } from './types.ts';

export interface FidelityVerifyInput {
  browser: Browser;
  url: string;
  baseline: DesignBaseline | null;
  sectionIds: string[];
  overrideSectionIds: ReadonlySet<string>;
  exemptions: Exemption[];
  /** DS-first: mounted design-system components own their design (see CompareInput). */
  dsFirst?: boolean;
  budget?: BudgetTracker;
  log?: (line: string) => void;
}

/**
 * Captures the running preview with the SAME routine, viewports, limits and settling as the baseline, then compares.
 * Nothing but the preview itself is contacted. Without a baseline nothing is captured and the verdict is `not-checked`.
 */
export async function verifyFidelity(input: FidelityVerifyInput): Promise<{ report: FidelityReport; observed: DesignCapture | null }> {
  if (!input.baseline) return { report: compareDesign({ baseline: null, observed: null, exemptions: input.exemptions }), observed: null };
  const host = new URL(input.url).host;
  const ctx = await input.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', (route) => { try { return new URL(route.request().url()).host === host || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort(); } catch { return route.abort(); } });
  try {
    const page = await ctx.newPage();
    await page.goto(input.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const observed = await captureDesign({ page, targets: previewTargets(input.sectionIds), viewports: input.baseline.viewports, limits: input.baseline.limits, hints: hintsFromBaseline(input.baseline), source: { kind: 'preview', htmlSha256: null, url: input.url }, ...(input.budget ? { shouldStop: () => input.budget!.timeUp() } : {}), ...(input.log ? { log: input.log } : {}) });
    const report = compareDesign({ baseline: input.baseline, observed, exemptions: input.exemptions, overrideSectionIds: input.overrideSectionIds, ...(input.dsFirst ? { dsFirst: true } : {}) });
    return { report, observed };
  } finally { await ctx.close(); }
}

export { evaluatePreserveTargets } from './preserve.ts';

/**
 * Writes the verification status of every PRESERVE decision from POSITIVE evidence (see `preserve.ts`): preserved-verified only when the
 * same element, part, property, state and viewport were compared and agree; failed on a measured unauthorized difference or a confirmed
 * removal; unverified, with the specific reason, for everything short of evidence. A preserve decision is never claimed from silence.
 */
export function applyFidelityToTargets(resolution: ResolutionFile, report: FidelityReport, baseline: DesignBaseline | null, exemptions: Exemption[] = [], overrideSectionIds?: ReadonlySet<string>): void {
  for (const r of evaluatePreserveTargets({ resolution, report, baseline, exemptions, ...(overrideSectionIds ? { overrideSectionIds } : {}) })) setVerification(resolution, (x) => x.id === r.targetId, r.verification, r.detail);
}
