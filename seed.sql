-- seeds/seed.sql — Jepy Leads (Cloudflare D1 / SQLite)
-- ---------------------------------------------------------------------------
-- Idempotent STEP 3 seed. Re-runnable: every row uses INSERT OR REPLACE.
-- Targets the FROZEN schema in migrations/0001_init.sql (ADR-028): column
-- names, CHECK enums and NOT NULL defaults are taken from that file, not from
-- the prose docs.
--
-- Traceability (R25 "no value without a source"):
--   A. provider_capability  <- 07-targets.md §3 (45 target types, primary +
--                              fallback), §4 (column meanings, cost tiers)
--   B. directory_sources    <- 05-schema.md §8/§9, 07-targets.md §3 Wave 3,
--                              08-sources.md §4.1 (Class C) / §4.4 (Class X)
--   C. score_weights        <- 12-scoring.md §2 (v1 weights)  [see NOTE]
--   D. STEP 3 validations   <- 07-targets.md §4, 03-execution.md STEP 3
--
-- Values the documents do NOT state (quality, avg_latency_ms, max_records,
-- per-pair cost, source base_url / rate limits / attribution) are left NULL —
-- never invented. See the report accompanying this file.
--
-- Provider naming (R22): provider is always lowercase. `brightdata`, never a
-- `bd_*` prefix; `bd` only ever appears as a country code (BD).
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- A. provider_capability — one row per (target_type, provider) pair
-- ===========================================================================
-- 71 rows covering all 45 target types of 07-targets.md §3.
--
-- cost_micro_per_unit is micro-USD (1 USD = 1,000,000). 07 §4 supplies only
-- three tiers: open dataset + gha_runner = 0, brightdata = 1500 ($0.0015 /
-- request), apify = 4000 ($0.004 / record). Every credential-free provider is
-- 0 by the seed rule; a credentialed provider whose cost the documents do not
-- state keeps NULL (meta, product_hunt_api, youtube_data_api, yelp,
-- zerobounce).
-- unit_type is stated only where 07 §4 ties a tier to a unit: brightdata ->
-- `request`, apify -> `record`. Everything else is NULL.
-- quality / avg_latency_ms / max_records: no document states a number for any
-- row, so all NULL (they are populated later from source_health_log).
-- priority: no document states a per-row value; the schema default (5) is used.
-- enabled = 0 marks a route that is not available in this build (ADR-035:
-- Mode B is disabled), never a deleted row.

-- --- Wave 0 — Base Discovery (5 target types) -----------------------------
INSERT OR REPLACE INTO provider_capability
  (id, target_type, provider, adapter, cost_micro_per_unit, unit_type, quality, avg_latency_ms, max_records, runner, requires_login, requires_credential, compliance_flag, priority, enabled)
VALUES
  ('pc_overture_places_gha_runner','overture_places','gha_runner','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_overture_places_fsq','overture_places','fsq','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_fsq_places_gha_runner','fsq_places','gha_runner','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_fsq_places_overture','fsq_places','overture','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_osm_overpass_gha_runner','osm_overpass','gha_runner','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_osm_overpass_overture','osm_overpass','overture','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_state_sos_bulk_gha_runner','state_sos_bulk','gha_runner','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_state_sos_bulk_manual','state_sos_bulk','manual','api_json',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_sec_edgar_worker','sec_edgar','worker','api_json',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_sec_edgar_gha_runner','sec_edgar','gha_runner','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1);

-- --- Wave 1 — Free probes (10 target types) -------------------------------
INSERT OR REPLACE INTO provider_capability
  (id, target_type, provider, adapter, cost_micro_per_unit, unit_type, quality, avg_latency_ms, max_records, runner, requires_login, requires_credential, compliance_flag, priority, enabled)
VALUES
  ('pc_psi_mobile_google_psi','psi_mobile','google_psi','tech_probe',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_psi_desktop_google_psi','psi_desktop','google_psi','tech_probe',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_dns_mx_doh','dns_mx','doh','tech_probe',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_ssl_cert_worker','ssl_cert','worker','tech_probe',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_wayback_history_archive_org','wayback_history','archive_org','api_json',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_tech_stack_worker','tech_stack','worker','tech_probe',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_robots_sitemap_worker','robots_sitemap','worker','tech_probe',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_website_meta_worker','website_meta','worker','directory_html',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_email_pattern_worker','email_pattern','worker','tech_probe',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_domain_age_rdap','domain_age','rdap','api_json',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1);

-- --- Wave 2 — Buying signals (10 target types) ----------------------------
INSERT OR REPLACE INTO provider_capability
  (id, target_type, provider, adapter, cost_micro_per_unit, unit_type, quality, avg_latency_ms, max_records, runner, requires_login, requires_credential, compliance_flag, priority, enabled)
VALUES
  ('pc_job_postings_ats_gha_runner','job_postings_ats','gha_runner','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_job_postings_ats_brightdata','job_postings_ats','brightdata','api_json',1500,'request',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_job_postings_serp_brightdata','job_postings_serp','brightdata','serp_query',1500,'request',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_job_postings_serp_gha_runner','job_postings_serp','gha_runner','serp_query',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_meta_ad_library_meta','meta_ad_library','meta','api_json',NULL,NULL,NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_meta_ad_library_manual','meta_ad_library','manual','api_json',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_google_ads_transparency_brightdata','google_ads_transparency','brightdata','directory_html',1500,'request',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_google_ads_transparency_extension','google_ads_transparency','extension','directory_html',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_funding_news_rss','funding_news','rss','feed_poll',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_funding_news_brightdata','funding_news','brightdata','serp_query',1500,'request',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_new_domain_reg_free_zone_feeds','new_domain_reg','free_zone_feeds','feed_poll',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_new_domain_reg_gha_runner','new_domain_reg','gha_runner','feed_poll',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_upwork_feed_rss','upwork_feed','rss','feed_poll',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_upwork_feed_manual','upwork_feed','manual','feed_poll',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_product_hunt_product_hunt_api','product_hunt','product_hunt_api','api_json',NULL,NULL,NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_product_hunt_rss','product_hunt','rss','feed_poll',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1),
  ('pc_app_listing_gha_runner','app_listing','gha_runner','profile_page',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_app_listing_brightdata','app_listing','brightdata','profile_page',1500,'request',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_review_velocity_overture_fsq_delta','review_velocity','overture_fsq_delta','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_review_velocity_manual','review_velocity','manual','api_json',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1);

-- --- Wave 3 — Directories (12 target types: 6 Class B + 6 Class C) --------
-- The 6 Class C target types (bbb, thumbtack, angi, healthgrades, zocdoc,
-- findlaw) have NO automated route: 07 §3 says automated routes (router / GHA
-- / Mode A) never touch them. Their only entry is Mode B manual capture,
-- which is disabled in this build (ADR-035), so those rows are enabled = 0.
INSERT OR REPLACE INTO provider_capability
  (id, target_type, provider, adapter, cost_micro_per_unit, unit_type, quality, avg_latency_ms, max_records, runner, requires_login, requires_credential, compliance_flag, priority, enabled)
VALUES
  ('pc_google_maps_serp_brightdata','google_maps_serp','brightdata','serp_query',1500,'request',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_google_maps_serp_gha_runner','google_maps_serp','gha_runner','serp_query',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_bing_serp_brightdata','bing_serp','brightdata','serp_query',1500,'request',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_bing_serp_gha_runner','bing_serp','gha_runner','serp_query',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_yellowpages_gha_runner','yellowpages','gha_runner','directory_html',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_manta_gha_runner','manta','gha_runner','directory_html',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_chamber_of_commerce_gha_runner','chamber_of_commerce','gha_runner','directory_html',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_clutch_agencies_brightdata','clutch_agencies','brightdata','directory_html',1500,'request',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_clutch_agencies_gha_runner','clutch_agencies','gha_runner','directory_html',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_bbb_extension','bbb','extension','directory_html',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,0),
  ('pc_thumbtack_extension','thumbtack','extension','directory_html',0,NULL,NULL,NULL,NULL,'extension',1,0,'ok',5,0),
  ('pc_angi_extension','angi','extension','directory_html',0,NULL,NULL,NULL,NULL,'extension',1,0,'ok',5,0),
  ('pc_healthgrades_extension','healthgrades','extension','directory_html',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,0),
  ('pc_zocdoc_extension','zocdoc','extension','directory_html',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,0),
  ('pc_findlaw_extension','findlaw','extension','directory_html',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,0);

-- --- Wave 4 — Social & contact enrichment (8 target types) ----------------
INSERT OR REPLACE INTO provider_capability
  (id, target_type, provider, adapter, cost_micro_per_unit, unit_type, quality, avg_latency_ms, max_records, runner, requires_login, requires_credential, compliance_flag, priority, enabled)
VALUES
  ('pc_instagram_profile_apify','instagram_profile','apify','profile_page',4000,'record',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_instagram_profile_extension','instagram_profile','extension','profile_page',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_facebook_page_apify','facebook_page','apify','profile_page',4000,'record',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_facebook_page_extension','facebook_page','extension','profile_page',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_tiktok_profile_apify','tiktok_profile','apify','profile_page',4000,'record',NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_tiktok_profile_extension','tiktok_profile','extension','profile_page',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_linkedin_company_extension','linkedin_company','extension','profile_page',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,0),
  ('pc_linkedin_company_manual','linkedin_company','manual','profile_page',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_youtube_channel_youtube_data_api','youtube_channel','youtube_data_api','api_json',NULL,NULL,NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_youtube_channel_gha_runner','youtube_channel','gha_runner','api_json',0,NULL,NULL,NULL,NULL,'gha',0,0,'ok',5,1),
  ('pc_twitter_x_profile_extension','twitter_x_profile','extension','profile_page',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_twitter_x_profile_manual','twitter_x_profile','manual','profile_page',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_yelp_verify_yelp','yelp_verify','yelp','api_json',NULL,NULL,NULL,NULL,NULL,'worker',0,1,'tos_limited',5,1),
  ('pc_yelp_verify_manual','yelp_verify','manual','api_json',0,NULL,NULL,NULL,NULL,'extension',0,0,'ok',5,1),
  ('pc_email_verify_l3_zerobounce','email_verify_l3','zerobounce','api_json',NULL,NULL,NULL,NULL,NULL,'worker',0,1,'ok',5,1),
  ('pc_email_verify_l3_doh','email_verify_l3','doh','tech_probe',0,NULL,NULL,NULL,NULL,'worker',0,0,'ok',5,1);

-- ===========================================================================
-- B. directory_sources — 8 Class C rows + exactly 1 Class X row
-- ===========================================================================
-- One table for every class, split by `class` (ADR-038; `manual_sources` no
-- longer exists). Class B rows are out of scope for this seed file.
--
--   class='C' -> manual-only. A NAMED block_reason from the seven-value enum is
--                mandatory, and so is a non-empty why_manual (05 §8/§9).
--   class='X' -> hard-blocked. No fetch, no link, no job, no override, ever.
--                Seeded disabled (enabled=0) as a read-only record.
--
-- base_url / rate_limit_per_min / manual_url_template / attribution_html are
-- NOT stated by any document for these sources -> NULL (never invented).
-- requires_credential = 0 for every row: Class C/X never carry a provider key
-- (Class C uses a device token only, R2). robots_ok is filled only where the
-- reason itself states it (ADA directory is robots_disallow -> 0).

-- --- Class C (8 sources: 6 that are target types + 2 registry-only) --------
INSERT OR REPLACE INTO directory_sources
  (id, source_key, display_name, base_url, target_type, adapter, rate_limit_per_min, requires_credential, robots_ok, class, block_reason, why_manual, manual_url_template, attribution_html, health, enabled)
VALUES
  ('ds_bbb','bbb','Better Business Bureau',NULL,'bbb','directory_html',NULL,0,NULL,'C','captcha',
   'Aggressive bot defense / captcha wall. Captcha auto-solving is forbidden (ADR-005), so only a human can read it. block_reason=captcha.',
   NULL,NULL,'ok',1),
  ('ds_thumbtack','thumbtack','Thumbtack',NULL,'thumbtack','directory_html',NULL,0,NULL,'C','login',
   'Listing sits behind a login wall, so automated fetch is impossible. block_reason=login.',
   NULL,NULL,'ok',1),
  ('ds_angi','angi','Angi',NULL,'angi','directory_html',NULL,0,NULL,'C','login',
   'Listing sits behind a login wall, so automated fetch is impossible. block_reason=login.',
   NULL,NULL,'ok',1),
  ('ds_healthgrades','healthgrades','Healthgrades',NULL,'healthgrades','directory_html',NULL,0,NULL,'C','tos_no_automation',
   'ToS ambiguity read conservatively: no automated access. block_reason=tos_no_automation.',
   NULL,NULL,'ok',1),
  ('ds_zocdoc','zocdoc','Zocdoc',NULL,'zocdoc','directory_html',NULL,0,NULL,'C','tos_no_automation',
   'ToS ambiguity read conservatively: no automated access. block_reason=tos_no_automation.',
   NULL,NULL,'ok',1),
  ('ds_findlaw','findlaw','FindLaw',NULL,'findlaw','directory_html',NULL,0,NULL,'C','tos_no_automation',
   'ToS ambiguity read conservatively: no automated access. block_reason=tos_no_automation.',
   NULL,NULL,'ok',1),
  ('ds_crunchbase','crunchbase','Crunchbase',NULL,NULL,'directory_html',NULL,0,NULL,'C','tos_no_automation',
   'ToS forbids automated access. No automated fetch by any runner; registry-only row, no target_type of its own (07 §3, 08 §4.1). block_reason=tos_no_automation.',
   NULL,NULL,'ok',1),
  ('ds_ada_directory','ada_directory','ADA Directory',NULL,NULL,'directory_html',NULL,0,0,'C','robots_disallow',
   'robots.txt disallows the crawler and there is no API. Registry-only row, no target_type of its own (07 §3, 08 §4.1). block_reason=robots_disallow.',
   NULL,NULL,'ok',1);

-- --- Class X (exactly 1 source: Yelp discovery) ---------------------------
-- Discovered from Yelp is prohibited outright and is NOT a Class C fallback:
-- block_reason='tos_no_storage' is override-proof. Any attempt returns
-- E_PROVIDER_POLICY + detail.reason="yelp_discovery" (16 §3.2). All fetch
-- columns are NULL, and the row is disabled — it exists only so the refusal is
-- visible and auditable rather than mysterious (20-roadmap §M0).
INSERT OR REPLACE INTO directory_sources
  (id, source_key, display_name, base_url, target_type, adapter, rate_limit_per_min, requires_credential, robots_ok, class, block_reason, why_manual, manual_url_template, attribution_html, health, enabled)
VALUES
  ('ds_yelp.com','yelp.com','Yelp (discovery)',NULL,NULL,NULL,NULL,0,NULL,'X','tos_no_storage',
   NULL,NULL,NULL,'ok',0);

-- ===========================================================================
-- C. score_weights version 1
-- ===========================================================================
-- RESOLVED — a schema/doc conflict found while seeding, and settled before the
-- first remote apply (the only moment 0001 may still change, ADR-028):
--
--   The first draft of 0001 enforced
--        weight REAL NOT NULL CHECK (weight >= 0.5 AND weight <= 1.5)
--   but 12-scoring.md §2 gives the v1 weights as points that SUM TO 100.
--   Both cannot hold: 18 values each <= 1.5 sum to at most 27, and a real run
--   raised `IntegrityError: CHECK constraint failed`.
--
--   The two numbers describe different things. ADR-021's clamp is the WEEKLY
--   MULTIPLIER on a lift — `new_weight = old × clamp(lift, 0.5, 1.5)`, written
--   to weight_history — while score_weights stores the POINT allocation it
--   multiplies. 0001 now bounds the column at 0-100 and says so in a comment.
--
--   So the INSERT below is live, not commented. 12 §9.3's "sums to 100"
--   requirement is met exactly; the one line in that checklist which repeats the
--   0.5-1.5 bound is the stale half of the same confusion.
--
-- Faithful v1 weight set, exactly as 12-scoring.md §2 (18 features, sum = 100):
--   Website Pain 35 · Reachability 25 · Buying Signal 25 · Fit 15
--   (12 §2.3 groups `job_postings_ats`/`_serp` into one weight and
--    `meta_ad_library`/`google_ads_transparency` into one, so those are one
--    row each — splitting them would invent numbers.)
--
INSERT OR REPLACE INTO score_weights (id, version, feature_key, weight, is_active) VALUES
  ('sw_v1_psi_mobile',            1, 'psi_mobile',            12, 1),  -- Website Pain
  ('sw_v1_wayback_last_change',   1, 'wayback_last_change',    8, 1),
  ('sw_v1_ssl_cert',              1, 'ssl_cert',               5, 1),
  ('sw_v1_tech_stack',            1, 'tech_stack',             6, 1),
  ('sw_v1_robots_sitemap',        1, 'robots_sitemap',         4, 1),
  ('sw_v1_email',                 1, 'email',                 10, 1),  -- Reachability
  ('sw_v1_phone_e164',            1, 'phone_e164',             6, 1),
  ('sw_v1_dns_mx',                1, 'dns_mx',                 5, 1),
  ('sw_v1_website_meta',          1, 'website_meta',           4, 1),
  ('sw_v1_job_postings_ats',      1, 'job_postings_ats',       8, 1),  -- Buying Signal
  ('sw_v1_meta_ad_library',       1, 'meta_ad_library',        7, 1),
  ('sw_v1_funding_news',          1, 'funding_news',           4, 1),
  ('sw_v1_new_domain_reg',        1, 'new_domain_reg',         3, 1),
  ('sw_v1_review_velocity',       1, 'review_velocity',        3, 1),
  ('sw_v1_niche',                 1, 'niche',                  6, 1),  -- Fit
  ('sw_v1_employee_estimate',     1, 'employee_estimate',      4, 1),
  ('sw_v1_geo_priority',          1, 'geo_priority',           3, 1),
  ('sw_v1_dataset_confidence',    1, 'dataset_confidence',     2, 1);

-- v1 is the active weights version.
UPDATE settings SET value_num = 1 WHERE key = 'active_weights_version';

-- ===========================================================================
-- D. STEP 3 validation queries — each MUST return zero rows
-- ===========================================================================
-- From 03-execution.md STEP 3 "Validation ১/২/৩" and 07-targets.md §4.
-- Run these after the seed is applied; a non-empty result fails the STEP.
--
-- (1) R20 — credential-free floor. Every target_type needs at least one
--     candidate row with requires_credential = 0, so that the pipeline does
--     not stop when every key is invalid at once.
--
--     SELECT target_type
--       FROM provider_capability
--      GROUP BY target_type
--     HAVING SUM(CASE WHEN requires_credential = 0 THEN 1 ELSE 0 END) = 0;
--     -- expect: 0 rows
--
-- (2) R22 — provider naming. No provider string may start with `bd`; the value
--     is always `brightdata` (`bd` is only a country code, BD = Bangladesh).
--
--     SELECT id, target_type, provider
--       FROM provider_capability
--      WHERE provider LIKE 'bd%';
--     -- expect: 0 rows
--
-- (3) R25 / ADR-038 — block_reason. No directory_sources row may carry a
--     block_reason outside the seven-value enum (or NULL), and no row may be
--     class C/X while claiming the Class-B-only sentinel 'none'.
--     Two conditions, one result set:
--
--     SELECT id, class, block_reason
--       FROM directory_sources
--      WHERE block_reason NOT IN
--            ('none','tos_no_storage','tos_no_automation','login','captcha','paid','robots_disallow')
--         OR block_reason IS NULL
--         OR (class IN ('C','X') AND block_reason = 'none');
--     -- expect: 0 rows
--
-- Companion STEP 3 assertions from 18-deployment.md §5 / 21-sprint-3day §5
-- (not one of the three above, listed for completeness — each must also return
-- zero rows):
--   * no class='X' row is enabled / reachable by the dispatcher;
--   * no provider_capability row has cost_micro_per_unit = 0 on a paid provider;
--   * the active score_weights version sums to 100 (±0.01).
-- ===========================================================================
