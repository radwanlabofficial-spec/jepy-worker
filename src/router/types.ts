/**
 * Router vocabulary.
 *
 * Two shapes matter here and they are deliberately different things:
 *
 *   `Candidate`        — a row of `provider_capability` that survived the hard
 *                        filters, plus the account pool it would draw on.
 *   `AdapterOutcome`   — what an adapter returns, which is the uniform contract
 *                        from 07-targets.md §2 (restated in 09 §7).
 *
 * `AdapterOutcome` is the union of that contract and the three fields the STEP 7
 * checklist in 03-execution.md adds (`runner`, `cursor`, `error_code`). Where the
 * two documents disagree on a name, 07-targets.md wins: it is the adapter
 * document and 09 §7 was written to agree with it. The checklist's shape
 * (`status`, `cost_units`, `records[]`) is the same information under different
 * names — `outcome`, `units`, `records` — and one name had to be chosen.
 *
 * `outcome` is `success | empty | error | blocked | timeout` and **`empty` counts
 * as failure** (R19). An adapter that returned an empty list and called it a
 * success would hide the single most common way a scrape goes wrong: the page
 * loaded, the selector matched nothing, and the run "succeeded" with zero rows.
 */

export type AdapterName =
  | 'api_json'
  | 'directory_html'
  | 'serp_query'
  | 'profile_page'
  | 'feed_poll'
  | 'tech_probe';

/** The only six. A seventh is forbidden (07 §2). */
export const ADAPTERS: readonly AdapterName[] = [
  'api_json',
  'directory_html',
  'serp_query',
  'profile_page',
  'feed_poll',
  'tech_probe',
];

export type Outcome = 'success' | 'empty' | 'error' | 'blocked' | 'timeout';

export interface SourceContext {
  source_id: string | null;
  source_key: string | null;
  base_url: string | null;
  url_template: string | null;
  pagination_mode: string | null;
  pagination_param: string | null;
  max_pages: number | null;
  rate_limit_rpm: number | null;
  /** From the `selector_packs` row with `status='active'` — never `active=1`. */
  selector_json: string | null;
  pack_version: number | null;
}

export interface ProviderAccountRow {
  id: string;
  provider: string;
  account_label: string;
  /** Latest credential's own verdict. `ok` is the only value R20 admits. */
  credential_status: string | null;
  status: string;
  enabled: number;
  cooldown_until: number | null;
  quota_limit: number | null;
  quota_used: number;
  quota_window: string | null;
  quota_expires_at: number | null;
  daily_limit: number | null;
  daily_used: number;
  last_used_at: number | null;
  priority: number;
}

export interface Candidate {
  capability_id: string;
  target_type: string;
  provider: string;
  adapter: AdapterName;
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

  /** Which source this capability is reached through, if any. */
  source: SourceContext | null;
  /** Every account of this provider that passed the account-level filters. */
  accounts: ProviderAccountRow[];
}

export interface ScoreComponents {
  cost: number;
  quality: number;
  success: number;
  latency: number;
  free: number;
  penalty: number;
  success_rate_7d: number;
  failure_streak: number;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  components: ScoreComponents;
  /** True when this candidate is credential-free and therefore pinned to hop 1. */
  tier0: boolean;
}

export interface AdapterOutcome {
  records: unknown[];
  records_count: number;
  provider: string;
  account_label: string;
  unit_type: string | null;
  units: number;
  cost_micro: number;
  latency_ms: number;
  outcome: Outcome;
  /** R2 key of the raw body, when it was worth keeping. */
  raw_ref_r2: string | null;
  runner: string;
  cursor: string | null;
  error_code: string | null;
  http_status: number | null;
}

export function emptyOutcome(
  over: Partial<AdapterOutcome> & Pick<AdapterOutcome, 'provider' | 'account_label'>,
): AdapterOutcome {
  return {
    records: [],
    records_count: 0,
    unit_type: null,
    units: 0,
    cost_micro: 0,
    latency_ms: 0,
    outcome: 'error',
    raw_ref_r2: null,
    runner: 'worker',
    cursor: null,
    error_code: null,
    http_status: null,
    ...over,
  };
}
