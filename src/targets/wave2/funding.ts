/**
 * Funding-signal normalization.
 *
 * Input: raw records from a news/funding Apify actor. Each record is expected
 * to carry some subset of: title, snippet / summary, url, published_at / date,
 * amount, round.
 *
 * Output: `funding_signal` (1/0), `funding_amount_usd` (when parseable),
 * `funding_round` (normalized round name or "unknown").
 *
 * Detection is keyword-based on title+snippet: funding verbs ("raised",
 * "raises", "secures", "closes", "announces … round", "seed", "series"). This
 * is deliberately recall-heavy — a false positive here only adds a signal row
 * that Pass 0 weighs, while a false negative misses the strongest buying
 * signal there is. The amount parser handles "$12M", "$12.5 million",
 * "$1.2B", "€5m" (converted at a fixed rough rate — precision is not the point;
 * order of magnitude is).
 */

import type { RawActorRecord, SignalWrite } from './types';
import { SIGNAL_TTL_SECONDS } from './types';

const TITLE_FIELDS = ['title', 'headline', 'name'];
const SNIPPET_FIELDS = ['snippet', 'summary', 'description', 'text'];
const AMOUNT_FIELDS = ['amount', 'funding_amount', 'raised'];
const ROUND_FIELDS = ['round', 'funding_round', 'round_type'];

const FUNDING_RE = /\b(raises?|raised|secures?|secured|closes?|closed|announces?|announced|lands?|landed|funding|investment|seed|series\s+[a-e]|pre-seed|venture)\b/i;
const ROUND_RE = /\b(pre-seed|seed|series\s+([a-e])|bridge|growth|ipo)\b/i;

function pickString(record: RawActorRecord, fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Parse "$12M" / "$12.5 million" / "$1.2B" / "€5m" → USD number, or null. */
export function parseAmountUsd(text: string): number | null {
  const m = text.match(/([$€£])\s*([\d,.]+)\s*(billion|million|thousand|[bmk])?/i);
  if (!m) return null;
  const currency = m[1] as string;
  const num = parseFloat((m[2] as string).replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const suffix = (m[3] ?? '').toLowerCase();
  const mult = suffix === 'b' || suffix === 'billion' ? 1e9
    : suffix === 'm' || suffix === 'million' ? 1e6
    : suffix === 'k' || suffix === 'thousand' ? 1e3
    : 1;
  // Rough fixed FX — order of magnitude only.
  const fx = currency === '€' ? 1.08 : currency === '£' ? 1.27 : 1;
  return Math.round(num * mult * fx);
}

function normalizeRound(text: string | null): string {
  if (!text) return 'unknown';
  const m = text.match(ROUND_RE);
  if (!m) return 'unknown';
  const raw = (m[1] as string).toLowerCase().replace(/\s+/g, '_');
  return raw === 'series_a' || raw === 'series_b' || raw === 'series_c' ||
    raw === 'series_d' || raw === 'series_e' ? raw : raw;
}

export function normalizeFunding(
  records: RawActorRecord[],
  company: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SignalWrite[] {
  const expiresAt = nowSec + SIGNAL_TTL_SECONDS.funding;

  if (records.length === 0) return [];

  const needle = company.trim().toLowerCase();

  const hits = records.filter((r) => {
    const title = pickString(r, TITLE_FIELDS) ?? '';
    const snippet = pickString(r, SNIPPET_FIELDS) ?? '';
    const haystack = `${title} ${snippet}`;
    if (!FUNDING_RE.test(haystack)) return false;
    if (!needle) return true;
    return haystack.toLowerCase().includes(needle);
  });

  if (hits.length === 0) {
    return [
      { signal_key: 'funding_signal', signal_value_num: 0, signal_value_text: null, expires_at: expiresAt },
    ];
  }

  // Take the hit with the largest parseable amount (most newsworthy).
  let bestAmount: number | null = null;
  let bestRound = 'unknown';
  for (const hit of hits) {
    const amountText = pickString(hit, AMOUNT_FIELDS)
      ?? `${pickString(hit, TITLE_FIELDS) ?? ''} ${pickString(hit, SNIPPET_FIELDS) ?? ''}`;
    const amount = parseAmountUsd(amountText);
    if (amount !== null && (bestAmount === null || amount > bestAmount)) {
      bestAmount = amount;
      bestRound = normalizeRound(pickString(hit, ROUND_FIELDS) ?? amountText);
    }
  }
  if (bestAmount === null && hits.length > 0) {
    const first = hits[0] as RawActorRecord;
    bestRound = normalizeRound(
      `${pickString(first, ROUND_FIELDS) ?? ''} ${pickString(first, TITLE_FIELDS) ?? ''}`,
    );
  }

  const out: SignalWrite[] = [
    { signal_key: 'funding_signal', signal_value_num: 1, signal_value_text: null, expires_at: expiresAt },
    { signal_key: 'funding_round', signal_value_num: null, signal_value_text: bestRound, expires_at: expiresAt },
  ];
  if (bestAmount !== null) {
    out.push({
      signal_key: 'funding_amount_usd',
      signal_value_num: bestAmount,
      signal_value_text: null,
      expires_at: expiresAt,
    });
  }
  return out;
}
