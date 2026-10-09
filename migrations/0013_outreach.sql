-- Track A, Item 7: outreach tracking (per-lead reach counts).
--
-- Deliberately lightweight: a counter + last-touch timestamp on the lead row
-- answers "how many times did we reach this lead?" in a single indexed read,
-- while the full history (channel, note, actor, time) lives in stage_events
-- where the rest of the lead's timeline already is. A separate outreach table
-- would double the write path for no query benefit — the dashboard's hot
-- questions are "never reached", "reached once", "reached 3+ times", all of
-- which are answered by the counter alone.
ALTER TABLE leads ADD COLUMN reach_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN last_reached_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_leads_reach ON leads(reach_count);

-- Additive only: stage_events records stage transitions (from_stage/to_stage);
-- an outreach touch is not a stage transition, so it needs its own label to be
-- queryable separately from the pipeline timeline. Existing rows keep
-- kind = NULL, which the queries treat as "not an outreach event".
ALTER TABLE stage_events ADD COLUMN kind TEXT;
