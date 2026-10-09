/**
 * AI scraper selection: Manifest picks Apify or BrightData for a backend scrape.
 *
 * WHY THIS EXISTS. The extension's "Capture this page" flow can fail on a page
 * (login walls, heavy JS, bot screens). The backend scrape job it leaves behind
 * needs a provider, and the right one is not fixed: Apify runs scrapers on a
 * pool of per-account quotas, BrightData burns zone proxy credit — which one
 * is healthier right now is a live question, so it is asked at claim time, not
 * stored at request time.
 *
 * WHY AI AT ALL. The choice is two-way today, but the inputs (circuit state,
 * daily usage, account pool depth, the manual-failure reason) are the kind of
 * fuzzy trade-off that a 15-token JSON answer does better than a nested
 * if-chain. The AI is an advisor with a deterministic floor: if the credential
 * is missing, the call times out, or the JSON will not parse, the deterministic
 * fallback below decides. The job ALWAYS gets a provider — this function never
 * throws, because an unprovidered job is a stuck job.
 *
 * The Manifest credential lives encrypted in the Vault under provider
 * 'manifest' (same row Pass 1 uses). The secret is decrypted here, passed
 * straight into the Authorization header, and never logged or returned.
 */

import { z } from 'zod';
import { openSecret } from './crypto';
import { parseManifestCredential } from '../scoring/pass1';
import { circuitScopeFor } from '../router/circuit';
import type { Env } from '../env';

/** Short on purpose: a provider pick must not hold the claim path hostage. */
const AI_TIMEOUT_MS = 15_000;

export interface ScraperDecision {
  provider: 'apify' | 'brightdata';
  /** The actor/zone is the runner's problem; selection picks the provider only. */
  actor?: string;
  reason: string;
  ai_used: boolean;
}

export interface ScraperSelectInput {
  url: string;
  reason?: string | null;
}

interface ProviderHealth {
  circuit_open: boolean;
  /** NULL when the provider has no accounts or no daily limit configured. */
  daily_used: number | null;
  daily_limit: number | null;
  accounts_available: number;
}

const AiDecisionSchema = z.object({
  provider: z.enum(['apify', 'brightdata']),
  reason: z.string().min(1).max(200),
});

/**
 * Reads both providers' health in ONE D1 batch: circuit rows plus the daily
 * spend ledger. A missing circuit row means "never failed" (closed), and a
 * missing quota row means "no recorded usage" — both are healthy readings, not
 * gaps, so NULLs are treated as zero usage rather than as unknown.
 */
async function readProviderHealth(db: D1Database): Promise<Record<'apify' | 'brightdata', ProviderHealth>> {
  const today = new Date().toISOString().slice(0, 10);
  const [circuits, accounts, counters] = await db.batch([
    db
      .prepare(`SELECT scope_key, state FROM circuit_state WHERE scope_key IN ('prov:apify', 'prov:brightdata')`),
    db
      .prepare(
        `SELECT provider,
                SUM(CASE WHEN enabled = 1 AND status = 'active'
                          AND (cooldown_until IS NULL OR cooldown_until <= unixepoch())
                          AND (daily_limit IS NULL OR daily_used < daily_limit)
                         THEN 1 ELSE 0 END) AS available,
                SUM(daily_used) AS used,
                SUM(daily_limit) AS lim
           FROM provider_accounts
          WHERE provider IN ('apify', 'brightdata')
          GROUP BY provider`,
      ),
    db
      .prepare(
        `SELECT provider, SUM(used) AS used
           FROM quota_counters
          WHERE provider IN ('apify', 'brightdata') AND window_key = ?
          GROUP BY provider`,
      ).bind(today),
  ]);
  // db.batch returns one result per statement; a missing slot means the batch
  // itself misbehaved, and selectScraper's outer catch turns that into the
  // deterministic fallback rather than a thrown claim-path error.
  if (!circuits || !accounts || !counters) throw new Error('provider health batch returned no results');

  const circuitByScope = new Map<string, string>();
  for (const row of (circuits.results ?? []) as Array<{ scope_key: string; state: string }>) {
    circuitByScope.set(row.scope_key, row.state);
  }
  const accountByProvider = new Map<
    string,
    { available: number | null; used: number | null; lim: number | null }
  >();
  for (const row of (accounts.results ?? []) as Array<{ provider: string; available: number | null; used: number | null; lim: number | null }>) {
    accountByProvider.set(row.provider, { available: row.available, used: row.used, lim: row.lim });
  }
  const counterByProvider = new Map<string, number>();
  for (const row of (counters.results ?? []) as Array<{ provider: string; used: number | null }>) {
    counterByProvider.set(row.provider, row.used ?? 0);
  }

  const build = (provider: 'apify' | 'brightdata'): ProviderHealth => {
    const account = accountByProvider.get(provider);
    const used = account?.used ?? counterByProvider.get(provider) ?? null;
    return {
      // isCircuitOpen's lazy-close semantics live in queue.ts; for a read-only
      // health snapshot the stored state is enough, because a stale 'open'
      // only ever pushes the AI toward the other provider for one pick.
      circuit_open: circuitByScope.get(circuitScopeFor.provider(provider)) === 'open',
      daily_used: used,
      daily_limit: account?.lim ?? null,
      accounts_available: account?.available ?? 0,
    };
  };
  return { apify: build('apify'), brightdata: build('brightdata') };
}

/**
 * The Vault pattern, exactly as scoring/run.ts does it: newest tested
 * credential for the 'manifest' account, decrypted with VAULT_KEY, parsed
 * with parseManifestCredential (which never includes the secret in an error).
 * Returns null when there is nothing usable — the caller treats that as
 * "AI unavailable", not as an error.
 */
async function manifestCredential(env: Env): Promise<{ endpoint: string; api_key: string; model: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT c.ciphertext, c.iv, c.auth_tag
       FROM provider_credentials c
       JOIN provider_accounts a ON a.id = c.account_id
      WHERE a.provider = 'manifest' AND c.test_status = 'ok'
      ORDER BY c.rotated_at IS NULL DESC, c.created_at DESC
      LIMIT 1`,
  ).first<{ ciphertext: string; iv: string; auth_tag: string }>();
  if (!row) return null;
  try {
    const secret = await openSecret(row, env.VAULT_KEY);
    return parseManifestCredential(secret);
  } catch {
    return null;
  }
}

/**
 * Asks Manifest for the pick with a strict-JSON prompt. The prompt carries the
 * URL, the manual-failure reason, and the provider health snapshot — everything
 * the AI needs and nothing it does not (no lead data, no secrets, no quotas
 * beyond today's usage). temperature 0, because this is a decision, not prose.
 */
async function askManifest(
  credential: { endpoint: string; api_key: string; model: string | null },
  input: ScraperSelectInput,
  health: Record<'apify' | 'brightdata', ProviderHealth>,
): Promise<z.infer<typeof AiDecisionSchema> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(credential.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.api_key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'jepy-worker/1.0',
      },
      body: JSON.stringify({
        model: credential.model ?? undefined,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You choose which web-scraping provider to use for one URL. ' +
              'Reply with ONLY valid JSON: {"provider":"apify"|"brightdata","reason":"<one short sentence, max 15 words>"}. ' +
              'Prefer the provider whose circuit is closed, which has accounts available, and which has daily quota left. ' +
              'Apify: pool of accounts, good for JS-heavy pages via actors. BrightData: proxy zones, good for blocked/IP-sensitive targets. ' +
              'If the manual scrape failed because of a login wall or bot screen, prefer BrightData residential proxies. ' +
              'No commentary before or after the JSON.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              url: input.url,
              manual_failure_reason: input.reason ?? null,
              apify: health.apify,
              brightdata: health.brightdata,
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
    const content = choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    // The model is told to answer bare JSON, but a fenced block costs nothing
    // to tolerate and saves a fallback on a cosmetic deviation.
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = AiDecisionSchema.safeParse(JSON.parse(cleaned));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The deterministic floor. Never consults the AI and never throws. */
function deterministicFallback(health: Record<'apify' | 'brightdata', ProviderHealth>): ScraperDecision {
  const usable = (provider: 'apify' | 'brightdata'): boolean => {
    const healthRow = health[provider];
    if (healthRow.circuit_open) return false;
    if (healthRow.daily_limit !== null && (healthRow.daily_used ?? 0) >= healthRow.daily_limit) return false;
    return true;
  };
  if (usable('apify')) {
    return { provider: 'apify', reason: 'deterministic: apify circuit closed and quota remains', ai_used: false };
  }
  if (usable('brightdata')) {
    return { provider: 'brightdata', reason: 'deterministic: apify unavailable, brightdata circuit closed and quota remains', ai_used: false };
  }
  // Both look exhausted. The job still needs a provider, so it keeps apify —
  // the runner's own claim path will surface the real quota wall with a name
  // on it, which a silent stall here would hide.
  return { provider: 'apify', reason: 'deterministic: both providers appear exhausted, defaulting to apify', ai_used: false };
}

/**
 * Picks the scraping provider for one backend scrape. Never throws: on ANY
 * failure — no vault credential, AI timeout, unparseable JSON, even a dead
 * database read — the deterministic fallback decides, so the caller can always
 * write a provider onto the job row.
 */
export async function selectScraper(env: Env, input: ScraperSelectInput): Promise<ScraperDecision> {
  try {
    const health = await readProviderHealth(env.DB);
    const credential = await manifestCredential(env);
    if (!credential) {
      const fallback = deterministicFallback(health);
      return { ...fallback, reason: `${fallback.reason} (no manifest credential in vault)` };
    }
    const decision = await askManifest(credential, input, health);
    if (!decision) return deterministicFallback(health);
    return { provider: decision.provider, reason: `ai: ${decision.reason}`, ai_used: true };
  } catch {
    // The health read itself failed. The fallback needs health, so it gets the
    // "everything unknown" snapshot — unknown is not open and not exhausted,
    // so apify wins by default, which is the documented last resort.
    return {
      provider: 'apify',
      reason: 'deterministic: provider health unreadable, defaulting to apify',
      ai_used: false,
    };
  }
}
