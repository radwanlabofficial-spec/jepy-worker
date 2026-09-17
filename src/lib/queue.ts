/**
 * The job queue and the circuit breaker — the engine's two moving parts.
 *
 * Claiming is ONE conditional UPDATE ... RETURNING (R6). Never "select then
 * update": between those two statements a second dispatcher tick can take the
 * same row, and both would then spend the same provider account. The plan calls
 * for a Durable Object so there is a single responsible instance; that arrives
 * with the router, and the atomicity of the claim does not depend on it — SQL is
 * doing the work either way.
 *
 * A circuit opens after three consecutive failures and closes after fifteen
 * minutes. There is no half-open state (R19): when the clock runs out it closes
 * outright and the next failure opens it again.
 *
 * Everything that counts is in D1, including counters. KV is a cache, and a
 * counter in a cache is a counter that loses.
 */

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_REOPEN_AFTER = 900;

/** Backoff between attempts, in seconds. Retry is a new row, never a silent loop. */
const BACKOFF_SECONDS = [60, 300, 900];

export interface EnqueueInput {
  jobType: string;
  targetType?: string | null;
  payload?: unknown;
  priority?: number;
  runAfter?: number | null;
}

export interface ClaimedJob {
  id: string;
  job_type: string;
  target_type: string | null;
  payload_json: string | null;
  attempts: number;
  max_attempts: number;
  hop_count: number;
}

export async function enqueue(db: D1Database, input: EnqueueInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO job_queue (id, job_type, target_type, payload_json, priority, status, run_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, unixepoch(), unixepoch())`,
    )
    .bind(
      id,
      input.jobType,
      input.targetType ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.priority ?? 5,
      input.runAfter ?? null,
    )
    .run();
  return id;
}

/**
 * Takes up to `limit` due jobs in one statement.
 *
 * The inner SELECT picks the rows; the outer UPDATE stamps them. Because it is a
 * single statement, two concurrent callers cannot both win the same row — the
 * second sees nothing left to take.
 */
export async function claim(db: D1Database, workerId: string, limit: number): Promise<ClaimedJob[]> {
  const result = await db
    .prepare(
      `UPDATE job_queue
          SET status = 'claimed', claimed_by = ?1, claimed_at = unixepoch(), updated_at = unixepoch()
        WHERE id IN (
          SELECT id FROM job_queue
           WHERE status = 'pending'
             AND (run_after IS NULL OR run_after <= unixepoch())
           ORDER BY priority DESC, created_at ASC
           LIMIT ?2
        )
      RETURNING id, job_type, target_type, payload_json, attempts, max_attempts, hop_count`,
    )
    .bind(workerId, limit)
    .all<ClaimedJob>();
  return (result.results ?? []) as ClaimedJob[];
}

export async function markRunning(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE job_queue SET status = 'running', updated_at = unixepoch() WHERE id = ?`)
    .bind(id)
    .run();
}

export async function complete(db: D1Database, id: string, resultRef: string | null): Promise<void> {
  await db
    .prepare(
      `UPDATE job_queue SET status = 'done', result_ref = ?, claimed_by = NULL, updated_at = unixepoch() WHERE id = ?`,
    )
    .bind(resultRef, id)
    .run();
}

export type FailureKind = 'transient' | 'permanent';

/**
 * Records a failure. A transient failure gets a backoff and stays pending until
 * it exhausts `max_attempts`; a permanent one either needs a human or is dead on
 * arrival. `needs_manual` exists as its own state so that "the machine gave up
 * and a person must look" is distinguishable from "it will try again".
 */
export async function fail(
  db: D1Database,
  job: { id: string; attempts: number; max_attempts: number },
  error: string,
  kind: FailureKind,
): Promise<{ status: string; run_after: number | null }> {
  const attempts = job.attempts + 1;

  if (kind === 'permanent') {
    await db
      .prepare(
        `UPDATE job_queue SET status = 'needs_manual', attempts = ?, last_error = ?, updated_at = unixepoch()
          WHERE id = ?`,
      )
      .bind(attempts, error.slice(0, 500), job.id)
      .run();
    return { status: 'needs_manual', run_after: null };
  }

  if (attempts >= job.max_attempts) {
    await db
      .prepare(
        `UPDATE job_queue SET status = 'dead', attempts = ?, last_error = ?, updated_at = unixepoch() WHERE id = ?`,
      )
      .bind(attempts, error.slice(0, 500), job.id)
      .run();
    return { status: 'dead', run_after: null };
  }

  const wait = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 900;
  const runAfter = Math.floor(Date.now() / 1000) + wait;
  await db
    .prepare(
      `UPDATE job_queue SET status = 'pending', attempts = ?, last_error = ?, claimed_by = NULL,
              claimed_at = NULL, run_after = ?, updated_at = unixepoch()
        WHERE id = ?`,
    )
    .bind(attempts, error.slice(0, 500), runAfter, job.id)
    .run();
  return { status: 'pending', run_after: runAfter };
}

/**
 * Returns jobs whose claimer died mid-flight. Without this a Worker restart
 * strands the row in `claimed` forever, and a queue that silently swallows work
 * is worse than one that fails loudly.
 */
export async function reclaimStale(db: D1Database, olderThanSeconds = 48 * 3600): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE job_queue
          SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = unixepoch()
        WHERE status IN ('claimed','running')
          AND claimed_at IS NOT NULL
          AND claimed_at < unixepoch() - ?`,
    )
    .bind(olderThanSeconds)
    .run();
  return result.meta.changes ?? 0;
}

export async function retry(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE job_queue SET status = 'pending', attempts = 0, run_after = NULL, last_error = NULL,
              claimed_by = NULL, claimed_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND status IN ('dead','failed','needs_manual')`,
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function cancel(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE job_queue SET status = 'dead', last_error = 'cancelled by operator', updated_at = unixepoch()
        WHERE id = ? AND status IN ('pending','claimed','running','needs_manual')`,
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function isCircuitOpen(db: D1Database, scope: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT state, opened_at, reopen_after FROM circuit_state WHERE scope_key = ?`,
    )
    .bind(scope)
    .first<{ state: string; opened_at: number | null; reopen_after: number }>();

  if (!row || row.state !== 'open') return false;

  // Lazy close: the state is only corrected when someone asks, which needs no
  // scheduled job and cannot drift, because the clock is the only input.
  const openedAt = row.opened_at ?? 0;
  if (openedAt + row.reopen_after <= Math.floor(Date.now() / 1000)) {
    await db
      .prepare(
        `UPDATE circuit_state SET state = 'closed', consecutive_failures = 0, updated_at = unixepoch()
          WHERE scope_key = ?`,
      )
      .bind(scope)
      .run();
    return false;
  }
  return true;
}

export async function recordFailure(db: D1Database, scope: string): Promise<{ opened: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO circuit_state (id, scope_key, state, consecutive_failures, updated_at)
       VALUES (?, ?, 'closed', 1, unixepoch())
       ON CONFLICT (scope_key) DO UPDATE SET
         consecutive_failures = circuit_state.consecutive_failures + 1,
         updated_at = unixepoch()`,
    )
    .bind(crypto.randomUUID(), scope)
    .run();

  const row = await db
    .prepare(`SELECT consecutive_failures FROM circuit_state WHERE scope_key = ?`)
    .bind(scope)
    .first<{ consecutive_failures: number }>();

  if ((row?.consecutive_failures ?? 0) >= CIRCUIT_THRESHOLD) {
    await db
      .prepare(
        `UPDATE circuit_state SET state = 'open', opened_at = ?, reopen_after = ?, updated_at = unixepoch()
          WHERE scope_key = ?`,
      )
      .bind(now, CIRCUIT_REOPEN_AFTER, scope)
      .run();
    return { opened: true };
  }
  return { opened: false };
}

export async function recordSuccess(db: D1Database, scope: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO circuit_state (id, scope_key, state, consecutive_failures, last_success_at, updated_at)
       VALUES (?, ?, 'closed', 0, unixepoch(), unixepoch())
       ON CONFLICT (scope_key) DO UPDATE SET
         state = 'closed', consecutive_failures = 0, last_success_at = unixepoch(), updated_at = unixepoch()`,
    )
    .bind(crypto.randomUUID(), scope)
    .run();
}
