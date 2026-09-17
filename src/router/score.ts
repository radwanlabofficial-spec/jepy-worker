/**
 * Candidate scoring (09-router.md §5).
 *
 *   score = w_cost    × cost_score
 *         + w_quality × (quality / 100)
 *         + w_success × success_rate_7d
 *         + w_latency × latency_score
 *         + w_free    × (requires_credential = 0 ? 1 : 0)
 *         − penalty
 *
 * Weights live in `settings.router_weights_json` and changing them needs an ADR,
 * because they move money. The defaults are 0.40 / 0.25 / 0.20 / 0.10 / 0.05 —
 * cost carries two fifths of the decision, which is the whole point of R10: the
 * system should prefer the free hop, and only pay when the free hops are gone.
 *
 * TWO THINGS SIT ABOVE THIS FILE AND NEITHER IS A WEIGHT.
 *
 * `Tier 0 gate` (R10): if any surviving candidate is credential-free, hop 1 must
 * be one of those, whatever it scored. No weight setting can switch this off.
 * It is applied in `applyTier0`, not folded into the formula, because a gate that
 * can be outvoted by arithmetic is not a gate.
 *
 * `Budget pressure modifier` (06 §3): once BrightData is 70% through its monthly
 * credits, `w_cost` rises to 0.60 for the rest of the month. This is a runtime
 * modifier, NOT a weight change — it needs no ADR — but it is recorded in
 * `route_attempts.note` so a decision made under pressure can still be explained
 * afterwards. Without that flag, the same candidate set would appear to produce
 * two different orderings for no visible reason.
 *
 * NULLs. The seed left `quality` and `avg_latency_ms` NULL wherever the documents
 * did not state them, which is most rows. The tempting reading — NULL is 0 — is
 * wrong in a way that is hard to see: it silently penalises every unmeasured
 * provider by the full weight of the term. An unknown value contributes the
 * midpoint of its own range instead (0.5), and the attempt note records that the
 * number was unknown, so nobody later mistakes a neutral 0.5 for a measured 50.
 */

import type { Candidate, ScoredCandidate, ScoreComponents } from './types';

export interface RouterWeights {
  w_cost: number;
  w_quality: number;
  w_success: number;
  w_latency: number;
  w_free: number;
}

export const DEFAULT_WEIGHTS: RouterWeights = {
  w_cost: 0.4,
  w_quality: 0.25,
  w_success: 0.2,
  w_latency: 0.1,
  w_free: 0.05,
};

/** Budget pressure is a documented runtime modifier, not a tunable. */
const PRESSURE_W_COST = 0.6;
const PRESSURE_TRIGGER = 0.7;

/** Below this many attempts the observed rate is noise, so the prior is used. */
const SUCCESS_RATE_MIN_ATTEMPTS = 20;
const SUCCESS_RATE_PRIOR = 0.7;

/** Latency that scores zero. 20 s is the number the document names. */
const LATENCY_CEILING_MS = 20_000;

const PENALTY_PER_FAILURE = 0.05;
const PENALTY_CAP = 0.3;

const NEUTRAL = 0.5;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export async function loadWeights(db: D1Database): Promise<RouterWeights> {
  const row = await db
    .prepare(`SELECT value_text FROM settings WHERE key = 'router_weights_json'`)
    .first<{ value_text: string | null }>();

  if (!row?.value_text) return { ...DEFAULT_WEIGHTS };
  try {
    const parsed = JSON.parse(row.value_text) as Partial<RouterWeights>;
    // A malformed or partial row falls back rather than producing NaN scores.
    // A NaN would sort unpredictably and the reason would not be visible.
    const merged: RouterWeights = {
      w_cost: num(parsed.w_cost, DEFAULT_WEIGHTS.w_cost),
      w_quality: num(parsed.w_quality, DEFAULT_WEIGHTS.w_quality),
      w_success: num(parsed.w_success, DEFAULT_WEIGHTS.w_success),
      w_latency: num(parsed.w_latency, DEFAULT_WEIGHTS.w_latency),
      w_free: num(parsed.w_free, DEFAULT_WEIGHTS.w_free),
    };
    const total = merged.w_cost + merged.w_quality + merged.w_success + merged.w_latency + merged.w_free;
    return total > 0 ? merged : { ...DEFAULT_WEIGHTS };
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * True when BrightData is at or past 70% of its monthly allowance.
 *
 * Read from `provider_accounts` rather than from the credit log: the log is a
 * record of what we spent, the account row is the provider's own view of the
 * remaining allowance, and budget pressure should follow the provider's number.
 */
export async function budgetPressure(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(quota_used), 0) AS used, COALESCE(SUM(quota_limit), 0) AS cap
         FROM provider_accounts
        WHERE provider = 'brightdata' AND quota_limit IS NOT NULL AND quota_limit > 0`,
    )
    .first<{ used: number; cap: number }>();

  if (!row || row.cap <= 0) return false;
  return row.used / row.cap >= PRESSURE_TRIGGER;
}

export interface SuccessStats {
  rate: number;
  attempts: number;
  failureStreak: number;
}

/**
 * Observed outcome per provider over the last seven days.
 *
 * `empty` counts as a failure here exactly as it does in the state machine
 * (R19): a provider that answers with nothing is not a provider that works.
 */
export async function successStats(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, SuccessStats>> {
  const since = now - 7 * 86400;
  const rows = await db
    .prepare(
      `SELECT provider,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS wins,
              MAX(created_at) AS last_at
         FROM route_attempts
        WHERE created_at >= ? AND provider IS NOT NULL
        GROUP BY provider`,
    )
    .bind(since)
    .all<{ provider: string; total: number; wins: number; last_at: number }>();

  // The failure streak is not the last-7-days rate: a provider that failed three
  // times in a row ten minutes ago should be avoided now, even if it has a good
  // week behind it. So the streak is read from the most recent attempts, newest
  // first, and stops at the first success.
  const recent = await db
    .prepare(
      `SELECT provider, outcome
         FROM route_attempts
        WHERE provider IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 300`,
    )
    .all<{ provider: string; outcome: string | null }>();

  const streaks = new Map<string, number>();
  const closed = new Set<string>();
  for (const row of recent.results ?? []) {
    if (closed.has(row.provider)) continue;
    if (row.outcome === 'success') {
      closed.add(row.provider);
      continue;
    }
    streaks.set(row.provider, (streaks.get(row.provider) ?? 0) + 1);
  }

  const out = new Map<string, SuccessStats>();
  for (const row of rows.results ?? []) {
    const attempts = row.total ?? 0;
    out.set(row.provider, {
      rate: attempts >= SUCCESS_RATE_MIN_ATTEMPTS ? (row.wins ?? 0) / attempts : SUCCESS_RATE_PRIOR,
      attempts,
      failureStreak: streaks.get(row.provider) ?? 0,
    });
  }
  // A provider with a failure streak but no successes in the window still needs
  // an entry, otherwise the penalty would never apply to the worst case.
  for (const [provider, streak] of streaks) {
    if (!out.has(provider)) {
      out.set(provider, { rate: SUCCESS_RATE_PRIOR, attempts: 0, failureStreak: streak });
    }
  }
  return out;
}

export interface ScoredSet {
  ranked: ScoredCandidate[];
  /** Candidates that passed the filters and can be tried, in order. */
  note: string[];
}

/**
 * Scores and orders a filtered candidate set.
 *
 * Deterministic by construction: the sort key ends in `account_label`, so two
 * runs over the same rows produce the same order. `Array.prototype.sort` is
 * stable in the Workers runtime, but relying on stability to break a tie would
 * make the order depend on the order the rows came back from D1, which is not a
 * promise anyone made.
 */
export function rankCandidates(
  candidates: Candidate[],
  weights: RouterWeights,
  stats: Map<string, SuccessStats>,
  underPressure: boolean,
): ScoredSet {
  if (candidates.length === 0) return { ranked: [], note: [] };

  const w = underPressure ? { ...weights, w_cost: PRESSURE_W_COST } : weights;

  // `cost_score` is relative within this candidate set: the most expensive
  // option scores zero on cost and everything else is measured against it. With
  // no priced candidate every cost score is 1, which is correct — there is
  // nothing to choose between.
  const prices = candidates.map((candidate) => candidate.cost_micro_per_unit ?? 0);
  const maxCost = Math.max(...prices, 0);

  const note: string[] = [];
  if (underPressure) note.push('budget pressure: w_cost raised to 0.60');

  const ranked: ScoredCandidate[] = candidates.map((candidate) => {
    const stat = stats.get(candidate.provider);
    const successRate = stat?.rate ?? SUCCESS_RATE_PRIOR;
    const failureStreak = stat?.failureStreak ?? 0;

    const free = candidate.requires_credential === 0;

    let costScore: number;
    if (free) {
      costScore = 1;
    } else if (candidate.cost_micro_per_unit === null) {
      // Unknown price on a paid provider. Neutral, and said out loud.
      costScore = NEUTRAL;
      note.push(`${candidate.provider}: cost unknown`);
    } else if (maxCost <= 0) {
      costScore = 1;
    } else {
      costScore = 1 - candidate.cost_micro_per_unit / maxCost;
    }

    let qualityTerm: number;
    if (candidate.quality === null) {
      qualityTerm = NEUTRAL;
      note.push(`${candidate.provider}: quality unmeasured`);
    } else {
      qualityTerm = clamp01(candidate.quality / 100);
    }

    let latencyScore: number;
    if (candidate.avg_latency_ms === null) {
      latencyScore = NEUTRAL;
    } else {
      latencyScore = clamp01(1 - candidate.avg_latency_ms / LATENCY_CEILING_MS);
    }

    const penalty = Math.min(PENALTY_CAP, failureStreak * PENALTY_PER_FAILURE);

    const components: ScoreComponents = {
      cost: costScore,
      quality: qualityTerm,
      success: successRate,
      latency: latencyScore,
      free: free ? 1 : 0,
      penalty,
      success_rate_7d: successRate,
      failure_streak: failureStreak,
    };

    const score =
      w.w_cost * costScore +
      w.w_quality * qualityTerm +
      w.w_success * successRate +
      w.w_latency * latencyScore +
      w.w_free * components.free -
      penalty;

    return { ...candidate, score, components, tier0: free };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const left = a.accounts[0]?.account_label ?? a.capability_id;
    const right = b.accounts[0]?.account_label ?? b.capability_id;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return { ranked, note };
}

/**
 * The Tier 0 gate (R10) and the R20 floor.
 *
 * ---------------------------------------------------------------------------
 * A CORRECTION, because two documents disagree and the rule itself settles it.
 *
 * 09-router.md §8 says "the last hop must always be credential-free (R20)". Read
 * literally, that forbids the chain shape the same section describes three lines
 * earlier — free → brightdata → apify/extension — because both of the last two
 * are paid. Applied to `applyTier0` it would truncate almost every chain to a
 * single hop, quietly gutting the fallback the engine is built around.
 *
 * R20's own text (02-rules.md, group E) is narrower and different:
 *
 *   "Every target_type must have at least one credential-free provider — a GHA
 *    scraper or a direct fetch. `seed.sql` checks this and FAILS if it is not
 *    met."
 *
 * That is a floor on the POOL, not a constraint on the chain. It exists so lead
 * flow survives every API key dying at once — slower, lower quality, still
 * running. So this function enforces R10 exactly and treats R20 as what it is.
 *
 * WHAT IS ENFORCED:
 *
 *   R10  Hop 1 is pinned to a credential-free candidate whenever one exists,
 *        however the paid candidates scored. No weight setting can outvote it.
 *
 *   R20  If the filtered set contains NO credential-free option, the seed's floor
 *        is broken. The job is not dispatched: opening an all-paid chain would
 *        turn a seeding mistake into money. It goes to the manual path with R20
 *        named — the same "go back to STEP 3" signal 03-execution.md gives for
 *        this case.
 *
 * Order is otherwise preserved, so the highest-scoring free candidate leads and
 * the paid hops follow in score order.
 */
export function applyTier0(
  ranked: ScoredCandidate[],
  chainLength: number,
): { chain: ScoredCandidate[]; note: string[] } {
  const note: string[] = [];
  if (ranked.length === 0) return { chain: [], note: ['no candidates at all'] };

  const free = ranked.filter((candidate) => candidate.tier0);
  const paid = ranked.filter((candidate) => !candidate.tier0);

  if (free.length === 0) {
    note.push(
      `R20: no credential-free candidate for this target_type — the seed's floor is missing, so no chain is opened`,
    );
    return { chain: [], note };
  }

  // Hop 1 is free by rule; the rest follow in score order and may be paid. The
  // tiers are concatenated rather than interleaved so that the best free option
  // always leads, which is the whole content of R10.
  const chain = [...free, ...paid].slice(0, Math.max(1, chainLength));

  note.push(`R10: hop 1 pinned to credential-free ${chain[0]!.provider}`);
  if (chain.length > 1) {
    note.push(`fallback: ${chain.slice(1).map((c) => `${c.provider}${c.tier0 ? '(free)' : ''}`).join(' > ')}`);
  }
  return { chain, note };
}
