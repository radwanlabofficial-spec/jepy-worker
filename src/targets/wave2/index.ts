/**
 * Wave 2 public surface.
 *
 * One entry point per signal family, plus the Apify config builders and the
 * shared types. The pipeline route (STEP 14) calls these with raw actor output
 * and gets back `SignalWrite[]` rows ready for `lead_signals`.
 */

export type { ActorKind, BuyingSignalKey, RawActorRecord, SignalWrite } from './types';
export { BUYING_SIGNAL_KEYS, SIGNAL_TTL_SECONDS } from './types';
export { normalizeHiring } from './hiring';
export { normalizeAds } from './ads';
export { normalizeFunding, parseAmountUsd } from './funding';
export type { ApifyRunConfig } from './apify';
export { DEFAULT_ACTORS, adsRunConfig, fundingRunConfig, hiringRunConfig } from './apify';

import type { ActorKind, RawActorRecord, SignalWrite } from './types';
import { normalizeHiring } from './hiring';
import { normalizeAds } from './ads';
import { normalizeFunding } from './funding';

/**
 * Normalize one Apify actor run into buying-signal rows.
 *
 * Pure function — no I/O, no D1. `kind` selects the normalizer; an unknown
 * kind returns no signals rather than throwing, because a misconfigured
 * capability row should degrade to "no signal" rather than fail the job.
 */
export function normalizeBuyingSignals(
  kind: ActorKind | string,
  records: RawActorRecord[],
  company: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SignalWrite[] {
  switch (kind) {
    case 'hiring':
      return normalizeHiring(records, company, nowSec);
    case 'ads':
      return normalizeAds(records, company, nowSec);
    case 'funding':
      return normalizeFunding(records, company, nowSec);
    default:
      return [];
  }
}
