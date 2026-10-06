/**
 * Wave 2 — buying signals (STEP 14).
 *
 * Where Wave 1 asks "does this business exist and can we reach it", Wave 2 asks
 * "is this business *buying* right now". Three signal families:
 *
 *   hiring  — open job postings (growth; they have budget for headcount)
 *   ads     — active ad campaigns (they spend on marketing)
 *   funding — recent funding/news (they have fresh capital)
 *
 * The adapter registry is closed (07 §2): no new adapter is added for these.
 * Apify actors are invoked through the generic `api_json` adapter against
 * `https://api.apify.com/v2/acts/{actor}/runs`, and the raw actor output is
 * normalized here into `SignalWrite` rows — the same shape Wave 1 writes.
 *
 * NOTHING IN THIS FILE TOUCHES D1. Normalization is pure: raw records in,
 * signal rows out. Persistence is the caller's job (RouterDO / pipeline route),
 * which is why this module is safe to unit-test without a database.
 */

export interface SignalWrite {
  signal_key: string;
  signal_value_num: number | null;
  signal_value_text: string | null;
  /** Unix seconds; null = does not expire. */
  expires_at: number | null;
}

/** Signal keys this module can emit. Closed set — a new key is a code change. */
export const BUYING_SIGNAL_KEYS = [
  'hiring_signal',      // 1 = hiring detected, 0 = checked, none found
  'job_count',          // number of open postings observed
  'job_titles',         // top titles, pipe-separated (text)
  'ad_spend_signal',    // 1 = active ads detected, 0 = checked, none found
  'ad_platforms',       // platforms with active ads, pipe-separated (text)
  'funding_signal',     // 1 = funding/news detected, 0 = checked, none found
  'funding_amount_usd',  // last round size when parseable
  'funding_round',      // e.g. "seed" | "series_a" | "series_b" | "unknown"
] as const;

export type BuyingSignalKey = (typeof BUYING_SIGNAL_KEYS)[number];

/** How long each signal family stays valid before it must be re-checked. */
export const SIGNAL_TTL_SECONDS = {
  hiring: 14 * 86_400,   // job postings go stale fast
  ads: 7 * 86_400,       // ad campaigns rotate weekly
  funding: 90 * 86_400,  // funding events are rare and long-lived
} as const;

/** One raw record from an Apify actor run, before normalization. */
export interface RawActorRecord {
  [field: string]: unknown;
}

/** Which Apify actor produced the records, so the normalizer knows the shape. */
export type ActorKind = 'hiring' | 'ads' | 'funding';
