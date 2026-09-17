/**
 * Leads.
 *
 * Read-only in this phase. Two details matter more than the query itself:
 * `provisional` is returned as its own flag rather than being folded into COLD,
 * and `manual_edited` travels with every row so the UI can mark a hand-edited
 * field — the whole point of that column is that a human value outranks a
 * scraped one (R7).
 */

import { Hono } from 'hono';
import { fail, ok, type ApiMeta } from '../lib/envelope';
import { badRequest, decodeCursor, encodeCursor, intParam, boolParam, readPage } from '../lib/http';
import type { Actor, Env } from '../env';

export const leadRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

const SELECT_COLUMNS = `
  id, name, domain, website_url, city, country_code, niche,
  tier, status, stage, rule_score, ai_score, final_score,
  is_manual_edited, next_follow_up_at, lost_reason,
  language, timezone, updated_at`;

leadRoutes.get('/leads', async (c) => {
  const url = new URL(c.req.url);
  const { limit, cursor } = readPage(url);

  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  const tier = url.searchParams.get('tier');
  if (tier) {
    where.push('tier = ?');
    params.push(tier);
  }
  const status = url.searchParams.get('status');
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const stage = url.searchParams.get('stage');
  if (stage) {
    where.push('stage = ?');
    params.push(stage);
  }
  const city = url.searchParams.get('city');
  if (city) {
    where.push('city = ?');
    params.push(city);
  }
  const niche = url.searchParams.get('niche');
  if (niche) {
    where.push('niche = ?');
    params.push(niche);
  }
  const minScore = intParam(url, 'min_score');
  if (minScore !== null) {
    where.push('final_score >= ?');
    params.push(minScore);
  }
  const hasEmail = boolParam(url, 'has_email');
  if (hasEmail !== null) {
    where.push(hasEmail ? 'email IS NOT NULL' : 'email IS NULL');
  }
  const q = url.searchParams.get('q');
  if (q) {
    // LIKE with a leading wildcard cannot use an index, which is acceptable at
    // this scale and honest about intent: this is a search box, not a lookup.
    where.push('(name LIKE ? OR domain LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const sort = url.searchParams.get('sort') === 'updated' ? 'updated' : 'score';

  if (cursor) {
    const parts = decodeCursor(cursor);
    if (!parts) {
      const { body, status: code } = badRequest();
      return c.json(body, code as 400);
    }
    const [lastScore, lastUpdated, lastId] = parts;
    if (sort === 'updated') {
      where.push('(updated_at, id) < (?, ?)');
      params.push(Number(lastUpdated), lastId);
    } else {
      where.push('(COALESCE(final_score, -1), id) < (?, ?)');
      params.push(Number(lastScore), lastId);
    }
  }

  const orderBy = sort === 'updated'
    ? 'updated_at DESC, id DESC'
    : 'COALESCE(final_score, -1) DESC, id DESC';

  const result = await c.env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM leads
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all<Record<string, unknown>>();

  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const meta: ApiMeta = {
    has_more: hasMore,
    next_cursor:
      hasMore && last
        ? encodeCursor([sort === 'updated' ? 0 : (last.final_score as number | null), last.updated_at as number, last.id as string])
        : null,
    // Deliberately not COUNT(*): an exact total on a filtered scan is the most
    // expensive query on this page and the UI only needs "is this all of it".
    total_estimate: null,
  };

  return c.json(ok(page, meta));
});

// Registered BEFORE `/leads/:id`. Hono matches in registration order, so with
// the parameterised route first the literal segment "stats" is captured as an
// id and the endpoint answers 404 — which is exactly what happened on the first
// deploy.
/**
 * The Overview's numbers, in one round trip.
 *
 * `mtd_budget_micro` is a code constant rather than a stored setting: the monthly
 * cash ceiling appears in 17-budget.md but was never given a `settings` key, and
 * the schema is frozen (ADR-028). It lives here, labelled, until an ADR moves it.
 */
const MONTHLY_BUDGET_MICRO = 70_000_000; // $70

leadRoutes.get('/leads/stats', async (c) => {
  const [tiers, totals, verified, queue, bdToday, mtd, errors, aiToday, config] =
    await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT COALESCE(tier, 'provisional') AS bucket, COUNT(*) AS n
         FROM leads WHERE deleted_at IS NULL GROUP BY bucket`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN created_at >= unixepoch() - 86400 THEN 1 ELSE 0 END), 0) AS new_today,
              COALESCE(SUM(CASE WHEN stage = 'won' THEN 1 ELSE 0 END), 0) AS won
         FROM leads WHERE deleted_at IS NULL`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT lead_id) AS verified_email FROM contacts WHERE verify_layer = 'L3'`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS queue_depth,
              COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
              MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending
         FROM job_queue WHERE status IN ('pending','claimed','running')`,
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(credits), 0) AS bd_credits_today FROM brightdata_credit_log
        WHERE created_at >= CAST(strftime('%s', date('now')) AS INTEGER)`,
    ),
    c.env.DB.prepare(
      `SELECT
         (SELECT COALESCE(SUM(cost_micro), 0) FROM brightdata_credit_log
           WHERE created_at >= CAST(strftime('%s', date('now','start of month')) AS INTEGER))
       + (SELECT COALESCE(SUM(cost_micro), 0) FROM apify_usage_log
           WHERE created_at >= CAST(strftime('%s', date('now','start of month')) AS INTEGER)) AS mtd_cost_micro`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS errors_24h FROM error_log WHERE created_at >= unixepoch() - 86400`,
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(lead_count), 0) AS ai_requests_today FROM ai_score_log
        WHERE created_at >= unixepoch() - 86400`,
    ),
    c.env.DB.prepare(
      `SELECT
         (SELECT value_num FROM settings WHERE key = 'daily_bd_credit_guard') AS bd_daily_guard,
         (SELECT value_num FROM settings WHERE key = 'ai_daily_cap')         AS ai_daily_cap,
         (SELECT value_num FROM settings WHERE key = 'gate_threshold')       AS gate_threshold`,
    ),
  ]);
  if (!tiers || !totals || !verified || !queue || !bdToday || !mtd || !errors || !aiToday || !config) {
    throw new Error('batch result count mismatch');
  }

  const byTier: Record<string, number> = {};
  for (const row of (tiers.results ?? []) as { bucket: string; n: number }[]) byTier[row.bucket] = row.n;

  const head = (totals.results ?? [])[0] ?? {};
  const queueRow = (queue.results ?? [])[0] ?? {};
  const oldest = queueRow.oldest_pending as number | null;
  const configRow = (config.results ?? [])[0] ?? {};

  // Flat and complete, because the Overview renders all fourteen cards from this
  // one answer and a missing key there reads as a broken panel.
  return c.json(
    ok({
      total: Number(head.total ?? 0),
      by_tier: byTier,
      new_today: Number(head.new_today ?? 0),
      won: Number(head.won ?? 0),
      verified_email: Number((verified.results ?? [])[0]?.verified_email ?? 0),
      queue_depth: Number(queueRow.queue_depth ?? 0),
      oldest_pending_sec: oldest ? Math.floor(Date.now() / 1000) - oldest : null,
      running: Number(queueRow.running ?? 0),
      bd_credits_today: Number((bdToday.results ?? [])[0]?.bd_credits_today ?? 0),
      bd_daily_guard: Number(configRow.bd_daily_guard ?? 0),
      mtd_cost_micro: Number((mtd.results ?? [])[0]?.mtd_cost_micro ?? 0),
      mtd_budget_micro: MONTHLY_BUDGET_MICRO,
      errors_24h: Number((errors.results ?? [])[0]?.errors_24h ?? 0),
      ai_requests_today: Number((aiToday.results ?? [])[0]?.ai_requests_today ?? 0),
      ai_daily_cap: Number(configRow.ai_daily_cap ?? 0),
      gate_threshold: Number(configRow.gate_threshold ?? 0),
    }),
  );
});

leadRoutes.get('/leads/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM leads WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(c.req.param('id'))
    .first();

  if (!row) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }
  return c.json(ok(row));
});
