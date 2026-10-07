/**
 * Apify async run pattern for Wave 2 buying signals.
 *
 * PROBLEM: `run-sync-get-dataset-items` blocks until the actor finishes.
 * Free-plan actors take 2-5 minutes; Cloudflare's edge times out at ~100s
 * (HTTP 524), killing the worker's subrequest even though the actor is
 * still running fine on Apify's side.
 *
 * SOLUTION: Split into three phases:
 *
 *   1. START:  POST /v2/acts/{actor}/runs  → returns { id, defaultDatasetId }
 *             (responds in <2s, well under the edge timeout)
 *   2. POLL:   GET /v2/actor-runs/{runId}   → status: RUNNING → SUCCEEDED
 *             (cheap, fast, safe to call from a cron or repeated endpoint hit)
 *   3. FETCH:  GET /v2/datasets/{datasetId}/items → the actual records
 *
 * Run state lives in D1 (`apify_runs` table) so any worker invocation can
 * pick up where the last one left off — no in-memory state, no lost runs
 * when the edge kills a long request.
 */
import { apiJsonAdapter } from '../../adapters/api_json';
import type { AdapterInvocation } from '../../adapters/shared';
import { openSecret } from '../../lib/crypto';
import { DEFAULT_ACTORS, hiringRunConfig, adsRunConfig, fundingRunConfig, type ApifyRunConfig } from './apify';
import { normalizeBuyingSignals, type ActorKind, type RawActorRecord, type SignalWrite } from './index';

export interface ApifyRunRecord {
  id: string;
  lead_id: string;
  family: ActorKind;
  actor: string;
  apify_run_id: string | null;
  dataset_id: string | null;
  status: 'started' | 'running' | 'succeeded' | 'failed' | 'timeout';
  started_at: number;
  updated_at: number;
  error: string | null;
  signals_written: number;
}

const CONFIGS: Record<ActorKind, (company: string) => ApifyRunConfig> = {
  hiring: (c) => hiringRunConfig(c),
  ads: (c) => adsRunConfig(c),
  funding: (c) => fundingRunConfig(c),
};

/** Resolve the least-used Apify account label. */
async function pickApifyAccount(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT account_label FROM provider_accounts WHERE provider = 'apify'
       ORDER BY account_label LIMIT 1`,
    )
    .first<{ account_label: string }>();
  return row?.account_label ?? null;
}

function makeInvocation(
  db: D1Database,
  env: { VAULT_KEY: string },
  accountId: string,
  accountLabel: string,
  url: string,
  method: string,
  jsonBody: Record<string, unknown> | undefined,
  timeoutMs: number,
  recordsPath = '',
): AdapterInvocation {
  const resolveCredential = async (): Promise<string | null> => {
    const row = await db
      .prepare(
        `SELECT ciphertext, iv, auth_tag FROM provider_credentials
          WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(accountId)
      .first<{ ciphertext: string; iv: string; auth_tag: string }>();
    if (!row) return null;
    try {
      return await openSecret(row, env.VAULT_KEY);
    } catch {
      return null;
    }
  };
  return {
    input: { url, method, auth_query: 'token', json_body: jsonBody },
    source: { url_template: url, selector_json: JSON.stringify({ records_path: recordsPath }) },
    credential_ref: { credential_id: accountId, provider: 'apify', account_label: accountLabel },
    budget: { deadline_ms: Date.now() + timeoutMs },
    resolveCredential,
  } as unknown as AdapterInvocation;
}

/**
 * START phase: launch Apify actor runs for a lead, one per family.
 * Returns quickly (<5s) with run IDs. Results come later via pollApifyRuns.
 */
export async function startApifyRuns(
  db: D1Database,
  env: { VAULT_KEY: string },
  leadId: string,
  families: ActorKind[] = ['hiring', 'ads', 'funding'],
): Promise<{ started: ApifyRunRecord[]; errors: string[] }> {
  const lead = await db
    .prepare(`SELECT id, name FROM leads WHERE id = ? AND deleted_at IS NULL`)
    .bind(leadId)
    .first<{ id: string; name: string | null }>();
  if (!lead || !lead.name) {
    return { started: [], errors: ['lead not found or has no name'] };
  }
  const company = lead.name;

  const accountLabel = await pickApifyAccount(db);
  if (!accountLabel) return { started: [], errors: ['no apify account'] };
  const account = await db
    .prepare(`SELECT id FROM provider_accounts WHERE provider = 'apify' AND account_label = ?`)
    .bind(accountLabel)
    .first<{ id: string }>();
  if (!account) return { started: [], errors: ['apify account row missing'] };

  const started: ApifyRunRecord[] = [];
  const errors: string[] = [];
  const now = Date.now();

  for (const family of families) {
    const actorId = (DEFAULT_ACTORS as Record<string, string>)[family];
    if (!actorId) {
      errors.push(`${family}: unknown actor`);
      continue;
    }
    const config = CONFIGS[family](company);
    // Convert sync URL to async: /acts/{actor}/runs
    const runUrl = `https://api.apify.com/v2/acts/${actorId.replace('/', '~')}/runs?token={token}`;
    const invocation = makeInvocation(
      db, env, account.id, accountLabel, runUrl, 'POST',
      config.input.json_body as Record<string, unknown>, 30_000,
      'data', // Apify wraps run objects in { data: {...} }
    );
    try {
      const outcome = await apiJsonAdapter.run(invocation);
      if (outcome.outcome !== 'success' && outcome.outcome !== 'empty') {
        errors.push(`${family}: ${outcome.error_code ?? outcome.outcome}`);
        continue;
      }
      // records[0] is the run object: { id, defaultDatasetId, ... }
      const runObj = (outcome.records?.[0] ?? {}) as { id?: string; defaultDatasetId?: string };
      const runId = typeof runObj.id === 'string' ? runObj.id : null;
      const datasetId = typeof runObj.defaultDatasetId === 'string' ? runObj.defaultDatasetId : null;
      const id = crypto.randomUUID();
      const record: ApifyRunRecord = {
        id, lead_id: leadId, family, actor: actorId,
        apify_run_id: runId, dataset_id: datasetId,
        status: runId ? 'started' : 'failed',
        started_at: now, updated_at: now,
        error: runId ? null : 'no run id in response',
        signals_written: 0,
      };
      await db.prepare(
        `INSERT INTO apify_runs (id, lead_id, family, actor, apify_run_id, dataset_id,
          status, started_at, updated_at, error, signals_written)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, leadId, family, actorId, runId, datasetId, record.status, now, now, record.error, 0).run();
      started.push(record);
    } catch (e) {
      errors.push(`${family}: ${e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150)}`);
    }
  }
  return { started, errors };
}

/**
 * POLL phase: check all pending runs, fetch completed ones, write signals.
 * Fast and idempotent — safe to call every few minutes from a cron.
 */
export async function pollApifyRuns(
  db: D1Database,
  env: { VAULT_KEY: string },
): Promise<{ checked: number; completed: number; signals_written: number; errors: string[] }> {
  const pending = await db
    .prepare(
      `SELECT * FROM apify_runs WHERE status IN ('started', 'running')
       ORDER BY updated_at ASC LIMIT 20`,
    )
    .all<ApifyRunRecord>();

  const accountLabel = await pickApifyAccount(db);
  const account = accountLabel
    ? await db.prepare(`SELECT id FROM provider_accounts WHERE provider = 'apify' AND account_label = ?`)
        .bind(accountLabel).first<{ id: string }>()
    : null;

  let completed = 0;
  let signalsWritten = 0;
  const errors: string[] = [];
  const now = Date.now();

  for (const run of pending.results ?? []) {
    if (!run.apify_run_id || !account || !accountLabel) {
      await db.prepare(`UPDATE apify_runs SET status = 'failed', error = 'missing run id or account', updated_at = ? WHERE id = ?`)
        .bind(now, run.id).run();
      continue;
    }
    try {
      // 1. Check run status
      const statusUrl = `https://api.apify.com/v2/actor-runs/${run.apify_run_id}?token={token}`;
      const statusInv = makeInvocation(db, env, account.id, accountLabel, statusUrl, 'GET', undefined, 20_000, 'data');
      const statusOut = await apiJsonAdapter.run(statusInv);
      if (statusOut.outcome !== 'success' && statusOut.outcome !== 'empty') {
        errors.push(`${run.family}: status check ${statusOut.error_code}`);
        continue;
      }
      const statusObj = (statusOut.records?.[0] ?? {}) as { status?: string };
      const apifyStatus = statusObj.status ?? 'UNKNOWN';

      if (apifyStatus === 'RUNNING' || apifyStatus === 'READY') {
        await db.prepare(`UPDATE apify_runs SET status = 'running', updated_at = ? WHERE id = ?`)
          .bind(now, run.id).run();
        continue;
      }
      if (apifyStatus !== 'SUCCEEDED') {
        await db.prepare(`UPDATE apify_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
          .bind(`apify status: ${apifyStatus}`, now, run.id).run();
        errors.push(`${run.family}: apify ${apifyStatus}`);
        continue;
      }

      // 2. Fetch dataset items
      const datasetId = run.dataset_id;
      if (!datasetId) {
        await db.prepare(`UPDATE apify_runs SET status = 'failed', error = 'no dataset id', updated_at = ? WHERE id = ?`)
          .bind(now, run.id).run();
        continue;
      }
      const itemsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token={token}&clean=true&limit=100`;
      const itemsInv = makeInvocation(db, env, account.id, accountLabel, itemsUrl, 'GET', undefined, 30_000);
      const itemsOut = await apiJsonAdapter.run(itemsInv);
      if (itemsOut.outcome !== 'success' || !Array.isArray(itemsOut.records)) {
        await db.prepare(`UPDATE apify_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
          .bind(`fetch: ${itemsOut.error_code ?? 'no records'}`, now, run.id).run();
        continue;
      }

      // 3. Normalize and write signals
      const lead = await db.prepare(`SELECT name FROM leads WHERE id = ?`).bind(run.lead_id)
        .first<{ name: string | null }>();
      const company = lead?.name ?? '';
      const signals = normalizeBuyingSignals(run.family, itemsOut.records as RawActorRecord[], company);
      let written = 0;
      if (signals.length > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        const stmts = signals.map((s: SignalWrite) =>
          db.prepare(
            `INSERT INTO lead_signals
               (id, lead_id, signal_key, signal_value_num, signal_value_text,
                confidence, collected_at, expires_at, source_provider)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (lead_id, signal_key) DO UPDATE SET
               signal_value_num  = excluded.signal_value_num,
               signal_value_text = excluded.signal_value_text,
               confidence        = excluded.confidence,
               collected_at      = excluded.collected_at,
               expires_at        = excluded.expires_at,
               source_provider   = excluded.source_provider`,
          ).bind(
            crypto.randomUUID(), run.lead_id, s.signal_key,
            s.signal_value_num, s.signal_value_text,
            0.7, nowSec, s.expires_at, 'apify',
          ),
        );
        await db.batch(stmts);
        written = signals.length;
      }
      await db.prepare(
        `UPDATE apify_runs SET status = 'succeeded', signals_written = ?, updated_at = ? WHERE id = ?`,
      ).bind(written, now, run.id).run();
      completed++;
      signalsWritten += written;
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      errors.push(`${run.family}: ${msg}`);
    }
  }

  return { checked: (pending.results ?? []).length, completed, signals_written: signalsWritten, errors };
}
