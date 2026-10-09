/**
 * Cold-storage reads (Track A, Item 2: R2 hybrid cold storage).
 *
 * These routes are R2-only: listing and reading archived leads costs zero D1
 * reads, which is the whole point of moving cold data out of D1. The one
 * exception is the optional `?log=1` on the batches list, which attaches the
 * `lead_archive_log` rows (a single cheap SELECT) so the dashboard can show
 * batch provenance without a second call.
 *
 * The archive job itself lives in `src/jobs/archive.ts` (cron/admin-triggered);
 * there is intentionally no write path here — nothing recreates cold leads into
 * D1 from these routes, so the archive can never silently inflate the hot
 * table's read bill.
 */

import { Hono } from 'hono';
import { fail, ok } from '../lib/envelope';
import { badRequest, decodeCursor, encodeCursor, readPage } from '../lib/http';
import type { Actor, Env } from '../env';

export const archiveRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

/** Every archive object lives under this prefix; anything else is not ours. */
const ARCHIVE_PREFIX = 'archives/leads/';
/** Never parse more than this many lines per call — a full 500-lead batch
 *  object stays a manageable few hundred KB in memory, and the dashboard
 *  pages through it instead of downloading history in one gulp. */
const MAX_LINES_PER_CALL = 200;

/**
 * `GET /archive/batches` — list archive batches (newest objects first, per R2
 * listing order), paginated with the opaque `?cursor=` R2 returns.
 */
archiveRoutes.get('/archive/batches', async (c) => {
  const url = new URL(c.req.url);
  const { limit, cursor } = readPage(url);

  const listing = await c.env.RAW.list({
    prefix: ARCHIVE_PREFIX,
    limit,
    cursor: cursor ?? undefined,
  });

  const batches = (listing.objects ?? []).map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded ? obj.uploaded.toISOString() : null,
  }));

  // Optional single-read provenance: which batch holds how many leads and
  // which created_at window, straight from the archive log.
  let log: Array<Record<string, unknown>> | undefined;
  if (url.searchParams.get('log') === '1') {
    const rows = await c.env.DB.prepare(
      `SELECT id, r2_key, lead_count, oldest_created_at, newest_created_at, created_at
         FROM lead_archive_log
        ORDER BY created_at DESC
        LIMIT 100`,
    ).all();
    log = (rows.results ?? []) as Array<Record<string, unknown>>;
  }

  return c.json(
    ok(
      { batches, log: log ?? null },
      { next_cursor: listing.truncated ? listing.cursor : null, has_more: listing.truncated },
    ),
  );
});

/**
 * `GET /archive/leads?key=<r2key>&limit=&cursor=` — page through one batch's
 * JSONL object. `key` MUST start with `archives/leads/`: without that check
 * this endpoint would read any object in the bucket, including import staging
 * files that belong to other workflows.
 *
 * The cursor is an opaque line offset into the object. The object is read in
 * full but only up to MAX_LINES_PER_CALL lines are parsed and returned — the
 * batch size is capped at 500 leads by the archive job, so the whole object
 * fits comfortably in memory while the caller still pays per-page.
 */
archiveRoutes.get('/archive/leads', async (c) => {
  const url = new URL(c.req.url);
  const key = url.searchParams.get('key') ?? '';
  if (!key.startsWith(ARCHIVE_PREFIX) || key.includes('..')) {
    const { body, status } = badRequest('invalid_archive_key');
    return c.json(body, status as 400);
  }

  const { limit } = readPage(url);
  const pageSize = Math.min(limit, MAX_LINES_PER_CALL);

  const rawCursor = url.searchParams.get('cursor');
  let offset = 0;
  if (rawCursor) {
    const parts = decodeCursor(rawCursor);
    const parsed = parts ? Number(parts[0]) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      const { body, status } = badRequest('invalid_cursor');
      return c.json(body, status as 400);
    }
    offset = Math.trunc(parsed);
  }

  const obj = await c.env.RAW.get(key);
  if (!obj) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'archive_batch_missing', key });
    return c.json(body, status as 404);
  }

  // Split first, parse only the page: a malformed line inside the page fails
  // the page (it should not exist), while malformed lines outside the page are
  // left alone — one bad byte must not poison the whole batch for everyone.
  const text = await obj.text();
  const lines = text.split('\n').filter((line) => line.length > 0);
  const pageLines = lines.slice(offset, offset + pageSize);

  const leads: Array<Record<string, unknown>> = [];
  for (const line of pageLines) {
    try {
      leads.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      const { body, status } = fail('E_INTERNAL', { reason: 'archive_line_corrupt', key, offset });
      return c.json(body, status as 500);
    }
  }

  const nextOffset = offset + pageLines.length;
  const hasMore = nextOffset < lines.length;

  return c.json(
    ok(
      { key, leads, total_lines: lines.length },
      { next_cursor: hasMore ? encodeCursor([nextOffset]) : null, has_more: hasMore },
    ),
  );
});
