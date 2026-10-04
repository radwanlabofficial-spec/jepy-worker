/**
 * Pass 0 — the deterministic, cost-zero rule score.
 *
 * This is the cheapest thing in the system and the only thing that runs on
 * EVERY lead, so it carries the whole economics argument: an LLM call on a
 * business with no website, no email and no buying signal returns the same
 * answer it would return for any other such business, and it costs money to
 * learn that. 12-scoring.md §1 puts the number at roughly 70% of leads removed
 * before a token is spent.
 *
 * FOUR THINGS HERE ARE NOT OBVIOUS AND EACH ONE IS A DECISION, NOT AN ACCIDENT
 *
 * 1. A MISSING SIGNAL IS NOT A ZERO (12-scoring.md §2.5). "The probe has not run
 *    yet" and "the probe ran and found nothing" are different facts about a
 *    lead, and only the second is evidence. A signal that was never collected is
 *    dropped from both the numerator AND the denominator, and the remaining
 *    weights are renormalised — otherwise every freshly imported lead would
 *    score zero on the 130-odd leads-per-minute the importer runs at, and COLD
 *    would stop meaning anything.
 *
 *    `coverage` is how much of the 100-point allocation was actually available.
 *    Because it renormalises, a lead with 60% coverage can still score 90 — the
 *    score is only as trustworthy as the coverage, which is why coverage travels
 *    with it and why the tier rule refuses to grade a thin lead at all.
 *
 * 2. AN EXPIRED SIGNAL IS ALSO ABSENT (§2.5). `lead_signals.expires_at` is not
 *    decoration: a hiring signal from eight months ago must not keep a lead HOT
 *    forever. The filter is applied here rather than in the caller so that the
 *    breakdown endpoint and the scoring run can never disagree about which rows
 *    they were looking at.
 *
 * 3. BELOW 60% COVERAGE THE LEAD IS PROVISIONAL AND GETS NO TIER (§2.5). This is
 *    the load-bearing guard on the whole design. Without it, the twenty-odd
 *    points of Buying Signal — which is Wave 2 and does not exist yet — are
 *    simply missing, every score is depressed, and every lead looks COLD. The
 *    tier would then encode "how much of Wave 2 have we built" instead of "how
 *    good is this lead". `tier = NULL` is the honest answer and the console
 *    already renders it as "probe চলছে".
 *
 * 4. TWO BANDS BELOW ARE DERIVED, NOT QUOTED, and they are marked as such. The
 *    documents give `niche` ("priority niche = 100") and `geo_priority` ("per
 *    geo_targets.priority") without a formula, and `employee_estimate` without a
 *    band for 51-199. Inventing a formula silently would be worse than naming it:
 *    every derived band is a candidate for the first ADR the feedback loop
 *    produces, and `weight_history` cannot correct a number nobody labelled.
 *
 * WHERE THE PROBE CANNOT SEE, THIS FILE DOES NOT PRETEND. `ssl_cert` is the clear
 * case: 03-execution.md and 12-scoring.md §2.1 both describe certificate expiry,
 * and a Cloudflare Worker cannot read a peer certificate — `adapters/tech_probe.ts`
 * says so explicitly and returns `certificate_expiry_checked: 0`. The normaliser
 * below therefore scores what IS observable (does TLS complete at all, and is
 * HSTS present) and refuses to map a healthy fetch onto "certificate is valid",
 * which is the one conclusion the probe cannot support.
 */

export interface WeightRow {
  feature_key: string;
  weight: number;
}

export interface SignalInput {
  signal_key: string;
  signal_value_num: number | null;
  signal_value_text: string | null;
  collected_at: number;
  expires_at: number | null;
}

export interface FeatureContribution {
  feature_key: string;
  /** The points this feature is worth in the active version, before renormalising. */
  weight: number;
  /** Was a non-expired row collected for this feature? */
  present: boolean;
  /** There was a row, but it is past its TTL — reported so the console can say why. */
  expired: boolean;
  raw_num: number | null;
  raw_text: string | null;
  /** 0-100, or null when nothing usable was collected. */
  normalized: number | null;
  /** `normalized × weight ÷ 100`. Summed these give the weighted mean below. */
  contribution: number;
}

export interface RuleScoreResult {
  /** 0-100, integer. */
  rule_score: number;
  /** Share of the 100-point allocation that was available: 0-1. */
  coverage: number;
  /** 1 when coverage < 0.60. Such a lead gets no tier (§2.5). */
  is_provisional: number;
  weights_version: number;
  available_weight: number;
  features: FeatureContribution[];
}

/** The threshold below which a lead has not been probed enough to be graded. */
export const PROVISIONAL_COVERAGE_FLOOR = 0.6;

/** Feature keys this pass understands. Wave 2 keys are listed because they are
 *  already allocated points in v1; they simply have no collector yet, so they
 *  arrive as absent and are renormalised away. */
export const PASS0_FEATURES = [
  'psi_mobile',
  'wayback_last_change',
  'ssl_cert',
  'tech_stack',
  'robots_sitemap',
  'email',
  'phone_e164',
  'dns_mx',
  'website_meta',
  'job_postings_ats',
  'meta_ad_library',
  'funding_news',
  'new_domain_reg',
  'review_velocity',
  'niche',
  'employee_estimate',
  'geo_priority',
  'dataset_confidence',
] as const;

const YEAR_DAYS = 365;

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** The band table shared by `niche` and `geo_priority`, keyed on 1-5 priority.
 *  DERIVED — 12-scoring.md §2.4 says only "priority niche = 100" and "per
 *  geo_targets.priority" and gives no formula. Documented here so the first
 *  feedback-loop correction has something concrete to correct. */
function priorityBand(priority: number | null): number | null {
  if (priority === null || !Number.isFinite(priority)) return null;
  const table: Record<number, number> = { 1: 100, 2: 80, 3: 60, 4: 40, 5: 20 };
  return table[Math.round(priority)] ?? null;
}

/**
 * One normaliser per feature key: raw signal → 0-100, or null for "not usable".
 *
 * Returning null is not the same as returning 0 and the difference is the point
 * of the whole file — null drops the feature from the denominator, 0 keeps it and
 * says "we looked, and it is bad".
 */
type Normaliser = (row: SignalInput, ctx: ScoreContext) => number | null;

export interface ScoreContext {
  /** `leads.has_website`: null unprobed, 0 no site, 1 site answered. */
  hasWebsite: number | null;
  /** `leads.phone_e164` — collected with the lead, so it never arrives as a signal row. */
  phoneE164: string | null;
  /** `niches.priority` for the lead's niche. */
  nichePriority: number | null;
  /** `geo_targets.priority` for the lead's country/region. */
  geoPriority: number | null;
  /** True when both `overture_id` and `fsq_id` are populated. */
  dualSourced: boolean;
  /** True when exactly one of the two ids is populated. */
  singleSourced: boolean;
}

const NORMALISERS: Record<string, Normaliser> = {
  // 0-40 = 100, 40-70 = 60, 70+ = 15. INVERTED on purpose: a slow mobile page is
  // the opportunity, so the worse the score the more points the lead earns.
  psi_mobile: (row) => {
    const score = row.signal_value_num;
    if (score === null || !Number.isFinite(score)) return null;
    if (score <= 40) return 100;
    if (score <= 70) return 60;
    return 15;
  },

  // Signal value is the site's age in DAYS since the last change. >3 years = 100,
  // 1-3 years = 60, under a year = 10. A site nobody has touched in three years
  // is a site whose owner has stopped caring about it.
  wayback_last_change: (row) => {
    const days = row.signal_value_num;
    if (days === null || !Number.isFinite(days)) return null;
    if (days >= 3 * YEAR_DAYS) return 100;
    if (days >= YEAR_DAYS) return 60;
    return 10;
  },

  // What the platform can actually observe. A `signal_value_text` of
  // 'expired'/'self_signed' means the collector learned it another way and wins;
  // otherwise TLS completion and HSTS are the standing proxies, and a site that
  // completes TLS with HSTS is scored 0 rather than assumed valid.
  ssl_cert: (row) => {
    const text = (row.signal_value_text ?? '').toLowerCase();
    if (text.includes('expired') || text.includes('self_signed') || text.includes('self-signed')) return 100;
    const value = row.signal_value_num;
    if (value === null || !Number.isFinite(value)) return null;
    // The collector writes 1 for "TLS completed", 0 for "it did not".
    if (value === 0) return 100;
    if (text.includes('no_hsts')) return 70;
    return 0;
  },

  // Old builder/CMS = 80, a modern stack = 10, and +20 on top when the page loads
  // no analytics at all (12-scoring.md §2.1). The analytics half is a real signal
  // about whether anyone is measuring anything; the collector fetches the
  // homepage anyway, so it costs nothing to look.
  tech_stack: (row, ctx) => {
    // No website is the extreme of "website pain" and the single signal STEP 8
    // calls the most valuable free one. It saturates the feature rather than
    // being routed to a column of its own, because 12-scoring.md §2.1 allocates
    // the points here and the weights are seed data, not something to re-cut
    // without an ADR.
    if (ctx.hasWebsite === 0) return 100;

    const text = (row.signal_value_text ?? '').toLowerCase();
    if (!text) return null;
    const markers = text.split(/[,|]/).map((part) => part.trim()).filter(Boolean);
    if (markers.length === 0) return null;

    const OLD = ['wordpress', 'wix', 'squarespace', 'joomla', 'drupal', 'godaddy', 'weebly'];
    const MODERN = ['shopify', 'next.js', 'nextjs', 'react', 'webflow', 'framer', 'vercel'];

    const base = markers.some((marker) => OLD.includes(marker))
      ? 80
      : markers.some((marker) => MODERN.includes(marker))
        ? 10
        : 50;
    const analyticsPenalty = markers.includes('no_analytics') ? 20 : 0;
    return clamp100(base + analyticsPenalty);
  },

  // "No sitemap, or fewer than five pages". Both are the same story: a site too
  // small or too neglected to be indexed properly.
  robots_sitemap: (row) => {
    if (row.signal_value_num === null || !Number.isFinite(row.signal_value_num)) return null;
    const pageCount = row.signal_value_num;
    const hasSitemap = (row.signal_value_text ?? '').includes('sitemap');
    if (!hasSitemap || pageCount < 5) return 70;
    return 0;
  },

  // Reachability is what the outreach actually depends on, so "no address found"
  // is a real 0 rather than an absence: the probe ran, and it looked.
  email: (row) => {
    const text = (row.signal_value_text ?? '').toLowerCase();
    if (text === 'valid') return 100;
    if (text === 'syntax_ok') return 50;
    if (text === 'none') return 0;
    const num = row.signal_value_num;
    if (num === null || !Number.isFinite(num)) return null;
    return clamp100(num);
  },

  // Read from the lead row itself rather than from a probe: an imported phone is
  // already E.164 or it is not, and §2.2 scores that as a binary.
  phone_e164: (_row, ctx) => {
    // The context wins when present, because a phone on the lead is a fact about
    // the lead; the row only exists so the feature can be reported as present.
    if (ctx.phoneE164 && ctx.phoneE164.startsWith('+')) return 100;
    return 0;
  },

  // Business mail is the strong signal; a generic provider is still reachable but
  // tells you less about whether anyone works there.
  dns_mx: (row) => {
    const hosts = (row.signal_value_text ?? '').toLowerCase();
    const num = row.signal_value_num;
    if (num === 0 || hosts === 'none') return 0;
    if (hosts.includes('google') || hosts.includes('outlook') || hosts.includes('microsoft')) return 100;
    if (num !== null && Number.isFinite(num) && num > 0) return 60;
    return null;
  },

  // A published contact route on the site. §2.2 gives one band, so this is a
  // binary: found or not found.
  website_meta: (row) => {
    const text = (row.signal_value_text ?? '').toLowerCase();
    if (text === 'contact_found') return 100;
    if (text === 'contact_absent') return 0;
    const num = row.signal_value_num;
    if (num === null || !Number.isFinite(num)) return null;
    return num > 0 ? 100 : 0;
  },

  // ---- Wave 2. No collector exists yet (STEP 14). Listed so the numbers below
  // ---- are ready the moment one does, and so a v1 weight row can never be
  // ---- silently unhandled.
  job_postings_ats: (row) => {
    const text = (row.signal_value_text ?? '').toLowerCase();
    if (text === 'active') return 100;
    if (text === 'within_90d') return 50;
    if (text === 'none') return 0;
    return null;
  },
  meta_ad_library: (row) => {
    const text = (row.signal_value_text ?? '').toLowerCase();
    if (text === 'active') return 100;
    if (text === 'none') return 0;
    return null;
  },
  funding_news: (row) => {
    const days = row.signal_value_num;
    if (days === null || !Number.isFinite(days)) return null;
    return days <= 182 ? 100 : 0;
  },
  new_domain_reg: (row) => {
    const days = row.signal_value_num;
    if (days === null || !Number.isFinite(days)) return null;
    return days < YEAR_DAYS ? 100 : 0;
  },
  review_velocity: (row) => {
    const value = row.signal_value_num;
    if (value === null || !Number.isFinite(value)) return null;
    return value > 0 ? 100 : 0;
  },

  // ---- Fit.
  niche: (_row, ctx) => priorityBand(ctx.nichePriority),
  geo_priority: (_row, ctx) => priorityBand(ctx.geoPriority),

  // 5-50 is the sweet spot: big enough to have a budget, small enough that the
  // owner answers their own email. 1-4 and 200+ are the two ends the documents
  // name; 51-199 is DERIVED (12-scoring.md §2.4 defines only the three bands).
  employee_estimate: (row) => {
    const size = row.signal_value_num;
    if (size === null || !Number.isFinite(size) || size <= 0) return null;
    if (size >= 5 && size <= 50) return 100;
    if (size <= 4) return 50;
    if (size >= 200) return 20;
    return 60;
  },

  // Two independent open datasets agreeing on the same business is corroboration
  // and nothing else in Wave 1 has it (§2.4).
  dataset_confidence: (_row, ctx) => {
    if (ctx.dualSourced) return 100;
    if (ctx.singleSourced) return 50;
    return 0;
  },
};

/**
 * Computes the rule score. Pure: no database, no clock, no fetch. `now` is a
 * parameter so the expiry filter is testable and so a replay of a historical
 * batch reproduces the score it produced at the time.
 */
export function computeRuleScore(input: {
  weights: WeightRow[];
  signals: SignalInput[];
  weightsVersion: number;
  context: ScoreContext;
  now: number;
}): RuleScoreResult {
  const { weights, signals, context, now } = input;

  const byKey = new Map<string, SignalInput>();
  for (const signal of signals) byKey.set(signal.signal_key, signal);

  const features: FeatureContribution[] = [];
  let availableWeight = 0;
  let weightedSum = 0;

  for (const row of weights) {
    const signal = byKey.get(row.feature_key);
    const normaliser = NORMALISERS[row.feature_key];

    if (!normaliser) {
      // A weight version naming a feature this engine does not implement. Keep
      // the feature visible in the breakdown rather than dropping it: the sum
      // would silently stop being 100 and the score would drift without anyone
      // being able to see why.
      features.push({
        feature_key: row.feature_key,
        weight: row.weight,
        present: false,
        expired: false,
        raw_num: null,
        raw_text: null,
        normalized: null,
        contribution: 0,
      });
      continue;
    }

    const expired = signal !== undefined && signal.expires_at !== null && signal.expires_at <= now;
    const usable = signal !== undefined && !expired;
    const normalized = usable ? normaliser(signal, context) : null;

    const contribution = normalized === null ? 0 : (normalized * row.weight) / 100;

    features.push({
      feature_key: row.feature_key,
      weight: row.weight,
      present: signal !== undefined,
      expired,
      raw_num: signal?.signal_value_num ?? null,
      raw_text: signal?.signal_value_text ?? null,
      normalized,
      contribution,
    });

    if (normalized !== null) {
      availableWeight += row.weight;
      weightedSum += contribution;
    }
  }

  // Renormalise over what was available. With nothing available there is no
  // score to report — 0 would read as "we looked and this lead is terrible",
  // which is exactly the confusion §2.5 exists to prevent.
  const coverage = availableWeight > 0 ? availableWeight / 100 : 0;
  const ruleScore = availableWeight > 0 ? Math.round((weightedSum / availableWeight) * 100) : 0;

  return {
    rule_score: clamp100(ruleScore),
    coverage: Math.round(coverage * 1000) / 1000,
    is_provisional: coverage < PROVISIONAL_COVERAGE_FLOOR ? 1 : 0,
    weights_version: input.weightsVersion,
    available_weight: availableWeight,
    features,
  };
}

/**
 * Tier assignment, deliberately separate from the score.
 *
 * Two rules live here that do not belong in the arithmetic:
 *   - a provisional lead gets NO tier, not COLD (§2.5);
 *   - a lead already in a conversation does not silently drop a tier when its
 *     score moves (§5.3). Score and tier are different promises: the score
 *     describes the lead, the tier describes what the operator has already
 *     decided to do about it. Manual edits always win (R7).
 */
export type Tier = 'HOT' | 'WARM' | 'COLD';

export function resolveTier(input: {
  finalScore: number;
  isProvisional: number;
  currentStatus: string | null;
  currentTier: string | null;
  isManualEdited: number;
}): Tier | null {
  if (input.isProvisional === 1) return null;

  const graded: Tier = input.finalScore >= 70 ? 'HOT' : input.finalScore >= 40 ? 'WARM' : 'COLD';

  // A tier is only ever one of three strings, or absent. `leads.tier` carries a
  // CHECK constraint that says so; the cast is the boundary where the database's
  // TEXT meets that constraint, and it is deliberately narrow.
  const current = input.currentTier as Tier | null;

  const CONVERSATION_STARTED = ['contacted', 'replied', 'dead'];
  const held =
    current !== null &&
    !input.isManualEdited &&
    CONVERSATION_STARTED.includes(input.currentStatus ?? '');

  if (held) {
    const order: Record<Tier, number> = { COLD: 0, WARM: 1, HOT: 2 };
    // Downgrade only, never a promotion: §5.3 is about protecting a running
    // conversation, and letting a rising score promote a contacted lead would
    // push it back into outreach it has already had.
    return order[graded] < order[current] ? current : graded;
  }

  return graded;
}

/** The final score. 0.6 × rule + 0.4 × AI when AI ran; the rule score alone when
 *  it did not. AI is never counted as zero (§1) — a gate that never admitted
 *  this lead is not evidence that the lead is bad. */
export function computeFinalScore(ruleScore: number, aiScore: number | null): number {
  if (aiScore === null) return clamp100(ruleScore);
  return clamp100(Math.round(0.6 * ruleScore + 0.4 * aiScore));
}
