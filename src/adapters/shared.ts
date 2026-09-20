/**
 * What every adapter shares.
 *
 * The contract is 07-targets.md §2: one shape out of six different code paths,
 * or the normalizer in STEP 9 breaks on the fifth one and nobody notices until
 * the seventh.
 *
 *   { records, records_count, provider, account_label, unit_type,
 *     units, cost_micro, latency_ms, outcome, raw_ref_r2 }
 *
 * plus `runner`, `cursor` and `error_code` from the STEP 7 checklist, which name
 * three things the contract needs and does not carry: who ran it, where a feed
 * got to, and a machine-readable reason. `cursor` is not optional decoration —
 * `feed_poll` exists to be polled, and without a cursor it re-reads the same
 * items forever.
 *
 * NO ADAPTER FETCHES ITS OWN CONFIGURATION. Selectors, templates and pagination
 * arrive in `source`, already assembled by the router (09 §11). An adapter that
 * opened its own database connection would need the selector, would be tempted
 * to cache it, and would then be a second place where a site's markup is
 * described — which is exactly what ADR-014 and R23 forbid.
 *
 * NO ADAPTER DECIDES WHETHER TO RETRY. It reports an outcome; the router decides
 * the next hop. An adapter that retried internally would spend hop budget the
 * router had already accounted for.
 *
 * CREDENTIALS. `credentialRef` is a reference, not a secret. The plaintext is
 * produced by `resolveCredential()` at the moment of use and lives only in the
 * adapter's call frame — never in a payload, never in D1, never in a log line
 * (R1, R2). An adapter that cannot resolve a credential it needs returns
 * `error`, not a request with `Bearer undefined`.
 */

import type { AdapterName, AdapterOutcome, Outcome, SourceContext } from '../router/types';
import { emptyOutcome } from '../router/types';

export interface CredentialRef {
  credential_id: string;
  provider: string;
  account_label: string;
}

export interface AdapterInvocation {
  job_id: string;
  target_type: string;
  adapter: AdapterName;
  hop: number;
  provider: string;
  account_label: string | null;
  /** Which runner is executing: `worker`, `gha` or `extension`. Reported back so
   *  the attempt row says who really ran it, not who usually does. */
  runner: string;
  /** `provider_capability.cost_micro_per_unit`. The router owns the price; the
   *  adapter multiplies it by the units it actually used, because the adapter is
   *  the only layer that knows how many units that was. */
  unit_cost_micro: number | null;
  credential_ref: CredentialRef | null;
  /** Resolves the reference to plaintext. Called at most once, inside the adapter. */
  resolveCredential: () => Promise<string | null>;
  source: SourceContext | null;
  input: Record<string, unknown>;
  budget: { remaining_subrequests: number; deadline_ms: number };
}

export interface Adapter {
  readonly name: AdapterName;
  run(invocation: AdapterInvocation): Promise<AdapterOutcome>;
}

/** Shape of the config a `directory_html` or `profile_page` pack carries. */
export interface SelectorPack {
  /** CSS selector for one row of a list. */
  row?: string;
  /** CSS selector for the container, when rows are nested. */
  container?: string;
  /** field name → CSS selector, relative to the row. */
  fields?: Record<string, string>;
  /** field name → attribute to read instead of text content. */
  attributes?: Record<string, string>;
  /** For `profile_page`: a JSON path map instead of CSS. */
  json_map?: Record<string, string>;
  /** For `api_json`: field name → dotted path in the response body. */
  path_map?: Record<string, string>;
  /** Where records sit inside the response body. */
  records_path?: string;
}

export function readSelectorPack(raw: string | null): SelectorPack | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SelectorPack;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads a dotted path out of parsed JSON. `a.b[2].c` is supported. */
export function readPath(root: unknown, path: string): unknown {
  if (!path) return root;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cursor: unknown = root;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** A value an adapter may put in a record. Objects and arrays are kept as-is —
 *  the normalizer decides what to flatten, not the adapter. */
export type RecordValue = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>;

export function buildOutcome(
  invocation: AdapterInvocation,
  over: {
    records?: unknown[];
    outcome: Outcome;
    units?: number;
    unit_type?: string | null;
    cost_micro?: number;
    latency_ms: number;
    http_status?: number | null;
    error_code?: string | null;
    cursor?: string | null;
    raw_ref_r2?: string | null;
  },
): AdapterOutcome {
  const records = over.records ?? [];
  const units = over.units ?? 0;
  return emptyOutcome({
    provider: invocation.provider,
    account_label: invocation.account_label ?? 'unclaimed',
    records,
    records_count: records.length,
    outcome: over.outcome,
    units,
    unit_type: over.unit_type ?? null,
    // Priced here and nowhere else. Until this line existed every adapter
    // reported cost_micro = 0, which made the 40%-weighted cost term in the
    // router score meaningless and left `brightdata_credit_log` empty — and the
    // daily budget guard sums that table, so it could never trip. The budget
    // model rested on a number no code produced.
    cost_micro: over.cost_micro ?? (invocation.unit_cost_micro ?? 0) * units,
    latency_ms: over.latency_ms,
    http_status: over.http_status ?? null,
    error_code: over.error_code ?? null,
    cursor: over.cursor ?? null,
    raw_ref_r2: over.raw_ref_r2 ?? null,
    runner: invocation.runner,
  });
}

/**
 * Maps a transport failure onto the outcome enum.
 *
 * The distinction that matters: a 401/403 means the credential is wrong and the
 * account should be disabled, while a 5xx or a timeout means the provider is
 * unwell and the account is fine. Collapsing them into one `error` would make the
 * router disable a perfectly good key every time a provider had a bad minute.
 */
export function classifyHttp(status: number): { outcome: Outcome; error_code: string } {
  if (status === 401 || status === 403) return { outcome: 'error', error_code: 'E_CREDENTIAL_INVALID' };
  if (status === 429) return { outcome: 'error', error_code: 'E_RATE_LIMITED' };
  if (status === 404) return { outcome: 'empty', error_code: 'E_NOT_FOUND' };
  if (status === 402 || status === 407) return { outcome: 'error', error_code: 'E_PROVIDER_POLICY' };
  if (status >= 500) return { outcome: 'error', error_code: 'E_PROVIDER_5XX' };
  if (status >= 400) return { outcome: 'error', error_code: 'E_BAD_REQUEST' };
  return { outcome: 'success', error_code: 'E_NONE' };
}

/** True when the response body reads like a captcha or bot wall. */
export function looksBlocked(body: string): boolean {
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes('captcha') ||
    head.includes('cf-challenge') ||
    head.includes('attention required') ||
    head.includes('are you a robot') ||
    head.includes('access denied') ||
    head.includes('enable javascript and cookies')
  );
}

export async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  deadlineMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, deadlineMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Fills `{placeholder}` slots in a configured template. Missing values become an
 *  empty string rather than the literal `{name}`, so a broken template produces
 *  an obviously wrong URL instead of a request to a URL containing braces. */
export function fillTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? '' : encodeURIComponent(String(value));
  });
}
