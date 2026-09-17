/**
 * Audit, devices, geo targets, niches, router weights.
 *
 * `router-weights` is exposed as its own route so the console can disable the
 * edit affordance without parsing JSON, and the reason it is read-only is
 * returned alongside the value rather than left to the client to know.
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
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
  const result = await c.env.DB.prepare(
    `SELECT id, country_code, region, city, bbox_json, population, priority, enabled,
            last_scanned_at, lead_count, created_at
       FROM geo_targets ORDER BY priority ASC, country_code ASC, city ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/niches', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, niche_slug, display_name, overture_categories_json, fsq_categories_json,
            avg_deal_value_micro, priority, enabled
       FROM niches ORDER BY priority ASC, niche_slug ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/router-weights', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT value_text, updated_at FROM settings WHERE key = 'router_weights_json'`,
  ).first<{ value_text: string | null; updated_at: number }>();

  let parsed: unknown = null;
  try {
    parsed = row?.value_text ? JSON.parse(row.value_text) : null;
  } catch {
    // A malformed blob is reported as-is rather than swallowed: silently
    // returning null would make the router look unconfigured when it is
    // actually misconfigured.
    parsed = { error: 'router_weights_json is not valid JSON' };
  }

  return c.json(
    ok({
      weights: parsed,
      editable: false,
      reason: 'adr_required',
      updated_at: row?.updated_at ?? null,
    }),
  );
});
