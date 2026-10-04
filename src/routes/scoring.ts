/**
 * Scoring — weights, weight history, AI usage.
 *
 * Shapes follow the console's declarations: `/scoring/weights` is an array of
 * rows, not an object carrying metadata. The earlier object shape made the page
 * call `.map` on a plain object, which threw during render and blanked the whole
 * application — the reason a crash boundary now exists in the console as well.
 *
 * `weight` is a point allocation summing to 100 per version, not a multiplier.
 * The 0.5-1.5 clamp in ADR-021 governs the weekly lift, which is what
 * `weight_history` records.
 *
 * Two contract fields have no column behind them and are returned as null rather
 * than invented: `sample_size` (a weight row has no sample; only a history row
 * does) and `label` (the schema stores keys, not display names). The console
 * renders null as an em dash, which is the same convention the rest of the
 * product uses for "not measured yet".
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import type { Actor, Env } from '../env';
import { computeRuleScore } from '../scoring/pass0';
import type { FeatureContribution, ScoreContext, SignalInput, WeightRow } from '../scoring/pass0';
import { PASS1_BATCH_SIZE } from '../scoring/pass1';
import { loadActiveWeights, scoreLeadPass0, scoreLeadPass1Batch } from '../scoring/run';

export const scoringRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

scoringRoutes.get('/scoring/weights', async (c) => {
  const active = await c.env.DB.prepare(
    `SELECT value_num AS version FROM settings WHERE key = 'active_weights_version'`,
  ).first<{ version: number | null }>();

  const version = active?.version ?? null;
  const rows = version === null
    ? { results: [] as Record<string, unknown>[] }
    : await c.env.DB.prepare(
        `SELECT feature_key              AS signal_key,
                feature_key              AS label,
                weight,
                version                  AS weights_version,
                created_at               AS updated_at,
                NULL                     AS sample_size
           FROM score_weights WHERE version = ? ORDER BY weight DESC, feature_key ASC`,
      )
        .bind(version)
        .all<Record<string, unknown>>();

  return c.json(ok(rows.results ?? []));
});

scoringRoutes.get('/scoring/history', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT week_key, feature_key AS signal_key, lift, sample_size, applied, created_at
       FROM weight_history ORDER BY week_key DESC, feature_key ASC LIMIT 200`,
  ).all();
  return c.json(ok(result.results ?? []));
});

scoringRoutes.get('/scoring/ai-usage', async (c) => {
  const [cap, today, month, byAccount] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(`SELECT value_num AS daily_cap FROM settings WHERE key = 'ai_daily_cap'`),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS requests FROM ai_score_log
        WHERE created_at >= unixepoch() - 86400`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(cost_micro), 0) AS cost_micro
         FROM ai_score_log WHERE created_at >= unixepoch() - 2592000`,
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(account_label, 'unassigned') AS account_label,
              COUNT(*) AS requests,
              COALESCE(SUM(cost_micro), 0) AS cost_micro
         FROM ai_score_log WHERE created_at >= unixepoch() - 2592000
        GROUP BY account_label ORDER BY requests DESC`,
    ),
  ]);
  if (!cap || !today || !month || !byAccount) throw new Error('batch result count mismatch');

  const monthRow = (month.results ?? [])[0] ?? {};
  const requestsMtd = Number(monthRow.requests ?? 0);

  // `share_pct` is computed here rather than in the browser so every surface
  // agrees on the denominator, including the one on the Overview page.
  const accounts = ((byAccount.results ?? []) as Record<string, unknown>[]).map((row) => ({
    ...row,
    share_pct: requestsMtd > 0 ? Math.round((Number(row.requests ?? 0) / requestsMtd) * 1000) / 10 : null,
  }));

  return c.json(
    ok({
      daily_cap: (cap.results ?? [])[0]?.daily_cap ?? null,
      requests_today: Number((today.results ?? [])[0]?.requests ?? 0),
      requests_mtd: requestsMtd,
      cost_mtd_micro: Number(monthRow.cost_micro ?? 0),
      by_account: accounts,
    }),
  );
});

/**
 * Re-scores leads that already exist, without probing anything.
 *
 * This is the endpoint the weekly feedback loop reaches for once a new weights
 * version is active: a weights change is worthless until the existing book has
 * been re-read through it, and re-probing to achieve that would spend money to
 * learn something already known. It is also the cheap way to repair a run that
 * scored before a signal was collected.
 *
 * Ordered by `id` and paged by `after_id` so a large rescore is resumable and two
 * concurrent calls do not collide on the same rows.
 */
const rescoreSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  after_id: z.string().min(1).nullable().optional(),
  lead_ids: z.array(z.string().min(1)).max(500).optional(),
  /** Only leads that have never been scored — the first pass after an import. */
  only_unscored: z.boolean().optional(),
  tier: z.enum(['HOT', 'WARM', 'COLD']).nullable().optional(),
});

const pass1Schema = z.object({
  lead_ids: z.array(z.string().min(1)).length(PASS1_BATCH_SIZE),
});

/**
 * Runs one exact Pass 1 batch. Gate checks are repeated inside the scoring layer,
 * so a caller cannot bypass provisional/cooldown rules by hand-picking ids.
 */
scoringRoutes.post('/admin/scoring/pass1', async (c) => {
  const parsed = pass1Schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION', { reason: 'exact_batch_size', batch_size: PASS1_BATCH_SIZE });
    return c.json(body, status as 400);
  }
  const result = await scoreLeadPass1Batch(c.env.DB, c.env.VAULT_KEY, parsed.data.lead_ids);
  return c.json(ok(result));
});

scoringRoutes.post('/scoring/rescore', async (c) => {
  const parsed = rescoreSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const limit = Math.min(parsed.data.limit ?? 100, 500);
  const after = parsed.data.after_id ?? '';

  let leadIds: string[];
  if (parsed.data.lead_ids && parsed.data.lead_ids.length > 0) {
    leadIds = parsed.data.lead_ids.slice(0, limit);
  } else {
    const where: string[] = ['deleted_at IS NULL', 'id > ?'];
    const params: unknown[] = [after];
    if (parsed.data.only_unscored) where.push('rule_score IS NULL');
    if (parsed.data.tier) {
      where.push('tier = ?');
      params.push(parsed.data.tier);
    }
    params.push(limit);

    const rows = await c.env.DB.prepare(
      `SELECT id FROM leads WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
    )
      .bind(...params)
      .all<{ id: string }>();
    leadIds = (rows.results ?? []).map((row) => row.id);
  }

  const results: Record<string, unknown>[] = [];
  for (const leadId of leadIds) {
    const scored = await scoreLeadPass0(c.env.DB, leadId);
    if (!scored) continue;
    results.push({
      lead_id: scored.lead_id,
      rule_score: scored.rule_score,
      final_score: scored.final_score,
      tier: scored.tier,
      coverage: scored.coverage,
      is_provisional: scored.is_provisional,
    });
  }

  // The distribution is returned with the result rather than left to a second
  // call: the point of a rescore is usually to see whether the tiers moved, and
  // a caller that has to ask again will usually just look at the first page.
  const distribution = results.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.tier ?? 'none');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return c.json(
    ok({
      rescored: results.length,
      requested_limit: limit,
      distribution,
      scores: results,
      next_after_id: leadIds[leadIds.length - 1] ?? null,
    }),
  );
});

/**
 * The breakdown — 12-scoring.md §7, and the reason the score is worth anything.
 *
 * A number nobody can explain is a number nobody will act on. The contract in
 * §7 asks for the whole chain per feature (raw value → normalised → weight →
 * contribution) and the console's scoring page renders exactly that, so a
 * disagreement between what the operator believes the model does and what it
 * actually did is visible in one screen rather than in a debugging session.
 *
 * IT PREFERS THE STORED SNAPSHOT AND FALLS BACK TO COMPUTING LIVE. The snapshot is
 * what the score WAS when it was written — replaying it is the only way to explain
 * a historical score after the weights have moved. But a lead that has signals and
 * has never been scored should still show a breakdown, so when there is no
 * `lead_scores` row the same pure function runs on the fly and the response says
 * so via `from_snapshot: 0`. It writes nothing: a GET must not change a score.
 */
function gateVerdict(ruleScore: number, isProvisional: number, coverage: number, threshold: number) {
  if (isProvisional === 1) {
    return {
      passed: 0 as const,
      reason: `provisional: coverage ${Math.round(coverage * 100)}% < 60%`,
    };
  }
  if (ruleScore >= threshold) {
    return { passed: 1 as const, reason: `rule_score ${ruleScore} ≥ gate ${threshold}` };
  }
  return { passed: 0 as const, reason: `rule_score ${ruleScore} < gate ${threshold}` };
}

scoringRoutes.get('/scoring/leads/:id/breakdown', async (c) => {
  const leadId = c.req.param('id');

  const lead = await c.env.DB.prepare(
    `SELECT id, rule_score, ai_score, final_score, tier, niche, country_code, city,
            phone_e164, has_website, overture_id, fsq_id
       FROM leads WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(leadId)
    .first<Record<string, unknown>>();

  if (!lead) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const [snapshot, signals, thresholdRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT rule_score, ai_score, final_score, tier, weights_version, score_version,
              is_provisional, ai_scored_at, features_json, model, created_at
         FROM lead_scores WHERE lead_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
      .bind(leadId)
      .first<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT signal_key, signal_value_num, signal_value_text, collected_at, expires_at
         FROM lead_signals WHERE lead_id = ?`,
    )
      .bind(leadId)
      .all<SignalInput>(),
    c.env.DB.prepare(`SELECT value_num AS gate FROM settings WHERE key = 'gate_threshold'`).first<{
      gate: number | null;
    }>(),
  ]);

  const signalRows = signals.results ?? [];
  const byKey = new Map(signalRows.map((row) => [row.signal_key, row]));
  const threshold = thresholdRow?.gate ?? 55;

  let features: FeatureContribution[] = [];
  let coverage = 0;
  let isProvisional = 0;
  let ruleScore = Number(lead.rule_score ?? 0);
  let weightsVersion = 0;
  let scoreVersion = 0;
  let aiScore: number | null = null;
  let aiReason: string | null = null;
  let aiAngle: string | null = null;
  let fromSnapshot = 0;

  if (snapshot?.features_json) {
    try {
      const parsed = JSON.parse(String(snapshot.features_json)) as {
        coverage?: number;
        features?: FeatureContribution[];
      };
      features = Array.isArray(parsed.features) ? parsed.features : [];
      coverage = Number(parsed.coverage ?? 0);
      isProvisional = Number(snapshot.is_provisional ?? 0);
      ruleScore = Number(snapshot.rule_score ?? ruleScore);
      weightsVersion = Number(snapshot.weights_version ?? 0);
      scoreVersion = Number(snapshot.score_version ?? 0);
      aiScore = snapshot.ai_score === null ? null : Number(snapshot.ai_score);
      fromSnapshot = 1;
    } catch {
      // A corrupt snapshot falls through to the live computation rather than
      // returning 500: the breakdown is a read, and the lead's real scores are
      // still on the lead row.
      features = [];
    }
  }

  if (features.length === 0) {
    const active = await loadActiveWeights(c.env.DB);
    if (active) {
      const overture = Boolean(lead.overture_id);
      const fsq = Boolean(lead.fsq_id);
      const [nicheRow, geoRow] = await Promise.all([
        lead.niche
          ? c.env.DB.prepare(`SELECT priority FROM niches WHERE niche_slug = ? AND enabled = 1`)
              .bind(lead.niche)
              .first<{ priority: number | null }>()
          : Promise.resolve(null),
        lead.country_code
          ? c.env.DB.prepare(
              `SELECT priority FROM geo_targets
                WHERE country_code = ? AND enabled = 1
                  AND (city IS NULL OR city = '' OR city = ?)
                ORDER BY priority ASC LIMIT 1`,
            )
              .bind(lead.country_code, lead.city ?? '')
              .first<{ priority: number | null }>()
          : Promise.resolve(null),
      ]);

      const context: ScoreContext = {
        hasWebsite: lead.has_website === null ? null : Number(lead.has_website),
        phoneE164: (lead.phone_e164 as string | null) ?? null,
        nichePriority: nicheRow?.priority ?? null,
        geoPriority: geoRow?.priority ?? null,
        dualSourced: overture && fsq,
        singleSourced: overture !== fsq,
      };

      const live = computeRuleScore({
        weights: active.weights as WeightRow[],
        signals: signalRows,
        weightsVersion: active.version,
        context,
        now: Math.floor(Date.now() / 1000),
      });
      features = live.features;
      coverage = live.coverage;
      isProvisional = live.is_provisional;
      ruleScore = live.rule_score;
      weightsVersion = live.weights_version;
    }
  }

  const verdict = gateVerdict(ruleScore, isProvisional, coverage, threshold);

  return c.json(
    ok({
      lead_id: leadId,
      rule_score: ruleScore,
      ai_score: aiScore,
      final_score: lead.final_score === null ? null : Number(lead.final_score),
      tier: lead.tier ?? null,
      gate_passed: verdict.passed,
      gate_reason: verdict.reason,
      gate_threshold: threshold,
      coverage_pct: Math.round(coverage * 100),
      is_provisional: isProvisional,
      score_version: scoreVersion,
      weights_version: weightsVersion,
      ai_reason: aiReason,
      ai_angle: aiAngle,
      from_snapshot: fromSnapshot,
      // `label` is the feature key: the schema stores keys and invents no display
      // names, and the console renders null as an em dash rather than guessing.
      signals: features.map((feature) => {
        const row = byKey.get(feature.feature_key);
        const expired =
          row?.expires_at !== null && row?.expires_at !== undefined
            ? row.expires_at <= Math.floor(Date.now() / 1000)
              ? 1
              : 0
            : 0;
        return {
          id: `${leadId}:${feature.feature_key}`,
          signal_key: feature.feature_key,
          label: feature.feature_key,
          value: feature.raw_num,
          value_text: feature.raw_text,
          collected_at: row?.collected_at ?? 0,
          expires_at: row?.expires_at ?? null,
          expired,
          weight: feature.weight,
          contribution: Math.round(feature.contribution * 100) / 100,
          normalized: feature.normalized,
          present: feature.present,
        };
      }),
    }),
  );
});
