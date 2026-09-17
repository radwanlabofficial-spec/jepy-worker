/**
 * Circuit breaker scopes (09-router.md §7).
 *
 * Three levels, all sharing one 15-minute open window (R19):
 *
 *   prov:<provider>                    the provider is unwell everywhere
 *   prov:<provider>:<target_type>      this pair is unwell — by far the most used
 *   src:<source_id>                    one Class B directory changed its markup
 *
 * The middle scope is the one that carries the load. A provider-wide scope alone
 * would take a working SERP integration down because an unrelated HTML directory
 * started failing, and a source-scoped one alone would keep hammering a provider
 * that has started refusing every request. Opening at the narrowest scope that
 * explains the failure is what keeps a single bad directory from costing a day.
 *
 * There is no half-open state (R19). When the window expires the circuit closes
 * outright and the next failure opens it again. That is a deliberate choice with
 * a known cost: at the moment of closing, every waiting job can arrive at once.
 * 09 §13 lists the thundering herd as an open item; the mitigation today is the
 * dispatcher's per-tick claim cap, which spreads the retry over several ticks
 * rather than releasing it all at once.
 *
 * This file owns the *naming* of scopes. The state transitions live in
 * `lib/queue.ts` and are not duplicated here — one implementation of "three
 * strikes opens it" is enough.
 */

import { isCircuitOpen, recordFailure, recordSuccess } from '../lib/queue';
import type { Env } from '../env';

export const circuitScopeFor = {
  provider: (provider: string): string => `prov:${provider}`,

  providerTarget: (provider: string, targetType: string | null): string | null =>
    targetType ? `prov:${provider}:${targetType}` : null,

  source: (sourceId: string): string => `src:${sourceId}`,
} as const;

/** Every scope a single attempt should be recorded against. */
export function scopesForAttempt(input: {
  provider: string;
  target_type: string | null;
  source_id: string | null;
}): string[] {
  return [
    circuitScopeFor.provider(input.provider),
    circuitScopeFor.providerTarget(input.provider, input.target_type),
    input.source_id ? circuitScopeFor.source(input.source_id) : null,
  ].filter((scope): scope is string => scope !== null);
}

export interface CircuitResult {
  opened: string[];
}

/**
 * Records a failed attempt against every applicable scope.
 *
 * A failure counts against all three so that two more failures of the same pair
 * will open the pair scope, while the same failure repeated across three
 * different target types opens the provider scope. That is the intended reading
 * of the §7 table: the scopes are independent counters, not a hierarchy.
 */
export async function recordAttemptFailure(
  db: D1Database,
  input: { provider: string; target_type: string | null; source_id: string | null },
): Promise<CircuitResult> {
  const opened: string[] = [];
  for (const scope of scopesForAttempt(input)) {
    const result = await recordFailure(db, scope);
    if (result.opened) opened.push(scope);
  }
  return { opened };
}

/** A success resets every scope the attempt touched. */
export async function recordAttemptSuccess(
  db: D1Database,
  input: { provider: string; target_type: string | null; source_id: string | null },
): Promise<void> {
  for (const scope of scopesForAttempt(input)) {
    await recordSuccess(db, scope);
  }
}

export async function circuitIsOpen(db: D1Database, scope: string | null): Promise<boolean> {
  if (!scope) return false;
  return isCircuitOpen(db, scope);
}

/** The scopes currently open, for `/api/jobs/meta` and the console badge. */
export async function openScopes(env: Env, now = Math.floor(Date.now() / 1000)): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT scope_key FROM circuit_state
      WHERE state = 'open' AND (opened_at IS NULL OR opened_at + reopen_after > ?)`,
  )
    .bind(now)
    .all<{ scope_key: string }>();
  return (rows.results ?? []).map((row) => row.scope_key);
}
