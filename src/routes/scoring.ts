/**
 * Scoring — weights, weight history, AI usage.
 *
 * The active weight version is returned with its features already assembled so
 * the Scoring page can render the table and the 100-point check without a second
 * call. `weight` is a point allocation, not a multiplier: the 0.5-1.5 clamp in
 * ADR-021 applies to the weekly lift, which is what `weight_history` records.
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
        `SELECT feature_key, weight, version, is_active, created_at
           FROM score_weights WHERE version = ? ORDER BY weight DESC, feature_key ASC`,
      )
        .bind(version)
        .all<Record<string, unknown>>();

  const features = rows.results ?? [];
  const total = features.reduce((sum, row) => sum + Number(row.weight ?? 0), 0);

  return c.json(
    ok({
      version,
      features,
      total_points: total,
      // The 100-point invariant is asserted by the seed and re-checked here, so a
      // bad hand-edit shows up on the page instead of quietly rescaling scores.
      sums_to_100: Math.abs(total - 100) <= 0.01,
    }),
  );
});

scoringRoutes.get('/scoring/history', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT week_key, feature_key, lift, old_weight, new_weight, sample_size, applied, created_at
       FROM weight_history ORDER BY week_key DESC, feature_key ASC LIMIT 200`,
  ).all();
  return c.json(ok(result.results ?? []));
});

scoringRoutes.get('/scoring/ai-usage', async (c) => {
  const [cap, today, month, byAccount] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(`SELECT value_num AS cap FROM settings WHERE key = 'ai_daily_cap'`),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(lead_count), 0) AS leads, COALESCE(SUM(cost_micro), 0) AS cost_micro,
              COUNT(*) AS batches
         FROM ai_score_log WHERE created_at >= unixepoch() - 86400`,
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(lead_count), 0) AS leads, COALESCE(SUM(cost_micro), 0) AS cost_micro,
              COUNT(*) AS batches
         FROM ai_score_log WHERE created_at >= unixepoch() - 2592000`,
    ),
    c.env.DB.prepare(
      `SELECT account_label, COUNT(*) AS batches, SUM(lead_count) AS leads, SUM(cost_micro) AS cost_micro
         FROM ai_score_log WHERE created_at >= unixepoch() - 2592000
        GROUP BY account_label ORDER BY account_label ASC`,
    ),
  ]);
  if (!cap || !today || !month || !byAccount) throw new Error('batch result count mismatch');

  return c.json(
    ok({
      daily_cap: (cap.results ?? [])[0]?.cap ?? null,
      last_24h: (today.results ?? [])[0] ?? null,
      last_30d: (month.results ?? [])[0] ?? null,
      by_account: byAccount.results ?? [],
    }),
  );
});
