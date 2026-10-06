/**
 * Leads.
 *
 * Mostly reads, plus two write paths that never touch a provider directly:
 * enrichment and Yelp verification both ENQUEUE a `job_queue` row (R16). Two
 * details matter more than the queries themselves: `provisional` is returned as
 * its own flag rather than being folded into COLD, and `manual_edited` travels
 * with every row so the UI can mark a hand-edited field — the whole point of
 * that column is that a human value outranks a scraped one (R7).
 */

import { Hono } from 'hono';
import { fail, ok, type ApiMeta } from '../lib/envelope';
import { badRequest, decodeCursor, encodeCursor, intParam, boolParam, readPage } from '../lib/http';
import { enqueue } from '../lib/queue';
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

/** Existence check shared by the four per-lead sub-resources below. */
async function leadExists(db: Env['DB'], id: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM leads WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ id: string }>();
  return row !== null;
}

/**
 * The lead's signals, with expired rows filtered out.
 *
 * The filter is `expires_at IS NULL OR expires_at > unixepoch()`, the exact
 * predicate 12-scoring.md §2.5 makes mandatory on every scoring query — a stale
 * signal must not keep inflating a score after its evidence aged out. A signal
 * with no expiry is kept on purpose: "never expires" and "expired" are different
 * facts and only the second is filtered.
 */
leadRoutes.get('/leads/:id/signals', async (c) => {
  const leadId = c.req.param('id');
  if (!(await leadExists(c.env.DB, leadId))) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const result = await c.env.DB.prepare(
    `SELECT id, signal_key, signal_value_num AS value, signal_value_text AS value_text,
            confidence, collected_at, expires_at
       FROM lead_signals
      WHERE lead_id = ? AND (expires_at IS NULL OR expires_at > unixepoch())
      ORDER BY signal_key ASC`,
  )
    .bind(leadId)
    .all();
  return c.json(ok(result.results ?? []));
});

/** Parses `leads.provenance_json`, treating an unreadable blob as "no provenance". */
function parseProvenance(raw: string | null): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Record<string, unknown>>) : {};
  } catch {
    return {};
  }
}

/**
 * Per-field provenance — where every value on this lead came from.
 *
 * The stored shape (08-sources.md §5) is `{ "<field>": { "src", "at", "locked" } }`
 * and it is returned per field so the console can mark the hand-edited ones:
 * `locked=1` is what R7 relies on, because a locked field is the one no scraper
 * may overwrite. `manual_edited` is surfaced per entry so the UI marks the
 * FIELD that was edited, not every field on a lead that happens to have one.
 * `captured_at` accepts the `at` key the docs use and the `ts` key R7's example
 * uses, because both have appeared.
 */
leadRoutes.get('/leads/:id/provenance', async (c) => {
  const leadId = c.req.param('id');
  const lead = await c.env.DB.prepare(
    `SELECT id, provenance_json FROM leads WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(leadId)
    .first<{ id: string; provenance_json: string | null }>();
  if (!lead) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const rows = Object.entries(parseProvenance(lead.provenance_json)).map(([field, entry]) => {
    const src = typeof entry.src === 'string' ? entry.src : null;
    const locked = entry.locked === 1 || entry.locked === true ? 1 : 0;
    const capturedAt =
      typeof entry.at === 'number' ? entry.at : typeof entry.ts === 'number' ? entry.ts : null;
    return {
      field,
      // `source` is the human-facing origin; `src` is the raw one it came from.
      source: typeof entry.source === 'string' ? entry.source : src ?? 'unknown',
      src,
      captured_at: capturedAt,
      locked,
      manual_edited: locked,
    };
  });
  return c.json(ok(rows));
});

/**
 * The lead timeline, newest first.
 *
 * Paginated with the same keyset helpers as every other list route rather than a
 * bespoke `?before=`: one cursor implementation, one place for it to be correct.
 * `event_type` leaves as `action` and `created_at` as `at`, because those are
 * the contract's names (13-ui-contract.md §4.2).
 */
leadRoutes.get('/leads/:id/activity', async (c) => {
  const leadId = c.req.param('id');
  if (!(await leadExists(c.env.DB, leadId))) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const url = new URL(c.req.url);
  const { limit, cursor } = readPage(url);

  const where: string[] = ['lead_id = ?'];
  const params: unknown[] = [leadId];
  if (cursor) {
    const parts = decodeCursor(cursor);
    if (!parts) {
      const { body, status } = badRequest();
      return c.json(body, status as 400);
    }
    where.push('(created_at, id) < (?, ?)');
    params.push(Number(parts[0]), parts[1]);
  }

  const result = await c.env.DB.prepare(
    `SELECT id, event_type AS action, actor, detail_json AS detail, created_at AS at
       FROM activity_log
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
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
    next_cursor: hasMore && last ? encodeCursor([last.at as number, last.id as string]) : null,
    total_estimate: null,
  };
  return c.json(ok(page, meta));
});

/**
 * On-demand enrichment — enqueued, never called here.
 *
 * R16 allows no handler to reach a provider directly; the queue is the single
 * choke point where retry, rate limit, cost accounting and the circuit breaker
 * apply, and a button that bypassed it would bypass all four. The job is marked
 * `urgency='urgent'` (11-api-contract.md §6), which the dispatcher reads as a
 * higher priority, not as a promise to call out of turn.
 *
 * `target_type` may be named in the body; the console's Enrich button names
 * none, so the default is `email_pattern` — the free Wave 1 probe that fills the
 * contact fields enrichment is for. A job with no target type at all would be
 * parked `needs_manual` by the dispatcher, which is a worse answer than a
 * sensible default.
 */
leadRoutes.post('/leads/:id/enrich', async (c) => {
  const leadId = c.req.param('id');
  if (!(await leadExists(c.env.DB, leadId))) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const input = (await c.req.json().catch(() => null)) as { target_type?: unknown } | null;
  const targetType =
    typeof input?.target_type === 'string' && input.target_type.length > 0 ? input.target_type : 'email_pattern';

  const jobId = await enqueue(c.env.DB, {
    jobType: 'enrich',
    targetType,
    payload: { lead_id: leadId, urgency: 'urgent', runner: 'worker' },
    priority: 8,
  });
  return c.json(ok({ job_id: jobId }));
});

/**
 * R21's Yelp constants. None of these is a `settings` key, and that is the point.
 *
 * `YELP_RULE_SCORE_FLOOR` is a hard literal, NOT `settings.gate_threshold`:
 * 12-scoring.md §3.1 keeps the two gates apart because budget pressure may lift
 * the AI gate to 65 while R21 forbids the Yelp gate from ever moving. Reading the
 * wrong one here would call Yelp on leads the rule was written to protect.
 * `YELP_CACHE_TTL_SECONDS` is exactly 24 hours and is not configurable —
 * 16-compliance.md §3.1 says a PATCH on that key is refused, so it is a constant
 * in code rather than a value someone can widen.
 */
const YELP_RULE_SCORE_FLOOR = 55;
const YELP_CALLS_PER_WINDOW = 300;
const YELP_WINDOW_SECONDS = 86_400;
const YELP_CACHE_TTL_SECONDS = 86_400;

/**
 * Yelp verification — gate first, then enqueue, never a direct call.
 *
 * The `yelp_verify` target type is enqueued only when `rule_score >= 55`
 * (16-compliance.md §3.1); below that the API answers `E_YELP_GATE` and the
 * console's button is already disabled. The 300-calls-per-rolling-24h ceiling is
 * counted from what the system already records — calls that ran
 * (`route_attempts`) plus verification jobs already queued but not yet run — so
 * a burst of enqueues cannot slip past a counter that has not been decremented.
 * A bucketed `quota_counters` row cannot express a rolling window, and the router
 * reads `quota_counters` without the window key, so a stale exhausted row would
 * block Yelp permanently; hence the count, not a counter (R6 is about counting
 * atomically, and there is nothing here to increment).
 *
 * Both refusals are `E_YELP_GATE` (19-errors.md §3 lists the score gate and the
 * consumed 300/24h under the same code) and differ by `detail.reason`. The job
 * carries the cache TTL and the persist rule so the work that actually touches
 * Yelp keeps to them: KV entry exactly 24 hours, and D1 holds `yelp_business_id`
 * and nothing else (R21).
 */
leadRoutes.post('/leads/:id/verify-yelp', async (c) => {
  const leadId = c.req.param('id');
  const lead = await c.env.DB.prepare(
    `SELECT id, rule_score, yelp_business_id FROM leads WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(leadId)
    .first<{ id: string; rule_score: number | null; yelp_business_id: string | null }>();
  if (!lead) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  if ((lead.rule_score ?? 0) < YELP_RULE_SCORE_FLOOR) {
    const { body, status } = fail('E_YELP_GATE', {
      reason: 'score_gate',
      lead_id: leadId,
      rule_score: lead.rule_score,
      threshold: YELP_RULE_SCORE_FLOOR,
    });
    return c.json(body, status as 403);
  }

  const counted = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM route_attempts
         WHERE provider = 'yelp' AND created_at >= unixepoch() - ?1)
     + (SELECT COUNT(*) FROM job_queue
         WHERE target_type = 'yelp_verify' AND status IN ('pending','claimed','running')
           AND created_at >= unixepoch() - ?1) AS n`,
  )
    .bind(YELP_WINDOW_SECONDS)
    .first<{ n: number }>();

  if ((counted?.n ?? 0) >= YELP_CALLS_PER_WINDOW) {
    const { body, status } = fail('E_YELP_GATE', {
      reason: 'daily_cap',
      cap: YELP_CALLS_PER_WINDOW,
      window_seconds: YELP_WINDOW_SECONDS,
    });
    return c.json(body, status as 403);
  }

  const jobId = await enqueue(c.env.DB, {
    jobType: 'verify',
    targetType: 'yelp_verify',
    payload: {
      lead_id: leadId,
      provider: 'yelp',
      cache_ttl_seconds: YELP_CACHE_TTL_SECONDS,
      persist_field: 'yelp_business_id',
      runner: 'worker',
    },
    priority: 8,
  });
  return c.json(ok({ job_id: jobId, lead_id: leadId, status: 'pending' }));
});

/**
 * Export leads as CSV. Accepts the same filter shape as the list endpoint;
 * returns a CSV string (not a file download — the dashboard triggers the
 * browser download from the response text).
 *
 * Capped at 10,000 rows: a larger export belongs in the job queue, not in a
 * single request.
 */
leadRoutes.post('/leads/export', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tier?: string; niche?: string; limit?: number };
  const limit = Math.min(body.limit ?? 1000, 10_000);

  let where = `WHERE deleted_at IS NULL`;
  const binds: unknown[] = [];
  if (body.tier) { where += ` AND tier = ?`; binds.push(body.tier); }
  if (body.niche) { where += ` AND niche = ?`; binds.push(body.niche); }

  const rows = await c.env.DB.prepare(
    `SELECT id, name, domain, website_url, phone_e164, tier, rule_score, final_score, niche, created_at
     FROM leads ${where} ORDER BY final_score DESC NULLS LAST LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<Record<string, unknown>>();

  const headers = ['id','name','domain','website_url','phone_e164','tier','rule_score','final_score','niche','created_at'];
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows.results ?? []) {
    lines.push(headers.map((h) => escape(r[h])).join(','));
  }

  return new Response(lines.join('\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8' },
  });
});
