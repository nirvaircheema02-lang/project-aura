-- Liveness beyond the bare PID: the owning process updates heartbeat_at every
-- ~30s while a run is RUNNING. A PID can be reused by an unrelated process
-- after the owner dies (so "is the pid alive?" alone can keep a dead run
-- RUNNING forever); a run whose beats have stopped is stale regardless.
ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
