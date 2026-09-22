-- 0004_phone_normalisation_columns.sql — the five columns STEP 9 writes. ADR-044.
--
-- Why: R8 describes the dedup cascade as starting from a VALID, NON-SHARED phone,
-- and names the fields the normaliser produces (country, type, validity) plus the
-- counter that decides sharing (`phone_usage_count > 2`). None of those columns
-- existed: `leads` carried only `phone_raw` and `phone_e164`, and phone_e164 is
-- still empty on all 8,126 rows. The plan described the output of a step whose
-- storage had never been created.
--
-- Five nullable columns, no index:
--
--   phone_country      ISO-3166 alpha-2 that libphonenumber resolved the number
--                      under. Kept because "+1 512..." is ambiguous between the
--                      US and Canada, and a later re-normalisation needs to know
--                      which default was assumed rather than guess again.
--   phone_type         the library's OWN value, stored verbatim, with no CHECK.
--                      This was nearly a CHECK, and the guess would have been
--                      wrong: the four values measured across the 7,353 real
--                      numbers are
--                          FIXED_LINE_OR_MOBILE  7197
--                          TOLL_FREE              152
--                          MOBILE                   2
--                          unknown                  2
--                      A CHECK written from memory would have said
--                      'fixed_or_mobile' (lower case) and rejected 7,349 of them.
--                      The library's vocabulary is 11 values and only 4 appear in
--                      current data, so a CHECK is a constraint that silently
--                      rejects real data the first time a new country is added.
--                      Measured by scripts/measure_normalise.mjs, not assumed.
--   phone_valid        0/1 from libphonenumber's validation, not from a regex.
--                      NULL means "never normalised", which is a different claim
--                      from 0 ("normalised and found invalid") — the same
--                      distinction the seed makes between NULL and 0 for cost.
--   is_shared_phone    set by the R8 rule when phone_usage_count > 2. NOT NULL
--                      with DEFAULT 0 so the 8,126 existing rows get a value
--                      without a rewrite, and a plain 0/1 rather than a nullable
--                      flag so the cascade never has to treat NULL as false.
--   phone_usage_count  how many leads carry this E.164 after normalisation.
--
-- Deliberately NOT indexed. An INSERT into `leads` costs 1 row plus one per
-- index (ADR-043), so an index here would take the price of every future lead
-- from 8 rows written to 9. Neither column is ever filtered on: the cascade reads
-- them from the row it already has, and the shared-phone rule is evaluated in one
-- GROUP BY during backfill.
--
-- None of the five is added with a NOT NULL-and-no-default, so this is metadata
-- only in SQLite — existing rows are not rewritten and the migration cannot make
-- the database unavailable while it holds the write lock.

ALTER TABLE leads ADD COLUMN phone_country     TEXT;
ALTER TABLE leads ADD COLUMN phone_type        TEXT;
-- 0 = normalised and invalid, 1 = normalised and valid, NULL = never normalised.
-- Three states on purpose: the plan's "validity" is meaningless until a number has
-- been through the parser, and 0 is a claim about the number, not about our work.
ALTER TABLE leads ADD COLUMN phone_valid       INTEGER;
ALTER TABLE leads ADD COLUMN is_shared_phone   INTEGER NOT NULL DEFAULT 0
                                                 CHECK (is_shared_phone IN (0,1));
ALTER TABLE leads ADD COLUMN phone_usage_count INTEGER;
