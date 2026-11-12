import type Database from 'better-sqlite3';
import type { CheckpointName } from './state.ts';

/**
 * §4.2: gates time out to a FALLBACK REVIEWER — never to auto-approve and
 * never to auto-reject. A timed-out gate stays PENDING; what changes is that
 * somebody else is now asked to look at it.
 *
 * The escalation is written once per gate (not once per poll), so a run left
 * paused over a weekend produces one item in the queue rather than thousands.
 */

export interface TimedOutGate {
  runId: string;
  name: CheckpointName;
  timeoutAt: number;
  escalated: boolean;
}

export function escalateTimedOutGates(db: Database.Database, now = Date.now()): TimedOutGate[] {
  const pending = db
    .prepare(`SELECT run_id, name, timeout_at FROM checkpoints WHERE status = 'PENDING' AND timeout_at IS NOT NULL AND timeout_at <= ?`)
    .all(now) as Array<{ run_id: string; name: CheckpointName; timeout_at: number }>;

  const insert = db.prepare(
    `INSERT INTO escalation_queue (run_id, page_id, node_id, finding_id, reason, detail_json, created_at)
     VALUES (?, NULL, ?, ?, 'NODE_FAILURE', ?, ?)`,
  );
  const already = db.prepare(`SELECT 1 FROM escalation_queue WHERE run_id = ? AND finding_id = ?`);

  const out: TimedOutGate[] = [];
  for (const row of pending) {
    const marker = `gate-timeout:${row.name}`;
    const seen = already.get(row.run_id, marker);
    if (!seen) {
      insert.run(
        row.run_id,
        row.name,
        marker,
        JSON.stringify({
          kind: 'GATE_TIMEOUT',
          gate: row.name,
          timedOutAt: row.timeout_at,
          note: 'Gate passed its timeout awaiting a decision. It remains PENDING — a fallback reviewer must decide; nothing is auto-approved or auto-rejected (§4.2).',
        }),
        now,
      );
    }
    out.push({ runId: row.run_id, name: row.name, timeoutAt: row.timeout_at, escalated: !seen });
  }
  return out;
}

/** Gates currently awaiting a human, with how long they have been waiting. */
export function pendingGates(db: Database.Database, now = Date.now()) {
  return (
    db.prepare(`SELECT run_id, name, timeout_at FROM checkpoints WHERE status = 'PENDING'`).all() as Array<{
      run_id: string;
      name: CheckpointName;
      timeout_at: number | null;
    }>
  ).map((row) => ({
    runId: row.run_id,
    name: row.name,
    timedOut: row.timeout_at !== null && now >= row.timeout_at,
    waitingMs: row.timeout_at === null ? null : Math.max(0, now - (row.timeout_at - 24 * 60 * 60_000)),
  }));
}
