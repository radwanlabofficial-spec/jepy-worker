-- 0014 — Track B: AI scraper selection + free-first email verification pipeline.
--
-- Two independent additive changes, forward-only:
--
--   A. AI scraper selection records its choice on the job row, so the decision
--      is auditable after the fact ("why did this URL go to BrightData?").
--   B. The email verification pipeline from
--      zerobounce_free_replacement_setup.md: Apify Verifier #1 (syntax+MX+
--      disposable) -> Apify Verifier #2 (UNKNOWN/RISKY only) -> ZeroBounce
--      free credits (hardest cases only) -> cache so an email is never
--      verified twice. Status model: VALID / INVALID / UNKNOWN / RISKY.
--
-- The existing email_verification_cache (0001) stores the old Layer-1 result
-- fields (layer/result/mx_json/is_disposable/is_role); it has no
-- provider-independent status, provider, or reason columns, so three additive
-- columns carry the design doc's status model. Existing rows are untouched.

-- ---------------------------------------------------------------------------
-- A. AI scraper selection (Item 3)
-- ---------------------------------------------------------------------------
ALTER TABLE job_queue ADD COLUMN provider_selected TEXT;
ALTER TABLE job_queue ADD COLUMN provider_select_reason TEXT;

-- ---------------------------------------------------------------------------
-- B. Email verification pipeline (Item 5)
-- ---------------------------------------------------------------------------

-- One row per verification attempt. The cache carries the FINAL status; the log
-- carries the history of how it got there (the design doc's pass1_*/pass2_*
-- fields, in rows rather than columns, because a pass may be retried).
CREATE TABLE email_verification_log (
  id          TEXT PRIMARY KEY,
  email_hash  TEXT NOT NULL,
  pass        INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  actor_id    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('VALID','INVALID','UNKNOWN','RISKY')),
  reason      TEXT,
  checked_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_verify_log_hash ON email_verification_log(email_hash);

ALTER TABLE email_verification_cache ADD COLUMN status TEXT
  CHECK (status IN ('VALID','INVALID','UNKNOWN','RISKY'));
ALTER TABLE email_verification_cache ADD COLUMN provider TEXT;
ALTER TABLE email_verification_cache ADD COLUMN reason TEXT;

-- Actor IDs the verifier runs through the settings table. NULL means "not
-- configured": verify.ts treats that as "queue but do not spend an Apify run"
-- rather than guessing an actor. The real free actors MUST be chosen by
-- benchmarking 100-200 emails per design doc section 13 — never ship a guess.
INSERT OR IGNORE INTO settings (key, value_text, updated_at) VALUES
  ('verify_actor_pass1', NULL, unixepoch()),
  ('verify_actor_pass2', NULL, unixepoch()),
  ('verify_cache_ttl_seconds', '2592000', unixepoch());
