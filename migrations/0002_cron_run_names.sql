-- 0002_cron_run_names.sql — widen cron_runs.cron_name. ADR-041.
--
-- 0001 froze this CHECK to three names ('dispatcher','daily_reset',
-- 'weekly_backup') because the plan described THREE cron triggers. The contract
-- later grew to NINE scheduled jobs, and the hourly tick records each job under
-- its own name — so seven of the nine failed their CHECK on insert, which is the
-- worst possible shape for a scheduler: the work ran and the record of it did not.
--
-- 0001 is immutable by rule (ADR-028), so this is a new migration. SQLite cannot
-- alter a CHECK constraint, so the table is rebuilt and its rows copied. No
-- column is added, removed or retyped: only the enum widens.
--
-- The old names are kept. 'daily_reset' is no longer emitted, but removing it
-- would delete the meaning of rows already written under it.

CREATE TABLE cron_runs_new (
  id                TEXT PRIMARY KEY,
  cron_name         TEXT NOT NULL
                      CHECK (cron_name IN (
                        'dispatcher', 'daily_reset', 'weekly_backup',
                        'budget_guard', 'quota_rollover', 'credential_test',
                        'retention_purge', 'reconcile', 'feedback_loop', 'dataset_import'
                      )),
  started_at        INTEGER,
  finished_at       INTEGER,
  jobs_dispatched   INTEGER,
  sub_requests_used INTEGER,
  status            TEXT,
  error_text        TEXT
);

INSERT INTO cron_runs_new
  SELECT id, cron_name, started_at, finished_at, jobs_dispatched, sub_requests_used, status, error_text
    FROM cron_runs;

DROP TABLE cron_runs;
ALTER TABLE cron_runs_new RENAME TO cron_runs;

CREATE INDEX idx_cron_runs_name ON cron_runs(cron_name, started_at);
