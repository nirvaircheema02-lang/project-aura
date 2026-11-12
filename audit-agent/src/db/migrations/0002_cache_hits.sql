-- §2.2 Graph State: cache_hits belongs with the other fan-out counters.
-- §4.4 re-audit memoization increments it when a page is skipped because both
-- its DOM hash and the DS registry version are unchanged since its last audit.
ALTER TABLE fan_out ADD COLUMN cache_hits INTEGER NOT NULL DEFAULT 0;
