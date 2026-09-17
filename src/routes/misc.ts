/**
 * Audit, devices, geo targets, niches, router weights.
 *
 * `router-weights` is exposed as its own route so the console can disable the
 * edit affordance without parsing JSON, and the reason it is read-only is
 * returned alongside the value rather than left to the client to know.
 */

import { Hono } from 'hono';
import { fail, ok } from '../lib/envelope';
import { intParam } from '../lib/http';
import type { Actor, Env } from '../env';

export const miscRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

miscRoutes.get('/audit', async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(intParam(url, 'limit') ?? 100, 500);
  const entityType = url.searchParams.get('entity_type');

  // Aliased to the contract's names: `at` and `detail`. Returning created_at and
  // detail_json left the WHEN and DETAIL columns of the audit table empty.
  const columns = `id, entity_type, entity_id, action, actor_email, result,
                   detail_json AS detail, created_at AS at`;

  const result = entityType
    ? await c.env.DB.prepare(
        `SELECT ${columns} FROM audit_log WHERE entity_type = ? ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(entityType, limit)
        .all()
    : await c.env.DB.prepare(`SELECT ${columns} FROM audit_log ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all();

  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/devices', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT d.id, d.device_label, d.mode, d.current_directive, d.pack_epoch, d.last_heartbeat_at,
            d.jobs_completed, d.captures_committed, d.status, d.created_at,
            CASE WHEN d.last_heartbeat_at IS NULL THEN NULL
                 ELSE unixepoch() - d.last_heartbeat_at END AS heartbeat_age_sec
       FROM devices d ORDER BY d.created_at DESC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/geo-targets', async (c) => {
  // The contract declares {id, label, country_code, niche_count, enabled}. `label`
  // is the most specific name the row has, and `niche_count` is counted from the
  // leads actually captured there rather than stored, because a stored counter is
  // one more thing that can drift away from the leads it counts.
  const result = await c.env.DB.prepare(
    `SELECT g.id,
            -- COALESCE takes at least two arguments; wrapping a bare CASE in one
            -- is a syntax error that only shows up at execution time.
            COALESCE(
              CASE WHEN g.city IS NOT NULL AND g.region IS NOT NULL THEN g.city || ', ' || g.region
                   WHEN g.city IS NOT NULL THEN g.city
                   WHEN g.region IS NOT NULL THEN g.region
                   ELSE NULL END,
              g.country_code
            ) AS label,
            g.country_code,
            (SELECT COUNT(DISTINCT l.niche) FROM leads l
              WHERE l.deleted_at IS NULL AND l.country_code = g.country_code
                AND (g.city IS NULL OR l.city = g.city)) AS niche_count,
            g.enabled
       FROM geo_targets g
      ORDER BY g.priority ASC, g.country_code ASC, g.city ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/niches', async (c) => {
  // The contract asks for `string[]`. Returning full rows here crashed nothing
  // but rendered nothing either, because the page maps over the values as
  // strings. Display names it is; a richer shape needs a console change first.
  const result = await c.env.DB.prepare(
    `SELECT display_name AS name FROM niches ORDER BY priority ASC, niche_slug ASC`,
  ).all<{ name: string }>();
  return c.json(ok((result.results ?? []).map((row) => row.name)));
});

// The console asks for these under /settings; they were served at /audit and
// /devices, so both paths exist rather than one being moved and breaking the
// other caller.
miscRoutes.get('/settings/errors', async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(intParam(url, 'limit') ?? 100, 500);
  const since = intParam(url, 'since');

  // Aliased to the contract: `at`, `reason`, `message`. `scope` is the closest
  // thing error_log has to a reason, and the code stays as it was recorded.
  const result = since
    ? await c.env.DB.prepare(
        `SELECT id, created_at AS at, code, scope AS reason, job_id, provider, message
           FROM error_log WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(since, limit)
        .all()
    : await c.env.DB.prepare(
        `SELECT id, created_at AS at, code, scope AS reason, job_id, provider, message
           FROM error_log ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(limit)
        .all();

  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/devices', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT d.id, d.device_label, d.mode, d.current_directive, d.pack_epoch, d.last_heartbeat_at,
            d.jobs_completed, d.captures_committed, d.status, d.created_at,
            CASE WHEN d.last_heartbeat_at IS NULL THEN NULL
                 ELSE unixepoch() - d.last_heartbeat_at END AS heartbeat_age_sec
       FROM devices d ORDER BY d.created_at DESC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/router-weights', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT value_text FROM settings WHERE key = 'router_weights_json'`,
  ).first<{ value_text: string | null }>();

  // A flat `Record<string, number>`, because that is what the contract declares
  // and the page renders every entry with `toFixed(2)`. Wrapping the weights in
  // an object with metadata put `editable: false` and `reason: 'adr_required'`
  // into those entries, and calling toFixed on a boolean throws — which is
  // exactly how the Settings page broke. Provenance belongs in the UI text, not
  // in a payload that is iterated as numbers.
  try {
    const parsed = row?.value_text ? (JSON.parse(row.value_text) as Record<string, number>) : {};
    return c.json(ok(parsed));
  } catch {
    // Malformed stored JSON is surfaced as a real error rather than an empty
    // object: an empty weight set looks like "not configured" when the truth is
    // "misconfigured", and those need different reactions.
    const { body, status } = fail('E_INTERNAL', { reason: 'router_weights_json_invalid' });
    return c.json(body, status as 500);
  }
});
