/**
 * Jobs and queue depth.
 *
 * `/api/jobs/meta` exists separately from `/api/jobs` because the Overview polls
 * it every 30 seconds while the Jobs page is open only occasionally: the cheap
 * aggregate should not be buried behind the expensive list.
 */

import { Hono } from 'hono';
import { ok, type ApiMeta } from '../lib/envelope';
import { decodeCursor, encodeCursor, intParam, readPage } from '../lib/http';
import type { Actor, Env } from '../env';

export const jobRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

jobRoutes.get('/jobs/meta', async (c) => {
  const [live, dead, circuits, byType] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS queue_depth,
              COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
              COALESCE(SUM(CASE WHEN status = 'needs_manual' THEN 1 ELSE 0 END), 0) AS needs_manual,
              MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending
         FROM job_queue WHERE status IN ('pending','claimed','running','needs_manual')`,
    ),
    // Counted separately: the previous version asked for `dead` inside a query
    // that filtered `dead` out, so the number was structurally always zero.
    c.env.DB.prepare(`SELECT COUNT(*) AS dead_count FROM job_queue WHERE status IN ('dead','failed')`),
    c.env.DB.prepare(`SELECT COUNT(*) AS open_circuits FROM circuit_state WHERE state = 'open'`),
    c.env.DB.prepare(
      `SELECT job_type, COUNT(*) AS n FROM job_queue
        WHERE status IN ('pending','claimed','running') GROUP BY job_type`,
    ),
  ]);
  // DB.batch answers one result per statement, in order. Checking it here turns
  // a silent undefined into a loud failure, and lets the unions narrow.
  if (!live || !dead || !circuits || !byType) throw new Error('batch result count mismatch');

  const liveRow = (live.results ?? [])[0] ?? {};
  const oldestPending = liveRow.oldest_pending as number | null;

  return c.json(
    ok({
      queue_depth: Number(liveRow.queue_depth ?? 0),
      running: Number(liveRow.running ?? 0),
      needs_manual: Number(liveRow.needs_manual ?? 0),
      dead_count: Number((dead.results ?? [])[0]?.dead_count ?? 0),
      open_circuits: Number((circuits.results ?? [])[0]?.open_circuits ?? 0),
      // Seconds, not a timestamp: the UI decides how to phrase "19m ago".
      oldest_pending_sec: oldestPending ? Math.floor(Date.now() / 1000) - oldestPending : null,
      by_type: byType.results ?? [],
    }),
  );
});

jobRoutes.get('/jobs', async (c) => {
  const url = new URL(c.req.url);
  const { limit, cursor } = readPage(url);

  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];

  for (const field of ['status', 'job_type', 'target_type'] as const) {
    const value = url.searchParams.get(field);
    if (value) {
      where.push(`${field} = ?`);
      params.push(value);
    }
  }
  const since = intParam(url, 'since');
  if (since !== null) {
    where.push('created_at >= ?');
    params.push(since);
  }
  if (cursor) {
    const parts = decodeCursor(cursor);
    if (parts) {
      where.push('(created_at, id) < (?, ?)');
      params.push(Number(parts[0]), parts[1]);
    }
  }

  const result = await c.env.DB.prepare(
    `SELECT id, job_type, target_type, payload_json, priority, status, attempts, max_attempts,
            claimed_by, claimed_at, run_after, hop_count, last_error, result_ref, created_at, updated_at
       FROM job_queue
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
    next_cursor: hasMore && last ? encodeCursor([last.created_at as number, last.id as string]) : null,
    total_estimate: null,
  };
  return c.json(ok(page, meta));
});

/**
 * The hop trail: the only way to reconstruct why a provider was chosen, which
 * candidate each hard filter dropped, and which pack version ran. `score_milli`
 * is returned as an integer to avoid a float crossing the wire.
 */
jobRoutes.get('/jobs/:id/hops', async (c) => {
  const jobId = c.req.param('id');
  const [job, hops, rejected] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT id, job_type, target_type, status, attempts, hop_count, last_error, result_ref, created_at
         FROM job_queue WHERE id = ?`,
    ).bind(jobId),
    c.env.DB.prepare(
      `SELECT hop, provider, account_label, adapter, source_id, pack_version, outcome, http_status,
              records_count, unit_type, units, cost_micro, latency_ms, circuit_scope,
              CAST(ROUND(COALESCE(score, 0) * 1000) AS INTEGER) AS score_milli, note, created_at
         FROM route_attempts WHERE job_id = ? ORDER BY hop ASC, created_at ASC`,
    ).bind(jobId),
    // Candidates that never ran are NOT stored per job: the schema keeps one row
    // per hop, and a skipped candidate consumed no hop. The two reasons that can
    // be reconstructed after the fact are an open circuit and a disabled
    // capability row, so those are what this list reports — with the reason
    // attached, because "circuit open" is temporary and "disabled" is a choice.
    c.env.DB.prepare(
      `SELECT c.scope_key AS candidate,
              'circuit_open' AS reason,
              c.state AS state,
              c.opened_at,
              c.reopen_after,
              NULL AS detail
         FROM circuit_state c
        WHERE c.state = 'open'
          AND ((SELECT target_type FROM job_queue WHERE id = ?1) IS NULL
               OR c.scope_key LIKE '%' || (SELECT target_type FROM job_queue WHERE id = ?1) || '%')
        ORDER BY c.opened_at DESC`,
    )
      .bind(jobId),
    c.env.DB.prepare(
      `SELECT provider || ':' || adapter AS candidate,
              'capability_disabled' AS reason,
              NULL AS state,
              NULL AS opened_at,
              NULL AS reopen_after,
              'enabled=0 for this target_type' AS detail
         FROM provider_capability
        WHERE enabled = 0
          AND ((SELECT target_type FROM job_queue WHERE id = ?1) IS NULL
               OR target_type = (SELECT target_type FROM job_queue WHERE id = ?1))
        ORDER BY provider ASC`,
    )
      .bind(jobId),
  ]);
  if (!job || !hops || !rejected) throw new Error('batch result count mismatch');

  const jobRow = (job.results ?? [])[0] as { target_type?: string | null } | undefined;
  const rejectionSets = rejected.results ?? [];

  return c.json(
    ok({
      job: jobRow ?? null,
      hops: hops.results ?? [],
      rejected: rejectionSets,
      // Stated plainly so the UI does not imply completeness it cannot have.
      rejected_note:
        'Only circuit-open and capability-disabled candidates can be reconstructed; per-candidate filter drops are not persisted.',
    }),
  );
});
