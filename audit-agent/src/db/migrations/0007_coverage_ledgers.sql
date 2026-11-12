-- B7's final coverage ledger (Decision Log #45), one per audited page and run. A page whose DOM, Design System
-- and audit policy are unchanged is reused from its previous run (§4.4); the reused page must carry that run's
-- ledger, or the Coverage Gate could not say whether anything on it was left unaccounted. Stored as one JSON
-- document — it is read whole, never queried.
CREATE TABLE coverage_ledgers (
  run_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  ledger_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, page_id)
);
