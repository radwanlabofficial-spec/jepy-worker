-- 0006_scoring_inputs_and_audit_enums.sql
--
-- Three small schema faults found by auditing the code against the rules, plus
-- the two settings keys STEP 10/12 need. 0001 is immutable by rule (ADR-028), so
-- this is a new forward-only migration.
--
-- WHY EACH ITEM IS HERE
--
-- 1. `leads.has_website` — 03-execution.md STEP 8 calls `has_website = 0` "the
--    most valuable free signal" and STEP 10 lists `has_website` among the Wave 1
--    outputs. `adapters/tech_probe.ts:259` already emits the field and there is no
--    column to put it in, so the one signal the whole budget argument rests on is
--    computed and then thrown away. A COLUMN, not a signal row: it must be
--    filterable in a `WHERE` clause to build the probe queue, and `lead_signals`
--    is keyed for lookup, not for scanning.
--
-- 2. `geo_targets.outreach_allowed` — 16-compliance.md §8 and 11-api-contract.md
--    §9 require an outreach block on Canada and Germany, enforceable per geo
--    target. Without a column the block cannot be expressed at all, so STEP 16
--    has nowhere to stand. Default 1 (allowed) because every existing row
--    predates the block and a default of 0 would silently stop outreach for
--    markets nobody decided to stop.
--
-- 3. `audit_log` enums — R25 requires an `entity_type='directory_source'` row for
--    every Class C override, and 12-scoring.md §3.1 requires an
--    `action='gate_auto_tighten'` row when budget pressure moves the AI gate.
--    0001 permits neither, so `routes/providers.ts:100-106` currently works
--    around it by logging account creation as `entity_type='credential'` with a
--    `kind` buried in `detail_json`. That workaround is worse than the problem:
--    "who added a provider account" and "who added a credential" stop being
--    different questions. SQLite cannot alter a CHECK, so the table is rebuilt
--    and its rows copied, exactly as 0002 did for `cron_runs`.
--
--    The action list also gains `draft`, `activate` and `heal` because the
--    selector-pack lifecycle in R23 (draft -> approve -> active, plus the
--    self-healing path) records those transitions, and `update` for a directory
--    transport edit. `capture_override` stays in the list because Mode B's
--    override audit entry is already specified by R25 even though the endpoint is
--    gated behind ADR-035.
--
-- 4. `settings.score_version` — `lead_scores` carries both `weights_version` and
--    `score_version` (R9), and only the first has a source. `score_version` is a
--    monotonically increasing counter, not a hash: its job is to answer "did the
--    scoring engine change between these two rows" without trusting git.
--
-- 5. `settings.outreach_blocked_countries` — the country list lives in `settings`
--    rather than in code so that adding a country is a PATCH, and removing one is
--    visible in `audit_log`, rather than a redeploy that nobody reviews.
--
-- AUTHORITY: R25, R9, ADR-028; 03-execution.md STEP 8/10/16; 12-scoring.md §3.1;
-- 16-compliance.md §8; 11-api-contract.md §9. These widen enums and add columns
-- to match rules that already exist — they do not change a locked decision, so
-- no new ADR is required to apply them. The `entity_type` workaround removal in
-- `routes/providers.ts` is a behaviour change and is covered by the ADR drafted
-- separately.

-- ---------------------------------------------------------------------------
-- 1. The free signal that had nowhere to live
-- ---------------------------------------------------------------------------

-- NULL means "not yet probed", 0 means "probed, no website", 1 means "probed,
-- website answered". The three are different facts and STEP 10's provisional-tier
-- rule depends on the distinction — the same reason `routes/leads.ts` renders a
-- missing value as an em-dash rather than a zero.
ALTER TABLE leads ADD COLUMN has_website INTEGER CHECK (has_website IN (0,1));

-- ---------------------------------------------------------------------------
-- 2. A place to express the outreach block
-- ---------------------------------------------------------------------------

ALTER TABLE geo_targets ADD COLUMN outreach_allowed INTEGER NOT NULL DEFAULT 1
  CHECK (outreach_allowed IN (0,1));

-- ---------------------------------------------------------------------------
-- 3. audit_log — widen the two enums, copy the rows, keep the indexes
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log_new (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL
                 CHECK (entity_type IN ('credential','selector_pack','manual_source','device',
                                        'directory_source','provider_account')),
  entity_id    TEXT,
  action       TEXT NOT NULL
                 CHECK (action IN ('add','rotate','delete','test','approve','reject','override',
                                   'revoke','draft','activate','heal','update',
                                   'capture_override','gate_auto_tighten','account_create')),
  actor_email  TEXT,
  result       TEXT,
  detail_json  TEXT,
  ip_hash      TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Every existing row is a valid row of the widened table: the new enum is a
-- superset, and no column changed name or type.
INSERT INTO audit_log_new
  SELECT id, entity_type, entity_id, action, actor_email, result, detail_json, ip_hash, created_at
    FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at);
CREATE INDEX idx_audit_log_actor  ON audit_log(actor_email, created_at);

-- ---------------------------------------------------------------------------
-- 4-5. The two settings keys
-- ---------------------------------------------------------------------------

-- OR IGNORE, not OR REPLACE: re-running a migration must never reset a counter
-- that has advanced, and `score_version` is exactly such a counter.
INSERT OR IGNORE INTO settings (key, value_num, value_text) VALUES
  ('score_version',              1,      NULL),
  ('outreach_blocked_countries', NULL,   'CA,DE');
