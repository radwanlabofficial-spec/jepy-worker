/**
 * Vault — the safe view of credentials.
 *
 * Only `last4` and `test_status` ever leave the database. There is no route that
 * returns a decrypted secret, and no route that returns `ciphertext`, `iv` or
 * `auth_tag` either: the shape of the sealed value is nobody's business outside
 * this Worker, and exposing it would invite a client-side decryption attempt.
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
import type { Actor, Env } from '../env';

export const vaultRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

vaultRoutes.get('/vault/credentials', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT c.id, a.provider, a.account_label, c.key_name, c.last4, c.test_status,
            c.last_tested_at, c.rotated_at, a.quota_expires_at
       FROM provider_credentials c
       JOIN provider_accounts a ON a.id = c.account_id
      ORDER BY a.provider ASC, a.account_label ASC, c.key_name ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});
