/**
 * Sources — directories, Class C manual rows, Class X blocks, import ledger.
 *
 * `block_reason` and `class` are returned on every directory row so the UI never
 * has to infer a gate from a missing field. Class X is returned like any other
 * row rather than filtered out: the console shows it, and its `enabled` flag is
 * what makes it unusable — hiding it would make the registry lie by omission.
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
import { intParam } from '../lib/http';
import type { Actor, Env } from '../env';

export const sourceRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

const DIRECTORY_COLUMNS = `
  id, source_key, display_name, base_url, target_type, adapter, rate_limit_per_min,
  requires_credential, robots_ok, class, block_reason, why_manual, manual_url_template,
  attribution_html, health, consecutive_failures, last_success_at, last_heal_at, enabled, note`;

sourceRoutes.get('/sources/directories', async (c) => {
  const url = new URL(c.req.url);
  const sourceClass = url.searchParams.get('class');

  const result = sourceClass
    ? await c.env.DB.prepare(
        `SELECT ${DIRECTORY_COLUMNS} FROM directory_sources
          WHERE class = ? AND deleted_at IS NULL ORDER BY source_key ASC`,
      )
        .bind(sourceClass)
        .all()
    : await c.env.DB.prepare(
        `SELECT ${DIRECTORY_COLUMNS} FROM directory_sources
          WHERE deleted_at IS NULL ORDER BY class ASC, source_key ASC`,
      ).all();

  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/manual', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT ${DIRECTORY_COLUMNS} FROM directory_sources
      WHERE class = 'C' AND deleted_at IS NULL ORDER BY source_key ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/blocked', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT ${DIRECTORY_COLUMNS} FROM directory_sources
      WHERE block_reason <> 'none' AND deleted_at IS NULL ORDER BY class ASC, source_key ASC`,
  ).all();
  return c.json(
    ok({
      rows: result.results ?? [],
      // Class X cannot be opened by an override; Class C can, by a human, with a
      // written reason. The UI needs that difference and should not compute it.
      note: "Class X is blocked permanently (ADR-031); Class C overrides are recorded in capture_batches with a reason of at least 20 characters.",
    }),
  );
});

sourceRoutes.get('/sources/imports', async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(intParam(url, 'limit') ?? 50, 200);
  const result = await c.env.DB.prepare(
    `SELECT id, dataset, release_version, geo_target_id, rows_read, rows_kept, rows_inserted,
            rows_deduped, min_confidence, runner, duration_sec, status, error_text, started_at, finished_at
       FROM dataset_imports ORDER BY started_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/health', async (c) => {
  const url = new URL(c.req.url);
  const since = intParam(url, 'since') ?? Math.floor(Date.now() / 1000) - 14 * 86_400;
  const result = await c.env.DB.prepare(
    `SELECT source_key, day, requests, success, blocked, empty, avg_latency_ms
       FROM source_health_log WHERE day >= date(?, 'unixepoch') ORDER BY day DESC, source_key ASC`,
  )
    .bind(since)
    .all();
  return c.json(ok(result.results ?? []));
});
