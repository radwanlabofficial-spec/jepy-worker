-- 0017_device_columns.sql
--
-- Schema drift fix for the extension's backend-scrape door. Verified against
-- PROD D1 via the Cloudflare API (sqlite_master), not guessed:
-- `src/routes/device.ts` POST /devices/request-scrape inserts `requested_by_device`
-- on job_queue, but 0001 never created that column, so every request-scrape call
-- fell into its try/catch fallback and then failed anyway (the fallback had its
-- own faults — 'backend_scrape' is not in the job_type CHECK and `target_url`
-- does not exist either; fixed in device.ts alongside).
--
-- One additive column, no rebuild: nothing existing references the name, and
-- NULL is the honest default for jobs no device ever requested.

ALTER TABLE job_queue ADD COLUMN requested_by_device TEXT;
