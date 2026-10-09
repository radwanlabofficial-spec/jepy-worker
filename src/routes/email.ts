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
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { requireActor } from '../middleware/auth';
import { hashEmail, normalizeEmail } from '../jobs/verify';
import type { VerifyStatus } from '../jobs/verify';
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

// ---------------------------------------------------------------------------
// Email verification pipeline — free-first (Track B).
//
// POST /email/verify queues uncached addresses for the verifier (jobs/verify.ts
// runs Apify #1 -> Apify #2 -> ZeroBounce-free and caches the final
// VALID/INVALID/UNKNOWN/RISKY verdict). requireActor on all three, because
// verification spends provider quota and the queue is operational state.
// ---------------------------------------------------------------------------

const verifyRequestSchema = z.object({
  emails: z.array(z.string().min(1).max(254)).min(1).max(200),
});

interface CacheHitRow {
  email_hash: string;
  status: VerifyStatus;
  provider: string | null;
  reason: string | null;
  checked_at: number | null;
}

async function verifyCacheTtl(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT value_text FROM settings WHERE key = 'verify_cache_ttl_seconds'`)
    .first<{ value_text: string | null }>();
  const ttl = Number(row?.value_text);
  return Number.isFinite(ttl) && ttl > 0 ? Math.trunc(ttl) : 30 * 24 * 3600;
}

emailRoutes.post('/email/verify', requireActor, async (c) => {
  const parsed = verifyRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION', { reason: 'emails must be an array of 1-200 strings' });
    return c.json(body, status as 400);
  }

  // Normalise once: lowercase + trim, deduped, input order preserved. The
  // display form keeps the caller's casing so the response echoes the input.
  const seen = new Map<string, string>();
  for (const raw of parsed.data.emails) {
    const lowered = raw.trim().toLowerCase();
    if (!seen.has(lowered)) seen.set(lowered, raw.trim());
  }
  const normalized = [...seen.keys()];
  const ttl = await verifyCacheTtl(c.env.DB);

  // ONE batch cache lookup for every hash. Only fresh provider-independent
  // verdicts count: a row without a status (old Layer-1 shape from 0001) is
  // not a hit, and neither is an expired one.
  const hashes = await Promise.all(normalized.map(async (email) => ({ email, hash: await hashEmail(email) })));
  const placeholders = hashes.map(() => '?').join(',');
  const hitRows = (await c.env.DB.prepare(
    `SELECT email_hash, status, provider, reason, checked_at
       FROM email_verification_cache
      WHERE email_hash IN (${placeholders})
        AND status IS NOT NULL
        AND checked_at > unixepoch() - ?`,
  )
    .bind(...hashes.map((entry) => entry.hash), ttl)
    .all<CacheHitRow>()).results ?? [];
  const hits = new Map(hitRows.map((row) => [row.email_hash, row]));

  const results: Array<{ email: string; status: VerifyStatus; source: 'cache' | 'queued' }> = [];
  const enqueueStmts: D1PreparedStatement[] = [];
  const invalidStmts: D1PreparedStatement[] = [];

  for (const { email, hash } of hashes) {
    const display = seen.get(email) ?? email;
    const hit = hits.get(hash);
    if (hit) {
      results.push({ email: display, status: hit.status, source: 'cache' });
      continue;
    }
    if (normalizeEmail(email) === null) {
      // Design doc §2: invalid syntax is a definitive INVALID that costs no
      // provider call. Cached immediately so it is never queued again.
      invalidStmts.push(
        c.env.DB.prepare(
          `INSERT INTO email_verification_log (id, email_hash, pass, provider, actor_id, status, reason, checked_at)
           VALUES (?, ?, 0, 'local', NULL, 'INVALID', 'invalid_syntax', unixepoch())`,
        ).bind(crypto.randomUUID(), hash),
        c.env.DB.prepare(
          `INSERT INTO email_verification_cache (id, email_hash, domain, status, provider, reason, checked_at, expires_at)
           VALUES (?, ?, ?, 'INVALID', 'local', 'invalid_syntax', unixepoch(), unixepoch() + ?)`,
        ).bind(crypto.randomUUID(), hash, email.split('@')[1] ?? '', ttl),
      );
      results.push({ email: display, status: 'INVALID', source: 'cache' });
      continue;
    }
    // `runner: 'verifier'` keeps the cron dispatcher from misrouting these:
    // its claim only takes jobs that declare no runner or 'worker', and
    // processVerifyJobs (jobs/verify.ts) claims verifier jobs directly.
    enqueueStmts.push(
      c.env.DB.prepare(
        `INSERT INTO job_queue (id, job_type, target_type, payload_json, priority, status, created_at, updated_at)
         VALUES (?, 'verify', 'email_verify', ?, 5, 'pending', unixepoch(), unixepoch())`,
      ).bind(crypto.randomUUID(), JSON.stringify({ email, pass: 1, runner: 'verifier' })),
    );
    results.push({ email: display, status: 'UNKNOWN', source: 'queued' });
  }

  // Writes go out in chunks: D1 batch discipline keeps each round-trip small
  // and a 200-address request stays a handful of statements, not hundreds of
  // sequential round-trips.
  const allStmts = [...invalidStmts, ...enqueueStmts];
  for (let i = 0; i < allStmts.length; i += 50) {
    await c.env.DB.batch(allStmts.slice(i, i + 50));
  }

  return c.json(ok({ results }));
});

/** Single-address cache lookup. A miss is not an error of the address, only
 *  of the cache — hence E_NOT_FOUND with reason 'not_verified'. */
emailRoutes.get('/email/verify/status', requireActor, async (c) => {
  const raw = (c.req.query('email') ?? '').trim();
  if (!raw) {
    const { body, status } = fail('E_VALIDATION', { reason: 'email query param is required' });
    return c.json(body, status as 400);
  }
  const email = raw.toLowerCase();
  const ttl = await verifyCacheTtl(c.env.DB);
  const row = await c.env.DB.prepare(
    `SELECT status, provider, reason, checked_at
       FROM email_verification_cache
      WHERE email_hash = ? AND status IS NOT NULL AND checked_at > unixepoch() - ?`,
  )
    .bind(await hashEmail(email), ttl)
    .first<CacheHitRow>();
  if (!row) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'not_verified', email });
    return c.json(body, status as 404);
  }
  return c.json(ok({ email, status: row.status, provider: row.provider, reason: row.reason, checked_at: row.checked_at }));
});

/** How much verification work is outstanding. One COUNT query, no rows read. */
emailRoutes.get('/email/verify/queue', requireActor, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM job_queue
      WHERE job_type = 'verify' AND status IN ('pending', 'claimed', 'running')`,
  ).first<{ n: number }>();
  return c.json(ok({ pending: row?.n ?? 0 }));
});
