/**
 * Wave 0 — the Tier 0 bulk import (STEP 8).
 *
 * The shape is three calls, deliberately:
 *
 *   start   open a row in `dataset_imports` and get an `import_id`
 *   chunk   N times, one per slice of the dump; each call stages the raw slice
 *           in R2 and upserts its rows into `leads`
 *   finish  close the ledger row with a status and a duration
 *
 * The runner is GitHub Actions with DuckDB, not this Worker: reading a 10 GB
 * parquet dump is not something an edge Worker should do, and the 15-minute
 * cron ceiling would cap it anyway. GitHub Actions reads the dump, filters it,
 * and pushes NDJSON here in slices.
 *
 * WHY THE RUNNER PUSHES INSTEAD OF WRITING TO R2 DIRECTLY. R2 speaks S3, so the
 * obvious design has DuckDB write parquet straight into the bucket with an R2
 * access key. That needs a second long-lived credential — an S3 key id and
 * secret, separate from the Cloudflare API token, with its own rotation and its
 * own way to leak into a GitHub log. This Worker already holds the `RAW` binding
 * and authenticates the runner with the same `ADMIN_SECRET` that already drives
 * cron, so routing the bytes through it removes a credential rather than adding
 * one. The cost is that a slice travels through the Worker before it reaches R2;
 * the benefit is that there is no R2 key to rotate and no new secret to store.
 *
 * `raw_ref_r2` is written per chunk for the same reason the adapters write it:
 * a row that looks wrong six months from now should be traceable to the exact
 * bytes that produced it, and re-parseable without re-downloading the dump.
 *
 * IDEMPOTENCY is the whole point of the `dedup_key` unique index. Every insert
 * is `INSERT OR IGNORE`, so a slice replayed after a network failure — or a
 * whole import run twice, which is what the foundation gate actually tests —
 * inserts nothing the second time and reports the difference. `rows_deduped` is
 * therefore not an error count: on a second run of the same dump it is expected
 * to equal `rows_kept`, and that is the pass condition, not a warning.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { requireAdmin } from '../middleware/auth';
import type { Actor, Env } from '../env';

/** Rows per call. Bounds the request body, the D1 batch and the R2 object. */
const MAX_ROWS_PER_CHUNK = 500;

export const importRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

importRoutes.use('/admin/import/*', requireAdmin);

/**
 * The staging key. Preview writes under `preview/`, which is the prefix the
 * bucket's lifecycle rule expires after seven days — so a preview run cannot
 * accumulate storage the free tier has to pay for. Production has no prefix and
 * no expiry, because a production slice is evidence.
 */
function stageKey(env: Env, importId: string, chunkIndex: number): string {
  const prefix = env.ENVIRONMENT === 'preview' ? 'preview/' : '';
  return `${prefix}wave0/${importId}/chunk-${String(chunkIndex).padStart(5, '0')}.ndjson`;
}

/**
 * A slug good enough to compare two business names, and no better.
 *
 * This is not the normaliser STEP 9 builds. It exists only so the third step of
 * the dedup cascade has something stable to compare, and it is intentionally
 * conservative: lowercase, strip accents and punctuation, collapse whitespace.
 * Anything cleverer here would silently merge two legitimately different
 * businesses, and the merge is not reversible from the surviving row.
 */
function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Digits for comparison, with a US country code when the shape is unmistakably
 * North American. STEP 9 replaces this with libphonenumber-js and the full
 * cascade; until then the honest statement is that this catches the common case
 * and nothing else, which is still better than deduplicating on nothing.
 */
function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8) return `+${digits}`;
  return null;
}

/**
 * The dedup cascade, in the order 05-schema.md gives it, restricted to the
 * fields a Tier 0 dump actually carries: phone, then the source's own id, then
 * name+city. Email and domain come later, when enrichment has fetched them.
 *
 * The prefix is part of the key on purpose. Two different businesses can share a
 * slug, and a slug that collides with a phone number would be a merge nobody
 * could explain afterwards.
 */
function dedupKey(row: { phone?: string | null; overture_id?: string | null; fsq_id?: string | null; name: string; city?: string | null }): string {
  const phone = phoneKey(row.phone);
  if (phone) return `p:${phone}`;
  if (row.overture_id) return `o:${row.overture_id}`;
  if (row.fsq_id) return `f:${row.fsq_id}`;
  return `n:${slugify(row.name)}|${slugify(row.city ?? '')}`;
}

const rowSchema = z.object({
  name: z.string().min(1).max(300),
  overture_id: z.string().max(120).nullish(),
  fsq_id: z.string().max(120).nullish(),
  website_url: z.string().max(500).nullish(),
  domain: z.string().max(300).nullish(),
  phone: z.string().max(60).nullish(),
  address_line: z.string().max(400).nullish(),
  city: z.string().max(200).nullish(),
  region: z.string().max(200).nullish(),
  postal_code: z.string().max(40).nullish(),
  country_code: z.string().max(4).nullish(),
  lat: z.number().nullish(),
  lng: z.number().nullish(),
  category: z.string().max(200).nullish(),
  basic_category: z.string().max(120).nullish(),
  niche: z.string().max(120).nullish(),
  // Not written to a `leads` column — there is none — but kept in the schema so
  // it survives validation and lands in `provenance_json`. Zod drops unknown
  // keys silently, and a silently dropped confidence is a filter threshold with
  // no record of which side of it a row fell on.
  confidence: z.number().nullish(),
});

const startSchema = z.object({
  dataset: z.enum(['overture', 'fsq']),
  release_version: z.string().min(1).max(80),
  geo_target_id: z.string().min(1).max(120),
  min_confidence: z.number().min(0).max(1).optional(),
  runner: z.string().min(1).max(80),
});

const chunkSchema = z.object({
  import_id: z.string().min(1).max(80),
  chunk_index: z.number().int().min(0),
  rows_read: z.number().int().min(0),
  rows_kept: z.number().int().min(0),
  rows: z.array(rowSchema).max(MAX_ROWS_PER_CHUNK),
});

const finishSchema = z.object({
  import_id: z.string().min(1).max(80),
  status: z.enum(['ok', 'failed']),
  error_text: z.string().max(1000).optional(),
  duration_sec: z.number().int().min(0).optional(),
});

/**
 * The category list the runner filters on, read from `niches` rather than kept
 * in the workflow file.
 *
 * This endpoint exists so that adding a niche is a row in D1 and not a commit
 * to the workflow. A list copied into the YAML would drift from `niches` the
 * first time someone edits one and not the other, and the failure would be
 * silent: the import would keep running and simply stop selecting the new
 * category.
 */
importRoutes.get('/admin/import/niches', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT niche_slug, display_name, overture_categories_json
       FROM niches
      WHERE enabled = 1 AND overture_categories_json IS NOT NULL
      ORDER BY priority DESC, niche_slug`,
  ).all<{ niche_slug: string; display_name: string; overture_categories_json: string }>();

  const niches = (rows.results ?? []).map((row) => ({
    niche_slug: row.niche_slug,
    display_name: row.display_name,
    overture_categories: JSON.parse(row.overture_categories_json) as string[],
  }));

  return c.json(ok({ niches, count: niches.length }));
});

importRoutes.post('/admin/import/start', async (c) => {
  const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const input = parsed.data;

  // The geo target has to exist. A dump imported against a target id nothing
  // points at would produce rows no scan ever revisits, and the foreign key
  // would have caught it one layer deeper with a worse message.
  const geo = await c.env.DB.prepare(`SELECT id FROM geo_targets WHERE id = ?`)
    .bind(input.geo_target_id)
    .first<{ id: string }>();
  if (!geo) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_geo_target' });
    return c.json(body, status as 404);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO dataset_imports
       (id, dataset, release_version, geo_target_id, min_confidence, runner, status, started_at, rows_read, rows_kept, rows_inserted, rows_deduped)
     VALUES (?, ?, ?, ?, ?, ?, 'running', unixepoch(), 0, 0, 0, 0)`,
  )
    .bind(id, input.dataset, input.release_version, input.geo_target_id, input.min_confidence ?? null, input.runner)
    .run();

  return c.json(ok({ import_id: id, max_rows_per_chunk: MAX_ROWS_PER_CHUNK }));
});

importRoutes.post('/admin/import/chunk', async (c) => {
  const parsed = chunkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const input = parsed.data;

  const ledger = await c.env.DB.prepare(
    `SELECT id, release_version, dataset, status FROM dataset_imports WHERE id = ?`,
  )
    .bind(input.import_id)
    .first<{ id: string; release_version: string; dataset: string; status: string }>();

  if (!ledger) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_import' });
    return c.json(body, status as 404);
  }
  if (ledger.status !== 'running') {
    // A closed ledger is not a transient condition: the runner has already told
    // us this import is over, so continuing to accept slices would write rows
    // that no `finished_at` ever covers.
    const { body, status } = fail('E_VALIDATION', { reason: 'import_closed' });
    return c.json(body, status as 400);
  }

  // Stage the slice BEFORE touching D1. If the insert then fails, the bytes are
  // already addressable and the run can be diagnosed from what actually arrived
  // rather than from what the caller believed it sent.
  const key = stageKey(c.env, input.import_id, input.chunk_index);
  await c.env.RAW.put(key, input.rows.map((row) => JSON.stringify(row)).join('\n') + '\n', {
    httpMetadata: { contentType: 'application/x-ndjson' },
  });

  const now = Math.floor(Date.now() / 1000);
  const statements = input.rows.map((row) => {
    const provenance = JSON.stringify({
      dataset: ledger.dataset,
      release: ledger.release_version,
      raw_ref_r2: key,
      fields: Object.fromEntries(
        Object.entries(row)
          .filter(([, value]) => value !== null && value !== undefined && value !== '')
          .map(([field]) => [field, ledger.dataset]),
      ),
    });

    return c.env.DB.prepare(
      // `INSERT OR IGNORE`, not `ON CONFLICT DO UPDATE`. An upsert would report a
      // change for every duplicate and make `rows_inserted` measure traffic
      // rather than new businesses, and the difference between the two is
      // exactly what the re-run test asserts.
      `INSERT OR IGNORE INTO leads
         (id, name, name_slug, domain, website_url, phone_raw, address_line, city, region, postal_code,
          country_code, lat, lng, category, niche, overture_id, fsq_id, dedup_key,
          status, stage, captured_by, source_url, lawful_basis, provenance_json, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'new', 'dataset', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      row.name,
      slugify(row.name),
      row.domain ?? null,
      row.website_url ?? null,
      row.phone ?? null,
      row.address_line ?? null,
      row.city ?? null,
      row.region ?? null,
      row.postal_code ?? null,
      row.country_code ?? null,
      row.lat ?? null,
      row.lng ?? null,
      row.category ?? null,
      row.niche ?? null,
      row.overture_id ?? null,
      row.fsq_id ?? null,
      dedupKey(row),
      row.website_url ?? null,
      // Overture Places is ODbL. Storing it is redistribution-neutral; EXPORTING
      // it is the open licensing question the plan still has to settle, so this
      // records where the data came from and nothing more.
      'public_dataset:overture-odbl',
      provenance,
      now,
    );
  });

  let inserted = 0;
  if (statements.length > 0) {
    // Sent in batches of 100 rather than as one call. A batch has a ceiling, and
    // discovering it halfway through a slice would leave the ledger short of what
    // actually landed — the one failure this ledger exists to make impossible.
    // `rows_inserted` is computed from the applied statements, so a partial
    // failure under-reports rather than over-reports, and the `dedup_key` index
    // means replaying the slice costs a wasted request and no duplicate rows.
    const BATCH_SIZE = 100;
    for (let offset = 0; offset < statements.length; offset += BATCH_SIZE) {
      const results = await c.env.DB.batch(statements.slice(offset, offset + BATCH_SIZE));
      for (const result of results) inserted += result.meta.changes ?? 0;
    }
  }
  const deduped = input.rows.length - inserted;

  // One statement for all four counters, so a retried slice cannot double-count:
  // the caller retries, the ledger stays the sum of what was actually applied.
  await c.env.DB.prepare(
    `UPDATE dataset_imports
        SET rows_read = rows_read + ?,
            rows_kept = rows_kept + ?,
            rows_inserted = rows_inserted + ?,
            rows_deduped = rows_deduped + ?
      WHERE id = ?`,
  )
    .bind(input.rows_read, input.rows_kept, inserted, deduped, input.import_id)
    .run();

  return c.json(ok({ chunk_index: input.chunk_index, staged_key: key, inserted, deduped }));
});

importRoutes.post('/admin/import/finish', async (c) => {
  const parsed = finishSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const input = parsed.data;

  const result = await c.env.DB.prepare(
    `UPDATE dataset_imports
        SET status = ?, error_text = ?, duration_sec = ?, finished_at = unixepoch()
      WHERE id = ?`,
  )
    .bind(input.status, input.error_text ?? null, input.duration_sec ?? null, input.import_id)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_import' });
    return c.json(body, status as 404);
  }

  const ledger = await c.env.DB.prepare(
    `SELECT rows_read, rows_kept, rows_inserted, rows_deduped, status FROM dataset_imports WHERE id = ?`,
  )
    .bind(input.import_id)
    .first();

  return c.json(ok({ import_id: input.import_id, ledger }));
});
