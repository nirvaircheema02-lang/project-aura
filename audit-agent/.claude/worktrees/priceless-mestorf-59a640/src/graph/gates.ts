import type Database from 'better-sqlite3';
import { createCheckpoint, checkpointTimedOut, getCheckpoint, type CheckpointName, type RunStatus } from './state.ts';

const CHECKPOINT_TO_STATUS: Record<CheckpointName, RunStatus> = {
  scope_confirmation: 'AWAITING_SCOPE_CONFIRMATION',
  publish_confirmation: 'AWAITING_PUBLISH_CONFIRMATION',
  failure_threshold: 'AWAITING_FAILURE_THRESHOLD_REVIEW',
};

export function statusForGate(name: CheckpointName): RunStatus {
  return CHECKPOINT_TO_STATUS[name];
}

/**
 * §4.2 — opens a gate: creates its checkpoint row and returns the run status
 * the run should move to. The engine (engine.ts) is responsible for actually
 * setting that status and stopping the walk; this module only owns gate
 * bookkeeping so it's independently testable.
 */
export function openGate(db: Database.Database, runId: string, name: CheckpointName, timeoutMs: number): RunStatus {
  createCheckpoint(db, runId, name, timeoutMs);
  return statusForGate(name);
}

export type GateOutcome = 'NOT_OPENED' | 'APPROVED' | 'REJECTED' | 'PENDING' | 'TIMED_OUT_AWAITING_FALLBACK';

/**
 * What should happen for a gate right now — never resolves a timeout as
 * approve/reject on its own. `NOT_OPENED` (no checkpoint row exists yet) is
 * deliberately distinct from `PENDING` (a checkpoint row exists and is still
 * awaiting a decision) — conflating them previously caused a re-check to call
 * openGate a second time and crash on the checkpoints table's own PK.
 */
export function gateOutcome(db: Database.Database, runId: string, name: CheckpointName, now = Date.now()): GateOutcome {
  const checkpoint = getCheckpoint(db, runId, name);
  if (!checkpoint) return 'NOT_OPENED';
  if (checkpoint.status !== 'PENDING') return checkpoint.status as 'APPROVED' | 'REJECTED';
  return checkpointTimedOut(checkpoint, now) ? 'TIMED_OUT_AWAITING_FALLBACK' : 'PENDING';
}
