import type Database from 'better-sqlite3';

/**
 * S9 — Registry Update Governance (ARCHITECTURE.md §4.1). The DS Candidate →
 * Registry write-back lifecycle: PROPOSED → UNDER_REVIEW → APPROVED|REJECTED
 * → MERGED. Only B6 proposes; only C3 merges an approved request.
 *
 * Dedup is structural, not best-effort: the partial UNIQUE index on
 * `signature WHERE status IN ('PROPOSED','UNDER_REVIEW')` means a repeated
 * pattern across pages and runs absorbs into the SAME live request instead of
 * spawning duplicates (§2.5 rule 3).
 */

export type RegistryUpdateStatus = 'PROPOSED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'MERGED';

export interface ProposeResult {
  candidateRef: string;
  created: boolean;
  /** The request's status — including when it already existed and nothing was inserted. */
  status: RegistryUpdateStatus;
}

/**
 * Proposes a DS Candidate, or absorbs it into the existing request for the
 * same ref/signature. `candidateRef` is DETERMINISTIC per pattern
 * (`cand-<signature>`, B6), so a re-audit of a page proposes the exact same
 * ref every time. Looking it up ONLY among live statuses (as the original
 * dedup intended) meant a REJECTED or MERGED request — a decision already
 * made — was invisible to this query, so the next run's B6 tried to INSERT
 * the same primary key again and crashed the node on a UNIQUE constraint
 * (third-pass review CH-2: the whole page's findings were lost, right after
 * a human used the governance gate as designed). Looking up by ref FIRST,
 * regardless of status, makes every status idempotent: a live request
 * absorbs the repeat as before; a decided one (REJECTED/APPROVED/MERGED) is
 * returned as-is and never reproposed or overwritten.
 */
export function proposeRegistryUpdate(db: Database.Database, input: { candidateRef: string; signature: string; proposedBy: string }): ProposeResult {
  const byRef = db.prepare(`SELECT candidate_ref, status FROM registry_update_requests WHERE candidate_ref = ?`).get(input.candidateRef) as
    | { candidate_ref: string; status: RegistryUpdateStatus }
    | undefined;
  if (byRef) return { candidateRef: byRef.candidate_ref, created: false, status: byRef.status };

  // Belt-and-braces: a live request for the same SIGNATURE under a different ref (only possible if
  // a caller ever changes the ref scheme) still absorbs into it rather than creating a duplicate.
  const bySignature = db
    .prepare(`SELECT candidate_ref, status FROM registry_update_requests WHERE signature = ? AND status IN ('PROPOSED','UNDER_REVIEW')`)
    .get(input.signature) as { candidate_ref: string; status: RegistryUpdateStatus } | undefined;
  if (bySignature) return { candidateRef: bySignature.candidate_ref, created: false, status: bySignature.status };

  db.prepare(
    `INSERT INTO registry_update_requests (candidate_ref, proposed_by, status, signature) VALUES (?, ?, 'PROPOSED', ?)`,
  ).run(input.candidateRef, input.proposedBy, input.signature);
  return { candidateRef: input.candidateRef, created: true, status: 'PROPOSED' };
}

const ALLOWED: Record<RegistryUpdateStatus, RegistryUpdateStatus[]> = {
  PROPOSED: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['MERGED'],
  REJECTED: [],
  MERGED: [],
};

/** Enforces the lifecycle — an out-of-order transition throws rather than quietly rewriting governance state. */
export function transitionRegistryUpdate(
  db: Database.Database,
  candidateRef: string,
  to: RegistryUpdateStatus,
  reviewedBy: string,
): void {
  const row = db.prepare('SELECT status FROM registry_update_requests WHERE candidate_ref = ?').get(candidateRef) as
    | { status: RegistryUpdateStatus }
    | undefined;
  if (!row) throw new Error(`S9: no registry update request ${candidateRef}`);
  if (!ALLOWED[row.status].includes(to)) {
    throw new Error(`S9: illegal transition ${row.status} → ${to} for ${candidateRef} (allowed: ${ALLOWED[row.status].join(', ') || 'none'})`);
  }
  db.prepare(
    `UPDATE registry_update_requests SET status = ?, reviewed_by = ?, merged_at = ? WHERE candidate_ref = ?`,
  ).run(to, reviewedBy, to === 'MERGED' ? Date.now() : null, candidateRef);
}
