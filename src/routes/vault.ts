/**
 * Vault — read the safe view, write new credentials.
 *
 * Three rules hold across every route in this file:
 *
 *   1. A plaintext secret enters a request body exactly once, is sealed here, and
 *      never leaves again. No route returns it, and no route returns the sealed
 *      parts either — `ciphertext`, `iv` and `auth_tag` are nobody's business
 *      outside this Worker, and handing them out would invite a client-side
 *      decryption attempt.
 *   2. The test runs BEFORE the row is written (06 §12). A key the provider
 *      refuses is never stored, because a stored bad key looks like a configured
 *      provider to the router and would burn real jobs before anyone noticed.
 *   3. Every change lands in `audit_log` with the operator's Access email. A
 *      credential change that leaves no trace is indistinguishable from one that
 *      never happened.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { last4, openSecret, sealSecret } from '../lib/crypto';
import { testCredential } from '../lib/provider-test';
import type { Actor, Env } from '../env';

export const vaultRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

vaultRoutes.get('/vault/credentials', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT c.id, a.provider, a.account_label, c.key_name, c.last4, c.test_status,
            c.last_tested_at, c.rotated_at, a.quota_expires_at,
            -- The console uses this to decide whether the account still needs a
            -- key, so an account without one must be able to say so.
            1 AS has_credential
       FROM provider_credentials c
       JOIN provider_accounts a ON a.id = c.account_id
      ORDER BY a.provider ASC, a.account_label ASC, c.key_name ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

/** Appends an audit row. Deliberately swallows its own failure: an audit write
 *  must never turn a successful rotation into an error for the operator, and the
 *  error path already records anything that really breaks. */
async function audit(
  env: Env,
  actor: Actor,
  entityId: string,
  action: 'add' | 'rotate' | 'delete' | 'test',
  result: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, entity_type, entity_id, action, actor_email, result, detail_json, created_at)
       VALUES (?, 'credential', ?, ?, ?, ?, ?, unixepoch())`,
    )
      .bind(crypto.randomUUID(), entityId, action, actor.email, result, detail ? JSON.stringify(detail) : null)
      .run();
  } catch {
    // ignore
  }
}

interface AccountRow {
  id: string;
  provider: string;
  account_label: string;
}

const createSchema = z.object({
  account_label: z.string().min(1),
  key_name: z.string().min(1),
  secret: z.string().min(4),
});

vaultRoutes.post('/vault/credentials', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const { account_label, key_name, secret } = parsed.data;

  const account = await c.env.DB.prepare(
    `SELECT id, provider, account_label FROM provider_accounts WHERE account_label = ?`,
  )
    .bind(account_label)
    .first<AccountRow>();

  if (!account) {
    // Its own reason, because the fix is different: the account has to be created
    // first, and the UI can offer exactly that from this response.
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_account', account_label });
    return c.json(body, status as 404);
  }

  // Rule 2: test first, store only what the provider accepts.
  const outcome = await testCredential(account.provider, secret);
  if (outcome.status === 'failed') {
    // A refused attempt is recorded too. 06 §12 puts every test in audit_log, and
    // an attempt to install a key the provider rejects is exactly the thing worth
    // being able to look up later.
    await audit(c.env, c.get('actor'), account.id, 'test', 'failed', {
      kind: 'credential_rejected',
      account_label,
      key_name,
      message: outcome.message,
    });
    const { body, status } = fail('E_CREDENTIAL_INVALID', { reason: 'provider_refused', message: outcome.message });
    return c.json(body, status as 502);
  }

  const sealed = await sealSecret(secret, c.env.VAULT_KEY);
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO provider_credentials
       (id, account_id, key_name, ciphertext, iv, auth_tag, last4, algo, test_status, last_tested_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'AES-256-GCM', ?, ?, unixepoch())`,
  )
    .bind(
      id,
      account.id,
      key_name,
      sealed.ciphertext,
      sealed.iv,
      sealed.auth_tag,
      sealed.last4,
      outcome.status,
      outcome.status === 'untested' ? null : Math.floor(Date.now() / 1000),
    )
    .run();

  await audit(c.env, c.get('actor'), id, 'add', outcome.status, {
    account_label,
    key_name,
    last4: sealed.last4,
    test: outcome.message,
  });

  // The response carries the verdict and the last four characters. Nothing else.
  return c.json(ok({ id, test_status: outcome.status, message: outcome.message, last4: sealed.last4 }));
});

vaultRoutes.post('/vault/credentials/:id/test', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT c.id, c.ciphertext, c.iv, c.auth_tag, a.provider
       FROM provider_credentials c JOIN provider_accounts a ON a.id = c.account_id
      WHERE c.id = ?`,
  )
    .bind(id)
    .first<{ id: string; ciphertext: string; iv: string; auth_tag: string; provider: string }>();

  if (!row) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  let secret: string;
  try {
    secret = await openSecret(row, c.env.VAULT_KEY);
  } catch {
    // An unopenable row means the key no longer matches this VAULT_KEY. That is
    // a real operational fact and it is stated as itself rather than as a
    // provider failure.
    const { body, status } = fail('E_CREDENTIAL_INVALID', { reason: 'vault_key_mismatch' });
    return c.json(body, status as 502);
  }

  const outcome = await testCredential(row.provider, secret);

  await c.env.DB.prepare(
    `UPDATE provider_credentials SET test_status = ?, last_tested_at = unixepoch() WHERE id = ?`,
  )
    .bind(outcome.status, id)
    .run();

  await audit(c.env, c.get('actor'), id, 'test', outcome.status, { provider: row.provider, message: outcome.message });

  return c.json(ok({ test_status: outcome.status, message: outcome.message }));
});

const rotateSchema = z.object({ secret: z.string().min(4) });

vaultRoutes.post('/vault/credentials/:id/rotate', async (c) => {
  const parsed = rotateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT c.id, a.provider FROM provider_credentials c
       JOIN provider_accounts a ON a.id = c.account_id WHERE c.id = ?`,
  )
    .bind(id)
    .first<{ id: string; provider: string }>();

  if (!row) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const outcome = await testCredential(row.provider, parsed.data.secret);
  if (outcome.status === 'failed') {
    const { body, status } = fail('E_CREDENTIAL_INVALID', { reason: 'provider_refused', message: outcome.message });
    return c.json(body, status as 502);
  }

  const sealed = await sealSecret(parsed.data.secret, c.env.VAULT_KEY);
  await c.env.DB.prepare(
    `UPDATE provider_credentials
        SET ciphertext = ?, iv = ?, auth_tag = ?, last4 = ?, test_status = ?,
            last_tested_at = unixepoch(), rotated_at = unixepoch()
      WHERE id = ?`,
  )
    .bind(sealed.ciphertext, sealed.iv, sealed.auth_tag, sealed.last4, outcome.status, id)
    .run();

  // Bumping the epoch invalidates any decrypted copy another request may still
  // be holding. Without it a rotation leaves two live keys in flight.
  const bumped = await c.env.DB.prepare(
    `UPDATE settings SET value_num = COALESCE(value_num, 0) + 1, updated_at = unixepoch()
      WHERE key = 'vault_epoch' RETURNING value_num`,
  ).first<{ value_num: number }>();

  await audit(c.env, c.get('actor'), id, 'rotate', outcome.status, {
    provider: row.provider,
    last4: sealed.last4,
    vault_epoch: bumped?.value_num ?? null,
  });

  return c.json(ok({ vault_epoch: bumped?.value_num ?? null, test_status: outcome.status, last4: sealed.last4 }));
});

vaultRoutes.delete('/vault/credentials/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT c.id, c.last4, a.provider, a.account_label
       FROM provider_credentials c JOIN provider_accounts a ON a.id = c.account_id
      WHERE c.id = ?`,
  )
    .bind(id)
    .first<{ id: string; last4: string | null; provider: string; account_label: string }>();

  if (!row) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  await c.env.DB.prepare(`DELETE FROM provider_credentials WHERE id = ?`).bind(id).run();
  await audit(c.env, c.get('actor'), id, 'delete', 'ok', {
    provider: row.provider,
    account_label: row.account_label,
    last4: row.last4,
  });

  return c.json(ok({ ok: true as const }));
});

/** What this build can actually verify, so the UI never implies more than it can. */
vaultRoutes.get('/vault/testable-providers', async (c) => {
  const { TESTABLE_PROVIDERS } = await import('../lib/provider-test');
  return c.json(ok({ providers: TESTABLE_PROVIDERS }));
});
