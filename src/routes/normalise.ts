/**
 * STEP 9 — normalising the numbers that are already in the database.
 *
 * Two passes, both idempotent, both driven in slices so that a run over 8,126
 * rows never needs one request to hold the whole table:
 *
 *   /chunk    walks `leads` by primary key, parses `phone_raw`, writes the five
 *             phone columns, and records which normaliser produced them
 *   /shared   one pass that fills `phone_usage_count` and applies R8's
 *             shared-phone rule
 *
 * WHY A BACKFILL EXISTS AT ALL. The import could have normalised as it inserted,
 * and now it does (`routes/imports.ts`) — but it could not before: the import
 * path carried `phoneKey()`, a digit-count stand-in written before
 * `libphonenumber-js` was a dependency, and the five columns did not exist until
 * migration 0004. So this runs once against the rows that arrived earlier, and
 * the insert path means it never has to run again.
 *
 * IDEMPOTENT BY COMPARISON, NOT BY TRUST. A row whose stored values already equal
 * what the normaliser produces is skipped, so a second run writes zero rows. That
 * is not politeness — the D1 allowance is counted in rows WRITTEN, and re-writing
 * 7,353 rows to arrive at the same answer spends a day's budget on nothing.
 *
 * IDEMPOTENT IS NOT THE SAME AS SAFE TO RE-RUN BLINDLY, so the pass also reports
 * what it did to each of the four kinds of row: updated, already correct, nothing
 * to normalise (a blank string), and skipped because it is manual.
 *
 * R7 — a manually edited row is never overwritten. Rows with
 * `is_manual_edited = 1` are skipped before the comparison and counted, because
 * the derived phone columns are exactly the kind of thing a person would have
 * corrected by hand, and a switchboard number typed in by an operator outranks a
 * parser's opinion of it.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { requireAdmin } from '../middleware/auth';
import { NORMALISER, normalisePhone } from '../lib/phone';
import type { Actor, Env } from '../env';

export const normaliseRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

normaliseRoutes.use('/admin/normalise/*', requireAdmin);

/** Bounds the response, the D1 batch and the number of statements per call. */
const MAX_ROWS_PER_CALL = 500;
/** Same ceiling as the import path, for the same reason: a batch has a limit. */
const BATCH_SIZE = 100;

const chunkSchema = z.object({
  after_id: z.string().max(80).nullish(),
  limit: z.number().int().min(1).max(MAX_ROWS_PER_CALL).nullish(),
});

interface LeadRow {
  id: string;
  phone_raw: string | null;
  country_code: string | null;
  phone_e164: string | null;
  phone_country: string | null;
  phone_type: string | null;
  phone_valid: number | null;
  provenance_json: string | null;
  is_manual_edited: number | null;
}

/**
 * Adds the derived phone fields to a row's provenance without disturbing what is
 * already there.
 *
 * The existing shape is `{dataset, release, raw_ref_r2, fields: {column: source}}`
 * and `fields` is what R7 reads to answer "who wrote this". A derived column's
 * source is the normaliser, recorded with its version: a bump to
 * `libphonenumber-js` can change which country a number resolves under, and a
 * provenance that named only the library would not say which of the two answers
 * this row holds.
 *
 * A provenance that will not parse is replaced rather than thrown on. It cannot
 * be merged, and leaving it alone would silently drop the record that these four
 * columns were derived at all.
 */
function withDerivedFields(raw: string | null, fields: string[]): string {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = { unparsable_provenance: raw.slice(0, 200) };
    }
  }

  const existing = parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)
    ? (parsed.fields as Record<string, unknown>)
    : {};

  parsed.fields = { ...existing };
  for (const field of fields) (parsed.fields as Record<string, string>)[field] = NORMALISER;

  return JSON.stringify(parsed);
}

/**
 * Normalises one slice. `after_id` is the last id processed; the caller passes the
 * `next_after_id` from the previous call and stops when `done` is true.
 *
 * Ordering is by primary key. `id` is a UUID string, so the order is arbitrary
 * but stable — which is all a cursor needs, and all it should depend on.
 */
normaliseRoutes.post('/admin/normalise/chunk', async (c) => {
  const parsed = chunkSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const afterId = parsed.data.after_id ?? '';
  const limit = parsed.data.limit ?? MAX_ROWS_PER_CALL;

  const result = await c.env.DB.prepare(
    `SELECT id, phone_raw, country_code, phone_e164, phone_country, phone_type, phone_valid,
            provenance_json, is_manual_edited
       FROM leads
      WHERE id > ?
      ORDER BY id
      LIMIT ?`,
  )
    .bind(afterId, limit)
    .all<LeadRow>();

  const rows = result.results ?? [];
  const statements: D1PreparedStatement[] = [];

  const counts = { updated: 0, already_correct: 0, nothing_to_normalise: 0, skipped_manual: 0, invalid: 0 };

  for (const row of rows) {
    // R7: the operator's answer wins, and is not even recomputed.
    if (row.is_manual_edited === 1) {
      counts.skipped_manual += 1;
      continue;
    }

    const n = normalisePhone(row.phone_raw, row.country_code);

    if (n.valid === null) {
      counts.nothing_to_normalise += 1;
      continue;
    }
    if (n.valid === 0) counts.invalid += 1;

    const unchanged =
      row.phone_e164 === n.e164 &&
      row.phone_country === n.country &&
      row.phone_type === n.type &&
      row.phone_valid === n.valid;

    if (unchanged) {
      counts.already_correct += 1;
      continue;
    }

    statements.push(
      c.env.DB.prepare(
        // The `is_manual_edited = 0` test is repeated here rather than trusted
        // from the read. The row was read in an earlier round trip and a human
        // can reach the console in between; the guard that matters is the one
        // evaluated by the writer.
        `UPDATE leads
            SET phone_e164 = ?, phone_country = ?, phone_type = ?, phone_valid = ?, provenance_json = ?
          WHERE id = ? AND is_manual_edited = 0`,
      ).bind(
        n.e164,
        n.country,
        n.type,
        n.valid,
        withDerivedFields(row.provenance_json, ['phone_e164', 'phone_country', 'phone_type', 'phone_valid']),
        row.id,
      ),
    );
    counts.updated += 1;
  }

  let written = 0;
  for (let offset = 0; offset < statements.length; offset += BATCH_SIZE) {
    const results = await c.env.DB.batch(statements.slice(offset, offset + BATCH_SIZE));
    for (const result of results) written += result.meta.changes ?? 0;
  }

  const last = rows[rows.length - 1];
  const done = rows.length < limit;

  return c.json(
    ok({
      processed: rows.length,
      written,
      ...counts,
      next_after_id: last ? last.id : afterId,
      done,
      normaliser: NORMALISER,
    }),
  );
});

/**
 * Fills `phone_usage_count` and applies R8's rule: a number carried by more than
 * two leads is a switchboard, not an identity, so the phone tier is demoted for
 * it and the cascade falls through to the source's own id.
 *
 * One statement rather than a chunk walk. The count is a correlated subquery
 * against `idx_leads_phone`, which is the index ADR-043 deliberately kept for
 * exactly this.
 *
 * Measured before it was written: across all 8,126 production rows, no E.164 is
 * held by more than one lead, so this sets every `phone_usage_count` to 1 and
 * flags nothing as shared. It is implemented all the same, because "no
 * switchboards in Austin restaurants" is a fact about one dataset and not a
 * property of the rule.
 */
normaliseRoutes.post('/admin/normalise/shared', async (c) => {
  const result = await c.env.DB.prepare(
    `UPDATE leads
        SET phone_usage_count = (SELECT COUNT(*) FROM leads l2 WHERE l2.phone_e164 = leads.phone_e164),
            is_shared_phone   = CASE
              WHEN (SELECT COUNT(*) FROM leads l2 WHERE l2.phone_e164 = leads.phone_e164) > 2 THEN 1 ELSE 0 END
      WHERE phone_e164 IS NOT NULL AND is_manual_edited = 0`,
  ).run();

  return c.json(ok({ rows_written: result.meta.changes ?? 0 }));
});

/**
 * Progress, in one round trip.
 *
 * `normalised` counts through `idx_leads_phone`, so it is an index count rather
 * than a table scan; the row total is the only full read and is unavoidable.
 */
normaliseRoutes.get('/admin/normalise/status', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM leads) AS leads,
            (SELECT COUNT(*) FROM leads WHERE phone_e164 IS NOT NULL) AS normalised,
            (SELECT COUNT(*) FROM leads WHERE phone_valid = 0) AS invalid,
            (SELECT COUNT(*) FROM leads WHERE phone_usage_count > 2) AS shared_phones,
            (SELECT COUNT(*) FROM leads WHERE is_manual_edited = 1) AS manual_edited`,
  ).first<{ leads: number; normalised: number; invalid: number; shared_phones: number; manual_edited: number }>();

  return c.json(ok({ ...row, normaliser: NORMALISER }));
});
