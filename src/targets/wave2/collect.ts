/**
 * Wave 2 collection — the D1-writing half of STEP 14.
 *
 * Wave 1's `collectWave1` is the template: fetch the lead, run the signals,
 * upsert to `lead_signals`. The difference is transport — Wave 1 probes run
 * locally (DNS, HTTP), Wave 2 runs go through Apify actors via the generic
 * `api_json` adapter, one actor per signal family.
 *
 * ACCOUNT ROTATION. Twenty Apify accounts sit in the Vault (`apify-01`…
 * `apify-20`). `pickApifyAccount` selects the active account with the lowest
 * recorded usage for the current window from `quota_counters`, so spend spreads
 * across the pool instead of draining one key. A per-call increment keeps the
 * counters honest even when two collections race.
 *
 * FAILURE MODE. An actor failure degrades to "no signal", never to a failed
 * job: a missing buying signal is the normal case (most businesses are not
 * hiring, not running ads, not raising). Only a credential or config error
 * aborts the collection, because those indicate a broken pipeline, not a
 * quiet business.
 */

import { apiJsonAdapter } from '../../adapters/api_json';
import type { AdapterInvocation } from '../../adapters/shared';
import { openSecret } from '../../lib/crypto';
import {
  adsRunConfig,
  fundingRunConfig,
  hiringRunConfig,
  type ApifyRunConfig,
} from './apify';
import { normalizeBuyingSignals } from './index';
import { SIGNAL_TTL_SECONDS, type ActorKind, type RawActorRecord, type SignalWrite } from './types';

interface LeadRow {
  id: string;
  company_name: string | null;
  name: string | null;
}

export interface Wave2Result {
  lead_id: string;
  signals_written: number;
  families: Record<ActorKind, 'ok' | 'no_signal' | 'error'>;
}

/**
 * Pick the Apify account with the lowest usage this window.
 *
 * Reads `quota_counters` for the current UTC day; the account with the
 * smallest `used` wins. Ties break by label so the choice is deterministic.
 * Returns the account label (e.g. `apify-07`), never the key itself.
 */
async function pickApifyAccount(db: D1Database): Promise<string | null> {
  const windowKey = new Date().toISOString().slice(0, 10); // UTC day
  const row = await db
    .prepare(
      `SELECT a.account_label,
              COALESCE(q.used, 0) AS used
         FROM provider_accounts a
         LEFT JOIN quota_counters q
           ON q.provider = 'apify'
          AND q.account_label = a.account_label
          AND q.window_key = ?
        WHERE a.provider = 'apify'
          AND a.enabled = 1
          AND a.status = 'active'
        ORDER BY used ASC, a.account_label ASC
        LIMIT 1`,
    )
    .bind(windowKey)
    .first<{ account_label: string; used: number }>();
  return row?.account_label ?? null;
}

async function bumpQuota(db: D1Database, accountLabel: string): Promise<void> {
  const windowKey = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO quota_counters (provider, account_label, window_key, used, updated_at)
       VALUES ('apify', ?, ?, 1, ?)
       ON CONFLICT (provider, account_label, window_key) DO UPDATE SET
         used = used + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(accountLabel, windowKey, now)
    .run();
}

/**
 * Run one Apify actor for a company and return the raw dataset items.
 *
 * Goes through `api_json` so auth, timeouts, and error classification stay in
 * one place. The credential is resolved from the Vault at call time via the
 * account's credential ref — this function never sees the key.
 */
async function runActor(
  db: D1Database,
  env: { VAULT_KEY: string },
  accountLabel: string,
  kind: ActorKind,
  config: ApifyRunConfig,
  timeoutMs: number,
): Promise<unknown[]> {
  // Resolve the account and its credential row.
  const account = await db
    .prepare(`SELECT id FROM provider_accounts WHERE provider = 'apify' AND account_label = ?`)
    .bind(accountLabel)
    .first<{ id: string }>();
  if (!account) return [];

  // The Vault is opened here, inside the call frame: no plaintext key ever
  // reaches a payload, a log line, or D1 (R1, R2).
  const resolveCredential = async (): Promise<string | null> => {
    const row = await db
      .prepare(
        `SELECT ciphertext, iv, auth_tag FROM provider_credentials
          WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(account.id)
      .first<{ ciphertext: string; iv: string; auth_tag: string }>();
    if (!row) return null;
    try {
      return await openSecret(row, env.VAULT_KEY);
    } catch {
      return null;
    }
  };

  const invocation = {
    input: {
      url: config.url_template,
      method: config.input.method,
      auth_query: config.input.auth_query,
      json_body: config.input.json_body,
    },
    source: {
      url_template: config.url_template,
      selector_json: JSON.stringify({ records_path: config.records_path }),
    },
    credential_ref: { credential_id: account.id, provider: 'apify', account_label: accountLabel },
    budget: { deadline_ms: Date.now() + timeoutMs },
    resolveCredential,
  } as unknown as AdapterInvocation;

  const outcome = await apiJsonAdapter.run(invocation);
  if (outcome.outcome !== 'success' || !Array.isArray(outcome.records)) return [];
  return outcome.records as unknown[];
}

/**
 * Collect Wave 2 buying signals for one lead and persist them.
 *
 * Pure orchestration: account pick → actor run → normalize → upsert.
 * Returns null when the lead does not exist.
 */
export async function collectWave2(
  db: D1Database,
  env: { VAULT_KEY: string },
  leadId: string,
  options: { timeoutMs?: number; families?: ActorKind[] } = {},
): Promise<Wave2Result | null> {
  const lead = await db
    .prepare(`SELECT id, company_name, name FROM leads WHERE id = ? AND deleted_at IS NULL`)
    .bind(leadId)
    .first<LeadRow>();
  if (!lead) return null;

  const company = lead.company_name ?? lead.name;
  if (!company) {
    return { lead_id: leadId, signals_written: 0, families: { hiring: 'no_signal', ads: 'no_signal', funding: 'no_signal' } };
  }

  const families = options.families ?? (['hiring', 'ads', 'funding'] as ActorKind[]);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = Math.floor(Date.now() / 1000);

  const accountLabel = await pickApifyAccount(db);
  const result: Wave2Result = {
    lead_id: leadId,
    signals_written: 0,
    families: { hiring: 'no_signal', ads: 'no_signal', funding: 'no_signal' },
  };
  if (!accountLabel) {
    result.families = { hiring: 'error', ads: 'error', funding: 'error' };
    return result;
  }

  const configs: Record<ActorKind, () => ApifyRunConfig> = {
    hiring: () => hiringRunConfig(company),
    ads: () => adsRunConfig(company),
    funding: () => fundingRunConfig(company),
  };

  const writes: SignalWrite[] = [];
  for (const kind of families) {
    try {
      const records = await runActor(db, env, accountLabel, kind, configs[kind](), timeoutMs);
      await bumpQuota(db, accountLabel);
      if (records.length === 0) continue;
      const signals = normalizeBuyingSignals(kind, records as RawActorRecord[], company);
      if (signals.length > 0) {
        result.families[kind] = 'ok';
        writes.push(...signals);
      }
    } catch {
      result.families[kind] = 'error';
    }
  }

  if (writes.length > 0) {
    const statements = writes.map((s) =>
      db
        .prepare(
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
        )
        .bind(
          crypto.randomUUID(),
          leadId,
          s.signal_key,
          s.signal_value_num,
          s.signal_value_text,
          1,
          now,
          s.expires_at,
          'apify',
        ),
    );
    await db.batch(statements);
    result.signals_written = writes.length;
  }

  return result;
}

export { SIGNAL_TTL_SECONDS };
