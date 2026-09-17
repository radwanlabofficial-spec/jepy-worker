/**
 * Scoring — weights, weight history, AI usage.
 *
 * Shapes follow the console's declarations: `/scoring/weights` is an array of
 * rows, not an object carrying metadata. The earlier object shape made the page
 * call `.map` on a plain object, which threw during render and blanked the whole
 * application — the reason a crash boundary now exists in the console as well.
 *
 * `weight` is a point allocation summing to 100 per version, not a multiplier.
 * The 0.5-1.5 clamp in ADR-021 governs the weekly lift, which is what
 * `weight_history` records.
 *
 * Two contract fields have no column behind them and are returned as null rather
 * than invented: `sample_size` (a weight row has no sample; only a history row
 * does) and `label` (the schema stores keys, not display names). The console
 * renders null as an em dash, which is the same convention the rest of the
 * product uses for "not measured yet".
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
import type { Actor, Env } from '../env';

export const scoringRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

scoringRoutes.get('/scoring/weights', async (c) => {
  const active = await c.env.DB.prepare(
    `SELECT value_num AS version FROM settings WHERE key = 'active_weights_version'`,
  ).first<{ version: number | null }>();

  const version = active?.version ?? null;
  const rows = version === null
    ? { results: [] as Record<string, unknown>[] }
    : await c.env.DB.prepare(
        `SELECT feature_key              AS signal_key,
                feature_key              AS label,
                weight,
                version                  AS weights_version,
                created_at               AS updated_at,
                NULL                     AS sample_size
           FROM score_weights WHERE version = ? ORDER BY weight DESC, feature_key ASC`,
      )
        .bind(version)
        .all<Record<string, unknown>>();

  return c.json(ok(rows.results ?? []));
});

scoringRoutes.get('/scoring/history', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT week_key, feature_key AS signal_key, lift, sample_size, applied, created_at
       FROM weight_history ORDER BY week_key DESC, feature_key ASC LIMIT 200`,
  ).all();
  return c.json(ok(result.results ?? []));
});

scoringRoutes.get('/scoring/ai-usage', async (c) => {
  const [cap, today, month, byAccount] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(`SELECT value_num AS daily_cap FROM settings WHERE key = 'ai_daily_cap'`),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(lead_count), 0) AS requests FROM ai_score_log
        WHERE created_at >= unixepoch() - 86400`,
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(lead_count), 0) AS requests, COALESCE(SUM(cost_micro), 0) AS cost_micro
         FROM ai_score_log WHERE created_at >= unixepoch() - 2592000`,
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(account_label, 'unassigned') AS account_label,
              COALESCE(SUM(lead_count), 0) AS requests,
              COALESCE(SUM(cost_micro), 0) AS cost_micro
         FROM ai_score_log WHERE created_at >= unixepoch() - 2592000
        GROUP BY account_label ORDER BY requests DESC`,
    ),
  ]);
  if (!cap || !today || !month || !byAccount) throw new Error('batch result count mismatch');

  const monthRow = (month.results ?? [])[0] ?? {};
  const requestsMtd = Number(monthRow.requests ?? 0);

  // `share_pct` is computed here rather than in the browser so every surface
  // agrees on the denominator, including the one on the Overview page.
  const accounts = ((byAccount.results ?? []) as Record<string, unknown>[]).map((row) => ({
    ...row,
    share_pct: requestsMtd > 0 ? Math.round((Number(row.requests ?? 0) / requestsMtd) * 1000) / 10 : null,
  }));

  return c.json(
    ok({
      daily_cap: (cap.results ?? [])[0]?.daily_cap ?? null,
      requests_today: Number((today.results ?? [])[0]?.requests ?? 0),
      requests_mtd: requestsMtd,
      cost_mtd_micro: Number(monthRow.cost_micro ?? 0),
      by_account: accounts,
    }),
  );
});
