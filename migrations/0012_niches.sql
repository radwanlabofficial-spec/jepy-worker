-- Track A, Item 6: niche/category folders.
--
-- The pre-existing `niches` table (0001) is a scraper-facing taxonomy
-- (niche_slug, display_name, overture/fsq categories, avg deal value). It is
-- the source of truth for WHICH niches exist. This migration adds the
-- operator-facing assignment layer: which lead belongs to which niche folder.
--
-- Why a join table rather than only `leads.niche`: a lead can legitimately sit
-- in more than one folder (e.g. a dental clinic that also does cosmetics is
-- both "dental" and "beauty"), and folder assignment is an operator action
-- that must survive the scraper overwriting `leads.niche`. The single-value
-- `leads.niche` column is kept as the backward-compatible primary folder so
-- every existing filter (`WHERE niche = ?`) keeps working unchanged.
CREATE TABLE IF NOT EXISTS lead_niche_assignments (
  lead_id     TEXT NOT NULL,
  niche_slug  TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (lead_id, niche_slug)
);

CREATE INDEX IF NOT EXISTS idx_lead_niche_assignments_slug
  ON lead_niche_assignments(niche_slug);

-- Additive only: lets POST/PATCH /niches carry a human description without
-- touching the scraper's taxonomy columns.
ALTER TABLE niches ADD COLUMN description TEXT;
