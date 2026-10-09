/**
 * The handoff: letting a runner outside this Worker take the jobs meant for it.
 *
 * WHY THIS EXISTS. Two of the three runners in this system are not the Worker.
 * A Tier 0 import is carried out by GitHub Actions, because reading a 10 GB
 * parquet dump is not something an edge isolate should do and a cron trigger's
 * fifteen minutes would cap it anyway. A Mode A capture is carried out by the
 * browser extension, because the page is already open in front of the operator.
 *
 * Until now there was nowhere for those jobs to go. The dispatcher claimed every
 * pending job, handed it to the router, and the router — which can only ever run
 * a provider adapter inside this Worker — picked the matching `gha_runner`
 * capability and ran its adapter anyway. `api_json` with no URL template answers
 * `E_CONFIG_MISSING`, the job parked as `needs_manual`, and the next cron tick
 * made another. The queue was not carrying a handoff; it was collecting tombstones.
 *
 * THE CONTRACT IS THREE CALLS, and it is the same shape as the import ledger
 * beside it: take a job, finish it, or report why it could not be finished.
 *
 *   claim     the runner asks for its due work and the queue marks it taken
 *   complete  the work happened; `result_ref` points at whatever proves it
 *   fail      transient exhausts attempts and retries; permanent needs a person
 *
 * `claimed` is the honest state for "an external runner is holding this". There
 * is no separate `start` call: a claimed job that never comes back is reclaimed
 * by `reclaimStale` after forty-eight hours, and for an import the progress that
 * actually matters is in `dataset_imports`, not here.
 *
 * WHAT THIS IS NOT. It is not the extension's own endpoint. Mode A polls
 * `/api/jobs/pending?type=dom` with a device token, because a browser extension
 * cannot hold an admin secret and must not be trusted with one (STEP 15). Both
 * doors call the same `claim()`; only the key they are opened with differs.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { requireActor, requireAdmin } from '../middleware/auth';
import { claim, complete, fail as failJob } from '../lib/queue';
import type { RunnerKind } from '../lib/queue';
import { selectScraper } from '../lib/scraper_select';
import type { Actor, Env } from '../env';

export const runnerRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

runnerRoutes.use('/admin/jobs/*', requireAdmin);

const MAX_CLAIM = 20;

const claimSchema = z.object({
  runner: z.enum(['gha', 'extension']),
  limit: z.number().int().min(1).max(MAX_CLAIM).nullish(),
});

const failSchema = z.object({
  reason: z.string().min(1).max(500),
  kind: z.enum(['transient', 'permanent']),
});

/**
 * Hands the caller up to `limit` due jobs that declared it as their runner.
 *
 * The `gha` and `extension` values are enumerated rather than accepted as free
 * text: `worker` is deliberately NOT a valid value here, because the Worker
 * claims its own work in the cron dispatcher and a remote caller claiming it
 * would take jobs out of the only runner that can finish them.
 */
runnerRoutes.post('/admin/jobs/claim', async (c) => {
  const parsed = claimSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const runner = parsed.data.runner as RunnerKind;
  const limit = parsed.data.limit ?? 1;

  // The claimed_by stamp names the runner, so a row that is stuck can be traced
  // to the thing that took it rather than to "someone".
  const jobs = await claim(c.env.DB, `runner:${runner}`, limit, runner);

  // AI scraper selection. An extension backend-scrape request arrives from
  // /devices/request-scrape as job_type='scrape' + target_type=
  // 'extension_backend_request' (the old 'backend_scrape' job_type was never in
  // the job_queue CHECK, and job_queue has no target_url column — the URL rides
  // in payload_json). The selection happens here, at claim time, because the
  // right provider is a live question (circuit state, today's quota) that a
  // stored-at-request-time choice would answer wrong by the time the runner
  // arrives. The decision is written back onto the job row so it is auditable
  // after the fact. A job that already carries a decision is left alone: the
  // AI is consulted once per job, not once per claim.
  //
  // The whole block is defensive by design. If migration 0014 has not been
  // applied yet the UPDATE below throws, and a provider choice must never turn
  // a successful claim into a 500 — so every failure is swallowed and the job
  // still goes out, undecided, for the runner to fall back on its own default.
  try {
    const scrapeJobs = jobs.filter(
      (job) => job.job_type === 'scrape' && job.target_type === 'extension_backend_request',
    );
    if (scrapeJobs.length > 0) {
      const placeholders = scrapeJobs.map(() => '?').join(',');
      const rows = (await c.env.DB.prepare(
        `SELECT id, provider_selected, payload_json
           FROM job_queue WHERE id IN (${placeholders})`,
      )
        .bind(...scrapeJobs.map((job) => job.id))
        .all<{ id: string; provider_selected: string | null; payload_json: string | null }>()
      ).results ?? [];

      for (const row of rows) {
        if (row.provider_selected) continue;
        const payload = row.payload_json ? safeParse(row.payload_json) : null;
        const payloadObj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
        const rawUrl =
          (typeof payloadObj?.url === 'string' && payloadObj.url) ||
          (typeof payloadObj?.target_url === 'string' && payloadObj.target_url) ||
          '';
        if (!rawUrl) continue;
        try {
          const decision = await selectScraper(c.env, {
            url: rawUrl,
            reason:
              (typeof payloadObj?.manual_failure_reason === 'string' && payloadObj.manual_failure_reason) ||
              (typeof payloadObj?.reason === 'string' && payloadObj.reason) ||
              null,
          });
          await c.env.DB.prepare(
            `UPDATE job_queue SET provider_selected = ?, provider_select_reason = ?, updated_at = unixepoch()
              WHERE id = ?`,
          )
            .bind(decision.provider, decision.reason.slice(0, 500), row.id)
            .run();
        } catch {
          // Per-job: one undecidable URL must not block the rest of the claim.
        }
      }
    }
  } catch {
    // Migration 0014 (or the target_url column) not present: the claim still
    // succeeds and the runner decides on its own.
  }

  return c.json(
    ok({
      runner,
      claimed: jobs.length,
      jobs: jobs.map((job) => ({
        id: job.id,
        job_type: job.job_type,
        target_type: job.target_type,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
        payload: job.payload_json ? safeParse(job.payload_json) : null,
      })),
    }),
  );
});

/**
 * Manual test hook for the AI scraper selection: `GET /api/scrape/decision?url=`.
 * Returns exactly what the claim path would write onto an extension
 * backend-scrape job row, without creating or touching a job. requireActor, because this is a
 * diagnostic for the operator, not a cost-bearing action — but it does call
 * Manifest, so it is not public.
 */
runnerRoutes.get('/scrape/decision', requireActor, async (c) => {
  const parsed = z
    .object({ url: z.string().min(1).max(2000), reason: z.string().max(500).nullish() })
    .safeParse({ url: c.req.query('url') ?? '', reason: c.req.query('reason') ?? null });
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION', { reason: 'url query param is required' });
    return c.json(body, status as 400);
  }
  const decision = await selectScraper(c.env, { url: parsed.data.url, reason: parsed.data.reason });
  return c.json(ok({ url: parsed.data.url, ...decision }));
});

/** `result_ref` is a pointer, not a payload: an R2 key, a ledger id, a URL. */
runnerRoutes.post('/admin/jobs/:id/complete', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ref = typeof body?.result_ref === 'string' && body.result_ref.trim() !== ''
    ? body.result_ref.trim().slice(0, 500)
    : null;

  const existing = await c.env.DB.prepare(
    `SELECT id, status, attempts, max_attempts FROM job_queue WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; status: string; attempts: number; max_attempts: number }>();

  if (!existing) {
    const { body: b, status } = fail('E_NOT_FOUND', { reason: 'unknown_job' });
    return c.json(b, status as 404);
  }

  // Idempotent on purpose: a runner that retries its own report must not turn a
  // finished job back into a pending one, and must not fail the job it just
  // finished with "already done".
  if (existing.status === 'done') {
    return c.json(ok({ id: existing.id, status: 'done', already: true }));
  }

  await complete(c.env.DB, existing.id, ref);
  return c.json(ok({ id: existing.id, status: 'done', result_ref: ref }));
});

runnerRoutes.post('/admin/jobs/:id/fail', async (c) => {
  const parsed = failSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const job = await c.env.DB.prepare(
    `SELECT id, status, attempts, max_attempts FROM job_queue WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; status: string; attempts: number; max_attempts: number }>();

  if (!job) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_job' });
    return c.json(body, status as 404);
  }

  const outcome = await failJob(c.env.DB, job, parsed.data.reason, parsed.data.kind);
  return c.json(ok({ id: job.id, status: outcome.status, run_after: outcome.run_after }));
});

/** A payload that will not parse is passed through as null rather than thrown on. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
