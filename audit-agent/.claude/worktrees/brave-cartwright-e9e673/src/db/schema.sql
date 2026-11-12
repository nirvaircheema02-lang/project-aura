-- Run-level Graph State (ARCHITECTURE.md §2.2)
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL CHECK (run_type IN ('full-site','single-page')),
  url TEXT NOT NULL,
  canonical_url TEXT,
  status TEXT NOT NULL,               -- PLANNING..COMPLETE (§2.2)
  ds_registry_version TEXT NOT NULL,  -- content hash, D6
  policy_version TEXT NOT NULL,       -- S8/S9 policy snapshot at run start
  started_at INTEGER NOT NULL,
  scope_json TEXT                     -- template families, page count, est. B-instance count
);

-- Run-level concurrency guard (§2.5 rule 6) — verified working via this exact pattern
CREATE UNIQUE INDEX runs_active_target ON runs(url, run_type) WHERE status = 'RUNNING';

CREATE TABLE checkpoints (            -- §2.2 checkpoints[]
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  name TEXT NOT NULL,                 -- 'scope_confirmation' | 'publish_confirmation' | 'failure_threshold'
  status TEXT NOT NULL,               -- PENDING | APPROVED | REJECTED
  decided_by TEXT, decided_at INTEGER,
  timeout_at INTEGER,                 -- gate-timeout-to-fallback-reviewer
  PRIMARY KEY (run_id, name)
);

CREATE TABLE fan_out (                -- §2.2 fan_out counters, atomic via ON CONFLICT
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  dispatched INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  retrying INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE findings (               -- S0 Result Contract, §2.5 rule 1's 4-part key
  run_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  node_id TEXT NOT NULL,              -- which agent node produced this (B3, B4, ...)
  finding_id TEXT NOT NULL,           -- stable content fingerprint, survives across runs (§4.4 diffing)
  classification TEXT NOT NULL,       -- MATCH | DEVIATION | INCORRECT | NEW_COMPONENT | DS_CANDIDATE
  confidence REAL,
  confidence_band TEXT,               -- HIGH | MEDIUM | LOW
  escalation_status TEXT,             -- NONE | QUEUED | IN_REVIEW | RESOLVED
  registry_update_ref TEXT,
  payload_json TEXT NOT NULL,         -- full S0 record: identity/location/component/classification/comparison/quality/action/history
  PRIMARY KEY (run_id, page_id, node_id, finding_id)
);

CREATE TABLE escalation_queue (
  run_id TEXT NOT NULL, page_id TEXT, node_id TEXT, finding_id TEXT,
  reason TEXT NOT NULL,               -- LOW_CONFIDENCE | NODE_FAILURE
  detail_json TEXT, status TEXT NOT NULL DEFAULT 'QUEUED',
  created_at INTEGER NOT NULL
);

CREATE TABLE registry_update_requests (  -- §4.1, S9
  candidate_ref TEXT PRIMARY KEY,
  proposed_by TEXT NOT NULL,          -- 'B6'
  status TEXT NOT NULL,               -- PROPOSED | UNDER_REVIEW | APPROVED | REJECTED | MERGED
  signature TEXT NOT NULL,            -- content-addressed dedup key, §2.5 rule 3
  reviewed_by TEXT, merged_at INTEGER
);
CREATE UNIQUE INDEX rur_signature ON registry_update_requests(signature)
  WHERE status IN ('PROPOSED','UNDER_REVIEW');   -- dedup: one live request per pattern

CREATE TABLE audit_history (          -- S7, baselines for §4.4 diffing
  page_id TEXT NOT NULL, run_id TEXT NOT NULL, dom_hash TEXT NOT NULL,
  ds_registry_version TEXT NOT NULL, completed_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, run_id)
);

CREATE TABLE spans (                  -- §2.6, OTel-shaped, GenAI semantic conventions
  span_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, page_id TEXT, node_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, error_detail TEXT
);
