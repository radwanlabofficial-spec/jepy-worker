/**
 * The pipeline's two manual handles: run Wave 1, and look at what it produced.
 *
 * 03-execution.md STEP 10 has a "Done when" that is a number and a picture:
 * "1,000 leads have a rule_score, and you can see the distribution". A number you
 * cannot read out of the system is not a milestone, so `status` returns the
 * distribution and the coverage split alongside the counts, and `run` is the
 * thing that produces them without waiting for a cron slot.
 *
 * THIS IS NOT A WAY AROUND THE QUEUE. The run endpoint performs its own probes,
 * which is only legitimate because it is itself the work: it does not reach a
 * provider on behalf of a queued job, and it does not spend a paid credit. The
 * moment a paid probe is added to the Wave 1 set this endpoint has to enqueue
 * instead of execute (R16, ADR-016).
 *
 * THE BATCH SIZE IS ARITHMETIC, NOT TASTE. One lead runs up to eight probes
 * costing nine sub-requests (robots/sitemap does two fetches; the other seven do
 * one). R15 caps a single Worker invocation at 40 sub-requests, so four leads is
 * 36 and leaves headroom for this route's own D1 statements. The cap is enforced
 * here rather than trusted to the caller: an operator asking for 50 gets 4 and a
 * note saying why, because the failure mode of not enforcing it is a truncated
 * run whose missing leads are indistinguishable from leads with no signals.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import type { Actor, Env } from '../env';
import { collectWave1, nextLeadsToProbe } from '../targets/wave1';
import { scoreLeadPass0 } from '../scoring/run';

export const pipelineRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

/** Nine sub-requests per lead, against R15's ceiling of forty per invocation. */
const SUB_REQUESTS_PER_LEAD = 9;
const INVOCATION_SUB_REQUEST_BUDGET = 40;
const RESERVED_FOR_OWN_QUERIES = 4;
export const MAX_LEADS_PER_RUN = Math.floor(
  (INVOCATION_SUB_REQUEST_BUDGET - RESERVED_FOR_OWN_QUERIES) / SUB_REQUESTS_PER_LEAD,
);

const runSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  after_id: z.string().min(1).nullable().optional(),
  lead_ids: z.array(z.string().min(1)).max(50).optional(),
  probes: z.array(z.string().min(1)).min(1).optional(),
  timeout_ms: z.number().int().min(1000).max(60_000).optional(),
  /** Scoring is separate so a probe run can be re-scored later without re-probing. */
  score: z.boolean().optional(),
});

/**
 * Probes a batch of leads and, unless told otherwise, scores each one.
 *
 * Probing and scoring are one endpoint because they are one milestone, but they
 * are separate switches: a lead that fails every probe still gets a score from
 * whatever signals already exist, and a re-score after a weights change needs no
 * probing at all.
 */
pipelineRoutes.post('/admin/probes/run', async (c) => {
  const parsed = runSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const requested = parsed.data.limit ?? MAX_LEADS_PER_RUN;
  const limit = Math.min(requested, MAX_LEADS_PER_RUN);

  const leadIds =
    parsed.data.lead_ids && parsed.data.lead_ids.length > 0
      ? parsed.data.lead_ids.slice(0, limit)
      : await nextLeadsToProbe(c.env.DB, { limit, afterId: parsed.data.after_id ?? null });

  if (leadIds.length === 0) {
    return c.json(
      ok({
        requested_limit: requested,
        effective_limit: limit,
        leads: [],
        notes: ['no leads are waiting to be probed'],
      }),
    );
  }

  const results: Record<string, unknown>[] = [];
  const scoreResults: Record<string, unknown>[] = [];

  for (const leadId of leadIds) {
    const probeResult = await collectWave1(c.env.DB, leadId, {
      timeoutMs: parsed.data.timeout_ms,
      probes: parsed.data.probes,
    });
    if (!probeResult) continue;

    results.push({
      lead_id: probeResult.lead_id,
      has_website: probeResult.has_website,
      signals_written: probeResult.signals_written,
      probed: probeResult.probed,
      failed: probeResult.failed,
    });

    if (parsed.data.score !== false) {
      const scored = await scoreLeadPass0(c.env.DB, leadId);
      if (scored) {
        scoreResults.push({
          lead_id: scored.lead_id,
          rule_score: scored.rule_score,
          final_score: scored.final_score,
          tier: scored.tier,
          coverage: scored.coverage,
          is_provisional: scored.is_provisional,
        });
      }
    }
  }

  return c.json(
    ok({
      requested_limit: requested,
      effective_limit: limit,
      // Stated in the response rather than only in this file, because an operator
      // who asked for 50 and got 4 needs the reason at the moment they ask.
      capped_by: requested > limit ? `R15: ${SUB_REQUESTS_PER_LEAD} sub-requests per lead, ${INVOCATION_SUB_REQUEST_BUDGET} per invocation` : null,
      probed: results.length,
      scored: scoreResults.length,
      leads: results,
      scores: scoreResults,
      next_after_id: leadIds[leadIds.length - 1] ?? null,
    }),
  );
});

/**
 * The STEP 10 picture.
 *
 * `coverage_band` is the column that matters and the only one that is not a plain
 * count: a lead below 60% coverage is provisional and will be graded by neither
 * the gate nor the tier rule, so a run that produced a thousand scores at 40%
 * coverage has produced a thousand numbers and no decisions. Splitting the total
 * this way makes that visible before anybody draws a conclusion from the mean.
 */
pipelineRoutes.get('/admin/probes/status', async (c) => {
  const [totals, signals, tiers, coverage] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT COUNT(*)                                                    AS leads_total,
              SUM(CASE WHEN has_website IS NULL THEN 1 ELSE 0 END)          AS not_probed,
              SUM(CASE WHEN has_website = 0 THEN 1 ELSE 0 END)              AS no_website,
              SUM(CASE WHEN has_website = 1 THEN 1 ELSE 0 END)              AS has_website,
              SUM(CASE WHEN rule_score IS NOT NULL THEN 1 ELSE 0 END)       AS scored
         FROM leads WHERE deleted_at IS NULL`,
    ),
    c.env.DB.prepare(
      `SELECT signal_key                AS signal_key,
              COUNT(*)                  AS rows,
              SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= unixepoch() THEN 1 ELSE 0 END) AS expired
         FROM lead_signals GROUP BY signal_key ORDER BY rows DESC`,
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(tier, 'none') AS tier, COUNT(*) AS leads
         FROM leads WHERE deleted_at IS NULL GROUP BY tier ORDER BY leads DESC`,
    ),
    c.env.DB.prepare(
      `SELECT CASE
                WHEN latest.is_provisional IS NULL THEN 'unscored'
                WHEN latest.is_provisional = 1     THEN 'provisional_under_60'
                ELSE 'gradeable'
              END      AS coverage_band,
              COUNT(*) AS leads
         FROM (
           SELECT (SELECT ls.is_provisional
                     FROM lead_scores ls
                    WHERE ls.lead_id = l.id
                    ORDER BY ls.created_at DESC, ls.rowid DESC
                    LIMIT 1) AS is_provisional
             FROM leads l
            WHERE l.deleted_at IS NULL AND l.rule_score IS NOT NULL
         ) AS latest
        GROUP BY coverage_band ORDER BY leads DESC`,
    ),
  ]);

  return c.json(
    ok({
      totals: (totals?.results ?? [])[0] ?? {},
      signals: signals?.results ?? [],
      tiers: tiers?.results ?? [],
      coverage: coverage?.results ?? [],
      max_leads_per_run: MAX_LEADS_PER_RUN,
    }),
  );
});
