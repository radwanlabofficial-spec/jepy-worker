/**
 * Email and compliance.
 *
 * Suppression addresses are returned masked. The table stores a hash and no
 * plaintext, so returning the hash would be a fingerprint of the address rather
 * than nothing at all — enough to confirm whether a given person is on the list.
 * The operator does not need that to work the queue.
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
import type { Actor, Env } from '../env';

export const emailRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

emailRoutes.get('/email/campaigns', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.niche, c.esp, c.from_domain, c.daily_cap, c.warmup_stage, c.status, c.created_at,
            (SELECT COUNT(*) FROM outreach_messages m WHERE m.campaign_id = c.id) AS messages,
            (SELECT COUNT(*) FROM outreach_messages m WHERE m.campaign_id = c.id AND m.status = 'sent') AS sent,
            (SELECT COUNT(*) FROM outreach_messages m WHERE m.campaign_id = c.id AND m.status = 'replied') AS replied
       FROM outreach_campaigns c ORDER BY c.created_at DESC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

emailRoutes.get('/email/suppression', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, domain, reason, source_campaign_id, created_at
       FROM suppression_list ORDER BY created_at DESC LIMIT 500`,
  ).all();
  return c.json(
    ok({
      rows: result.results ?? [],
      note: "Addresses are stored as a SHA-256 hash and are shown masked by design; the plaintext is never persisted.",
    }),
  );
});

emailRoutes.get('/email/dsr', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, request_type, received_at, due_at, completed_at, affected_rows, note,
            (due_at IS NOT NULL AND completed_at IS NULL AND due_at < unixepoch()) AS overdue
       FROM dsr_requests ORDER BY received_at DESC`,
  ).all();
  return c.json(ok(result.results ?? []));
});
