-- 0010_stats_indexes.sql — read-path indexes for /api/leads/stats.
--
-- Why this exists: on 2026-10-08 D1 sat at 232% of the free tier's 5M daily
-- reads. /api/leads/stats runs 9 queries per call and the dashboard polls it
-- every 2 minutes, so the stats path alone is the single biggest read sink.
-- Each query below was checked against the existing index list; every one of
-- these filters on a column with no usable index today:
--
--   added                                  serves
--   ------------------------------------   ----------------------------------
--   idx_leads_deleted_tier                 stats q1: WHERE deleted_at IS NULL
--     ON leads(deleted_at, tier)            GROUP BY tier
--   idx_leads_deleted_created              stats q2: WHERE deleted_at IS NULL
--     ON leads(deleted_at, created_at)      AND created_at >= <day>
--   idx_contacts_verify_layer              stats q3: WHERE verify_layer = 'L3'
--     ON contacts(verify_layer, lead_id)
--   idx_bd_credit_log_created              stats q5/q6: brightdata_credit_log
--     ON brightdata_credit_log(created_at)  WHERE created_at >= <day|month>
--   idx_apify_usage_log_created            stats q6: apify_usage_log
--     ON apify_usage_log(created_at)        WHERE created_at >= <month>
--   idx_ai_score_log_created               stats q8: ai_score_log
--     ON ai_score_log(created_at)           WHERE created_at >= <day>
--   idx_error_log_created                  stats q7: error_log
--     ON error_log(created_at)              WHERE created_at >= <day>
--
-- Deliberately NOT added: job_queue(status) — the stats queue query filters
-- status IN ('pending','claimed','running') and idx_job_queue_pick already
-- leads with (status, run_after, priority DESC); a second status index would
-- only cost writes. settings(key) is the PRIMARY KEY; the config subqueries
-- need nothing.
--
-- Write-cost note (cf. 0003, ADR-043): each index on `leads` bills one extra
-- row written per INSERT. `leads` goes from 8 to 10 billed rows per lead.
-- That trade is taken on purpose: writes sat at ~1.4% of the daily budget
-- when reads were at 232%. If writes ever become the binding constraint,
-- revisit idx_leads_deleted_created first (q2 can fall back to a scan of the
-- 8k-row table; the GROUP BY in q1 cannot).

CREATE INDEX IF NOT EXISTS idx_leads_deleted_tier
  ON leads(deleted_at, tier);
CREATE INDEX IF NOT EXISTS idx_leads_deleted_created
  ON leads(deleted_at, created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_verify_layer
  ON contacts(verify_layer, lead_id);
CREATE INDEX IF NOT EXISTS idx_bd_credit_log_created
  ON brightdata_credit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_apify_usage_log_created
  ON apify_usage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_score_log_created
  ON ai_score_log(created_at);
CREATE INDEX IF NOT EXISTS idx_error_log_created
  ON error_log(created_at);
