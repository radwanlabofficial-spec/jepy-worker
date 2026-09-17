-- migrations/0001_init.sql
-- Jepy Leads — initial schema. 44 tables: the 42 of 05-schema.md v7.1 §L, plus
-- `stage_events` and `clients` added under ADR-040 while the window was open.
--
-- FORWARD-ONLY AND EFFECTIVELY IMMUTABLE. Once this file has been applied with
-- `wrangler d1 migrations apply --remote`, it is never edited again: every
-- further schema change is a new migration file plus a new ADR (ADR-028). The
-- window in which a column can be added here is therefore *now*.
--
-- Conventions (05 §0):
--   * every time column is INTEGER unixepoch() seconds UTC, named *_at
--   * externally referenced entities get a TEXT stable id
--   * nested data is TEXT JSON, column name ends in _json
--   * money is cost_micro INTEGER (1 USD = 1,000,000). FLOAT money is banned
--   * booleans are INTEGER 0/1 named is_* or enabled
--   * status is TEXT with a CHECK constraint — never a magic number
--   * if a gate reads a column, NULL is banned: NOT NULL plus an explicit
--     sentinel, because NULL means "nobody looked" while 'none' means
--     "looked, and nothing blocks it" — the gate must tell those apart
--   * counters increment in one atomic UPDATE ... SET x = x + 1
--   * soft delete only: deleted_at INTEGER NULL; hard delete exists solely
--     inside the DSR flow
--
-- Provider value is always `brightdata`, never a `bd_*` prefix (R22).
-- Yelp content is never persisted, only leads.yelp_business_id (ADR-003).

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- A. Core Lead Tables (5 + 2 pipeline tables added by ADR-040)
-- ===========================================================================

-- The centre of everything: one real business = one row.
CREATE TABLE leads (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  name_slug          TEXT,
  domain             TEXT,
  website_url        TEXT,
  phone_e164         TEXT,
  phone_raw          TEXT,
  email              TEXT,
  address_line       TEXT,
  city               TEXT,
  region             TEXT,
  postal_code        TEXT,
  country_code       TEXT,
  lat                REAL,
  lng                REAL,
  category           TEXT,
  niche              TEXT,
  employee_estimate  INTEGER,
  overture_id        TEXT,
  fsq_id             TEXT,
  yelp_business_id   TEXT,
  dedup_key          TEXT NOT NULL,
  rule_score         INTEGER,
  ai_score           INTEGER,
  final_score        INTEGER,
  tier               TEXT CHECK (tier IN ('HOT','WARM','COLD')),
  status             TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','enriched','scored','queued','contacted','replied','dead')),
  -- Sales pipeline (ADR-040). `status` answers "where is the machine with this
  -- lead"; `stage` answers "where is the human". Different axes: a lead can be
  -- status='contacted' and stage='interested' at the same time.
  stage              TEXT NOT NULL DEFAULT 'new'
                       CHECK (stage IN ('new','researched','qualified','contacted','replied','interested',
                                        'call_booked','call_done','proposal','negotiation','won','lost')),
  next_follow_up_at  INTEGER,
  lost_reason        TEXT CHECK (lost_reason IN ('not_interested','bad_fit','no_response','budget',
                                                'timing','competitor','lost')),
  -- Outreach timing and copy need these. geo_targets alone is too coarse, and
  -- inferring per lead risks sending at the wrong hour.
  language           TEXT,
  timezone           TEXT,
  source_url         TEXT,
  lawful_basis       TEXT,
  captured_by        TEXT CHECK (captured_by IN ('dataset','scrape','manual')),
  capture_batch_id   TEXT REFERENCES capture_batches(id),
  is_manual_edited   INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_edited IN (0,1)),
  provenance_json    TEXT,
  first_seen_at      INTEGER,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at         INTEGER
);

CREATE UNIQUE INDEX idx_leads_dedup_key       ON leads(dedup_key);
CREATE INDEX        idx_leads_phone           ON leads(phone_e164);
CREATE INDEX        idx_leads_domain          ON leads(domain);
CREATE INDEX        idx_leads_overture        ON leads(overture_id);
CREATE INDEX        idx_leads_fsq             ON leads(fsq_id);
CREATE INDEX        idx_leads_tier_score      ON leads(tier, final_score);
CREATE INDEX        idx_leads_city_niche      ON leads(city, niche);
CREATE INDEX        idx_leads_status_updated  ON leads(status, updated_at);
CREATE INDEX        idx_leads_capture_batch   ON leads(capture_batch_id);
CREATE INDEX        idx_leads_stage           ON leads(stage, next_follow_up_at);

-- One lead may hold several people and several addresses.
CREATE TABLE contacts (
  id                   TEXT PRIMARY KEY,
  lead_id              TEXT NOT NULL REFERENCES leads(id),
  full_name            TEXT,
  role_title           TEXT,
  email                TEXT,
  email_pattern_guess  TEXT,
  verify_status        TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (verify_status IN ('unknown','syntax_ok','mx_ok','valid','invalid','catch_all','disposable')),
  verify_layer         TEXT CHECK (verify_layer IN ('L1','L2','L3')),
  verified_at          INTEGER,
  phone_e164           TEXT,
  linkedin_url         TEXT,
  is_primary           INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  source               TEXT,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_contacts_lead ON contacts(lead_id);

-- Wave 1/2 signals live here rather than as fifty columns on `leads`, so a
-- signal can be added or retired without touching the lead row.
CREATE TABLE lead_signals (
  id                 TEXT PRIMARY KEY,
  lead_id            TEXT NOT NULL REFERENCES leads(id),
  signal_key         TEXT NOT NULL,
  signal_value_num   REAL,
  signal_value_text  TEXT,
  confidence         REAL,
  collected_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at         INTEGER,
  source_provider    TEXT
);

CREATE INDEX idx_lead_signals_lead   ON lead_signals(lead_id, signal_key);
CREATE INDEX idx_lead_signals_key    ON lead_signals(signal_key, collected_at);

-- The lead timeline: both audit trail and debugging aid.
CREATE TABLE activity_log (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT REFERENCES leads(id),
  event_type   TEXT NOT NULL
                 CHECK (event_type IN ('imported','enriched','scored','emailed','bounced','replied','manual_edit','manual_capture')),
  actor        TEXT NOT NULL DEFAULT 'system'
                 CHECK (actor IN ('system','cron','user','extension')),
  detail_json  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_activity_log_lead ON activity_log(lead_id, created_at);

-- Every dedup merge, kept so the merge can be undone.
CREATE TABLE merge_log (
  id                 TEXT PRIMARY KEY,
  winner_lead_id     TEXT NOT NULL REFERENCES leads(id),
  loser_lead_id      TEXT NOT NULL REFERENCES leads(id),
  matched_on         TEXT NOT NULL
                       CHECK (matched_on IN ('phone','overture_id','fsq_id','email','domain','name_slug')),
  merged_fields_json TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------------------------------------------------------------------------
-- A2. Pipeline (ADR-040, added before the first remote apply)
-- ---------------------------------------------------------------------------

-- Append-only stage history, same shape as feedback_events and weight_history:
-- the current stage is a column on `leads`, the path taken to get there is here.
CREATE TABLE stage_events (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads(id),
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'user' CHECK (actor IN ('user','system','cron','extension')),
  note       TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_stage_events_lead ON stage_events(lead_id, created_at);

-- Created only when a lead reaches stage='won'. Deliberately thin: projects and
-- invoices stay out of scope (ADR-024), so this is a client list, not an ERP.
CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT REFERENCES leads(id),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','churned')),
  started_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_clients_lead ON clients(lead_id);

-- ===========================================================================
-- B. Source & Discovery Tables (5 + one enum note)
-- ===========================================================================

-- Which cities and regions get scanned.
CREATE TABLE geo_targets (
  id              TEXT PRIMARY KEY,
  country_code    TEXT NOT NULL,
  region          TEXT,
  city            TEXT,
  bbox_json       TEXT,
  population      INTEGER,
  priority        INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_scanned_at INTEGER,
  lead_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_geo_targets_enabled ON geo_targets(enabled, priority);

-- The target business categories we sell into.
CREATE TABLE niches (
  id                      TEXT PRIMARY KEY,
  niche_slug             TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  overture_categories_json TEXT,
  fsq_categories_json    TEXT,
  avg_deal_value_micro   INTEGER,
  priority               INTEGER NOT NULL DEFAULT 3,
  enabled                INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
);

CREATE UNIQUE INDEX idx_niches_slug ON niches(niche_slug);

-- Every source of every class in one table, split by `class` (ADR-038). Before
-- v7 this held Class B only and Class C lived in a separate manual_sources
-- table; that table is retired, because Class X had nowhere to sit and the gate
-- had to consult two places.
--
-- Transport, gate and health metadata ONLY. There is no CSS selector here: all
-- selectors live in selector_packs (ADR-032), so a selector can never drift into
-- the route table.
CREATE TABLE directory_sources (
  id                  TEXT PRIMARY KEY,
  source_key          TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  base_url            TEXT,
  target_type         TEXT,
  adapter             TEXT CHECK (adapter IN ('api_json','directory_html','serp_query','profile_page','feed_poll','tech_probe')),
  url_template        TEXT,
  pagination_json     TEXT,
  rate_limit_per_min  INTEGER,
  requires_credential INTEGER NOT NULL DEFAULT 0 CHECK (requires_credential IN (0,1)),
  robots_ok           INTEGER CHECK (robots_ok IN (0,1)),
  class               TEXT NOT NULL CHECK (class IN ('B','C','X')),
  -- Sentinel, never NULL: NULL would mean "nobody checked" and the gate would
  -- have to guess (ADR-031). 'none' means checked, and clear.
  block_reason        TEXT NOT NULL DEFAULT 'none'
                        CHECK (block_reason IN ('none','tos_no_storage','tos_no_automation','login','captcha','paid','robots_disallow')),
  why_manual          TEXT,
  manual_url_template TEXT,
  attribution_html    TEXT,
  health              TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok','degraded','broken')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at     INTEGER,
  last_heal_at        INTEGER,
  note                TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at          INTEGER
);

CREATE UNIQUE INDEX idx_directory_sources_key    ON directory_sources(source_key);
CREATE INDEX        idx_directory_sources_gate   ON directory_sources(class, block_reason);
CREATE INDEX        idx_directory_sources_route  ON directory_sources(target_type, enabled);

-- `block_reason` is NOT a table. It is the enum above, documented in 05 §9 as
-- its own numbered section purely for readability. The table count stays 42
-- even though section numbers run to 43.

-- Tier 0 bulk import ledger: Overture and Foursquare dumps.
CREATE TABLE dataset_imports (
  id               TEXT PRIMARY KEY,
  dataset          TEXT NOT NULL CHECK (dataset IN ('overture','fsq')),
  release_version  TEXT,
  geo_target_id    TEXT REFERENCES geo_targets(id),
  parquet_path_r2  TEXT,
  rows_read        INTEGER,
  rows_kept        INTEGER,
  rows_inserted    INTEGER,
  rows_deduped     INTEGER,
  min_confidence   REAL,
  runner           TEXT,
  duration_sec     INTEGER,
  status           TEXT,
  error_text       TEXT,
  started_at       INTEGER,
  finished_at      INTEGER
);

CREATE INDEX idx_dataset_imports_dataset ON dataset_imports(dataset, started_at);

-- Daily per-source block-rate and latency snapshot: the input to self-healing.
CREATE TABLE source_health_log (
  id              TEXT PRIMARY KEY,
  source_key      TEXT NOT NULL,
  day             INTEGER NOT NULL,
  requests        INTEGER NOT NULL DEFAULT 0,
  success         INTEGER NOT NULL DEFAULT 0,
  blocked         INTEGER NOT NULL DEFAULT 0,
  empty           INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms  INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_source_health_source_day ON source_health_log(source_key, day);

-- ===========================================================================
-- C. Provider, Vault & Quota Tables (7)
-- ===========================================================================

-- Runtime state per account. Credentials are NOT here — they are in the Vault.
CREATE TABLE provider_accounts (
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  account_label      TEXT NOT NULL,
  quota_limit        INTEGER,
  quota_used         INTEGER NOT NULL DEFAULT 0,
  quota_window       TEXT CHECK (quota_window IN ('day','month')),
  quota_reset_at     INTEGER,
  quota_expires_at   INTEGER,
  -- The Providers page shows the provider's OWN view of the account, not just
  -- our local ledger: plan tier, monthly price, and when the meter last synced.
  plan_label         TEXT,
  plan_price_micro   INTEGER,
  last_synced_at     INTEGER,
  sync_error         TEXT,
  daily_used         INTEGER NOT NULL DEFAULT 0,
  daily_limit        INTEGER,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','invalid','rate_limited','exhausted','disabled')),
  cooldown_until     INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  priority           INTEGER NOT NULL DEFAULT 5,
  last_used_at       INTEGER,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_provider_accounts_label ON provider_accounts(provider, account_label);
CREATE INDEX        idx_provider_accounts_pick  ON provider_accounts(provider, enabled, status, last_used_at);

-- The Vault. AES-256-GCM; the key itself is a Worker secret and never touches D1.
CREATE TABLE provider_credentials (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES provider_accounts(id),
  key_name       TEXT NOT NULL,
  ciphertext     TEXT NOT NULL,
  iv             TEXT NOT NULL,
  auth_tag       TEXT NOT NULL,
  last4          TEXT,
  algo           TEXT NOT NULL DEFAULT 'AES-256-GCM',
  test_status    TEXT NOT NULL DEFAULT 'untested'
                   CHECK (test_status IN ('untested','ok','failed')),
  last_tested_at INTEGER,
  rotated_at     INTEGER,
  cache_epoch    INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_provider_credentials_account ON provider_credentials(account_id);

-- The single audit table for the whole system: credentials, selector-pack
-- approvals, Class C overrides, device directives. One table, so that "who
-- overrode what last month" is one query rather than three.
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL
                 CHECK (entity_type IN ('credential','selector_pack','manual_source','device')),
  entity_id    TEXT,
  action       TEXT NOT NULL
                 CHECK (action IN ('add','rotate','delete','test','approve','reject','override','revoke')),
  actor_email  TEXT,
  result       TEXT,
  detail_json  TEXT,
  ip_hash      TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at);
CREATE INDEX idx_audit_log_actor  ON audit_log(actor_email, created_at);

-- The router's brain: one row per (target_type x provider).
CREATE TABLE provider_capability (
  id                   TEXT PRIMARY KEY,
  target_type          TEXT NOT NULL,
  provider             TEXT NOT NULL,
  adapter              TEXT NOT NULL
                         CHECK (adapter IN ('api_json','directory_html','serp_query','profile_page','feed_poll','tech_probe')),
  cost_micro_per_unit  INTEGER,
  unit_type            TEXT CHECK (unit_type IN ('request','record','page','mb')),
  quality              INTEGER CHECK (quality BETWEEN 0 AND 100),
  avg_latency_ms       INTEGER,
  max_records          INTEGER,
  runner               TEXT NOT NULL CHECK (runner IN ('worker','gha','extension')),
  requires_login       INTEGER NOT NULL DEFAULT 0 CHECK (requires_login IN (0,1)),
  requires_credential  INTEGER NOT NULL DEFAULT 0 CHECK (requires_credential IN (0,1)),
  compliance_flag      TEXT NOT NULL DEFAULT 'ok'
                         CHECK (compliance_flag IN ('ok','geo_blocked','tos_limited')),
  priority             INTEGER NOT NULL DEFAULT 5,
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
);

CREATE UNIQUE INDEX idx_provider_capability_pair   ON provider_capability(target_type, provider);
CREATE INDEX        idx_provider_capability_route  ON provider_capability(target_type, enabled, priority);

-- BrightData credit ledger. The only place credit accounting happens.
CREATE TABLE brightdata_credit_log (
  id             TEXT PRIMARY KEY,
  account_label  TEXT NOT NULL,
  zone           TEXT CHECK (zone IN ('unlocker','serp','scraper','browser')),
  unit_type      TEXT CHECK (unit_type IN ('request','record','page','mb')),
  units          INTEGER,
  credits        INTEGER,
  cost_micro     INTEGER,
  job_id         TEXT,
  target_type    TEXT,
  success        INTEGER CHECK (success IN (0,1)),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_bd_credit_log_account ON brightdata_credit_log(account_label, created_at);

CREATE TABLE apify_usage_log (
  id             TEXT PRIMARY KEY,
  account_label  TEXT NOT NULL,
  actor_id       TEXT,
  run_id         TEXT,
  compute_units  REAL,
  records        INTEGER,
  cost_micro     INTEGER,
  job_id         TEXT,
  status         TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_apify_usage_account ON apify_usage_log(account_label, created_at);

-- Generic daily/monthly counter for every windowed quota.
CREATE TABLE quota_counters (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  account_label  TEXT NOT NULL,
  window_key     TEXT NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0,
  limit_value    INTEGER,
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_quota_counters_window ON quota_counters(provider, account_label, window_key);

-- ===========================================================================
-- D. Job Queue & Router Tables (5)
-- ===========================================================================

-- Every external call goes through this queue (R15/R16). Three things are
-- deliberately excluded from it because they are interactive and are not
-- provider calls at all (ADR-016): the on-demand Yelp verification, the Vault
-- test button, and Mode B manual capture.
CREATE TABLE job_queue (
  id            TEXT PRIMARY KEY,
  job_type      TEXT NOT NULL
                  CHECK (job_type IN ('dataset_import','probe','scrape','enrich','verify','score','dom','email','quota_sync')),
  target_type   TEXT,
  payload_json  TEXT,
  priority      INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','claimed','running','done','failed','dead','needs_manual')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  claimed_by    TEXT,
  claimed_at    INTEGER,
  run_after     INTEGER,
  -- Hard ceiling of three hops per job. The final hop must always be
  -- credential-free (R20).
  hop_count     INTEGER NOT NULL DEFAULT 0 CHECK (hop_count <= 3),
  last_error    TEXT,
  result_ref    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_job_queue_pick   ON job_queue(status, run_after, priority DESC);
CREATE INDEX idx_job_queue_type   ON job_queue(job_type, status);

-- Large result payloads live apart from the queue, so the queue table stays small.
CREATE TABLE job_results (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES job_queue(id),
  provider        TEXT,
  account_label   TEXT,
  records_count   INTEGER,
  raw_ref_r2      TEXT,
  normalized_json TEXT,
  duration_ms     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_job_results_job ON job_results(job_id);

-- One row per hop, without exception. `pack_version` is mandatory in spirit:
-- without it a heal rollback cannot be traced, and "the new pack broke it"
-- cannot be told apart from "the site changed". Note that a circuit-skipped
-- candidate writes nothing here, because it never consumed a hop.
CREATE TABLE route_attempts (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES job_queue(id),
  hop            INTEGER NOT NULL CHECK (hop BETWEEN 1 AND 3),
  target_type    TEXT,
  provider       TEXT,
  account_label  TEXT,
  -- Why this provider won, and which layer the circuit opened at. 09 §10 keeps
  -- these so a bad route can be explained after the fact without re-running it.
  adapter        TEXT,
  source_id      TEXT,
  decision_score REAL,
  score          REAL,
  circuit_scope  TEXT,
  pack_version   INTEGER,
  outcome        TEXT CHECK (outcome IN ('success','empty','error','blocked','timeout')),
  http_status    INTEGER,
  records_count  INTEGER,
  unit_type      TEXT,
  units          INTEGER,
  latency_ms     INTEGER,
  cost_micro     INTEGER,
  error_text     TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_route_attempts_job      ON route_attempts(job_id, hop);
CREATE INDEX idx_route_attempts_provider ON route_attempts(provider, created_at);

-- No half-open: when the clock runs out the circuit closes directly, and the
-- first failure opens it again. Fifteen minutes everywhere (R19).
CREATE TABLE circuit_state (
  id                   TEXT PRIMARY KEY,
  scope_key            TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at            INTEGER,
  reopen_after         INTEGER NOT NULL DEFAULT 900,
  last_success_at      INTEGER,
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_circuit_state_scope ON circuit_state(scope_key);

-- Health of the three cron slots.
CREATE TABLE cron_runs (
  id                TEXT PRIMARY KEY,
  cron_name         TEXT NOT NULL CHECK (cron_name IN ('dispatcher','daily_reset','weekly_backup')),
  started_at        INTEGER,
  finished_at       INTEGER,
  jobs_dispatched   INTEGER,
  sub_requests_used INTEGER,
  status            TEXT,
  error_text        TEXT
);

CREATE INDEX idx_cron_runs_name ON cron_runs(cron_name, started_at);

-- ===========================================================================
-- E. Scoring & Feedback Tables (5)
-- ===========================================================================

-- Versioned weight sets. The feedback loop inserts a new version; it never
-- edits an existing one, so any historical score stays explainable (R9).
CREATE TABLE score_weights (
  id          TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  feature_key TEXT NOT NULL,
  -- Points, not a multiplier: 12-scoring.md §2 allocates the v1 weights as
  -- points summing to 100 per version (35 Website Pain + 25 Reachability
  -- + 25 Buying Signal + 15 Fit). The 0.5-1.5 clamp in ADR-021 governs the
  -- weekly feedback step — `new_weight = old × clamp(lift, 0.5, 1.5)`, recorded
  -- in weight_history — and is NOT a bound on the absolute weight. Applying it
  -- here would cap an 18-feature version at 27 points and make the documented
  -- v1 set impossible to insert.
  weight      REAL NOT NULL CHECK (weight >= 0 AND weight <= 100),
  is_active   INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_score_weights_version ON score_weights(version, feature_key);

-- A snapshot per scoring run.
CREATE TABLE lead_scores (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT NOT NULL REFERENCES leads(id),
  pass            INTEGER CHECK (pass IN (0,1)),
  rule_score      INTEGER,
  ai_score        INTEGER,
  final_score     INTEGER,
  tier            TEXT CHECK (tier IN ('HOT','WARM','COLD')),
  weights_version INTEGER,
  score_version   INTEGER,
  -- Signal coverage below 60%: such a lead gets no tier at all (tier IS NULL)
  -- and never reaches the AI gate.
  is_provisional  INTEGER NOT NULL DEFAULT 0 CHECK (is_provisional IN (0,1)),
  ai_scored_at    INTEGER,
  features_json   TEXT,
  model           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_lead_scores_lead ON lead_scores(lead_id, created_at);

-- Exactly one row per batch. `batch_id` is the idempotency key that ties a
-- retry to its original; `lead_count` is what actually went, not the configured
-- batch size, because the final batch may be short and cost is computed per lead.
CREATE TABLE ai_score_log (
  id             TEXT PRIMARY KEY,
  batch_id       TEXT NOT NULL,
  provider       TEXT NOT NULL DEFAULT 'manifest',
  account_label  TEXT,
  lead_count     INTEGER,
  prompt_version TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_micro     INTEGER,
  latency_ms     INTEGER,
  outcome        TEXT CHECK (outcome IN ('ok','parse_fail','timeout','error')),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_ai_score_log_batch   ON ai_score_log(batch_id);
CREATE INDEX idx_ai_score_log_account ON ai_score_log(account_label, created_at);

CREATE TABLE feedback_events (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT REFERENCES leads(id),
  event       TEXT NOT NULL
                CHECK (event IN ('opened','clicked','replied','positive_reply','converted','bounced','unsub')),
  weight_hint REAL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_feedback_events_lead ON feedback_events(lead_id, created_at);

-- The weekly lift calculation. `applied` matters: computing a lift and actually
-- shipping it as a new weight version are two different events, and without the
-- flag there is no way to answer "did that lift ever take effect?".
CREATE TABLE weight_history (
  id          TEXT PRIMARY KEY,
  week_key    TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  lift        REAL,
  old_weight  REAL,
  new_weight  REAL,
  sample_size INTEGER,
  applied     INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0,1)),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_weight_history_week ON weight_history(week_key, feature_key);

-- ===========================================================================
-- F. Email & Compliance Tables (6)
-- ===========================================================================

-- Stops the same address or domain being verified over and over.
CREATE TABLE email_verification_cache (
  id            TEXT PRIMARY KEY,
  email_hash    TEXT NOT NULL,
  domain        TEXT,
  layer         TEXT CHECK (layer IN ('L1','L2','L3')),
  result        TEXT,
  mx_json       TEXT,
  is_disposable INTEGER CHECK (is_disposable IN (0,1)),
  is_role       INTEGER CHECK (is_role IN (0,1)),
  checked_at    INTEGER,
  expires_at    INTEGER
);

CREATE INDEX idx_email_cache_hash   ON email_verification_cache(email_hash);
CREATE INDEX idx_email_cache_domain ON email_verification_cache(domain, expires_at);

CREATE TABLE outreach_campaigns (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  niche         TEXT,
  geo_target_id TEXT REFERENCES geo_targets(id),
  -- Resend is transactional only; cold outreach needs a separate ESP on a
  -- separate domain (ADR-009).
  esp           TEXT NOT NULL CHECK (esp IN ('resend','cold_esp')),
  from_domain   TEXT,
  daily_cap     INTEGER,
  warmup_stage  INTEGER,
  status        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE outreach_messages (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT REFERENCES outreach_campaigns(id),
  lead_id             TEXT REFERENCES leads(id),
  contact_id          TEXT REFERENCES contacts(id),
  subject             TEXT,
  body_ref            TEXT,
  step_number         INTEGER,
  scheduled_at        INTEGER,
  sent_at             INTEGER,
  provider_message_id TEXT,
  status              TEXT CHECK (status IN ('queued','sent','bounced','complained','replied','suppressed')),
  unsub_token         TEXT
);

CREATE INDEX idx_outreach_messages_campaign ON outreach_messages(campaign_id, status);
CREATE INDEX idx_outreach_messages_lead     ON outreach_messages(lead_id);

-- Checked before every single send, with no exception.
CREATE TABLE suppression_list (
  id                 TEXT PRIMARY KEY,
  email_hash         TEXT NOT NULL,
  domain             TEXT,
  reason             TEXT NOT NULL
                       CHECK (reason IN ('unsubscribe','complaint','hard_bounce','manual','dsr')),
  source_campaign_id TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_suppression_hash   ON suppression_list(email_hash);
CREATE INDEX        idx_suppression_domain ON suppression_list(domain);

-- Complaint above 0.1% or bounce above 2% pauses the campaign automatically.
CREATE TABLE bounce_complaint_log (
  id          TEXT PRIMARY KEY,
  message_id  TEXT REFERENCES outreach_messages(id),
  type        TEXT NOT NULL CHECK (type IN ('soft_bounce','hard_bounce','complaint')),
  code        TEXT,
  detail      TEXT,
  received_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_bounce_log_type ON bounce_complaint_log(type, received_at);

-- GDPR / CCPA access and erasure requests.
CREATE TABLE dsr_requests (
  id                 TEXT PRIMARY KEY,
  subject_email_hash TEXT NOT NULL,
  request_type       TEXT NOT NULL CHECK (request_type IN ('access','delete')),
  received_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  due_at             INTEGER,
  completed_at       INTEGER,
  affected_rows      INTEGER,
  note               TEXT
);

-- ===========================================================================
-- G. Extension, Capture & Device Tables (5)
-- ===========================================================================

-- Named `devices`, not `device_tokens` (ADR-023/029).
CREATE TABLE devices (
  id                TEXT PRIMARY KEY,
  device_label      TEXT NOT NULL,
  -- SHA-256 of a 32-byte token. The plaintext is shown exactly once, at
  -- registration, and is never stored (R2).
  token_hash        TEXT NOT NULL,
  mode              TEXT NOT NULL DEFAULT 'a' CHECK (mode IN ('a','b','both')),
  current_directive TEXT NOT NULL DEFAULT 'run' CHECK (current_directive IN ('run','pause','drain','revoke')),
  pack_epoch        INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at INTEGER,
  jobs_completed    INTEGER NOT NULL DEFAULT 0,
  captures_committed INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','revoked')),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_devices_token  ON devices(token_hash);
CREATE INDEX        idx_devices_status ON devices(status, last_heartbeat_at);

-- DOM extraction from the extension, both modes. Without pack_version a stale
-- profile capture cannot be detected, so it is never dropped from this table.
CREATE TABLE dom_captures (
  id                TEXT PRIMARY KEY,
  job_id            TEXT REFERENCES job_queue(id),
  capture_batch_id  TEXT REFERENCES capture_batches(id),
  device_id         TEXT REFERENCES devices(id),
  mode              TEXT CHECK (mode IN ('a','b')),
  url               TEXT,
  extracted_json    TEXT,
  pack_version      INTEGER,
  screenshot_r2_key TEXT,
  duration_ms       INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_dom_captures_job    ON dom_captures(job_id);
CREATE INDEX idx_dom_captures_device ON dom_captures(device_id, created_at);

-- One Mode B capture session per row. The id is supplied by the extension and
-- doubles as the idempotency key, so a retried commit cannot double-insert.
CREATE TABLE capture_batches (
  id                     TEXT PRIMARY KEY,
  source_key             TEXT REFERENCES directory_sources(source_key),
  source_url             TEXT,
  device_id              TEXT REFERENCES devices(id),
  geo_target_id          TEXT REFERENCES geo_targets(id),
  niche                  TEXT,
  pack_id                TEXT,
  pack_version           INTEGER,
  records_captured       INTEGER NOT NULL DEFAULT 0,
  records_new            INTEGER NOT NULL DEFAULT 0,
  records_duplicate      INTEGER NOT NULL DEFAULT 0,
  records_conflict       INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'capturing'
                           CHECK (status IN ('capturing','preview','committed','discarded')),
  -- A snapshot of what the registry said at capture time: if the registry later
  -- changes, the question "under which rule was this taken?" still has an
  -- answer, which matters for DSR and due diligence.
  block_reason_at_capture TEXT NOT NULL DEFAULT 'none'
                            CHECK (block_reason_at_capture IN ('none','tos_no_storage','tos_no_automation','login','captcha','paid','robots_disallow')),
  override_ack           INTEGER NOT NULL DEFAULT 0 CHECK (override_ack IN (0,1)),
  -- Mandatory, and at least 20 characters, whenever override_ack = 1.
  override_reason        TEXT CHECK (override_reason IS NULL OR length(override_reason) >= 20),
  lawful_basis           TEXT,
  captured_by            TEXT NOT NULL DEFAULT 'manual' CHECK (captured_by IN ('manual')),
  started_at             INTEGER,
  committed_at           INTEGER,
  created_at             INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_capture_batches_device ON capture_batches(device_id, created_at);
CREATE INDEX idx_capture_batches_status ON capture_batches(status);
CREATE INDEX idx_capture_batches_source ON capture_batches(source_key, created_at);

-- Extraction rules per site. A draft pack never runs: a human approves it, and
-- every approval and rejection lands in audit_log (ADR-030, R23).
CREATE TABLE selector_packs (
  id             TEXT PRIMARY KEY,
  source_key     TEXT NOT NULL REFERENCES directory_sources(source_key),
  domain_pattern TEXT,
  version        INTEGER NOT NULL,
  selector_json  TEXT,
  pagination_json TEXT,
  field_count    INTEGER,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','rejected','broken')),
  success_rate   INTEGER CHECK (success_rate BETWEEN 0 AND 100),
  runs           INTEGER NOT NULL DEFAULT 0,
  empty_runs     INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  generated_by   TEXT NOT NULL DEFAULT 'seed' CHECK (generated_by IN ('seed','heal','manual','ai')),
  -- Why a heal produced this pack. Without it, a rollback leaves no record of
  -- what the pack was for.
  heal_reason    TEXT,
  -- The html_samples row this pack was derived from.
  sample_ref     TEXT,
  approved_by    TEXT,
  approved_at    INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_selector_packs_version   ON selector_packs(source_key, version);
CREATE INDEX        idx_selector_packs_status    ON selector_packs(status, source_key);
CREATE INDEX        idx_selector_packs_selection ON selector_packs(source_key, status);

-- A sanitised page sample, kept only to teach structure. script/style/inline
-- handlers are stripped and visible PII is masked; the raw HTML stays in R2.
CREATE TABLE html_samples (
  id                    TEXT PRIMARY KEY,
  source_key            TEXT REFERENCES directory_sources(source_key),
  pack_id               TEXT REFERENCES selector_packs(id),
  url                   TEXT,
  sanitized_html_r2_key TEXT,
  -- Guards against an R2 object being replaced or lost, and stops the same
  -- broken page being stored again on every run.
  sha256                TEXT,
  byte_size             INTEGER,
  reason                TEXT CHECK (reason IN ('no_pack','pack_broken','field_missing')),
  used_for_draft_pack   INTEGER NOT NULL DEFAULT 0 CHECK (used_for_draft_pack IN (0,1)),
  draft_pack_id         TEXT REFERENCES selector_packs(id),
  created_at            INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_html_samples_source ON html_samples(source_key, created_at);
CREATE INDEX idx_html_samples_sha    ON html_samples(sha256);

-- ===========================================================================
-- H. System & Ops Tables (4)
-- ===========================================================================

-- Key/value config. It lives in D1 rather than KV because the increments and
-- the compare-and-set have to be atomic.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_text TEXT,
  value_num  REAL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE error_log (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  scope      TEXT,
  job_id     TEXT,
  provider   TEXT,
  message    TEXT,
  stack_ref  TEXT,
  severity   TEXT CHECK (severity IN ('info','warn','error','fatal')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_error_log_code ON error_log(code, created_at);
CREATE INDEX idx_error_log_time ON error_log(created_at);

CREATE TABLE backup_log (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('d1_dump','vault_export')),
  r2_key     TEXT,
  size_bytes INTEGER,
  row_count  INTEGER,
  checksum   TEXT,
  status     TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  filename   TEXT NOT NULL,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
  checksum   TEXT
);

-- ===========================================================================
-- Seeds that must live in 0001
-- ===========================================================================
-- Nine keys. The last three were added in v7 and have to be here: once this
-- file is applied remotely it is immutable (ADR-028), so a missing key would
-- cost a whole migration later.
--
-- `router_weights_json` holds the five router weights (09 §5). Changing it
-- requires an ADR, so the API refuses with E_FORBIDDEN/reason=adr_required.
-- `gate_threshold` holds the AI gate base of 55; budget pressure raises it to
-- 65. `vault_epoch` is system-managed and refuses a UI PATCH with
-- E_FORBIDDEN/reason=setting_locked.

INSERT INTO settings (key, value_num, value_text) VALUES
  ('cache_epoch',            1,    NULL),
  ('vault_epoch',            1,    NULL),
  ('dispatcher_paused',      0,    NULL),
  ('daily_bd_credit_guard',  1800, NULL),
  ('ai_daily_cap',           200,  NULL),
  ('gate_threshold',         55,   NULL),
  ('active_weights_version', 1,    NULL),
  ('router_weights_json',    NULL, '{"w_cost":0.40,"w_quality":0.25,"w_success":0.20,"w_latency":0.10,"w_free":0.05}'),
  ('d1_daily_write_ceiling', 1500000, NULL);

-- `d1_daily_write_ceiling` = 1,500,000. Workers Paid includes 50 million rows
-- written per month (Cloudflare D1 pricing, 21 Apr 2026), and 50,000,000 / 31
-- is about 1.6 million, so a runaway that pins this guard every single day still
-- lands inside the included allowance and bills nothing. Projected normal load
-- is roughly 15,000 leads x ~15 writes, i.e. well under a tenth of it.
-- `quota_sync` is the daily job that pulls each provider's own balance, so the
-- Providers page shows the real remaining credit rather than only our ledger.

-- ===========================================================================
-- Verify after applying (03-execution.md STEP 2)
-- ===========================================================================
--   SELECT count(*) FROM sqlite_master
--     WHERE type='table' AND name NOT LIKE 'sqlite_%'
--       AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations';
--     -- expect 44
--
-- The prefix filters are load-bearing. D1 keeps its own tables — `d1_migrations`,
-- `_cf_METADATA` (and `_cf_KV` on the remote instance) plus `sqlite_sequence` —
-- so counting every row in sqlite_master gives 46 locally and 47 in the Wrangler
-- dev state, both of which are correct. Filtering by prefix is used rather than a
-- fixed deny-list so that a future D1 internal table cannot break the check.
--   SELECT count(*) FROM settings;          -- expect 9
--   SELECT count(*) FROM sqlite_master WHERE type='index';
--
-- The three seed-assertion queries (Class C/X rows, the credential-free floor,
-- and the weight version) belong to STEP 3 and live in the seed file.
