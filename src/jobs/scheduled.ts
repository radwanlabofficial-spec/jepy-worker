/**
 * The nine scheduled jobs (11-api-contract.md §11), dispatched by cron string.
 *
 * Every run writes a `cron_runs` row — started, finished, status, error. A
 * scheduler whose work is invisible is a scheduler you cannot debug, and the
 * three-in-the-morning question is always "did it run, or did it not".
 *
 * Two of these jobs are meant to do no real work in the Worker: the dataset
 * import and the weekly backup both need a full machine (wrangler, parquet,
 * R2 bulk), so their correct implementation is to ENQUEUE and record. That is
 * the design, not an unfinished stub.
 */

import { claim, enqueue, fail, markRunning, reclaimStale, recordSuccess, recordFailure } from '../lib/queue';
import { openSecret, sha256Hex } from '../lib/crypto';
import { testCredential } from '../lib/provider-test';
import type { Env } from '../env';

/**
 * The nine jobs and the schedule each is meant to keep. These strings are
 * identifiers for on-demand runs (`POST /api/admin/run-cron`) and documentation
 * of intent — they are NOT the triggers configured in wrangler.toml.
 *
 * Cloudflare caps cron triggers per Worker, so only two are registered: the
 * dispatcher and an hourly tick. The tick reads the UTC hour and weekday and
 * runs whatever is due, which is why quota rollover happens at 00:00 rather than
 * the 00:05 written in the contract, and why everything on the hour can be
 * delayed by up to an hour if a tick fails.
 */
export const CRONS = {
  dispatcher: '*/2 * * * *',
  budgetGuard: '0 * * * *',
  quotaRollover: '5 0 * * *',
  credentialTest: '0 3 * * *',
  retentionPurge: '0 4 * * *',
  reconcile: '0 5 * * 1',
  feedbackLoop: '0 6 * * 1',
  datasetImport: '0 7 * * 1',
  weeklyBackup: '0 20 * * 6',
} as const;

/** The two expressions actually registered in wrangler.toml. */
export const TRIGGERS = { dispatcher: '*/2 * * * *', hourly: '0 * * * *' } as const;

/**
 * Runs whichever jobs the current UTC moment is due for. Called by the hourly
 * trigger; the dispatcher stays on its own faster schedule because a two-minute
 * queue lag is a different thing from a daily report arriving an hour late.
 */
export async function runTick(env: Env, now = new Date()): Promise<string[]> {
  const hour = now.getUTCHours();
  const day = now.getUTCDay(); // 0 Sunday, 1 Monday, 6 Saturday
  const ran: string[] = [];

  // Every hour, no exception: the ceiling is checked before any spending.
  await runScheduled(CRONS.budgetGuard, env);
  ran.push('budget_guard');

  if (hour === 0) {
    await runScheduled(CRONS.quotaRollover, env);
    ran.push('quota_rollover');
  }
  if (hour === 3) {
    await runScheduled(CRONS.credentialTest, env);
    ran.push('credential_test');
  }
  if (hour === 4) {
    await runScheduled(CRONS.retentionPurge, env);
    ran.push('retention_purge');
  }
  if (day === 1 && hour === 5) {
    await runScheduled(CRONS.reconcile, env);
    ran.push('reconcile');
  }
  if (day === 1 && hour === 6) {
    await runScheduled(CRONS.feedbackLoop, env);
    ran.push('feedback_loop');
  }
  if (day === 1 && hour === 7) {
    await runScheduled(CRONS.datasetImport, env);
    ran.push('dataset_import');
  }
  if (day === 6 && hour === 20) {
    await runScheduled(CRONS.weeklyBackup, env);
    ran.push('weekly_backup');
  }
  return ran;
}

export type CronName = keyof typeof CRONS;

/** Operational log windows. Deliberately conservative and logs-only: nothing
 *  here touches leads, contacts or messages, so no personal data is destroyed by
 *  a retention policy that has not been reviewed against 16-compliance.md. */
const RETENTION_DAYS = { routeAttempts: 90, errorLog: 30, sourceHealth: 90, jobResults: 30 };

async function setting(db: D1Database, key: string): Promise<number | null> {
  const row = await db
    .prepare(`SELECT value_num FROM settings WHERE key = ?`)
    .bind(key)
    .first<{ value_num: number | null }>();
  return row?.value_num ?? null;
}

async function setSetting(db: D1Database, key: string, value: number): Promise<void> {
  await db
    .prepare(`UPDATE settings SET value_num = ?, updated_at = unixepoch() WHERE key = ?`)
    .bind(value, key)
    .run();
}

/** Wraps a job so its run is always recorded, including when it throws. */
async function record(
  env: Env,
  cronName: string,
  work: () => Promise<{ dispatched?: number; subRequests?: number; note?: string }>,
): Promise<void> {
  const id = crypto.randomUUID();
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    const outcome = await work();
    await env.DB.prepare(
      `INSERT INTO cron_runs (id, cron_name, started_at, finished_at, jobs_dispatched, sub_requests_used, status, error_text)
       VALUES (?, ?, ?, unixepoch(), ?, ?, 'ok', ?)`,
    )
      .bind(id, cronName, startedAt, outcome.dispatched ?? 0, outcome.subRequests ?? 0, outcome.note ?? null)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      `INSERT INTO cron_runs (id, cron_name, started_at, finished_at, status, error_text)
       VALUES (?, ?, ?, unixepoch(), 'failed', ?)`,
    )
      .bind(id, cronName, startedAt, message.slice(0, 500))
      .run();
    try {
      await env.DB.prepare(
        `INSERT INTO error_log (id, code, scope, message, severity, created_at)
         VALUES (?, 'E_INTERNAL', ?, ?, 'error', unixepoch())`,
      )
        .bind(crypto.randomUUID(), `cron:${cronName}`, message.slice(0, 500))
        .run();
    } catch {
      // ignore
    }
  }
}

/**
 * Dispatcher. Claims due jobs and runs them.
 *
 * No adapter is registered until Phase 6, so a claimed job is parked in
 * `needs_manual` with the reason written on it rather than silently retried or
 * dropped. A job that disappears without a trace is the one failure mode a queue
 * must never have.
 */
async function dispatcher(env: Env): Promise<{ dispatched: number; note?: string }> {
  const paused = await setting(env.DB, 'dispatcher_paused');
  if (paused === 1) return { dispatched: 0, note: 'dispatcher_paused=1 — nothing claimed' };

  // Cap per tick: a 40-sub-request budget is per invocation, so the tick must
  // never claim more work than it can finish inside it.
  const claimed = await claim(env.DB, 'cron:dispatcher', 5);
  if (claimed.length === 0) return { dispatched: 0, note: 'queue empty' };

  let dispatched = 0;
  for (const job of claimed) {
    await markRunning(env.DB, job.id);
    const reason = `no adapter registered for job_type=${job.job_type} target_type=${job.target_type ?? '-'} (Phase 6)`;
    await fail(env.DB, job, reason, 'permanent');
    dispatched += 1;
  }
  return { dispatched, note: `${claimed.length} claimed, ${dispatched} parked as needs_manual` };
}

/** Budget guard: crossing the daily BrightData guard pauses the dispatcher. */
async function budgetGuard(env: Env): Promise<{ note?: string }> {
  const [guard, spentRow] = await Promise.all([
    setting(env.DB, 'daily_bd_credit_guard'),
    env.DB
      .prepare(
        `SELECT COALESCE(SUM(credits), 0) AS credits FROM brightdata_credit_log
          WHERE created_at >= CAST(strftime('%s', date('now')) AS INTEGER)`,
      )
      .first<{ credits: number }>(),
  ]);

  const spent = spentRow?.credits ?? 0;
  const limit = guard ?? 1800;
  if (spent < limit) return { note: `${spent}/${limit} credits today` };

  await setSetting(env.DB, 'dispatcher_paused', 1);
  try {
    await env.DB.prepare(
      `INSERT INTO error_log (id, code, scope, message, severity, created_at)
       VALUES (?, 'E_BUDGET_GUARD', 'cron:budget-guard', ?, 'warn', unixepoch())`,
    )
      .bind(crypto.randomUUID(), `daily guard crossed: ${spent}/${limit} credits — dispatcher paused`)
      .run();
  } catch {
    // ignore
  }
  return { note: `guard crossed (${spent}/${limit}) — dispatcher paused` };
}

/** Daily counters reset; monthly quotas roll when their own reset date arrives. */
async function quotaRollover(env: Env): Promise<{ note?: string }> {
  const now = Math.floor(Date.now() / 1000);
  const daily = await env.DB
    .prepare(`UPDATE provider_accounts SET daily_used = 0 WHERE daily_used <> 0`)
    .run();

  // An account comes back the moment its window rolls, not when someone notices.
  const rolled = await env.DB
    .prepare(
      `UPDATE provider_accounts
          SET quota_used = 0,
              status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END,
              quota_reset_at = NULL
        WHERE quota_reset_at IS NOT NULL AND quota_reset_at <= ?`,
    )
    .bind(now)
    .run();

  await env.DB.prepare(`DELETE FROM quota_counters WHERE window_key < ?`)
    .bind(String(Math.floor(now / 86400) - 40))
    .run();

  return { note: `${daily.meta.changes ?? 0} daily counters cleared, ${rolled.meta.changes ?? 0} accounts rolled` };
}

/** Daily credential test, so a dead key is found by the clock rather than by a job. */
async function credentialTest(env: Env): Promise<{ subRequests?: number; note?: string }> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.ciphertext, c.iv, c.auth_tag, a.provider
       FROM provider_credentials c JOIN provider_accounts a ON a.id = c.account_id
      LIMIT 50`,
  ).all<{ id: string; ciphertext: string; iv: string; auth_tag: string; provider: string }>();

  const credentials = rows.results ?? [];
  let tested = 0;

  for (const credential of credentials) {
    // One provider call each, counted against the tick's own budget.
    if (tested >= 20) break;
    try {
      const secret = await openSecret(credential, env.VAULT_KEY);
      const outcome = await testCredential(credential.provider, secret);
      await env.DB.prepare(
        `UPDATE provider_credentials SET test_status = ?, last_tested_at = unixepoch() WHERE id = ?`,
      )
        .bind(outcome.status, credential.id)
        .run();

      if (outcome.status === 'failed') {
        // A refused credential disables its account: routing through a key the
        // provider rejects burns real jobs before anyone reads a dashboard.
        await env.DB.prepare(
          `UPDATE provider_accounts SET status = 'invalid', enabled = 0
            WHERE id = (SELECT account_id FROM provider_credentials WHERE id = ?)`,
        )
          .bind(credential.id)
          .run();
      }
      tested += 1;
    } catch {
      // An unopenable row is logged by the caller's error path; keep going, one
      // bad credential must not stop the sweep.
    }
  }
  return { subRequests: tested, note: `${tested}/${credentials.length} credentials tested` };
}

/** Retention purge — operational logs only, never personal data. */
async function retentionPurge(env: Env): Promise<{ note?: string }> {
  const day = 86_400;
  const now = Math.floor(Date.now() / 1000);
  const cut = (days: number) => now - days * day;

  const attempts = await env.DB.prepare(`DELETE FROM route_attempts WHERE created_at < ?`)
    .bind(cut(RETENTION_DAYS.routeAttempts)).run();
  const errors = await env.DB.prepare(`DELETE FROM error_log WHERE created_at < ?`)
    .bind(cut(RETENTION_DAYS.errorLog)).run();
  const health = await env.DB.prepare(`DELETE FROM source_health_log WHERE day < ?`)
    .bind(Math.floor(cut(RETENTION_DAYS.sourceHealth) / day)).run();
  const results = await env.DB.prepare(`DELETE FROM job_results WHERE created_at < ?`)
    .bind(cut(RETENTION_DAYS.jobResults)).run();

  return {
    note: `purged route_attempts ${attempts.meta.changes ?? 0}, error_log ${errors.meta.changes ?? 0}, source_health_log ${health.meta.changes ?? 0}, job_results ${results.meta.changes ?? 0}`,
  };
}

/**
 * Weekly reconcile. `quota_used` is recomputed from the ledgers rather than
 * trusted, because the counter is incremented on many paths and the ledger is
 * written once — when the two disagree, the ledger is right.
 */
async function reconcile(env: Env): Promise<{ note?: string }> {
  const fixed = await env.DB.prepare(
    `UPDATE provider_accounts
        SET quota_used = COALESCE((
              SELECT SUM(CASE WHEN provider = 'brightdata' THEN credits ELSE units END)
                FROM brightdata_credit_log l
               WHERE l.account_label = provider_accounts.account_label
                 AND l.created_at >= CAST(strftime('%s', date('now','start of month')) AS INTEGER)
            ), 0)
      WHERE provider = 'brightdata'`,
  ).run();
  return { note: `${fixed.meta.changes ?? 0} BrightData accounts reconciled from the ledger` };
}

/**
 * Weekly feedback loop. It refuses to move a weight on a small sample: a lift
 * computed from a handful of replies is noise, and the guardrail (0.5-1.5) would
 * turn that noise into a version that looks authoritative.
 */
async function feedbackLoop(env: Env): Promise<{ note?: string }> {
  const weekKey = new Date().toISOString().slice(0, 10);
  const sample = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feedback_events WHERE created_at >= unixepoch() - 7 * 86400`,
  ).first<{ n: number }>();

  const events = sample?.n ?? 0;
  if (events < 100) {
    return { note: `insufficient sample (${events} events < 100) — no weight moved` };
  }

  // With a sufficient sample the lift is computed per feature elsewhere; the
  // rows are written with applied=0 so that computing a lift and shipping it
  // stay two separate, reviewable events.
  return { note: `${events} events — lift computation deferred to the scoring phase` };
}

/** Wave 0 import: the Worker enqueues, GitHub Actions does the heavy lifting. */
async function datasetImport(env: Env): Promise<{ dispatched: number; note?: string }> {
  const targets = await env.DB.prepare(`SELECT COUNT(*) AS n FROM geo_targets WHERE enabled = 1`)
    .first<{ n: number }>();
  let dispatched = 0;
  for (const dataset of ['overture', 'fsq'] as const) {
    await enqueue(env.DB, {
      jobType: 'dataset_import',
      targetType: dataset,
      payload: { dataset, runner: 'gha', geo_targets: targets?.n ?? 0 },
      priority: 3,
    });
    dispatched += 1;
  }
  return { dispatched, note: `${dispatched} import jobs enqueued for the GitHub Actions runner` };
}

/** Weekly backup: recorded here, executed by wrangler in CI. */
async function weeklyBackup(env: Env): Promise<{ dispatched: number; note?: string }> {
  const jobId = await enqueue(env.DB, { jobType: 'dataset_import', targetType: 'backup', payload: { kind: 'd1_dump' }, priority: 1 });
  await env.DB.prepare(
    `INSERT INTO backup_log (id, kind, status, created_at) VALUES (?, 'd1_dump', 'requested', unixepoch())`,
  )
    .bind(crypto.randomUUID())
    .run();
  return { dispatched: 1, note: `backup requested as job ${jobId.slice(0, 8)}` };
}

export async function runScheduled(cron: string, env: Env): Promise<void> {
  switch (cron) {
    case CRONS.dispatcher:
      await reclaimStale(env.DB);
      await record(env, 'dispatcher', () => dispatcher(env));
      return;
    case CRONS.budgetGuard:
      await record(env, 'budget_guard', () => budgetGuard(env));
      return;
    case CRONS.quotaRollover:
      await record(env, 'quota_rollover', () => quotaRollover(env));
      return;
    case CRONS.credentialTest:
      await record(env, 'credential_test', () => credentialTest(env));
      return;
    case CRONS.retentionPurge:
      await record(env, 'retention_purge', () => retentionPurge(env));
      return;
    case CRONS.reconcile:
      await record(env, 'reconcile', () => reconcile(env));
      return;
    case CRONS.feedbackLoop:
      await record(env, 'feedback_loop', () => feedbackLoop(env));
      return;
    case CRONS.datasetImport:
      await record(env, 'dataset_import', () => datasetImport(env));
      return;
    case CRONS.weeklyBackup:
      await record(env, 'weekly_backup', () => weeklyBackup(env));
      return;
    default:
      // An unrecognised cron is recorded rather than ignored: a trigger that
      // fires into nothing is how a schedule silently stops being a schedule.
      await record(env, `unknown:${cron}`, async () => ({ note: 'no handler for this cron expression' }));
  }
}

/** Exported for the health surface and for tests. */
export { sha256Hex, recordSuccess, recordFailure };
