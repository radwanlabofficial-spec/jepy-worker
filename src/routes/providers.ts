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
import { auditLog } from './misc';
import type { Actor, Env } from '../env';

export const providerRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

/** Escapes a provider name so it can be used literally inside the label pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

  // R22. `bd` is the BANGLADESH country prefix, never a provider. The value this
  // system actually uses is always `brightdata`, but the guard is here because a
  // row named `bd_...` would read to any later reader — human or model — as a
  // geo filter, and a wrong geo filter silently produces the wrong dataset.
  // Refused without a `detail.reason`: 11-api-contract.md §12 records this as a
  // bare E_VALIDATION.
  if (/^bd/i.test(input.provider)) {
    const { body, status } = fail('E_VALIDATION', { provider: input.provider });
    return c.json(body, status as 400);
  }

  // ADR-034. The pool grows from the dashboard, so the label is the one stable
  // identity a row keeps across `brightdata_credit_log` and `route_attempts`; it
  // must be `<provider>-<NN>`. A free-form label lets two rows collide in the
  // `/next-label` allocator and makes the pool unreadable after the fact.
  const labelPattern = new RegExp(`^${escapeRegExp(input.provider)}-\\d{2}$`);
  if (!labelPattern.test(input.account_label)) {
    const { body, status } = fail('E_VALIDATION', { reason: 'label_format', account_label: input.account_label });
    return c.json(body, status as 400);
  }

  // R21. Exactly one Yelp account, forever — a second is a terms problem, not a
  // quota problem, and ADR-034 makes the refusal permanent rather than
  // threshold-based. ADR-034 and 19-errors.md §4 assign this E_FORBIDDEN with
  // `yelp_single_account`: the request is well formed, it is simply not
  // permitted, which is what E_FORBIDDEN means.
  if (input.provider === 'yelp') {
    const existingYelp = await c.env.DB.prepare(
      `SELECT id FROM provider_accounts WHERE provider = 'yelp' LIMIT 1`,
    ).first<{ id: string }>();
    if (existingYelp) {
      const { body, status } = fail('E_FORBIDDEN', { reason: 'yelp_single_account' });
      return c.json(body, status as 403);
    }
  }

  // A PAID provider may not be registered with a zero ceiling. `cost_micro_per_unit`
  // is what marks a provider as charging: if any of its capability rows carries a
  // non-zero unit cost, then a `quota_limit` of 0 is not "unlimited" — it is the
  // budget guard multiplied by a zero cost, which is a guard that can never fire
  // (R11's spirit, 11-api-contract.md §4.1 `quota_zero`). Keyless/free providers
  // keep the null they have; only a paid row is refused.
  const paid = await c.env.DB.prepare(
    `SELECT 1 AS paid FROM provider_capability
      WHERE provider = ? AND COALESCE(cost_micro_per_unit, 0) > 0 LIMIT 1`,
  )
    .bind(input.provider)
    .first<{ paid: number }>();
  if (paid && (input.quota_limit ?? 0) <= 0) {
    const { body, status } = fail('E_VALIDATION', { reason: 'quota_zero', provider: input.provider });
    return c.json(body, status as 400);
  }

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

  // Recorded AS an account, which it is. Until 0006 widened `audit_log.entity_type`
  // this was logged as entity_type='credential' with `kind:'provider_account'`
  // buried in the detail blob, purely because the old CHECK listed only four
  // entity types. That workaround is gone: it made "who added a provider account"
  // and "who added a credential" the same question, which is the opposite of why
  // the table exists. 11-api-contract.md §4.1 names the row precisely —
  // entity_type='provider_account', action='account_create', entity_id=<label>.
  await auditLog(c.env, c.get('actor'), {
    entityType: 'provider_account',
    entityId: input.account_label,
    action: 'account_create',
    detail: {
      provider: input.provider,
      quota_limit: input.quota_limit ?? null,
      quota_window: input.quota_window ?? null,
      plan_label: input.plan_label ?? null,
    },
  });

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

  // Same correction as account creation: an edit to an account is an account
  // action, recorded as `entity_type='provider_account'` with the new `update`
  // action, not as a credential `test` with the real intent in a detail blob.
  await auditLog(c.env, c.get('actor'), {
    entityType: 'provider_account',
    entityId: id,
    action: 'update',
    detail: { provider: row.provider, account_label: row.account_label, ...patch },
  });

  return c.json(ok({ id, ...patch }));
});

providerRoutes.get('/providers/accounts', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, provider, account_label, quota_limit, quota_used,
            -- The contract calls this quota_period; the column is quota_window.
            quota_window AS quota_period,
            quota_reset_at, quota_expires_at, daily_used, daily_limit, status, cooldown_until,
            consecutive_errors, plan_label, plan_price_micro, last_synced_at, sync_error,
            enabled, priority, last_used_at,
            1 AS has_credential
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
  // Field names are the contract's (`account_count`, `quota_total`, `unit_type`
  // …), derived in SQL so the pool tiles render without client-side guesswork.
  // `unit_type` is the provider's own unit, because "5,000 of what?" is the
  // question the tile exists to answer.
  const result = await c.env.DB.prepare(
    `SELECT provider,
            COUNT(*) AS account_count,
            SUM(CASE WHEN enabled = 1 AND status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END)      AS invalid,
            SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited,
            SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)    AS exhausted,
            COALESCE(SUM(COALESCE(quota_limit, 0)), 0) AS quota_total,
            COALESCE(SUM(COALESCE(quota_used, 0)), 0)  AS quota_used,
            CASE provider
              WHEN 'brightdata' THEN 'credits'
              WHEN 'apify'      THEN 'USD'
              WHEN 'zerobounce' THEN 'verifications'
              WHEN 'resend'     THEN 'emails'
              WHEN 'yelp'       THEN 'calls/day'
              WHEN 'google_psi' THEN 'requests/day'
              ELSE 'requests'
            END AS unit_type,
            -- Keyless providers hold no credential at all, so the tile must not
            -- offer a key that does not exist.
            CASE WHEN provider IN ('google_psi','gha_runner') THEN 1 ELSE 0 END AS keyless,
            -- Exactly one account, forever: a second Yelp account is a terms
            -- problem, not a quota problem (R21).
            CASE WHEN provider IN ('yelp','mapquest') THEN 1 ELSE 0 END AS single_account
       FROM provider_accounts
      GROUP BY provider
      ORDER BY provider ASC`,
  ).all();

  // The pool is a floor, not a ceiling (ADR-034): `account_count` is what exists
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

/**
 * Live credit/status check for every Apify account in the pool.
 * Decrypts each credential server-side, calls /v2/users/me, and reports
 * username, plan, and whether the key is working. This is the "check" button
 * the dashboard calls — it never exposes the keys.
 */
providerRoutes.get('/providers/credits/apify', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.account_label, c.ciphertext, c.iv, c.auth_tag
       FROM provider_credentials c
       JOIN provider_accounts a ON a.id = c.account_id
      WHERE a.provider = 'apify' AND a.status = 'active'
      ORDER BY a.account_label ASC`,
  ).all<{ account_label: string; ciphertext: string; iv: string; auth_tag: string }>();

  const { openSecret } = await import('../lib/crypto');
  const results = [];
  for (const row of (rows.results ?? [])) {
    try {
      const secret = await openSecret(
        { ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag },
        c.env.VAULT_KEY,
      );
      const resp = await fetch(
        `https://api.apify.com/v2/users/me?token=${encodeURIComponent(secret)}`,
        { headers: { 'User-Agent': 'jepy-worker/1.0' } },
      );
      if (!resp.ok) {
        results.push({ account_label: row.account_label, working: false, error: `HTTP ${resp.status}` });
        continue;
      }
      const body = (await resp.json()) as {
        data?: { username?: string; plan?: { id?: string }; usage?: unknown };
      };
      results.push({
        account_label: row.account_label,
        working: !!body.data?.username,
        username: body.data?.username ?? null,
        plan: body.data?.plan?.id ?? null,
      });
    } catch (e) {
      results.push({
        account_label: row.account_label,
        working: false,
        error: e instanceof Error ? e.message.slice(0, 100) : 'unknown',
      });
    }
  }
  return c.json(ok({ accounts: results, checked_at: Math.floor(Date.now() / 1000) }));
});
