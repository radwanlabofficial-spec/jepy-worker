-- 0009: apify_runs table for async Wave 2 signal collection.
--
-- The sync `run-sync-get-dataset-items` endpoint blocks until the actor
-- finishes (2-5 min on free plan), but Cloudflare's edge times out at ~100s.
-- The async pattern splits collection into START (launch run, <2s) and
-- POLL (check status, fetch results when done). Run state lives here so any
-- worker invocation can resume.
CREATE TABLE IF NOT EXISTS apify_runs (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('hiring', 'ads', 'funding')),
  actor TEXT NOT NULL,
  apify_run_id TEXT,
  dataset_id TEXT,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'running', 'succeeded', 'failed', 'timeout')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error TEXT,
  signals_written INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_apify_runs_status ON apify_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_apify_runs_lead ON apify_runs(lead_id, family);
