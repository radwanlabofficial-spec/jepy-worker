/**
 * Hiring-signal normalization.
 *
 * Input: raw records from a job-postings Apify actor (LinkedIn/Indeed-style).
 * Each record is expected to carry some subset of: title, company, location,
 * posted_at / date, url, description snippet.
 *
 * Output: `hiring_signal` (1/0), `job_count`, `job_titles` (top 5, deduped).
 *
 * The normalizer is defensive: actors change their output shape without notice.
 * A record with no recognizable title field is skipped, not coerced. Zero
 * recognizable records out of a non-empty run is `hiring_signal = 0` (checked,
 * none found) — which is different from an empty run, where we emit nothing at
 * all and let the caller decide whether the actor itself failed.
 */

import type { RawActorRecord, SignalWrite } from './types';
import { SIGNAL_TTL_SECONDS } from './types';

const TITLE_FIELDS = ['title', 'jobTitle', 'job_title', 'position', 'name'];
const COMPANY_FIELDS = ['company', 'companyName', 'company_name', 'employer'];

function pickString(record: RawActorRecord, fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Best-effort: does this record look like a job posting for the target company? */
function isJobRecord(record: RawActorRecord): boolean {
  return pickString(record, TITLE_FIELDS) !== null;
}

/**
 * Normalize hiring actor output.
 *
 * @param records  raw actor output items
 * @param company  canonical company name, for relevance filtering (case-insensitive substring)
 * @param nowSec   current unix time (injected for testability)
 */
export function normalizeHiring(
  records: RawActorRecord[],
  company: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SignalWrite[] {
  const jobs = records.filter(isJobRecord);
  const expiresAt = nowSec + SIGNAL_TTL_SECONDS.hiring;

  if (records.length > 0 && jobs.length === 0) {
    // The actor ran and returned rows, but none look like jobs — the shape
    // changed. Report "checked, none found" rather than failing loudly; the
    // empty-outcome path is for the actor returning nothing at all.
    return [
      { signal_key: 'hiring_signal', signal_value_num: 0, signal_value_text: null, expires_at: expiresAt },
    ];
  }

  if (jobs.length === 0) return [];

  const needle = company.trim().toLowerCase();
  const relevant = needle
    ? jobs.filter((r) => {
        const co = pickString(r, COMPANY_FIELDS);
        return co === null || co.toLowerCase().includes(needle) || needle.includes(co.toLowerCase());
      })
    : jobs;

  const titles = [...new Set(
    relevant.map((r) => pickString(r, TITLE_FIELDS)).filter((t): t is string => t !== null),
  )].slice(0, 5);

  const out: SignalWrite[] = [
    {
      signal_key: 'hiring_signal',
      signal_value_num: relevant.length > 0 ? 1 : 0,
      signal_value_text: null,
      expires_at: expiresAt,
    },
    {
      signal_key: 'job_count',
      signal_value_num: relevant.length,
      signal_value_text: null,
      expires_at: expiresAt,
    },
  ];

  if (titles.length > 0) {
    out.push({
      signal_key: 'job_titles',
      signal_value_num: null,
      signal_value_text: titles.join(' | ').slice(0, 500),
      expires_at: expiresAt,
    });
  }

  return out;
}
