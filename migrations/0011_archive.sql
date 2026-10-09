-- Track A, Item 2: R2 hybrid cold storage.
--
-- Leads older than 90 days move OUT of the hot D1 table into R2
-- (`jepy-raw` bucket, `archives/leads/<YYYY-MM-DD>/batch-<epoch>.jsonl`) so the
-- free-tier D1 budget (5M reads/day, 100k writes/day) is spent on live leads,
-- not history. The dashboard keeps querying D1 (hot leads only); an archived
-- lead stays readable on demand from R2 via GET /archive/leads.
--
-- Why `archived_at` instead of deleting: a DELETE would destroy the row the
-- dashboard's "Total leads" counter and the dedup pipeline rely on, and an
-- archived lead may still need re-activation. Marking keeps the row's identity
-- (and its dedup_key) while excluding it from every hot query via
-- `archived_at IS NULL` — the same soft-delete pattern as `deleted_at`.
--
-- Why a separate log table: the R2 write and the D1 mark are two systems that
-- cannot be transactional. The log records exactly which R2 key holds which
-- leads, so a run that crashes between the R2 put and the D1 mark is
-- diagnosable and re-runnable (the next run just writes a second batch; the
-- D1 mark is the idempotency guard, so no lead is ever archived twice).
CREATE TABLE IF NOT EXISTS lead_archive_log (
  id               TEXT PRIMARY KEY,
  r2_key           TEXT NOT NULL,
  lead_count       INTEGER NOT NULL,
  oldest_created_at INTEGER,
  newest_created_at INTEGER,
  created_at       INTEGER NOT NULL
);

ALTER TABLE leads ADD COLUMN archived_at INTEGER;

-- Partial index: D1 (SQLite) supports partial indexes, and this one covers only
-- the hot candidate set (archived_at IS NULL), so the archive job's candidate
-- scan never touches the cold history it already moved out.
CREATE INDEX IF NOT EXISTS idx_leads_archive_candidate
  ON leads(archived_at, created_at) WHERE archived_at IS NULL;
