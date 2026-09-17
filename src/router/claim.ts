/**
 * The atomic account claim, and the two logs that surround it.
 *
 * CLAIMING IS ONE STATEMENT. There is no `SELECT` first, and that is the entire
 * point: between a select and an update, a second dispatcher tick can read the
 * same row as free and both callers then spend the same account. The plan puts a
 * Durable Object in front of this so there is a single responsible instance, but
 * the SQL is what actually makes it safe — a DO is one instance per key, and a
 * key is not a lock on a row.
 *
 * Selection order is least-recently-used, which spreads the whole pool evenly
 * instead of draining one account to empty before touching the next. In SQLite
 * `ORDER BY last_used_at ASC` puts NULLs first, so an account that has never
 * been used is chosen before any account that has — which is the correct reading
 * of "least recently used" and needs no special case.
 *
 * The claim also increments the counters in the same statement. `SET x = x + 1`
 * is atomic in SQLite (R6); read-then-write is not, and a counter that can lose
 * an increment is a counter that lets the budget be exceeded.
 *
 * ROUTE ATTEMPTS ARE WRITTEN BEFORE THE CALL, NOT AFTER. The row goes in with
 * `outcome = NULL`, and the outcome is written when the adapter returns. Two
 * reasons, and the second is the important one:
 *
 *   - A crashed worker leaves a row with a NULL outcome rather than no row, so
 *     "it vanished" becomes "it started and never finished", which is a fact.
 *   - The in-flight count per account is then just a `COUNT(*) WHERE outcome IS
 *     NULL`, which is what the Apify per-account concurrency limit needs. A
 *     separate in-flight table would be a second source of truth for the same
 *     question.
 */

import type { Outcome } from './types';

/**
 * Per-provider concurrency ceilings. Only Apify has one in the documents
 * (09 §6: two actors per account). It lives here rather than in a column because
 * one provider needing it does not justify a schema change; if a second provider
 * needs one, this belongs in `provider_capability` as a column, not as a second
 * entry in a map.
 */
const MAX_CONCURRENCY: Record<string, number> = { apify: 2 };

export interface ClaimedAccount {
  id: string;
  account_label: string;
  provider: string;
  quota_used: number | null;
  quota_limit: number | null;
  daily_used: number | null;
  daily_limit: number | null;
}

/**
 * Claims one account for a provider, or returns null.
 *
 * A null return is not an error: it means every account for this provider is
 * cooling down, out of quota, disabled or busy. The router drops the candidate
 * and moves on without spending a hop, because nothing external was called.
 */
export async function claimAccount(
  db: D1Database,
  provider: string,
  now = Math.floor(Date.now() / 1000),
): Promise<ClaimedAccount | null> {
  const maxConcurrency = MAX_CONCURRENCY[provider] ?? null;

  const row = await db
    .prepare(
      `UPDATE provider_accounts
          SET last_used_at = ?1,
              quota_used = quota_used + 1,
              daily_used = daily_used + 1
        WHERE id = (
          SELECT id FROM provider_accounts AS candidate
           WHERE candidate.provider = ?2
             AND candidate.enabled = 1
             AND candidate.status = 'active'
             AND (candidate.cooldown_until IS NULL OR candidate.cooldown_until <= ?1)
             AND (candidate.quota_expires_at IS NULL OR candidate.quota_expires_at > ?1)
             AND (candidate.daily_limit IS NULL OR candidate.daily_used < candidate.daily_limit)
             AND (candidate.quota_limit IS NULL OR candidate.quota_limit <= 0
                  OR candidate.quota_used < candidate.quota_limit)
             AND NOT EXISTS (
                   SELECT 1 FROM quota_counters AS qc
                    WHERE qc.provider = candidate.provider
                      AND qc.account_label = candidate.account_label
                      AND qc.limit_value IS NOT NULL
                      AND qc.used >= qc.limit_value
                 )
             AND (?3 IS NULL OR (
                   SELECT COUNT(*) FROM route_attempts AS ra
                    WHERE ra.provider = candidate.provider
                      AND ra.account_label = candidate.account_label
                      AND ra.outcome IS NULL
                 ) < ?3)
           ORDER BY candidate.last_used_at ASC, candidate.priority ASC, candidate.account_label ASC
           LIMIT 1
        )
        RETURNING id, account_label, provider, quota_used, quota_limit, daily_used, daily_limit`,
    )
    .bind(now, provider, maxConcurrency)
    .first<ClaimedAccount>();

  return row ?? null;
}

export interface AttemptInput {
  job_id: string;
  hop: number;
  target_type: string | null;
  provider: string;
  account_label: string | null;
  adapter: string;
  source_id: string | null;
  pack_version: number | null;
  circuit_scope: string | null;
  score: number | null;
  note: string | null;
}

/** Opens an attempt row. Written before the external call, deliberately. */
export async function openAttempt(db: D1Database, input: AttemptInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO route_attempts
         (id, job_id, hop, target_type, provider, account_label, adapter, source_id,
          pack_version, circuit_scope, score, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    )
    .bind(
      id,
      input.job_id,
      input.hop,
      input.target_type,
      input.provider,
      input.account_label,
      input.adapter,
      input.source_id,
      input.pack_version,
      input.circuit_scope,
      input.score,
      input.note,
    )
    .run();
  return id;
}

export interface AttemptResult {
  outcome: Outcome;
  http_status: number | null;
  records_count: number;
  unit_type: string | null;
  units: number;
  cost_micro: number;
  latency_ms: number;
  error_text: string | null;
}

export async function closeAttempt(
  db: D1Database,
  attemptId: string,
  result: AttemptResult,
): Promise<void> {
  await db
    .prepare(
      `UPDATE route_attempts
          SET outcome = ?, http_status = ?, records_count = ?, unit_type = ?,
              units = ?, cost_micro = ?, latency_ms = ?, error_text = ?
        WHERE id = ?`,
    )
    .bind(
      result.outcome,
      result.http_status,
      result.records_count,
      result.unit_type,
      result.units,
      result.cost_micro,
      result.latency_ms,
      result.error_text,
      attemptId,
    )
    .run();
}

/**
 * Account state transitions from the 09 §7 table.
 *
 * `quotaUsedBack` matters: a call that never left the building — a 401, or a
 * refusal to dispatch — must not leave the counter incremented, or the account
 * will drift toward its ceiling at the rate of our own mistakes.
 */
export async function setAccountState(
  db: D1Database,
  accountId: string,
  state: {
    status?: 'active' | 'invalid' | 'rate_limited' | 'exhausted' | 'disabled';
    enabled?: 0 | 1;
    cooldownUntil?: number | null;
    resetFailureStreak?: boolean;
    quotaUsedBack?: boolean;
    lastOkAt?: boolean;
  },
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (state.status !== undefined) {
    sets.push('status = ?');
    binds.push(state.status);
  }
  if (state.enabled !== undefined) {
    sets.push('enabled = ?');
    binds.push(state.enabled);
  }
  if (state.cooldownUntil !== undefined) {
    sets.push('cooldown_until = ?');
    binds.push(state.cooldownUntil);
  }
  if (state.resetFailureStreak) {
    sets.push('consecutive_errors = 0');
  }
  if (state.quotaUsedBack) {
    sets.push('quota_used = MAX(quota_used - 1, 0)', 'daily_used = MAX(daily_used - 1, 0)');
  }
  void now;

  if (sets.length === 0) return;
  binds.push(accountId);

  await db
    .prepare(`UPDATE provider_accounts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/** The success half of the §7 table. */
export async function markAccountUsed(
  db: D1Database,
  accountId: string,
  latencyMs: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE provider_accounts
          SET status = 'active', cooldown_until = NULL, consecutive_errors = 0
        WHERE id = ?`,
    )
    .bind(accountId)
    .run();
  void latencyMs;
}

/** Records one failure against an account and returns the new streak. */
export async function bumpAccountFailure(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE provider_accounts
          SET consecutive_errors = consecutive_errors + 1
        WHERE id = ?
        RETURNING consecutive_errors`,
    )
    .bind(accountId)
    .first<{ consecutive_errors: number }>();
  return row?.consecutive_errors ?? 0;
}
