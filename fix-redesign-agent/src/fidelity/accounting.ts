import type { CheckStatus, FindingOutcome } from '../preview/types.ts';
import type { ResolutionFile } from '../resolution/schema.ts';
import type { PreserveResult, PreserveSummary } from './types.ts';

/**
 * Property level, finding level and overall verification must say the same thing. A finding that changes something and breaks something it
 * was told to keep is never `fixed-verified`; preserve decisions without evidence are surfaced (not hidden); the check, the tallies and the
 * report all derive from the same `PreserveResult`s.
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Unverified preserve decisions nothing in the pipeline can ever turn into evidence: the verifier does not measure the property, does not capture the
 * state or theme, the section is hand-authored, there is no comparison at all, or the part names nothing the capture holds. (The rest — a missing box baseline, a moved element, a capped part — are actionable.) Matched on the
 * reason's leading words, which `preserve.ts` produces.
 */
const PRESERVE_BY_DESIGN = ['not measured by the verifier', 'state not captured by the verifier', 'theme not captured by the verifier', 'hand-authored section', 'inside a design-system component', 'no comparison available', 'part cannot be mapped'];
export const isByDesignPreserveReason = (reason: string): boolean => PRESERVE_BY_DESIGN.some((r) => reason.startsWith(r));

export function summarizePreserve(results: readonly PreserveResult[]): PreserveSummary {
  const reasons = new Map<string, number>();
  for (const r of results) if (r.verification !== 'preserved-verified') reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  const open = results.filter((r) => r.verification !== 'preserved-verified');
  const rank = (r: PreserveResult) => (r.verification === 'failed' ? 0 : 1);
  return {
    total: results.length,
    verified: results.filter((r) => r.verification === 'preserved-verified').length,
    failed: results.filter((r) => r.verification === 'failed').length,
    unverified: results.filter((r) => r.verification === 'unverified').length,
    byDesign: results.filter((r) => r.verification === 'unverified' && isByDesignPreserveReason(r.reason)).length,
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    worst: open.slice().sort((a, b) => rank(a) - rank(b) || a.findingId.localeCompare(b.findingId) || a.property.localeCompare(b.property) || a.targetId.localeCompare(b.targetId)).slice(0, 20)
      .map((r) => ({ targetId: r.targetId, findingId: r.findingId, property: r.property, state: r.state, verification: r.verification as 'failed' | 'unverified', detail: r.detail.slice(0, 300) })),
  };
}

/** The `ds-fix.preserved-unchanged` check: fail when something preserved changed, not-checked when preservation lacks evidence, pass when every decision is verified. */
export function preserveCheck(s: PreserveSummary): { status: CheckStatus; detail: string } {
  if (s.total === 0) return { status: 'pass', detail: 'no preserve decision to verify' };
  const top = s.reasons.slice(0, 3).map((r) => `${r.reason} ×${r.count}`).join(', ');
  const counts = `${s.verified} preserved-verified, ${s.failed} changed, ${s.unverified} unverified, of ${s.total}`;
  if (s.failed > 0) return { status: 'fail', detail: `${counts}${top ? ` (${top})` : ''}; first: ${s.worst[0]?.detail.slice(0, 160) ?? ''}` };
  if (s.unverified > 0) return { status: 'not-checked', detail: `${counts} (${top})` };
  return { status: 'pass', detail: counts };
}

/** Folds the preserve results into each finding's tallies, status and detail. */
export function reconcilePreserve(findings: FindingOutcome[], resolution: ResolutionFile | null, results: readonly PreserveResult[]): void {
  if (!resolution) return;
  for (const f of findings) {
    const mine = resolution.targets.filter((t) => t.findingId === f.findingId && t.outcome === 'preserve-existing');
    if (mine.length === 0) continue;
    const found = mine.map((t) => results.find((r) => r.targetId === t.id) ?? null);
    const failed = found.filter((r): r is PreserveResult => r?.verification === 'failed');
    const verified = found.filter((r) => r?.verification === 'preserved-verified').length;
    const unverified = mine.length - verified - failed.length; // no result at all counts as unverified, never as preserved
    f.targets = { ...(f.targets ?? { resolved: 0, verified: 0, failed: 0, unmeasurable: 0, preserved: mine.length, unresolved: 0 }), preservedVerified: verified, preservedFailed: failed.length, preservedUnverified: unverified };
    if (failed.length) {
      const what = failed.slice(0, 3).map((r) => `${r.property}${r.state === 'default' ? '' : ` [${r.state}]`}`).join(', ');
      const prefix = `${failed.length} preserved ${plural(failed.length, 'property', 'properties')} changed (${what}): ${failed[0]!.detail.slice(0, 140)}`;
      if (f.status === 'fixed-verified' || f.status === 'component-verified') { f.status = 'partially-verified'; delete f.reported; f.detail = `${prefix} — ${f.detail}`; }
      // a decision-preserved finding whose preserved property changed is no longer "explained by a decision": drop the flag so no check treats the failure as explained
      else if (f.status === 'preserved-by-decision') { f.status = 'unresolved'; delete f.reported; f.detail = `${prefix} — ${f.detail}`; }
      else f.detail = `${prefix} — ${f.detail}`;
    } else if (unverified > 0) {
      const reasons = [...new Set(found.filter((r): r is PreserveResult => !!r && r.verification === 'unverified').map((r) => r.reason))].slice(0, 3).join(', ');
      f.detail = `${f.detail}; ${unverified} preserve decision(s) not verified${reasons ? ` (${reasons})` : ''}`;
    }
  }
}
