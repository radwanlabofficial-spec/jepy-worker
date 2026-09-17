/**
 * Sources — directories, Class C manual rows, Class X blocks, import ledger.
 *
 * Field names here are the CONTRACT's, not the database's, and the translation
 * happens in SQL aliases. The console's types are the contract
 * (13-ui-contract.md), so `rate_limit_per_min` leaves as `rate_limit_rpm`,
 * `last_success_at` as `last_ok_at`, and the pagination blob is unpacked into the
 * three flat fields the table renders. Returning database column names instead
 * produced `undefined` cells and, where a page mapped over the result, a blank
 * screen — the two most visible faults in the console.
 *
 * `block_reason` and `class` travel on every row so the UI never has to infer a
 * gate from a missing field, and Class X is returned like any other row rather
 * than filtered out: its `enabled` flag is what makes it unusable, and hiding it
 * would make the registry lie by omission.
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
import { intParam } from '../lib/http';
import type { Actor, Env } from '../env';

export const sourceRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

/**
 * Shared projection. `active_pack_version` is a correlated subquery rather than a
 * join so a source with two active packs (which should never happen) still yields
 * one row here instead of multiplying.
 */
const DIRECTORY_SELECT = `
  SELECT d.source_key, d.display_name, d.base_url, d.target_type, d.adapter,
         COALESCE(d.rate_limit_per_min, 0) AS rate_limit_rpm,
         d.url_template,
         json_extract(d.pagination_json, '$.mode')      AS pagination_mode,
         json_extract(d.pagination_json, '$.param')     AS pagination_param,
         json_extract(d.pagination_json, '$.max_pages') AS max_pages,
         d.enabled, d.health, d.consecutive_failures,
         d.last_success_at AS last_ok_at,
         d.class, d.block_reason, d.why_manual, d.manual_url_template,
         d.attribution_html, d.robots_ok, d.requires_credential, d.note,
         (SELECT MAX(p.version) FROM selector_packs p
           WHERE p.source_key = d.source_key AND p.status = 'active') AS active_pack_version
    FROM directory_sources d`;

sourceRoutes.get('/sources/directories', async (c) => {
  const url = new URL(c.req.url);
  const sourceClass = url.searchParams.get('class');

  const result = sourceClass
    ? await c.env.DB.prepare(`${DIRECTORY_SELECT} WHERE d.class = ? AND d.deleted_at IS NULL ORDER BY d.class ASC, d.source_key ASC`)
        .bind(sourceClass)
        .all()
    : await c.env.DB.prepare(`${DIRECTORY_SELECT} WHERE d.deleted_at IS NULL ORDER BY d.class ASC, d.source_key ASC`).all();

  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/manual', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT d.source_key, d.display_name, d.block_reason, d.why_manual,
            d.manual_url_template, d.attribution_html,
            -- The override lives on the capture batch, not on the source: a
            -- permission is granted per capture session, never once and for all.
            COALESCE((SELECT b.override_ack FROM capture_batches b
                       WHERE b.source_key = d.source_key
                       ORDER BY b.created_at DESC LIMIT 1), 0) AS override_ack,
            (SELECT b.override_reason FROM capture_batches b
              WHERE b.source_key = d.source_key
              ORDER BY b.created_at DESC LIMIT 1) AS override_reason
       FROM directory_sources d
      WHERE d.class = 'C' AND d.deleted_at IS NULL
      ORDER BY d.source_key ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/blocked', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT d.source_key, d.display_name, d.block_reason,
            -- The console labels this column "explanation"; the registry stores
            -- the same idea as why_manual.
            COALESCE(d.why_manual, d.note, '') AS explanation,
            d.class
       FROM directory_sources d
      WHERE d.block_reason <> 'none' AND d.deleted_at IS NULL
      ORDER BY d.class ASC, d.source_key ASC`,
  ).all();

  // An array, because the console declares `BlockedSource[]`. Wrapping it in an
  // object was a mistake of mine and it crashed the tab that maps over it — the
  // rule is simple: the declared type wins, every time.
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/imports', async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(intParam(url, 'limit') ?? 50, 200);
  const result = await c.env.DB.prepare(
    `SELECT id, dataset, release_version,
            rows_read      AS rows_scanned,
            rows_inserted  AS rows_ingested,
            rows_deduped   AS rows_merged,
            COALESCE(rows_read, 0) - COALESCE(rows_kept, 0) AS rows_skipped,
            min_confidence, duration_sec, status, started_at
       FROM dataset_imports ORDER BY started_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/selector-packs', async (c) => {
  const url = new URL(c.req.url);
  const sourceKey = url.searchParams.get('source_key');

  const sql = `
    SELECT id, source_key, version, status, field_count, success_rate, runs, empty_runs,
           generated_by, heal_reason, sample_ref, approved_by, approved_at, created_at,
           -- A short preview so the approve step is not a blind click.
           substr(COALESCE(selector_json, ''), 1, 160) AS selector_preview
      FROM selector_packs
     ${sourceKey ? 'WHERE source_key = ?' : ''}
     ORDER BY source_key ASC, version DESC`;

  const result = sourceKey
    ? await c.env.DB.prepare(sql).bind(sourceKey).all()
    : await c.env.DB.prepare(sql).all();

  return c.json(ok(result.results ?? []));
});

// The per-source form the console uses once a source is chosen. Registered as
// its own route because Hono treats an empty parameter and a missing segment as
// different paths, and the console is allowed to ask either way.
sourceRoutes.get('/sources/directories/:sourceKey/selector-packs', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, source_key, version, status, field_count, success_rate, runs, empty_runs,
            generated_by, heal_reason, sample_ref, approved_by, approved_at, created_at,
            substr(COALESCE(selector_json, ''), 1, 160) AS selector_preview
       FROM selector_packs WHERE source_key = ? ORDER BY version DESC`,
  )
    .bind(c.req.param('sourceKey'))
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
