/**
 * The response envelope and the error registry.
 *
 * Every route answers with `{ ok: true, data }` or `{ ok: false, error: {...} }`
 * and never a bare array or string (11-api-contract.md §1). The UI branches on
 * `code`, never on `message`; where two failures share a code the difference is
 * carried in `detail.reason`.
 *
 * The code enum is CLOSED at nineteen (19-errors.md §3). Adding a twentieth
 * needs a migration plus an ADR, because `error_log.code` has a CHECK constraint
 * that will refuse the insert first.
 */

export const ERROR_STATUS: Record<ErrorCode, number> = {
  E_VALIDATION: 400,
  E_UNAUTHENTICATED: 401,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_RATE_LIMIT: 429,
  E_QUOTA_EXHAUSTED: 429,
  E_BUDGET_GUARD: 429,
  E_AI_CAP: 429,
  E_YELP_GATE: 403,
  E_TIER_GATE: 403,
  E_COMPLIANCE_BLOCK: 403,
  E_LICENSE_BLOCK: 403,
  E_PROVIDER_POLICY: 403,
  E_CREDENTIAL_INVALID: 502,
  E_PROVIDER_ERROR: 502,
  E_TIMEOUT: 504,
  E_NO_CANDIDATE: 503,
  E_INTERNAL: 500,
};

export type ErrorCode = keyof typeof ERROR_MESSAGES;

/**
 * Bengali, because the operator reads Bengali and a translated error loses the
 * exact distinction the code was invented for. The frontend carries its own copy
 * of this map so a network failure with no body still reads correctly.
 */
export const ERROR_MESSAGES = {
  E_VALIDATION: 'ইনপুট ঠিক নেই (detail দেখুন)',
  E_UNAUTHENTICATED: 'সেশন শেষ — আবার login করুন',
  E_FORBIDDEN: 'এই কাজের অনুমতি নেই',
  E_NOT_FOUND: 'পাওয়া যায়নি — হয়তো মুছে ফেলা হয়েছে',
  E_CONFLICT: 'একই সময়ে অন্য কেউ বদলেছে, বা একই request দুবার গেছে',
  E_RATE_LIMIT: 'অনেক দ্রুত request — কিছুক্ষণ পরে আবার চেষ্টা করুন',
  E_QUOTA_EXHAUSTED: 'এই account-এর quota শেষ',
  E_BUDGET_GUARD: 'খরচের সীমা ছুঁয়েছে — dispatcher থেমে আছে',
  E_AI_CAP: 'আজকের AI স্কোরিং সীমা শেষ',
  E_YELP_GATE: 'Yelp কেবল rule_score ≥ ৫৫ হলে ব্যবহার করা যায়',
  E_TIER_GATE: 'এই ধাপটি ওই tier-এর জন্য নয় (ZeroBounce কেবল HOT)',
  E_COMPLIANCE_BLOCK: 'অনুবর্তন-নিয়মে আটকে গেছে — এটা করা যাবে না',
  E_LICENSE_BLOCK: 'ডেটাসেটের লাইসেন্স এই ব্যবহার/export অনুমোদন করে না',
  E_PROVIDER_POLICY: 'প্রদানকারীর নিজের নীতি এটি নিষিদ্ধ করে',
  E_CREDENTIAL_INVALID: 'credential test fail — Vault-এ গিয়ে rotate করুন',
  E_PROVIDER_ERROR: 'প্রদানকারীর দিক থেকে ব্যর্থতা',
  E_TIMEOUT: 'সময় শেষ — upstream উত্তর দেয়নি',
  E_NO_CANDIDATE: 'কোনো provider টিকল না — হাতে দেখতে হবে',
  E_INTERNAL: 'অপ্রত্যাশিত সমস্যা — error log দেখুন',
} as const satisfies Record<string, string>;

export interface ApiError {
  code: ErrorCode;
  message: string;
  detail?: Record<string, unknown>;
}

/** `meta` is only for pagination and per-request counters, never for data. */
export interface ApiMeta {
  next_cursor?: string | null;
  has_more?: boolean;
  total_estimate?: number | null;
}

export type Envelope<T> = { ok: true; data: T; meta?: ApiMeta } | { ok: false; error: ApiError };

export function ok<T>(data: T, meta?: ApiMeta): Envelope<T> {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}

/**
 * Turn an internal error into the envelope plus the HTTP status the contract
 * assigns to that code. Where a code has one, `detail.reason` carries the
 * nuance — a compliance block must say `class_x` or `login_wall`, because those
 * two need different reactions from the operator.
 */
export function fail(
  code: ErrorCode,
  detail?: Record<string, unknown>,
  message?: string,
): { body: Envelope<never>; status: number } {
  return {
    body: { ok: false, error: { code, message: message ?? ERROR_MESSAGES[code], detail } },
    status: ERROR_STATUS[code],
  };
}
