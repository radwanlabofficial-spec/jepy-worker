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
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { intParam } from '../lib/http';
import type { Actor, Env } from '../env';

export const providerRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

// `/next-label` is registered before `/accounts/:id` would matter, but they use
// different methods so there is no shadowing here.
providerRoutes.get('/providers/accounts/next-label', async (c) => {
  const url = new URL(c.req.url);
  const provider = (url.searchParams.get('provider') ?? '').trim();
  if (!provider) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS used FROM provider_accounts WHERE provider = ?`,
  )
    .bind(provider)
    .first<{ used: number }>();

  const used = row?.used ?? 0;
  return c.json(
    ok({
      account_label: `${provider}-${String(used + 1).padStart(2, '0')}`,
      // The unit a provider counts in. Kept here so the UI does not hard-code it.
      unit_type: provider === 'apify' ? 'USD' : provider === 'zerobounce' ? 'verifications' : null,
    }),
  );
});

const accountSchema = z.object({
  provider: z.string().min(1),
  account_label: z.string().min(1),
  quota_limit: z.number().int().nonnegative().nullable().optional(),
  quota_window: z.enum(['day', 'month']).nullable().optional(),
  daily_limit: z.number().int().nonnegative().nullable().optional(),
  // Only for providers whose free allowance has an end date (mapquest, R14).
  quota_expires_at: z.number().int().positive().nullable().optional(),
  plan_label: z.string().max(40).nullable().optional(),
  plan_price_micro: z.number().int().nonnegative().nullable().optional(),
});

providerRoutes.post('/providers/accounts', async (c) => {
  const parsed = accountSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const input = parsed.data;

  const existing = await c.env.DB.prepare(
    `SELECT id FROM provider_accounts WHERE provider = ? AND account_label = ?`,
  )
    .bind(input.provider, input.account_label)
    .first<{ id: string }>();

  if (existing) {
    const { body, status } = fail('E_CONFLICT', { reason: 'label_reused', account_label: input.account_label });
    return c.json(body, status as 409);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO provider_accounts
       (id, provider, account_label, quota_limit, quota_window, daily_limit, quota_expires_at,
        plan_label, plan_price_micro, status, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, unixepoch())`,
  )
    .bind(
      id,
      input.provider,
      input.account_label,
      input.quota_limit ?? null,
      input.quota_window ?? null,
      input.daily_limit ?? null,
      input.quota_expires_at ?? null,
      input.plan_label ?? null,
      input.plan_price_micro ?? null,
    )
    .run();

  // `audit_log.entity_type` is a closed enum of four values and an account is not
  // one of them, so account changes are recorded against their credentials — the
  // surface they exist to hold — with the account named in the detail.
  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_log (id, entity_type, entity_id, action, actor_email, result, detail_json, created_at)
       VALUES (?, 'credential', ?, 'add', ?, 'ok', ?, unixepoch())`,
    )
      .bind(crypto.randomUUID(), id, c.get('actor').email, JSON.stringify({ kind: 'provider_account', ...input }))
      .run();
  } catch {
    // ignore
  }

  return c.json(ok({ id, account_label: input.account_label, provider: input.provider }));
});

const accountPatchSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).max(10).optional(),
  plan_label: z.string().max(40).nullable().optional(),
  plan_price_micro: z.number().int().nonnegative().nullable().optional(),
  // Quota is intentionally absent: it is owned by the provider and the rollover
  // job, and a writable quota would let the UI disagree with reality.
});

providerRoutes.patch('/providers/accounts/:id', async (c) => {
  const parsed = accountPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const patch = parsed.data;
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(`SELECT id, provider, account_label FROM provider_accounts WHERE id = ?`)
    .bind(id)
    .first<{ id: string; provider: string; account_label: string }>();
  if (!row) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  await c.env.DB.prepare(
    `UPDATE provider_accounts
        SET enabled = COALESCE(?, enabled),
            priority = COALESCE(?, priority),
            plan_label = COALESCE(?, plan_label),
            plan_price_micro = COALESCE(?, plan_price_micro)
      WHERE id = ?`,
  )
    .bind(
      patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
      patch.priority ?? null,
      patch.plan_label ?? null,
      patch.plan_price_micro ?? null,
      id,
    )
    .run();

  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_log (id, entity_type, entity_id, action, actor_email, result, detail_json, created_at)
       VALUES (?, 'credential', ?, 'test', ?, 'ok', ?, unixepoch())`,
    )
      .bind(crypto.randomUUID(), id, c.get('actor').email, JSON.stringify({ kind: 'provider_account_patch', ...patch }))
      .run();
  } catch {
    // ignore
  }

  return c.json(ok({ id, ...patch }));
});

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
