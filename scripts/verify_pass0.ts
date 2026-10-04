/**
 * Verifies the Pass 0 arithmetic against 12-scoring.md §2.
 *
 * The weights here are the v1 allocation exactly as `seed.sql` inserts it, so
 * this file fails the moment the seed and the scoring engine disagree about what
 * the eighteen features are or what they are worth. That is the point: the
 * weights are seed data and the normalisers are code, and nothing else checks
 * that the two still describe the same system.
 *
 * Run: node --experimental-strip-types scripts/verify_pass0.ts
 */

import {
  computeFinalScore,
  computeRuleScore,
  resolveTier,
  PROVISIONAL_COVERAGE_FLOOR,
} from '../src/scoring/pass0.ts';
import type { ScoreContext, SignalInput, WeightRow } from '../src/scoring/pass0.ts';

const NOW = 1_800_000_000;
const DAY = 86_400;

// seed.sql §C, verbatim: 18 features summing to 100.
const WEIGHTS: WeightRow[] = [
  { feature_key: 'psi_mobile', weight: 12 },
  { feature_key: 'wayback_last_change', weight: 8 },
  { feature_key: 'ssl_cert', weight: 5 },
  { feature_key: 'tech_stack', weight: 6 },
  { feature_key: 'robots_sitemap', weight: 4 },
  { feature_key: 'email', weight: 10 },
  { feature_key: 'phone_e164', weight: 6 },
  { feature_key: 'dns_mx', weight: 5 },
  { feature_key: 'website_meta', weight: 4 },
  { feature_key: 'job_postings_ats', weight: 8 },
  { feature_key: 'meta_ad_library', weight: 7 },
  { feature_key: 'funding_news', weight: 4 },
  { feature_key: 'new_domain_reg', weight: 3 },
  { feature_key: 'review_velocity', weight: 3 },
  { feature_key: 'niche', weight: 6 },
  { feature_key: 'employee_estimate', weight: 4 },
  { feature_key: 'geo_priority', weight: 3 },
  { feature_key: 'dataset_confidence', weight: 2 },
];

const NEUTRAL_CONTEXT: ScoreContext = {
  hasWebsite: 1,
  phoneE164: '+8801700000000',
  nichePriority: 3,
  geoPriority: 3,
  dualSourced: true,
  singleSourced: false,
};

function signal(
  key: string,
  num: number | null,
  text: string | null = null,
  expiresInDays: number | null = null,
): SignalInput {
  return {
    signal_key: key,
    signal_value_num: num,
    signal_value_text: text,
    collected_at: NOW - DAY,
    expires_at: expiresInDays === null ? null : NOW + expiresInDays * DAY,
  };
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

const weightTotal = WEIGHTS.reduce((sum, w) => sum + w.weight, 0);
console.log(`weight total = ${weightTotal} (12-scoring.md §9.3 requires 100)`);
check('weights sum to 100', weightTotal, 100);

// ---------------------------------------------------------------------------
// 1. Every signal present, every one of them a good signal.
// ---------------------------------------------------------------------------
console.log('\n1. perfect lead — all 18 signals present');
const perfect = computeRuleScore({
  weights: WEIGHTS,
  weightsVersion: 1,
  now: NOW,
  context: NEUTRAL_CONTEXT,
  signals: [
    signal('psi_mobile', 95, null, 30),
    signal('wayback_last_change', 30, null, 30),
    signal('ssl_cert', 1, 'tls_ok', 30),
    signal('tech_stack', null, 'shopify,next.js', 30),
    signal('robots_sitemap', 40, 'sitemap', 30),
    signal('email', 2, 'valid', 30),
    signal('phone_e164', 100, null, null),
    signal('dns_mx', 1, 'aspmx.l.google.com', 30),
    signal('website_meta', 1, 'contact_found', 30),
    signal('job_postings_ats', null, 'active', 45),
    signal('meta_ad_library', null, 'active', 30),
    signal('funding_news', 20, null, 30),
    signal('new_domain_reg', 400, null, 30),
    signal('review_velocity', 0, null, 90),
    signal('niche', 1, null, null),
    signal('employee_estimate', 20, null, null),
    signal('geo_priority', 1, null, null),
    signal('dataset_confidence', 100, null, null),
  ],
});
check('coverage is 1.0', perfect.coverage, 1);
check('not provisional', perfect.is_provisional, 0);
// Worked by hand from §2 so the expectation is arithmetic and not a snapshot of
// whatever the code happened to print:
//   psi        95  -> >70        -> 15  x0.12 = 1.8
//   wayback    30d -> <1y        -> 10  x0.08 = 0.8
//   ssl        tls_ok            ->  0  x0.05 = 0
//   tech_stack shopify,next.js   -> 10  x0.06 = 0.6
//   robots     40 pages +sitemap ->  0  x0.04 = 0
//   email      valid             -> 100 x0.10 = 10
//   phone      +                  -> 100 x0.06 = 6
//   dns_mx     google             -> 100 x0.05 = 5
//   website_meta contact_found    -> 100 x0.04 = 4
//   job_postings active           -> 100 x0.08 = 8
//   meta_ads   active             -> 100 x0.07 = 7
//   funding    20d                -> 100 x0.04 = 4
//   new_domain 400d               ->   0 x0.03 = 0
//   reviews    0                  ->   0 x0.03 = 0
//   niche      priority 3        ->  60 x0.06 = 3.6   <- from the CONTEXT, not the row
//   employee   20                 -> 100 x0.04 = 4
//   geo        priority 3        ->  60 x0.03 = 1.8   <- from the CONTEXT, not the row
//   dataset    dual source        -> 100 x0.02 = 2
//                                                    ----
//                                                    58.6 -> 59
check('rule_score', perfect.rule_score, 59);

// `niche` and `geo_priority` are scored from the lead's own attributes, not from
// the signal value. The row only has to exist for the feature to count towards
// coverage, which this asserts so a future refactor cannot quietly switch them
// to reading the row.
check(
  'niche reads the context priority, not the row value',
  perfect.features.find((f) => f.feature_key === 'niche')?.normalized,
  60,
);

// ---------------------------------------------------------------------------
// 2. The lead the whole thesis is about: no website at all.
// ---------------------------------------------------------------------------
console.log('\n2. no website — the most valuable free signal');
const noSite = computeRuleScore({
  weights: WEIGHTS,
  weightsVersion: 1,
  now: NOW,
  context: { ...NEUTRAL_CONTEXT, hasWebsite: 0, phoneE164: null },
  signals: [
    signal('tech_stack', null, 'no_website', null),
    signal('phone_e164', 0, null, null),
    signal('dataset_confidence', 100, null, null),
  ],
});
check('has_website=0 saturates tech_stack at 100', noSite.features.find((f) => f.feature_key === 'tech_stack')?.normalized, 100);
check('phone absent scores 0', noSite.features.find((f) => f.feature_key === 'phone_e164')?.normalized, 0);
check('available weight is 6+6+2 = 14', noSite.available_weight, 14);
check('coverage 0.14', noSite.coverage, 0.14);
check('provisional, because 14% < 60%', noSite.is_provisional, 1);
check('no tier for a provisional lead', resolveTier({
  finalScore: noSite.rule_score,
  isProvisional: noSite.is_provisional,
  currentStatus: 'new',
  currentTier: null,
  isManualEdited: 0,
}), null);

// ---------------------------------------------------------------------------
// 3. Missing signals must be dropped from the denominator, not counted as zero.
// ---------------------------------------------------------------------------
console.log('\n3. renormalisation — a thin lead is not a bad lead');
const thin = computeRuleScore({
  weights: WEIGHTS,
  weightsVersion: 1,
  now: NOW,
  context: NEUTRAL_CONTEXT,
  signals: [signal('psi_mobile', 30, null, 30), signal('ssl_cert', 1, 'tls_ok_no_hsts', 30)],
});
// psi 30 -> <=40 -> 100 x0.12 = 12    (a slow mobile page is the opportunity)
// ssl  1 + no HSTS -> 70 x0.05 = 3.5  (TLS completes, but nothing is pinned)
// 15.5 / 17 = 91.2 -> 91
check('available weight is 12+5 = 17', thin.available_weight, 17);
check('rule_score renormalised over 17, not 100', thin.rule_score, 91);
check('still provisional, because 17% < 60%', thin.is_provisional, 1);
// The renormalisation is the whole point: a lead probed only for page speed and
// TLS scores 91 on the evidence available. It is NOT 15.5 out of 100, and it is
// NOT graded — it is 91 with 17% coverage, which is a different statement.
check(
  'a missing feature contributes nothing and is not counted',
  thin.features.find((f) => f.feature_key === 'email')?.contribution,
  0,
);

// ---------------------------------------------------------------------------
// 4. An expired signal is absent, not zero (12-scoring.md §2.5).
// ---------------------------------------------------------------------------
console.log('\n4. expiry — a stale measurement stops counting');
const expired = computeRuleScore({
  weights: WEIGHTS,
  weightsVersion: 1,
  now: NOW,
  context: NEUTRAL_CONTEXT,
  signals: [
    signal('psi_mobile', 30, null, 30),
    // Collected, but 10 days past its TTL.
    { signal_key: 'wayback_last_change', signal_value_num: 5, signal_value_text: null, collected_at: NOW - 60 * DAY, expires_at: NOW - 10 * DAY },
  ],
});
check('expired wayback dropped from the denominator', expired.available_weight, 12);
check('the row is still reported as expired', expired.features.find((f) => f.feature_key === 'wayback_last_change')?.expired, true);
check('an expired row contributes nothing', expired.features.find((f) => f.feature_key === 'wayback_last_change')?.contribution, 0);

// ---------------------------------------------------------------------------
// 5. The final score never treats a gate rejection as a zero (§1).
// ---------------------------------------------------------------------------
console.log('\n5. final score with and without AI');
check('no AI -> rule alone (not 0.6 x it)', computeFinalScore(80, null), 80);
check('AI present -> 0.6/0.4 blend', computeFinalScore(80, 50), 68);

// ---------------------------------------------------------------------------
// 6. Tiers, including the conversation guard (§5.3).
// ---------------------------------------------------------------------------
console.log('\n6. tiers');
const tier = (finalScore: number, status: string, currentTier: string | null, edited = 0) =>
  resolveTier({ finalScore, isProvisional: 0, currentStatus: status, currentTier, isManualEdited: edited });
check('72 -> HOT', tier(72, 'new', null), 'HOT');
check('70 -> HOT (boundary)', tier(70, 'new', null), 'HOT');
check('69 -> WARM (boundary)', tier(69, 'new', null), 'WARM');
check('40 -> WARM (boundary)', tier(40, 'new', null), 'WARM');
check('39 -> COLD (boundary)', tier(39, 'new', null), 'COLD');
check('a contacted lead keeps HOT when the score falls', tier(30, 'contacted', 'HOT'), 'HOT');
check('a contacted lead still promotes upward', tier(80, 'contacted', 'WARM'), 'HOT');
check('a manual tier is never overwritten (R7)', tier(30, 'contacted', 'HOT', 1), 'COLD');
check('replied leads are protected too', tier(30, 'replied', 'WARM'), 'WARM');
check('a new lead is graded freely', tier(30, 'new', 'HOT'), 'COLD');

console.log(`\ncoverage floor = ${PROVISIONAL_COVERAGE_FLOOR}`);
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
