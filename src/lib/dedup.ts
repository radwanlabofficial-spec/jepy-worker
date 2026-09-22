/**
 * The dedup cascade (R8), and the slug it falls back to.
 *
 * This moved out of `routes/imports.ts` in STEP 9. It lived there because the
 * Tier 0 import was the only thing inserting leads; it does not any more — the
 * backfill, the console, and Mode B capture all have to answer "have I seen this
 * business before", and R16 makes one ingest path the rule rather than a
 * preference. Keeping a second copy in the capture route is exactly the mistake
 * the rule exists to prevent.
 *
 * THE CASCADE IS COMPUTED, NOT QUERIED TIER BY TIER. Two candidate rows are
 * compared by computing a key from each and comparing the two keys — the only
 * thing the database does is enforce UNIQUE on `dedup_key`. That is what ADR-043
 * leans on when it drops the indexes on `overture_id`, `fsq_id` and `domain`:
 * those columns are written and never looked up, because they are folded into
 * this key first.
 *
 * THE PREFIX IS PART OF THE KEY ON PURPOSE. Two different businesses can share a
 * slug, and a slug that collided with a phone number would be a merge nobody
 * could explain afterwards.
 *
 * ORDER (R8): valid non-shared phone → overture_id / fsq_id → email → domain →
 * name_slug. The email and domain tiers are new here — the import-path version
 * stopped at `name_slug` with a note that those two "come later, when enrichment
 * has fetched them". They have not been fetched, no lead in production carries an
 * `e:` or `d:` key today, and adding the tiers is what makes the function correct
 * for the capture path, which will see both.
 */

import { normalisePhone } from './phone';

/**
 * A slug good enough to compare two business names, and no better.
 *
 * Deliberately conservative: lowercase, strip accents and punctuation, collapse
 * whitespace. Anything cleverer silently merges two legitimately different
 * businesses, and a merge is not reversible from the surviving row.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export interface CascadeFields {
  /** Raw phone as it arrived. Normalised here, not by the caller. */
  phone?: string | null;
  /** Country hint for a national-format number. */
  country_code?: string | null;
  /**
   * R8 demotes the phone tier when more than two leads share a number, because
   * the number is then a switchboard rather than an identity. The caller passes
   * the answer from `phone_usage_count`; the import path cannot know it without a
   * query per row, and measured across all 8,126 production rows it is false for
   * every one of them.
   */
  phone_is_shared?: boolean;
  overture_id?: string | null;
  fsq_id?: string | null;
  email?: string | null;
  domain?: string | null;
  name: string;
  city?: string | null;
}

/** The phone tier's contribution, or null when the tier is not usable. */
export function phoneDedupValue(raw: unknown, defaultCountry?: string | null): string | null {
  const n = normalisePhone(raw, defaultCountry);
  return n.valid === 1 && n.e164 ? n.e164 : null;
}

export function dedupKey(f: CascadeFields): string {
  if (!f.phone_is_shared) {
    const phone = phoneDedupValue(f.phone, f.country_code);
    if (phone) return `p:${phone}`;
  }
  if (f.overture_id) return `o:${f.overture_id}`;
  if (f.fsq_id) return `f:${f.fsq_id}`;
  if (f.email) return `e:${f.email.trim().toLowerCase()}`;
  if (f.domain) return `d:${f.domain.trim().toLowerCase()}`;
  return `n:${slugify(f.name)}|${slugify(f.city ?? '')}`;
}
