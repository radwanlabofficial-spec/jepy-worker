/**
 * Candidate building and the eleven hard filters (09-router.md §4).
 *
 * The order matters and is the document's, not mine: filters run *before*
 * scoring, and no weight can override them. A capability that fails one of these
 * is not a low-scoring option — it is not an option.
 *
 *  1  circuit open
 *  2  Class X      — override-proof, permanently blocked
 *  3  Class C      — manual only, never an automated route
 *  4  compliance   — geo_blocked, or tos_limited with no override
 *  5  credential   — needs a key and the provider has no claimable account
 *  6  login        — needs a login and the runner is not the extension
 *  7  quota        — the window is at its ceiling
 *  8  quota expiry — the account's entitlement has lapsed
 *  9  cooldown     — every account is cooling down
 * 10  runner       — the job's runner context is not this capability's
 * 11  naming guard — `provider LIKE 'bd%'` is an invalid row (R22)
 *
 * Filters 2 and 3 are the ones worth being loud about. **Class C has an operator
 * override path; Class X does not exist in the candidate list at all.** R25's
 * override is a Mode B manual-capture action and is never consulted here, so a
 * Class X source cannot be reached by any route through this file — not by a
 * better score, not by a flag on the job, not by an empty fallback.
 *
 * Filters 5 and 7–9 need account rows. They are fetched once for the whole
 * candidate set rather than per candidate, because a router that issues four
 * queries per provider is a router that spends its sub-request budget on itself.
 */

import { isCircuitOpen } from '../lib/queue';
import { circuitScopeFor } from './circuit';
import type { Candidate, ProviderAccountRow, SourceContext } from './types';

/** What the router knows about the job it is routing. */
export interface RouteRequest {
  job_id: string;
  target_type: string | null;
  /** Which runner is executing: `worker` for cron, `extension` for Mode A. */
  runner: string;
  /** Optional explicit source, from the job payload. */
  source_id?: string | null;
}

export interface CandidateBuild {
  candidates: Candidate[];
  /** How many rows each filter removed, in filter order. Kept for the UI and for
   *  answering "why did nothing run" without a debugger. */
  rejected: Record<string, number>;
  /** Rows the naming guard found. These also go to error_log (R22). */
  invalid_providers: string[];
}

interface CapabilityRow {
  id: string;
  target_type: string;
  provider: string;
  adapter: Candidate['adapter'];
  cost_micro_per_unit: number | null;
  unit_type: string | null;
  quality: number | null;
  avg_latency_ms: number | null;
  max_records: number | null;
  runner: string;
  requires_login: number;
  requires_credential: number;
  compliance_flag: string;
  priority: number;
}

interface SourceRow {
  id: string;
  source_key: string;
  base_url: string | null;
  target_type: string | null;
  adapter: string | null;
  pagination_json: string | null;
  rate_limit_per_min: number | null;
  class: string;
  block_reason: string;
  enabled: number;
}

interface PackRow {
  source_key: string;
  version: number;
  selector_json: string | null;
}

/** `pagination_json` is free-form in the schema; these are the three keys the
 *  adapter contract actually names (07 §2). Anything else is ignored rather than
 *  guessed at. */
function readPagination(raw: string | null): { mode: string | null; param: string | null; maxPages: number | null } {
  if (!raw) return { mode: null, param: null, maxPages: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      mode: typeof parsed.mode === 'string' ? parsed.mode : null,
      param: typeof parsed.param === 'string' ? parsed.param : null,
      maxPages: typeof parsed.max_pages === 'number' ? parsed.max_pages : null,
    };
  } catch {
    return { mode: null, param: null, maxPages: null };
  }
}

/**
 * Picks the source a capability is reached through.
 *
 * The schema carries no foreign key from `provider_capability` to
 * `directory_sources`: the join is `(target_type, adapter)`, and that is not a
 * guess — both columns exist on both tables for exactly this purpose (07 §3, 08).
 * An explicit `source_id` on the job wins, because a job that names its source is
 * the operator overriding the default lookup, not the operator bypassing a
 * filter. The filter still runs against whatever source was picked.
 */
function pickSource(
  sources: SourceRow[],
  capability: CapabilityRow,
  explicitSourceId: string | null | undefined,
): SourceRow | null {
  if (explicitSourceId) {
    const exact = sources.find((row) => row.id === explicitSourceId);
    if (exact) return exact;
  }

  // A disabled source is not a candidate source. The column was already being
  // selected and simply not used, which meant a switched-off directory could
  // still win the lookup and then be judged on its class and block reason.
  const matches = sources
    .filter(
      (row) =>
        row.enabled === 1 &&
        row.target_type === capability.target_type &&
        row.adapter === capability.adapter,
    )
    // Deterministic. Without an order, a second source sharing the same
    // (target_type, adapter) pair would decide a Class X or Class C verdict by
    // row order — the kind of bug that appears once, in production, and cannot
    // be reproduced.
    .sort((a, b) => (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0));

  return matches[0] ?? null;
}

function toSourceContext(source: SourceRow | null, pack: PackRow | null): SourceContext | null {
  if (!source) return null;
  const pagination = readPagination(source.pagination_json);
  return {
    source_id: source.id,
    source_key: source.source_key,
    base_url: source.base_url,
    url_template: null,
    pagination_mode: pagination.mode,
    pagination_param: pagination.param,
    max_pages: pagination.maxPages,
    rate_limit_rpm: source.rate_limit_per_min,
    selector_json: pack?.selector_json ?? null,
    pack_version: pack?.version ?? null,
  };
}

/** An account can be claimed right now if every gate on it passes. */
function accountIsClaimable(account: ProviderAccountRow, now: number): boolean {
  if (account.enabled !== 1) return false;
  if (account.status !== 'active') return false;
  if (account.cooldown_until !== null && account.cooldown_until > now) return false;
  if (account.quota_expires_at !== null && account.quota_expires_at <= now) return false;
  if (account.daily_limit !== null && account.daily_used >= account.daily_limit) return false;
  if (account.quota_limit !== null && account.quota_limit > 0 && account.quota_used >= account.quota_limit) {
    return false;
  }
  return true;
}

export async function buildCandidates(
  db: D1Database,
  request: RouteRequest,
  now = Math.floor(Date.now() / 1000),
): Promise<CandidateBuild> {
  if (!request.target_type) {
    return { candidates: [], rejected: { no_target_type: 1 }, invalid_providers: [] };
  }

  const [capabilities, sources, packs, accounts] = await Promise.all([
    db
      .prepare(
        `SELECT id, target_type, provider, adapter, cost_micro_per_unit, unit_type, quality,
                avg_latency_ms, max_records, runner, requires_login, requires_credential,
                compliance_flag, priority
           FROM provider_capability
          WHERE target_type = ? AND enabled = 1
          ORDER BY priority ASC, provider ASC`,
      )
      .bind(request.target_type)
      .all<CapabilityRow>(),
    db
      .prepare(
        `SELECT id, source_key, base_url, target_type, adapter, pagination_json,
                rate_limit_per_min, class, block_reason, enabled
           FROM directory_sources
          WHERE deleted_at IS NULL`,
      )
      .all<SourceRow>(),
    // `status='active'`, NOT `active=1` — selector_packs has no `active` column,
    // and a boolean could not express "proposed but not yet approved" (ADR-030,
    // 09 §10).
    db
      .prepare(
        `SELECT source_key, version, selector_json
           FROM selector_packs
          WHERE status = 'active'`,
      )
      .all<PackRow>(),
    db
      .prepare(
        // `credential_status` rides along because R20 has a second half that is
        // easy to miss: a credential that is `untested` or `failed` must never
        // reach the candidate list at all. Reading it here is what makes that
        // possible before scoring, instead of relying on the account's own
        // `status` column as an accidental proxy.
        `SELECT a.id, a.provider, a.account_label, a.status, a.enabled, a.cooldown_until,
                a.quota_limit, a.quota_used, a.quota_window, a.quota_expires_at,
                a.daily_limit, a.daily_used, a.last_used_at, a.priority,
                (SELECT c.test_status FROM provider_credentials c
                  WHERE c.account_id = a.id
                  ORDER BY c.rotated_at IS NULL DESC, c.created_at DESC LIMIT 1) AS credential_status
           FROM provider_accounts a`,
      )
      .all<ProviderAccountRow>(),
  ]);

  const sourceRows = sources.results ?? [];
  const packByKey = new Map((packs.results ?? []).map((row) => [row.source_key, row]));
  const accountsByProvider = new Map<string, ProviderAccountRow[]>();
  for (const account of accounts.results ?? []) {
    const list = accountsByProvider.get(account.provider) ?? [];
    list.push(account);
    accountsByProvider.set(account.provider, list);
  }

  // Quota counters are per (provider, account, window). Read once, keyed the same
  // way the claim statement looks them up, so a candidate is dropped here for the
  // same reason the claim would later refuse it.
  const counters = await db
    .prepare(`SELECT provider, account_label, window_key, used, limit_value FROM quota_counters`)
    .all<{ provider: string; account_label: string; window_key: string; used: number; limit_value: number | null }>();
  const counterByKey = new Map(
    (counters.results ?? []).map((row) => [`${row.provider}\u0000${row.account_label}`, row]),
  );

  const rejected: Record<string, number> = {};
  const invalidProviders: string[] = [];
  const drop = (filter: string) => {
    rejected[filter] = (rejected[filter] ?? 0) + 1;
  };

  const candidates: Candidate[] = [];

  for (const capability of capabilities.results ?? []) {
    // 11. Naming guard (R22). `provider` is always lowercase and never `bd_*`;
    // `bd` is a country code. A row that breaks this was written by something
    // other than the seed, so it is refused and reported rather than routed.
    if (/^bd/i.test(capability.provider)) {
      drop('naming_guard');
      invalidProviders.push(`${capability.id}:${capability.provider}`);
      continue;
    }

    const sourceRow = pickSource(sourceRows, capability, request.source_id);

    // 2. Class X — override-proof. Checked before Class C so that a source that
    // were ever both would still be permanently blocked.
    if (sourceRow && (sourceRow.class === 'X' || sourceRow.block_reason === 'tos_no_storage')) {
      drop('class_x');
      continue;
    }

    // 3. Class C — manual only. R25's override is a Mode B action and is
    // deliberately not consulted on this path.
    if (sourceRow && sourceRow.class === 'C') {
      drop('class_c');
      continue;
    }

    // 4. Compliance. `geo_blocked` means the target geo is blocked, so the flag
    // itself is the verdict. `tos_limited` is also refused: the only override in
    // this system is for Class C manual capture, which filter 3 already excluded.
    if (capability.compliance_flag === 'geo_blocked') {
      drop('compliance_geo_blocked');
      continue;
    }
    if (capability.compliance_flag === 'tos_limited') {
      drop('compliance_tos_limited');
      continue;
    }

    // 10. Runner mismatch. A `worker` job cannot drive a capability whose only
    // runner is the extension, and vice versa.
    if (capability.runner !== request.runner) {
      drop('runner_mismatch');
      continue;
    }

    // 6. Login. `requires_login` capabilities are reachable only by the
    // extension, which runs inside a browser that is already signed in.
    if (capability.requires_login === 1 && capability.runner !== 'extension') {
      drop('requires_login');
      continue;
    }

    const pool = accountsByProvider.get(capability.provider) ?? [];

    if (capability.requires_credential === 1) {
      // 5. Credential. "No claimable account" — the document's words — is a
      // stricter test than "no account row", and the difference is the whole
      // point of the filter: an account that exists but cannot be claimed is not
      // a candidate, and treating it as one produced a routing refusal that only
      // showed up much later, inside the claim, after a hop had been charged.
      if (pool.length === 0) {
        drop('no_credential');
        continue;
      }

      // R20's co-rule: `untested` and `failed` credentials never reach the
      // candidate list — dropped first, in the hard filters. This is not the
      // same question as the account's own `status`; a credential can be dead
      // while the account still says `active`, and until this check existed the
      // only thing standing between a dead key and the router was that accident.
      const hasHealthyCredential = pool.some((account) => account.credential_status === 'ok');
      if (!hasHealthyCredential) {
        drop('credential_unhealthy');
        continue;
      }
    }

    // 8, 7 and 9, in the document's order, each reported under its own name.
    // They were previously collapsed into one `cooldown_or_quota` bucket, which
    // told an operator that SOMETHING was wrong with the account without saying
    // which of three unrelated things it was — and the three need different
    // reactions: an expired entitlement is a purchase, a ceiling is a rollover,
    // a cooldown is patience.
    if (pool.length > 0 && pool.every((account) => account.quota_expires_at !== null && account.quota_expires_at <= now)) {
      drop('quota_expired');
      continue;
    }

    const claimable = pool.filter((account) => accountIsClaimable(account, now));
    if (pool.length > 0 && claimable.length === 0) {
      const atCeiling = pool.some(
        (account) => account.quota_limit !== null && account.quota_limit > 0 && account.quota_used >= account.quota_limit,
      );
      const counterSpent = pool.some((account) => {
        const counter = counterByKey.get(`${capability.provider}\u0000${account.account_label}`);
        return counter?.limit_value !== null && counter?.limit_value !== undefined && (counter.used ?? 0) >= counter.limit_value;
      });
      if (atCeiling || counterSpent) {
        drop('quota_exhausted');
      } else {
        drop('cooldown');
      }
      continue;
    }

    // 7. The window ceiling has to be checked HERE, before scoring, and not only
    // inside the claim. A counter's own limit is a different wall from the
    // account's quota, and leaving it to the claim meant a candidate could win
    // scoring, cost a hop, and only then be refused by a number the router had
    // already read and thrown away.
    if (pool.length > 0) {
      const everyCounterSpent = pool.every((account) => {
        const counter = counterByKey.get(`${capability.provider}\u0000${account.account_label}`);
        if (!counter || counter.limit_value === null || counter.limit_value === undefined) return false;
        return (counter.used ?? 0) >= counter.limit_value;
      });
      if (everyCounterSpent) {
        drop('quota_counter_exhausted');
        continue;
      }
    }

    // Credential-free capabilities have no account to claim, so their circuit is
    // scoped to the provider only.
    // 1. Circuit. Any of the three scopes being open removes the candidate.
    const scopes = [
      circuitScopeFor.provider(capability.provider),
      circuitScopeFor.providerTarget(capability.provider, capability.target_type),
      sourceRow ? circuitScopeFor.source(sourceRow.id) : null,
    ].filter((scope): scope is string => scope !== null);
    let circuitOpen = false;
    for (const scope of scopes) {
      if (await isCircuitOpen(db, scope)) {
        circuitOpen = true;
        break;
      }
    }
    if (circuitOpen) {
      drop('circuit_open');
      continue;
    }

    const pack = sourceRow ? (packByKey.get(sourceRow.source_key) ?? null) : null;

    candidates.push({
      capability_id: capability.id,
      target_type: capability.target_type,
      provider: capability.provider,
      adapter: capability.adapter,
      cost_micro_per_unit: capability.cost_micro_per_unit,
      unit_type: capability.unit_type,
      quality: capability.quality,
      avg_latency_ms: capability.avg_latency_ms,
      max_records: capability.max_records,
      runner: capability.runner,
      requires_login: capability.requires_login,
      requires_credential: capability.requires_credential,
      compliance_flag: capability.compliance_flag,
      priority: capability.priority,
      source: toSourceContext(sourceRow, pack),
      accounts: claimable,
    });
  }

  return { candidates, rejected, invalid_providers: invalidProviders };
}
