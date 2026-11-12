import { statusOf } from './status.ts';
import type { PreviewVerification } from './types.ts';

/**
 * The rule behind `decide G2 --outcome approve`: a visual approval is only recorded against a
 * preview that was produced AND verified. The static export is never an acceptable substitute, and
 * a FAILED verification is only approved when the reviewer explicitly accepts it. An INCOMPLETE one (nothing
 * required failed, but required evidence is missing) stays approvable - G2 is the user's decision - yet the
 * recorded note names every failure and every unverified requirement that was accepted, never "PASS" by silence.
 */
export type G2ApprovalCheck = { ok: true; note: string | null } | { ok: false; lines: string[] };

const NOTE_GAPS = 8;
const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function checkG2Approval(v: PreviewVerification | null, opts: { acceptPreviewFailures: boolean; note: string | null; verificationPath: string; redesignRunId: string }): G2ApprovalCheck {
  if (!v) {
    return { ok: false, lines: [`Cannot approve G2: ${opts.verificationPath} does not exist — the React preview was not produced and verified for this run, and the static export is not an acceptable substitute. Run \`pnpm run agent resume ${opts.redesignRunId}\` (or \`preview ${opts.redesignRunId} --regenerate\`).`] };
  }
  // the effective status: the stored one, or one derived from an older file (an old `pass` whose fidelity was not-checked is not a pass)
  const s = statusOf(v);
  const failed = v.checks.filter((c) => c.status === 'fail');
  // failed required items that are not a failed check of their own (a regression or a changed preserved property whose check is the same fact)
  const failedGaps = s.gaps.filter((g) => g.kind === 'failed' && g.family !== 'checks' && !(g.family === 'fidelity:regression' && failed.some((c) => c.id === 'fidelity.design-state')) && !(g.family === 'preserve:changed' && failed.some((c) => c.id === 'ds-fix.preserved-unchanged')));
  if (s.verdict === 'fail' && !opts.acceptPreviewFailures) {
    return { ok: false, lines: [`Cannot approve G2: the React preview's verification FAILED (${failed.length ? `${failed.length} check(s)` : `${s.failedRequired} required item(s)`}${s.unverifiedRequired ? `; ${s.unverifiedRequired} more required check(s) are not verified` : ''}):`, ...failed.map((c) => `  - ${c.name} — ${c.detail}`), ...failedGaps.map((g) => `  - ${g.text}`), 'Fix the cause and regenerate, request changes, or approve explicitly with --accept-preview-failures.'] };
  }
  const notes: string[] = [];
  if (opts.note) notes.push(opts.note);
  if (s.verdict === 'fail') notes.push(`ACCEPTED FAILED PREVIEW CHECKS: ${failed.length ? failed.map((c) => c.id).join(', ') : failedGaps.map((g) => short(g.text, 160)).join('; ')}`);
  const unverified = s.gaps.filter((g) => g.kind === 'unverified');
  if (unverified.length) {
    const rest = unverified.length - NOTE_GAPS + s.gapsTruncated;
    notes.push(`ACKNOWLEDGED UNVERIFIED REQUIRED CHECKS: ${s.unverifiedRequired} required check(s) not verified — ${unverified.slice(0, NOTE_GAPS).map((g) => short(g.text)).join(' | ')}${rest > 0 ? ` | …and ${rest} more (see verification.json, status.gaps)` : ''}`);
  }
  return { ok: true, note: notes.length ? notes.join(' · ') : opts.note };
}
