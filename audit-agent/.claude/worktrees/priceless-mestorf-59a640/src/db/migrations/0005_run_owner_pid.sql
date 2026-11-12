-- The process that owns a RUNNING run. A run whose owner has died (Ctrl-C,
-- a closed terminal, a laptop that slept) would otherwise stay RUNNING
-- forever, and the runs_active_target guard would then refuse every later
-- audit of the same URL. recoverStaleRuns() marks such runs FAILED.
ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
