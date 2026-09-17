/**
 * Email and compliance.
 *
 * Two honest limitations, both stated rather than papered over:
 *
 *   * A suppression row cannot show a masked address, because the table stores a
 *     SHA-256 hash and no plaintext (rule R22). The contract's `email_masked` is
 *     therefore null, and the console renders an em dash. Returning the hash
 *     would be worse than nothing: it is a fingerprint that would let anyone
 *     confirm whether a given address is on the list.
 *   * `id` is a TEXT uuid in the schema while the contract declares a number.
 *     The console's type was widened to string instead of the API casting a uuid
 *     to a number, which would have been a lie that happened to typecheck.
 *
 * Bounce and complaint rates are computed from the log rather than stored, so
 * they cannot drift away from the events that produced them.
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
import type { Actor, Env } from '../env';

export const emailRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

emailRoutes.get('/email/campaigns', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.esp, c.status, c.warmup_stage, c.created_at,
            (SELECT COUNT(*) FROM outreach_messages m WHERE m.campaign_id = c.id AND m.status = 'sent')    AS sent,
            (SELECT COUNT(*) FROM outreach_messages m WHERE m.campaign_id = c.id AND m.status = 'replied') AS replies,
            (SELECT COUNT(*) FROM bounce_complaint_log b
               JOIN outreach_messages m2 ON m2.id = b.message_id
              WHERE m2.campaign_id = c.id AND b.type = 'hard_bounce')  AS hard_bounces,
            (SELECT COUNT(*) FROM bounce_complaint_log b
               JOIN outreach_messages m3 ON m3.id = b.message_id
              WHERE m3.campaign_id = c.id AND b.type = 'complaint')    AS complaints
       FROM outreach_campaigns c ORDER BY c.created_at DESC`,
  ).all();

  const rows = ((result.results ?? []) as Record<string, unknown>[]).map((row) => {
    const sent = Number(row.sent ?? 0);
    return {
      ...row,
      bounce_rate: sent > 0 ? Math.round((Number(row.hard_bounces ?? 0) / sent) * 10000) / 100 : 0,
      complaint_rate: sent > 0 ? Math.round((Number(row.complaints ?? 0) / sent) * 10000) / 100 : 0,
    };
  });

  return c.json(ok(rows));
});

emailRoutes.get('/email/suppression', async (c) => {
  // An array, because the console declares `SuppressionEntry[]`.
  const result = await c.env.DB.prepare(
    `SELECT id, domain,
            -- The console's vocabulary; the schema stores hard_bounce.
            CASE reason WHEN 'hard_bounce' THEN 'bounce' ELSE reason END AS reason,
            NULL AS email_masked,
            created_at
       FROM suppression_list ORDER BY created_at DESC LIMIT 500`,
  ).all();
  return c.json(ok(result.results ?? []));
});

emailRoutes.get('/email/dsr', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, NULL AS subject_masked,
            CASE request_type WHEN 'delete' THEN 'erase' ELSE 'access' END AS kind,
            received_at, due_at,
            CASE WHEN completed_at IS NULL THEN 'open' ELSE 'done' END AS status,
            affected_rows, note
       FROM dsr_requests ORDER BY received_at DESC`,
  ).all();
  return c.json(ok(result.results ?? []));
});
