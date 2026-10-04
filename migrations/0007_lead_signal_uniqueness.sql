-- 0007_lead_signal_uniqueness.sql — one row per (lead, signal).
--
-- WHY THIS EXISTS. `lead_signals` was built as an append-only log: two plain
-- indexes, no unique key. That was fine while nothing wrote to it. STEP 10 makes
-- it the scoring input, and scoring reads ONE value per feature key — so if a
-- re-probe appends a second `psi_mobile` row, `pass0.ts` picks whichever the query
-- happened to return first and the score becomes non-deterministic for reasons
-- nobody can see by reading either file.
--
-- There are two honest ways to model a re-measurement: append every measurement
-- and read the newest, or hold the current measurement. This keeps the second,
-- because 12-scoring.md §2.5 already gives each signal an `expires_at` — a row
-- that is superseded is not history worth keeping, it is stale evidence with no
-- reader. `collected_at` on the surviving row answers "how fresh is this" on its
-- own, and any future change to keep a history belongs in its own table rather
-- than in the scoring input.
--
-- The unique index REPLACES the non-unique `idx_lead_signals_lead`, which covered
-- the same columns and is therefore now pure write cost. This is the same
-- trade migration 0003 made on `leads`: an index that no query needs is a tax on
-- every insert, and D1 charges for rows written.
--
-- AUTHORITY: 12-scoring.md §2.5 (one current value per feature, expiry decides
-- freshness); ADR-028 (forward-only migrations). No locked decision changes.

DROP INDEX idx_lead_signals_lead;

CREATE UNIQUE INDEX idx_lead_signals_lead_key ON lead_signals(lead_id, signal_key);
