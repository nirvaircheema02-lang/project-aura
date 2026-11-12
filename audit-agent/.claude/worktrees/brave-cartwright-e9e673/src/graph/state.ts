import type Database from 'better-sqlite3';

/**
 * ARCHITECTURE.md §2.2 — Graph State, run-level, separate from S0's per-finding
 * contract. This is a thin, typed layer directly over the SQL tables in
 * src/db/schema.sql — "declare SQL authoritative" (IMPLEMENTATION-PLAN.md §2),
 * no in-memory shadow copy.
 */

export type RunType = 'full-site' | 'single-page';
export type RunStatus =
  | 'PLANNING'
  | 'RUNNING'
  | 'AWAITING_SCOPE_CONFIRMATION'
  | 'AWAITING_PUBLISH_CONFIRMATION'
  | 'AWAITING_FAILURE_THRESHOLD_REVIEW'
  | 'COMPLETE'
  | 'FAILED'
  | 'ABORTED';

export interface RunRow {
  run_id: string;
  run_type: RunType;
  url: string;
  canonical_url: string | null;
  status: RunStatus;
  ds_registry_version: string;
  policy_version: string;
  started_at: number;
  scope_json: string | null;
  /** Full rendering-engine record (migration 0004). Null only for runs created before it existed. */
  rendering_policy_json: string | null;
  /** The process that owns this run while it is RUNNING (migration 0005). */
  owner_pid: number | null;
  /** Last liveness beat from the owner (migration 0006). */
  heartbeat_at: number | null;
}

/** How often an owner beats, and how long silence means the owner is gone. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = 3 * 60_000;

export interface FanOutCounts {
  dispatched: number;
  completed: number;
  failed: number;
  retrying: number;
  /** §4.4 — pages skipped because their DOM hash and the DS version were both unchanged. */
  cache_hits: number;
}

export type CheckpointName = 'scope_confirmation' | 'publish_confirmation' | 'failure_threshold';
export type CheckpointStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * Creates a run row. The partial UNIQUE index on runs(url, run_type) WHERE
 * status='RUNNING' (§2.5 rule 6 / B7) is what actually enforces the run-level
 * concurrency guard — this just surfaces that as a clear error instead of a
 * raw SQLite constraint message.
 */
export function createRun(
  db: Database.Database,
  input: Pick<RunRow, 'run_id' | 'run_type' | 'url' | 'ds_registry_version' | 'policy_version'> & {
    canonical_url?: string | null;
    scope_json?: string | null;
    rendering_policy_json?: string | null;
  },
): RunRow {
  try {
    db.prepare(
      `INSERT INTO runs (run_id, run_type, url, canonical_url, status, ds_registry_version, policy_version, started_at, scope_json, rendering_policy_json, owner_pid, heartbeat_at)
       VALUES (@run_id, @run_type, @url, @canonical_url, 'RUNNING', @ds_registry_version, @policy_version, @started_at, @scope_json, @rendering_policy_json, @owner_pid, @started_at)`,
    ).run({
      run_id: input.run_id,
      run_type: input.run_type,
      url: input.url,
      canonical_url: input.canonical_url ?? null,
      ds_registry_version: input.ds_registry_version,
      policy_version: input.policy_version,
      started_at: Date.now(),
      scope_json: input.scope_json ?? null,
      rendering_policy_json: input.rendering_policy_json ?? null,
      owner_pid: process.pid,
    });
    db.prepare('INSERT INTO fan_out (run_id) VALUES (?)').run(input.run_id);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: runs\.url, runs\.run_type/.test(err.message)) {
      const active = activeRunFor(db, input.url, input.run_type);
      throw new Error(
        `A ${input.run_type} run against ${input.url} is already RUNNING${active ? ` (${active})` : ''} — refusing to start a second concurrent run against the same target (ARCHITECTURE.md §2.5 rule 6 / B7). ` +
          `If no audit is actually running, clear it with:  pnpm run agent run-fail ${active ?? '<run_id>'}`,
      );
    }
    throw err;
  }
  return getRun(db, input.run_id) as RunRow;
}

/** The RUNNING run holding the §2.5 guard for this target, if any. */
export function activeRunFor(db: Database.Database, url: string, runType: RunType): string | null {
  const row = db.prepare(`SELECT run_id FROM runs WHERE url = ? AND run_type = ? AND status = 'RUNNING'`).get(url, runType) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

export function getRun(db: Database.Database, runId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
}

export function setRunStatus(db: Database.Database, runId: string, status: RunStatus): void {
  db.prepare('UPDATE runs SET status = ? WHERE run_id = ?').run(status, runId);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check only, nothing is sent
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours to signal
  }
}

/**
 * Marks RUNNING runs whose owning process is gone as FAILED, and says so. A
 * killed run (Ctrl-C, a closed terminal, a sleeping laptop, kill -9 — the
 * last two bypass any signal handler) would otherwise hold the §2.5
 * one-active-run-per-target guard forever. A run with no recorded owner
 * predates migration 0005 and cannot belong to a live process of this build.
 */
export function recoverStaleRuns(
  db: Database.Database,
  isAlive: (pid: number) => boolean = processIsAlive,
  now = Date.now(),
): Array<{ runId: string; url: string; ownerPid: number | null }> {
  const running = db.prepare(`SELECT run_id, url, owner_pid, heartbeat_at FROM runs WHERE status = 'RUNNING'`).all() as Array<{
    run_id: string;
    url: string;
    owner_pid: number | null;
    heartbeat_at: number | null;
  }>;
  // Stale: no owner recorded; or an owner that is not us and is either dead, or alive but
  // silent (its PID reused by an unrelated process after the real owner died).
  const stale = running.filter(
    (r) =>
      r.owner_pid === null ||
      (r.owner_pid !== process.pid && (!isAlive(r.owner_pid) || (r.heartbeat_at !== null && now - r.heartbeat_at > HEARTBEAT_STALE_MS))),
  );
  const mark = db.prepare(`UPDATE runs SET status = 'FAILED' WHERE run_id = ? AND status = 'RUNNING'`);
  const note = db.prepare(`INSERT INTO escalation_queue (run_id, node_id, reason, detail_json, created_at) VALUES (?, 'RUN', 'NODE_FAILURE', ?, ?)`);
  for (const r of stale) {
    mark.run(r.run_id);
    note.run(r.run_id, JSON.stringify({ error: `run interrupted: owning process ${r.owner_pid ?? 'unknown'} is gone or has stopped responding — marked FAILED` }), now);
  }
  return stale.map((r) => ({ runId: r.run_id, url: r.url, ownerPid: r.owner_pid }));
}

/**
 * Atomic counter increment (§2.5 rule 2) — `ON CONFLICT ... RETURNING`, never
 * read-modify-write. Safe under concurrent writers (verified in
 * IMPLEMENTATION-PLAN.md §2's grounding: returned 1 then 2 under concurrent calls).
 */
export function incrementFanOut(db: Database.Database, runId: string, field: keyof FanOutCounts, by = 1): number {
  const row = db
    .prepare(
      `INSERT INTO fan_out (run_id, ${field}) VALUES (@run_id, @by)
       ON CONFLICT (run_id) DO UPDATE SET ${field} = ${field} + @by
       RETURNING ${field}`,
    )
    .get({ run_id: runId, by }) as Record<string, number>;
  return row[field] as number;
}

export function getFanOut(db: Database.Database, runId: string): FanOutCounts {
  const row = db.prepare('SELECT dispatched, completed, failed, retrying, cache_hits FROM fan_out WHERE run_id = ?').get(runId) as
    | FanOutCounts
    | undefined;
  return row ?? { dispatched: 0, completed: 0, failed: 0, retrying: 0, cache_hits: 0 };
}

/** §2.4 partial fan-in: A4-equivalent consolidation may proceed once every dispatched branch reached a terminal state. */
export function fanOutSettled(counts: FanOutCounts): boolean {
  return counts.dispatched === counts.completed + counts.failed;
}

export function createCheckpoint(
  db: Database.Database,
  runId: string,
  name: CheckpointName,
  timeoutMs: number,
): void {
  db.prepare(
    `INSERT INTO checkpoints (run_id, name, status, timeout_at) VALUES (?, ?, 'PENDING', ?)`,
  ).run(runId, name, Date.now() + timeoutMs);
}

/**
 * Records a gate decision. Only a PENDING gate can be decided — an unknown run,
 * an unopened or unknown gate, or one already decided changes nothing — and
 * the return value says whether the decision was recorded.
 */
export function decideCheckpoint(
  db: Database.Database,
  runId: string,
  name: CheckpointName,
  status: Exclude<CheckpointStatus, 'PENDING'>,
  decidedBy: string,
): boolean {
  return (
    db
      .prepare(`UPDATE checkpoints SET status = ?, decided_by = ?, decided_at = ? WHERE run_id = ? AND name = ? AND status = 'PENDING'`)
      .run(status, decidedBy, Date.now(), runId, name).changes === 1
  );
}

/**
 * Takes ownership of a paused run for THIS process: status RUNNING and our pid,
 * in one statement, and only from one of the expected statuses — so two
 * concurrent `resume`s cannot both proceed, and the resumed run is not marked
 * FAILED by stale-run recovery for carrying the dead pid of the process that
 * started it.
 */
export function claimRun(db: Database.Database, runId: string, fromStatuses: RunStatus[]): boolean {
  const placeholders = fromStatuses.map(() => '?').join(', ');
  try {
    return (
      db
        .prepare(`UPDATE runs SET status = 'RUNNING', owner_pid = ?, heartbeat_at = ? WHERE run_id = ? AND status IN (${placeholders})`)
        .run(process.pid, Date.now(), runId, ...fromStatuses).changes === 1
    );
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: runs\.url, runs\.run_type/.test(err.message)) {
      throw new Error(`Another run against the same target is already RUNNING — refusing to resume ${runId} concurrently (ARCHITECTURE.md §2.5 rule 6).`);
    }
    throw err;
  }
}

/** Liveness beat for the run this process owns; stale-run recovery reads it (see recoverStaleRuns). */
export function heartbeat(db: Database.Database, runId: string): void {
  db.prepare(`UPDATE runs SET heartbeat_at = ? WHERE run_id = ? AND owner_pid = ?`).run(Date.now(), runId, process.pid);
}

export interface CheckpointRow {
  run_id: string;
  name: CheckpointName;
  status: CheckpointStatus;
  decided_by: string | null;
  decided_at: number | null;
  timeout_at: number | null;
}

export function getCheckpoint(db: Database.Database, runId: string, name: CheckpointName): CheckpointRow | undefined {
  return db.prepare('SELECT * FROM checkpoints WHERE run_id = ? AND name = ?').get(runId, name) as
    | CheckpointRow
    | undefined;
}

/**
 * §4.2: gates auto-escalate to a fallback reviewer on timeout — never
 * auto-approve, never auto-reject. Returns true if `name` has timed out
 * while still PENDING; the caller is responsible for actually paging a
 * fallback reviewer.
 */
export function checkpointTimedOut(checkpoint: CheckpointRow, now = Date.now()): boolean {
  return checkpoint.status === 'PENDING' && checkpoint.timeout_at !== null && now >= checkpoint.timeout_at;
}
