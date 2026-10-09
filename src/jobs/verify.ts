/**
 * Email verification pipeline — free-first (Track B).
 *
 * WHY THIS EXISTS. The design doc (zerobounce_free_replacement_setup.md) lays
 * out a $0-first pipeline: Apify Verifier #1 (syntax + MX/DNS + disposable)
 * -> Apify Verifier #2 (UNKNOWN/RISKY only) -> ZeroBounce free credits
 * (hardest cases only) -> cache so an email is never verified twice. This
 * module is the EMAIL VERIFIER ADAPTER from that doc: the rest of the platform
 * sees only the provider-independent statuses VALID / INVALID / UNKNOWN /
 * RISKY, and providers can be swapped without touching the callers.
 *
 * WHY IT NEVER MARKS INVALID ON PROVIDER ERRORS. A timeout, a refused actor
 * run, or an empty dataset is evidence about the provider, not the email.
 * Design doc §8 says technical failures get retried, never auto-invalidated —
 * so a provider outage must not poison the lead database with false INVALIDs.
 * The job keeps its UNKNOWN non-verdict and goes back on the queue with the
 * normal backoff; `max_attempts` still bounds the retries.
 *
 * WHY PASS 2 REUSES THE SAME JOB ROW. Pass 2 is not a retry, it is the next
 * pipeline stage, so the row is updated in place (payload pass 1 -> 2) rather
 * than failed-and-requeued: the attempt history stays linear and the operator
 * sees one job per email, not a chain.
 *
 * COST DISCIPLINE. Pass 2 runs ONLY for UNKNOWN/RISKY (never for the whole
 * list). ZeroBounce runs ONLY when a zerobounce credential exists in the Vault
 * AND /v2/getcredits reports a positive balance — the check happens before the
 * call, so paid credit is never spent by accident. The Apify pool is the
 * existing 20-account pool claimed via claimAccount, which enforces per-account
 * daily limits and least-recently-used rotation.
 *
 * WIRING. The cron dispatcher (jobs/scheduled.ts) routes every claimed job to
 * the RouterDO by target_type, which knows nothing about email verification.
 * processVerifyJobs must therefore run in the dispatcher tick BEFORE the
 * router claim, and verify jobs declare `runner: 'verifier'` in their payload
 * so the dispatcher's own claim (which only takes runner='worker' jobs) skips
 * them. Without that ordering the dispatcher would misroute them.
 */

import { z } from 'zod';
import { openSecret, sha256Hex } from '../lib/crypto';
import { claimAccount } from '../router/claim';
import { recordAttemptFailure, recordAttemptSuccess } from '../router/circuit';
import { complete, fail as failJob } from '../lib/queue';
import type { Env } from '../env';

/**
 * PLACEHOLDER actor IDs — deliberately not real actors. The free Apify email
 * verifiers for pass 1 and pass 2 MUST be chosen by benchmarking 100-200
 * emails per design doc §13 (false VALID/INVALID, UNKNOWN %, cost, time) and
 * then stored in the settings keys below. Until then the settings rows are
 * NULL and the pipeline queues but never spends an Apify run: a placeholder
 * is treated as "not configured", never as a guess to call.
 */
const PLACEHOLDER_ACTOR = 'pending-benchmark/no-actor-selected';
const DEFAULT_VERIFY_ACTORS = { pass1: PLACEHOLDER_ACTOR, pass2: PLACEHOLDER_ACTOR } as const;

const SETTING_KEYS = ['verify_actor_pass1', 'verify_actor_pass2', 'verify_cache_ttl_seconds'] as const;
const CACHE_TTL_DEFAULT_SECONDS = 30 * 24 * 3600;

/** run-sync waits for the actor; the actor-side budget is 300s, the HTTP
 *  abort is shorter so one slow actor cannot eat the whole cron tick. */
const APIFY_TIMEOUT_MS = 60_000;
const ZEROBOUNCE_TIMEOUT_MS = 20_000;

export type VerifyStatus = 'VALID' | 'INVALID' | 'UNKNOWN' | 'RISKY';

/** Lowercase + trim. Returns null for syntactically invalid addresses, which
 *  the design doc (§2) treats as a definitive INVALID without a provider call. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export async function hashEmail(email: string): Promise<string> {
  return sha256Hex(email);
}

const verifyPayloadSchema = z.object({
  email: z.string().min(3).max(254),
  pass: z.number().int().min(1).max(2).default(1),
});

interface VerifySettings {
  actorPass1: string;
  actorPass2: string;
  cacheTtlSeconds: number;
}

async function readVerifySettings(db: D1Database): Promise<VerifySettings> {
  const rows = (await db
    .prepare(`SELECT key, value_text FROM settings WHERE key IN ('verify_actor_pass1','verify_actor_pass2','verify_cache_ttl_seconds')`)
    .all<{ key: string; value_text: string | null }>()).results ?? [];
  const byKey = new Map(rows.map((row) => [row.key, row.value_text]));
  const actor = (key: string, fallback: string): string => {
    const value = (byKey.get(key) ?? '').trim();
    return value === '' ? fallback : value;
  };
  const ttl = Number(byKey.get('verify_cache_ttl_seconds'));
  return {
    actorPass1: actor('verify_actor_pass1', DEFAULT_VERIFY_ACTORS.pass1),
    actorPass2: actor('verify_actor_pass2', DEFAULT_VERIFY_ACTORS.pass2),
    cacheTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.trunc(ttl) : CACHE_TTL_DEFAULT_SECONDS,
  };
}

interface CachedVerdict {
  status: VerifyStatus;
  provider: string | null;
  reason: string | null;
  checked_at: number | null;
}

/** Fresh cache hit: a provider-independent status inside the TTL window. */
async function readCache(db: D1Database, emailHash: string, ttlSeconds: number): Promise<CachedVerdict | null> {
  const row = await db
    .prepare(
      `SELECT status, provider, reason, checked_at FROM email_verification_cache
        WHERE email_hash = ? AND status IS NOT NULL AND checked_at > unixepoch() - ?`,
    )
    .bind(emailHash, ttlSeconds)
    .first<CachedVerdict>();
  return row;
}

/** One attempt row. The log carries the history; the cache carries the final
 *  verdict. They are written separately on purpose: a pass-1 UNKNOWN is an
 *  attempt, not an answer, and writing it to the cache would make the next
 *  readCache hit skip pass 2 entirely. */
async function logAttempt(db: D1Database, input: {
  emailHash: string;
  pass: number;
  provider: string;
  actorId: string | null;
  status: VerifyStatus;
  reason: string;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_verification_log (id, email_hash, pass, provider, actor_id, status, reason, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    )
    .bind(
      crypto.randomUUID(), input.emailHash, input.pass, input.provider,
      input.actorId, input.status, input.reason,
    )
    .run();
}

/** Writes the FINAL verdict to the cache.
 *  The cache has no UNIQUE constraint on email_hash (0001), so the write is
 *  UPDATE-then-INSERT rather than ON CONFLICT — a second source of truth for
 *  "the email is already cached" would be worse than the tiny race here. */
async function writeCache(db: D1Database, input: {
  emailHash: string;
  domain: string;
  status: VerifyStatus;
  provider: string;
  reason: string;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const updated = await db
    .prepare(
      `UPDATE email_verification_cache
          SET status = ?, provider = ?, reason = ?, checked_at = ?, expires_at = ?
        WHERE email_hash = ?`,
    )
    .bind(input.status, input.provider, input.reason, now, now + CACHE_TTL_DEFAULT_SECONDS, input.emailHash)
    .run();
  if ((updated.meta.changes ?? 0) === 0) {
    await db
      .prepare(
        `INSERT INTO email_verification_cache
           (id, email_hash, domain, status, provider, reason, checked_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(), input.emailHash, input.domain, input.status,
        input.provider, input.reason, now, now + CACHE_TTL_DEFAULT_SECONDS,
      )
      .run();
  }
}

/** A provider failure is evidence about the provider, never about the email —
 *  so it is recorded against the circuit scopes (three strikes opens the
 *  provider) and the job is retried, with no cache write at all. */
class ProviderError extends Error {}

/** Fetches the newest tested Vault credential for a provider. The plaintext
 *  secret is decrypted here, used in the Authorization header/query below, and
 *  never logged — the same pattern as scoring/run.ts. */
async function vaultSecret(env: Env, provider: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT c.ciphertext, c.iv, c.auth_tag
       FROM provider_credentials c
       JOIN provider_accounts a ON a.id = c.account_id
      WHERE a.provider = ? AND c.test_status = 'ok'
      ORDER BY c.rotated_at IS NULL DESC, c.created_at DESC
      LIMIT 1`,
  )
    .bind(provider)
    .first<{ ciphertext: string; iv: string; auth_tag: string }>();
  if (!row) return null;
  try {
    return await openSecret(row, env.VAULT_KEY);
  } catch {
    return null;
  }
}

/**
 * Runs one email through an Apify email-verifier actor via the established
 * run-sync pattern (targets/wave2/apify.ts): the actor ID goes in the path
 * with a tilde, the token in the query string, and the endpoint returns the
 * dataset items directly. Throws ProviderError on any technical failure.
 */
async function runApifyEmailCheck(
  env: Env,
  actor: string,
  email: string,
): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  // The 20-account pool with per-account daily limits and LRU rotation — the
  // free-first spend goes through the same ledger as every other Apify call.
  const account = await claimAccount(env.DB, 'apify', now, true);
  if (!account) throw new ProviderError('no claimable apify account (pool exhausted or cooling down)');

  const token = await vaultSecret(env, 'apify');
  if (!token) throw new ProviderError('apify account claimed but its vault credential is unopenable');

  // Actor IDs use a TILDE in the URL path, not a slash (see wave2/apify.ts).
  const actorPath = actor.replace('/', '~');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=300`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'jepy-worker/1.0' },
        body: JSON.stringify({ email }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new ProviderError(`apify run-sync returned HTTP ${response.status}`);
    const items = (await response.json()) as unknown;
    if (!Array.isArray(items) || items.length === 0) {
      throw new ProviderError('apify actor returned no dataset items');
    }
    const first = items[0];
    if (!first || typeof first !== 'object') throw new ProviderError('apify actor returned an unparseable item');
    return first as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function boolField(item: Record<string, unknown>, ...names: string[]): boolean | null {
  for (const name of names) {
    const value = item[name];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function textField(item: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = item[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().toLowerCase();
  }
  return null;
}

/**
 * Maps an Apify verifier's dataset item to the provider-independent status
 * model. The schema is sniffed rather than assumed, because the pass-1 and
 * pass-2 actors are chosen by benchmark (§13) and may not share a field
 * layout. Design doc pass-1 rules:
 *   INVALID — syntax invalid, no MX, explicit mailbox rejection, disposable
 *   VALID   — strong positives (syntax ok, MX ok, not disposable, reachability
 *             positive when the actor reports it)
 *   RISKY   — catch-all (§9: catch-all is RISKY, not guaranteed valid)
 *   UNKNOWN — timeouts, blocks, conflicting signals, anything unrecognised
 */
function mapApifyEmailResult(item: Record<string, unknown>): { status: VerifyStatus; reason: string } {
  const valid = boolField(item, 'valid', 'isValid', 'is_valid', 'emailValid', 'email_valid');
  const statusText = textField(item, 'status', 'emailStatus', 'email_status', 'verificationStatus', 'verification_status', 'result');
  const disposable = boolField(item, 'disposable', 'isDisposable', 'is_disposable');
  const catchAll = boolField(item, 'catchAll', 'catch_all', 'isCatchAll', 'is_catch_all');
  const syntaxOk = boolField(item, 'syntaxValid', 'syntax_valid', 'isSyntaxValid');
  const mxOk = boolField(item, 'hasMx', 'has_mx', 'mxValid', 'mx_valid');
  const mxRecords = item['mxRecords'] ?? item['mx_records'];
  const smtpOk = boolField(item, 'smtpValid', 'smtp_valid', 'reachable', 'isReachable', 'smtpOk');

  // Plain booleans up front: the fields below are `boolean | null`, and using
  // them directly after early returns makes TS narrow them to `false | null`,
  // which then flags `!== true` comparisons as unintentional.
  const isDisposable = disposable === true;
  const isCatchAll = catchAll === true;
  const explicitValid = valid === true;
  const explicitInvalid = valid === false;
  const smtpPositive = smtpOk === true;

  if (syntaxOk === false) return { status: 'INVALID', reason: 'apify: syntax invalid' };
  if (isDisposable) return { status: 'INVALID', reason: 'apify: disposable address' };
  if (mxOk === false || (Array.isArray(mxRecords) && mxRecords.length === 0)) {
    return { status: 'INVALID', reason: 'apify: no MX records' };
  }
  if (statusText && ['invalid', 'undeliverable', 'do_not_mail', 'bounced'].includes(statusText)) {
    return { status: 'INVALID', reason: `apify: status=${statusText}` };
  }
  if (explicitInvalid && !smtpPositive) {
    // An explicit false without a positive reachability signal is a definitive
    // rejection; when the actor disagrees with itself the verdict is unknown.
    return { status: 'INVALID', reason: 'apify: mailbox rejected' };
  }
  if (isCatchAll) return { status: 'RISKY', reason: 'apify: catch-all domain' };
  if (explicitValid && !isDisposable) {
    return { status: 'VALID', reason: 'apify: syntax+MX valid, not disposable' };
  }
  if (statusText && ['valid', 'deliverable', 'ok', 'safe'].includes(statusText) && !isCatchAll) {
    return { status: 'VALID', reason: `apify: status=${statusText}` };
  }
  return { status: 'UNKNOWN', reason: 'apify: inconclusive or conflicting signals' };
}

/**
 * ZeroBounce, the last resort for the hardest cases. Two hard rules:
 *   1. The credit balance is checked BEFORE the call via /v2/getcredits, and a
 *      zero/negative balance means "do not call" — paid credit is never spent.
 *      (getcredits cannot tell free from paid credit; the balance check only
 *      guarantees we never go negative, and the standing commitment is that no
 *      credits are bought until the free pipeline is benchmarked.)
 *   2. A missing zerobounce credential is not an error — it just means the
 *      pipeline ends at pass 2.
 * Returns null when ZeroBounce is unavailable, so the caller keeps the pass-2
 * verdict as final instead of inventing a third one.
 */
async function runZeroBounceCheck(
  env: Env,
  email: string,
): Promise<{ status: VerifyStatus; reason: string } | null> {
  const apiKey = await vaultSecret(env, 'zerobounce');
  if (!apiKey) return null;

  const get = async (path: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ZEROBOUNCE_TIMEOUT_MS);
    try {
      return await fetch(`https://api.zerobounce.net${path}`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const creditsResponse = await get(`/v2/getcredits?api_key=${encodeURIComponent(apiKey)}`);
  if (!creditsResponse.ok) throw new ProviderError(`zerobounce getcredits returned HTTP ${creditsResponse.status}`);
  const creditsBody = (await creditsResponse.json()) as { Credits?: string; error?: string };
  const credits = Number(creditsBody.Credits);
  if (!Number.isFinite(credits) || credits <= 0) {
    // Not a failure of the email — the allowance is simply gone, so the pass-2
    // verdict stands as final.
    return { status: 'UNKNOWN', reason: 'zerobounce: no free credits remaining' };
  }

  const validateResponse = await get(
    `/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`,
  );
  if (!validateResponse.ok) throw new ProviderError(`zerobounce validate returned HTTP ${validateResponse.status}`);
  const body = (await validateResponse.json()) as { status?: string; sub_status?: string };
  const zbStatus = (body.status ?? '').toLowerCase();

  switch (zbStatus) {
    case 'valid':
      return { status: 'VALID', reason: 'zerobounce: valid' };
    case 'invalid':
    case 'do_not_mail':
    case 'abuse':
    case 'spamtrap':
      // A spamtrap is not a reachable lead address, so for lead-gen use it is
      // INVALID rather than a deliverability footnote.
      return { status: 'INVALID', reason: `zerobounce: ${zbStatus}` };
    case 'catch-all':
      return { status: 'RISKY', reason: 'zerobounce: catch-all' };
    default:
      return { status: 'UNKNOWN', reason: `zerobounce: status=${zbStatus || 'missing'}` };
  }
}

/** Shared with the route layer: records a syntactically-invalid address as a
 *  local INVALID verdict (pass 0) and caches it, so it is never queued. */
export async function recordLocalInvalid(db: D1Database, input: {
  emailHash: string;
  domain: string;
}): Promise<void> {
  await logAttempt(db, {
    emailHash: input.emailHash, pass: 0, provider: 'local', actorId: null,
    status: 'INVALID', reason: 'invalid_syntax',
  });
  await writeCache(db, {
    emailHash: input.emailHash, domain: input.domain,
    status: 'INVALID', provider: 'local', reason: 'invalid_syntax',
  });
}

/**
 * Claims up to `limit` pending verify jobs and runs each through the
 * free-first pipeline. Returns the number of jobs touched (completed, moved to
 * pass 2, or requeued after a technical failure).
 *
 * The claim is ONE UPDATE...RETURNING (R6) — never select-then-update — so two
 * cron ticks cannot take the same email.
 */
export async function processVerifyJobs(env: Env, limit = 25): Promise<{ processed: number }> {
  const db = env.DB;
  const settings = await readVerifySettings(db);

  const claimed = (await db
    .prepare(
      `UPDATE job_queue
          SET status = 'claimed', claimed_by = 'cron:verify', claimed_at = unixepoch(), updated_at = unixepoch()
        WHERE id IN (
          SELECT id FROM job_queue
           WHERE job_type = 'verify'
             AND status = 'pending'
             AND (run_after IS NULL OR run_after <= unixepoch())
           ORDER BY priority DESC, created_at ASC
           LIMIT ?
        )
      RETURNING id, payload_json, attempts, max_attempts`,
    )
    .bind(limit)
    .all<{ id: string; payload_json: string | null; attempts: number; max_attempts: number }>()).results ?? [];

  let processed = 0;

  for (const job of claimed) {
    processed += 1;
    let parsedPayload: unknown = null;
    try {
      parsedPayload = job.payload_json ? JSON.parse(job.payload_json) : null;
    } catch {
      parsedPayload = null;
    }
    const payload = verifyPayloadSchema.safeParse(parsedPayload);
    if (!payload.success) {
      // A job that cannot say which email it is for can never be processed;
      // parking it as permanent is honest, retrying it is a loop.
      await failJob(db, job, 'verify job payload is not {email, pass}', 'permanent');
      continue;
    }

    const email = normalizeEmail(payload.data.email);
    const emailHash = await hashEmail(payload.data.email.trim().toLowerCase());
    const domain = payload.data.email.trim().toLowerCase().split('@')[1] ?? '';
    const pass = payload.data.pass;

    // Local syntax gate: an invalid address is INVALID without spending a
    // provider call, and it is cached so it is never queued again.
    if (!email) {
      await recordLocalInvalid(db, { emailHash, domain });
      await complete(db, job.id, null);
      continue;
    }

    // Cache first: an email is never verified twice inside the TTL window.
    const cached = await readCache(db, emailHash, settings.cacheTtlSeconds);
    if (cached) {
      await complete(db, job.id, null);
      continue;
    }

    const actor = pass === 1 ? settings.actorPass1 : settings.actorPass2;

    try {
      if (actor === PLACEHOLDER_ACTOR) {
        // The free actors are chosen by benchmark (§13); until then the queue
        // holds the work but spends nothing. A technical failure keeps the job
        // retryable instead of writing a verdict nobody earned.
        throw new ProviderError(
          `verify_actor_pass${pass} is not configured — free Apify actor pending benchmark (design doc §13)`,
        );
      }

      const item = await runApifyEmailCheck(env, actor, email);
      const mapped = mapApifyEmailResult(item);
      await recordAttemptSuccess(db, { provider: 'apify', target_type: 'verify', source_id: null });
      await logAttempt(db, {
        emailHash, pass, provider: 'apify', actorId: actor,
        status: mapped.status, reason: mapped.reason,
      });

      if (mapped.status === 'VALID' || mapped.status === 'INVALID') {
        await writeCache(db, {
          emailHash, domain, status: mapped.status, provider: 'apify', reason: mapped.reason,
        });
        await complete(db, job.id, null);
        continue;
      }

      if (pass === 1) {
        // UNKNOWN/RISKY goes to the second verifier — a different actor, not
        // the same check twice. The attempt is already logged above; the job
        // moves to pass 2. Nothing is written to the cache: this is not final.
        await db
          .prepare(
            `UPDATE job_queue
                SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
                    payload_json = ?, run_after = unixepoch() + 15, updated_at = unixepoch()
              WHERE id = ?`,
          )
          .bind(JSON.stringify({ email, pass: 2, runner: 'verifier' }), job.id)
          .run();
        continue;
      }

      // Pass 2 still UNKNOWN/RISKY: ZeroBounce gets the hardest cases only,
      // and only when its free-credit balance allows.
      const zb = await runZeroBounceCheck(env, email);
      if (zb) {
        await recordAttemptSuccess(db, { provider: 'zerobounce', target_type: 'verify', source_id: null });
        await logAttempt(db, {
          emailHash, pass: 3, provider: 'zerobounce', actorId: null,
          status: zb.status, reason: zb.reason,
        });
        await writeCache(db, {
          emailHash, domain, status: zb.status, provider: 'zerobounce', reason: zb.reason,
        });
      } else {
        // No ZeroBounce credential: the pass-2 verdict is the final answer.
        await writeCache(db, {
          emailHash, domain, status: mapped.status, provider: 'apify',
          reason: `${mapped.reason} (zerobounce unavailable)`,
        });
      }
      await complete(db, job.id, null);
    } catch (error) {
      // Technical failures (timeouts, HTTP errors, actor failures, no
      // claimable account) are provider problems, not email verdicts: the
      // circuit records them, the job is requeued with backoff, and nothing
      // is written to the cache. INVALID is never inferred from an error.
      const message = error instanceof Error ? error.message : String(error);
      const provider = message.startsWith('zerobounce') ? 'zerobounce' : 'apify';
      try {
        await recordAttemptFailure(db, { provider, target_type: 'verify', source_id: null });
      } catch {
        // Circuit bookkeeping must never fail the job twice.
      }
      await failJob(db, job, message.slice(0, 500), 'transient');
    }
  }

  return { processed };
}
