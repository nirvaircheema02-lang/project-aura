-- A gate's `from` node must persist whatever the gate needs BEFORE pausing:
-- resume re-enters routing, it does not re-run the node (ARCHITECTURE.md §2
-- orchestrator shape). A2 persists its scope into runs.scope_json; A4's master
-- result needs somewhere equivalent, or approving the Publish Gate after a
-- process restart would resume with an empty result.
CREATE TABLE run_results (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  node_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
