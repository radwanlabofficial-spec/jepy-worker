-- 0005_cron_run_device_sweep.sql — two more names, and the prefix the default
-- branch already needed. ADR-046.
--
-- 0002 widened this CHECK from three names to ten and wrote down why the failure
-- it was fixing is the worst shape a scheduler can have: "the work ran and the
-- record of it did not". Two additions here, and the first one is that same
-- mistake being made again by a new step.
--
-- `device_sweep` — the hourly tick now labels a device that has gone quiet for
-- forty-eight hours. Written without this migration, the sweep DID run (a test
-- device was correctly marked `stale`) and recording it threw a CHECK failure,
-- which turned a healthy hour into a 500 and stopped the rest of the tick. The
-- device state was right and the evidence of how it got that way was missing.
--
-- `unknown:<expression>` — `runScheduled`'s default branch answers an
-- unrecognised cron by RECORDING it under this name, on the stated principle that
-- "a trigger that fires into nothing is how a schedule silently stops being a
-- schedule". THAT BRANCH IS UNREACHABLE TODAY, and deliberately so:
-- `/api/admin/run-cron` refuses any expression that is not in `CRONS`, and the
-- triggers are fixed in wrangler.toml. It is not dead code to be deleted — it is
-- the last line of defence for a schedule that stops matching — but until this
-- migration it could not have done its job: the name it writes was never a value
-- the old CHECK accepted, so the fallback would have thrown at exactly the moment
-- it existed to leave a trace. A closed list cannot hold a name whose whole point
-- is that it is not on the list, which is what the LIKE clause is for.
--
-- The honest label for this half is "made correct, not observed": no test can
-- reach it without weakening the validation that protects it.
--
-- 0001 is immutable by rule (ADR-028) and 0002 already rebuilt this table the same
-- way. SQLite cannot alter a CHECK constraint, so the table is rebuilt and its
-- rows copied. No column is added, removed or retyped. Every name 0002 allowed is
-- kept, because removing one would delete the meaning of rows already written
-- under it.

CREATE TABLE cron_runs_new (
  id                TEXT PRIMARY KEY,
  cron_name         TEXT NOT NULL
                      CHECK (
                        cron_name LIKE 'unknown:%'
                        OR cron_name IN (
                          'dispatcher', 'daily_reset', 'weekly_backup',
                          'budget_guard', 'quota_rollover', 'credential_test',
                          'retention_purge', 'reconcile', 'feedback_loop', 'dataset_import',
                          'device_sweep'
                        )
                      ),
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
