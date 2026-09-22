/**
 * The phone normaliser. One implementation, used by every ingress.
 *
 * R16 allows exactly one ingest path — normalize → dedup → gate → provenance —
 * and forbids a second implementation for a different door. A Tier 0 dump, a
 * Mode B capture and a re-run of the backfill therefore all call THIS function,
 * so a business that arrived through the console and the same business arriving
 * through a parquet file cannot end up with two different phone numbers.
 *
 * WHY THE LIBRARY'S OWN `phone_type` IS STORED VERBATIM. The value is not
 * translated into our own enum. Measured across the 7,353 numbers in production,
 * the library returns FIXED_LINE_OR_MOBILE (7,197), TOLL_FREE (152), MOBILE (2)
 * and unknown (2) — and a hand-written enum would have said `fixed_or_mobile`,
 * lower case, which is a different string. Translating would mean inventing a
 * mapping between two vocabularies and then owning it forever; storing what the
 * library said means the next reader can go and look up what it meant.
 * scripts/measure_normalise.mjs is how that list was obtained.
 *
 * WHY `valid` HAS THREE STATES. `null` means there was nothing to normalise (a
 * blank string, or a row the backfill has not reached yet). `0` means a real
 * string was parsed and the library says it is not a valid number. Those are
 * different facts and collapsing them would make "the parser disagrees with this
 * data" indistinguishable from "we have not looked yet". The seed makes the same
 * distinction between a NULL cost and a cost of 0.
 */

import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import type { CountryCode } from 'libphonenumber-js/min';

/** Recorded against every derived field, because a version bump changes results. */
export const NORMALISER = 'libphonenumber-js@1.13.13';

export interface NormalisedPhone {
  /** E.164, or null when there is no number to speak of. */
  e164: string | null;
  /** ISO-3166 alpha-2 the library resolved the number under. */
  country: string | null;
  /** The library's own vocabulary, verbatim. */
  type: string | null;
  /** 1 valid · 0 normalised and invalid · null nothing to normalise. */
  valid: 0 | 1 | null;
}

const NOTHING_TO_NORMALISE: NormalisedPhone = { e164: null, country: null, type: null, valid: null };
const INVALID: NormalisedPhone = { e164: null, country: null, type: null, valid: 0 };

/**
 * Normalises one raw phone string.
 *
 * `defaultCountry` matters and is not decoration: "5125550100" is a US number
 * only because the row's `country_code` says so. A national-format string with no
 * country hint parses as nothing, and returning that as `invalid` would be a
 * claim about the number rather than about the hint we failed to supply — which
 * is why an unusable hint is passed through as `undefined` and left to the
 * library's own rules.
 */
export function normalisePhone(raw: unknown, defaultCountry?: string | null): NormalisedPhone {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return NOTHING_TO_NORMALISE;

  const hint = typeof defaultCountry === 'string' && /^[A-Za-z]{2}$/.test(defaultCountry.trim())
    ? (defaultCountry.trim().toUpperCase() as CountryCode)
    : undefined;

  let parsed: ReturnType<typeof parsePhoneNumberFromString>;
  try {
    parsed = parsePhoneNumberFromString(text, hint);
  } catch {
    // A malformed string is data, not an exception. It must not take down a
    // slice of 500 rows.
    return INVALID;
  }

  if (!parsed || !parsed.isValid()) return INVALID;

  return {
    e164: parsed.number,
    country: parsed.country ?? null,
    type: parsed.getType() ?? 'unknown',
    valid: 1,
  };
}
