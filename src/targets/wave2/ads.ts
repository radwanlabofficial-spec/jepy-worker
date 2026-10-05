/**
 * Ad-spend signal normalization.
 *
 * Input: raw records from an ads-library Apify actor (Meta Ad Library /
 * Google Ads Transparency style). Each record is expected to carry some subset
 * of: advertiser, platform, ad_text / creative, start_date, status.
 *
 * Output: `ad_spend_signal` (1/0), `ad_platforms` (pipe-separated).
 *
 * An "active" ad is one whose status field (when present) is not an explicit
 * negative. Actors disagree on the vocabulary ("active", "running", "live",
 * "ACTIVE"), so anything that is not clearly inactive counts — with one
 * exception: a record that explicitly says inactive/paused/ended/rejected is
 * excluded. When the actor provides no status at all, presence in the library
 * is itself the signal (libraries only list ads that ran).
 */

import type { RawActorRecord, SignalWrite } from './types';
import { SIGNAL_TTL_SECONDS } from './types';

const ADVERTISER_FIELDS = ['advertiser', 'page_name', 'pageName', 'advertiser_name', 'brand'];
const PLATFORM_FIELDS = ['platform', 'network', 'source', 'library'];
const STATUS_FIELDS = ['status', 'ad_status', 'state'];

const INACTIVE_RE = /\b(inactive|paused|ended|rejected|disapproved|archived|deleted)\b/i;

function pickString(record: RawActorRecord, fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function isActiveAd(record: RawActorRecord): boolean {
  const status = pickString(record, STATUS_FIELDS);
  if (status === null) return true; // in the library => it ran
  return !INACTIVE_RE.test(status);
}

export function normalizeAds(
  records: RawActorRecord[],
  company: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SignalWrite[] {
  const expiresAt = nowSec + SIGNAL_TTL_SECONDS.ads;

  if (records.length === 0) return [];

  const needle = company.trim().toLowerCase();
  const relevant = needle
    ? records.filter((r) => {
        const adv = pickString(r, ADVERTISER_FIELDS);
        if (adv === null) return true; // actor already scoped the search
        return adv.toLowerCase().includes(needle) || needle.includes(adv.toLowerCase());
      })
    : records;

  const active = relevant.filter(isActiveAd);
  const platforms = [...new Set(
    active.map((r) => pickString(r, PLATFORM_FIELDS)).filter((p): p is string => p !== null),
  )].slice(0, 5);

  const out: SignalWrite[] = [
    {
      signal_key: 'ad_spend_signal',
      signal_value_num: active.length > 0 ? 1 : 0,
      signal_value_text: null,
      expires_at: expiresAt,
    },
  ];

  if (platforms.length > 0) {
    out.push({
      signal_key: 'ad_platforms',
      signal_value_num: null,
      signal_value_text: platforms.join(' | ').slice(0, 200),
      expires_at: expiresAt,
    });
  }

  return out;
}
