/**
 * Providers, capability matrix, credit ledger and the account pool.
 *
 * Read-only here. `quota_limit` is reported, never accepted: quota is owned by
 * the provider and the rollover job, and a writable quota field would let the
 * UI disagree with reality.
 *
 * The credit series is what the Overview chart draws, so it is returned already
 * bucketed by day rather than as raw rows the client would have to aggregate.
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
import { intParam } from '../lib/http';
import type { Actor, Env } from '../env';

export const providerRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

providerRoutes.get('/providers/accounts', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, provider, account_label, quota_limit, quota_used, quota_window, quota_reset_at,
            quota_expires_at, daily_used, daily_limit, status, cooldown_until, consecutive_errors,
            plan_label, plan_price_micro, last_synced_at, sync_error, enabled, priority, last_used_at
       FROM provider_accounts
      ORDER BY provider ASC, account_label ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

providerRoutes.get('/providers/capability', async (c) => {
  const url = new URL(c.req.url);
  const targetType = url.searchParams.get('target_type');

  const result = targetType
    ? await c.env.DB.prepare(
        `SELECT * FROM provider_capability WHERE target_type = ? ORDER BY priority ASC, provider ASC`,
      )
        .bind(targetType)
        .all()
    : await c.env.DB.prepare(
        `SELECT * FROM provider_capability ORDER BY target_type ASC, priority ASC, provider ASC`,
      ).all();

  return c.json(ok(result.results ?? []));
});

providerRoutes.get('/providers/pools', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT provider,
            COUNT(*) AS accounts,
            SUM(CASE WHEN enabled = 1 AND status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) AS invalid,
            SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited,
            SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) AS exhausted,
            SUM(COALESCE(quota_limit, 0)) AS quota_limit,
            SUM(COALESCE(quota_used, 0)) AS quota_used
       FROM provider_accounts
      GROUP BY provider
      ORDER BY provider ASC`,
  ).all();

  // The pool is a floor, not a ceiling (ADR-034): `accounts` is what exists
  // today and every one of these rows can grow from the dashboard.
  return c.json(ok(result.results ?? []));
});

providerRoutes.get('/providers/credits/brightdata', async (c) => {
  const url = new URL(c.req.url);
  const days = intParam(url, 'days') ?? 14;
  const since = Math.floor(Date.now() / 1000) - days * 86_400;

  const result = await c.env.DB.prepare(
    `SELECT account_label, unit_type,
            date(created_at, 'unixepoch') AS day,
            SUM(units) AS units,
            SUM(credits) AS credits,
            SUM(cost_micro) AS cost_micro,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes,
            COUNT(*) AS calls
       FROM brightdata_credit_log
      WHERE created_at >= ?
      GROUP BY account_label, unit_type, day
      ORDER BY day DESC, account_label ASC`,
  )
    .bind(since)
    .all();

  return c.json(ok({ series: result.results ?? [] }));
});
