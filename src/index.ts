/**
 * Jepy Leads API — router.
 *
 * One unauthenticated route (`/api/health`) and everything else behind
 * `requireActor`. Authentication is Cloudflare Access for humans, `X-Admin-Secret`
 * for cron and GitHub Actions, and (from Phase 12) a device token for the
 * extension; there is no fourth path and no users table.
 *
 * The console reaches this Worker through its own origin: Pages proxies `/api/*`
 * here, which is why the Access cookie needs no CORS handling for the normal
 * path. The CORS block below exists only so a direct call from a developer's
 * browser is not mysteriously blocked — it is not the production path.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fail, ok } from './lib/envelope';
import { requireActor } from './middleware/auth';
import type { Actor, Env } from './env';

import { healthRoutes, meRoutes } from './routes/health';
import { settingsRoutes } from './routes/settings';
import { leadRoutes } from './routes/leads';
import { jobRoutes } from './routes/jobs';
import { providerRoutes } from './routes/providers';
import { sourceRoutes } from './routes/sources';
import { scoringRoutes } from './routes/scoring';
import { vaultRoutes } from './routes/vault';
import { emailRoutes } from './routes/email';
import { miscRoutes } from './routes/misc';
import { importRoutes } from './routes/imports';
import { normaliseRoutes } from './routes/normalise';
import { CRONS, TRIGGERS, runScheduled, runTick } from './jobs/scheduled';
import { cancel, enqueue, retry } from './lib/queue';
import { z } from 'zod';

type AppEnv = { Bindings: Env; Variables: { actor: Actor } };

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  const allowed = (c.env.CONSOLE_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const middleware = cors({
    origin: (requestOrigin) => (allowed.includes(requestOrigin) ? requestOrigin : null),
    credentials: true,
    allowHeaders: ['Content-Type', 'Idempotency-Key', 'X-Admin-Secret', 'X-Device-Token'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });
  await middleware(c, next);
});

app.use('/api/*', async (c, next) => {
  // Health is the probe Cloudflare and the operator use; it must answer before
  // any credential exists. Everything else needs an identity.
  if (c.req.path === '/api/health') {
    await next();
    return;
  }
  return requireActor(c, next);
});

// A human who opens the bare hostname gets an answer instead of a 404. This is
// not a data route and carries no configuration: it exists because "the link
// does not work" is the wrong first impression for a service that is in fact
// running, and the console is the only real entry point.
app.get('/', (c) =>
  c.json(
    ok({
      service: 'jepy-worker',
      status: 'running',
      health: '/api/health',
      console: c.env.CONSOLE_ORIGIN || null,
      note: 'All data routes live under /api and require a Cloudflare Access session. This hostname is not the console.',
    }),
  ),
);

app.route('/api', healthRoutes);
app.route('/api', meRoutes);
app.route('/api', settingsRoutes);
app.route('/api', leadRoutes);
app.route('/api', jobRoutes);
app.route('/api', providerRoutes);
app.route('/api', sourceRoutes);
app.route('/api', scoringRoutes);
app.route('/api', vaultRoutes);
app.route('/api', emailRoutes);
app.route('/api', miscRoutes);
app.route('/api', importRoutes);
app.route('/api', normaliseRoutes);

app.notFound((c) => {
  const { body, status } = fail('E_NOT_FOUND');
  return c.json(body, status as 404);
});

app.onError(async (error, c) => {
  const message = error instanceof Error ? error.message : String(error);

  // Best effort: a failure to log must never turn into a second failure for the
  // caller, so the insert is wrapped and its own error discarded.
  try {
    await c.env.DB.prepare(
      `INSERT INTO error_log (id, code, scope, message, severity, created_at)
       VALUES (?, 'E_INTERNAL', ?, ?, 'error', unixepoch())`,
    )
      .bind(crypto.randomUUID(), c.req.path, message.slice(0, 500))
      .run();
  } catch {
    // ignore
  }

  const { body, status } = fail('E_INTERNAL');
  return c.json(body, status as 500);
});

/**
 * Queue control. The console enqueues work and can retry or cancel it; nothing
 * here calls a provider, so a human click cannot spend money on its own — the
 * dispatcher does that, on its own schedule, inside its own budget.
 */
const enqueueSchema = z.object({
  job_type: z.enum(['dataset_import', 'probe', 'scrape', 'enrich', 'verify', 'score', 'dom', 'email', 'quota_sync']),
  target_type: z.string().min(1).nullable().optional(),
  payload: z.unknown().optional(),
  priority: z.number().int().min(1).max(10).optional(),
});

app.post('/api/jobs', async (c) => {
  const parsed = enqueueSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const id = await enqueue(c.env.DB, {
    jobType: parsed.data.job_type,
    targetType: parsed.data.target_type ?? null,
    payload: parsed.data.payload,
    priority: parsed.data.priority,
  });
  return c.json(ok({ id, status: 'pending' }));
});

app.post('/api/jobs/:id/retry', async (c) => {
  const changed = await retry(c.env.DB, c.req.param('id'));
  if (!changed) {
    // Nothing to retry: either it does not exist or it is still live. Both are
    // the same answer to a human, and neither is an error.
    const { body, status } = fail('E_NOT_FOUND', { reason: 'not_retryable' });
    return c.json(body, status as 404);
  }
  return c.json(ok({ id: c.req.param('id'), status: 'pending' }));
});

app.post('/api/jobs/:id/cancel', async (c) => {
  const changed = await cancel(c.env.DB, c.req.param('id'));
  if (!changed) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'not_cancellable' });
    return c.json(body, status as 404);
  }
  return c.json(ok({ id: c.req.param('id'), status: 'dead' }));
});

/**
 * Manual trigger for one scheduled job. Cloudflare offers no way to fire a cron
 * on demand, and "wait until Monday 05:00 to see whether it works" is not a
 * verification strategy. It is also what the console's backup button calls.
 */
app.post('/api/admin/run-cron', async (c) => {
  const parsed = z.object({ cron: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const known = Object.values(CRONS) as string[];
  if (!known.includes(parsed.data.cron)) {
    const { body, status } = fail('E_VALIDATION', { reason: 'unknown_cron', known });
    return c.json(body, status as 400);
  }

  // The name the run was recorded under comes back from the scheduler itself,
  // so the endpoint never has to guess it from the expression.
  const cronName = await runScheduled(parsed.data.cron, c.env);

  const last = await c.env.DB.prepare(
    `SELECT cron_name, status, error_text, jobs_dispatched, finished_at
       FROM cron_runs
      WHERE cron_name = ? AND started_at >= ?
      ORDER BY started_at DESC, finished_at DESC
      LIMIT 1`,
  )
    .bind(cronName, Math.floor(Date.now() / 1000) - 300)
    .first();

  return c.json(ok({ cron: parsed.data.cron, cron_name: cronName, last }));
});

app.get('/api/admin/cron-runs', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT cron_name, started_at, finished_at, jobs_dispatched, sub_requests_used, status, error_text
       FROM cron_runs ORDER BY started_at DESC LIMIT 50`,
  ).all();
  return c.json(ok(rows.results ?? []));
});

/**
 * The router. Exported at module scope because Cloudflare resolves a Durable
 * Object class by name from the Worker's entry module — `class_name = "RouterDO"`
 * in wrangler.toml points here, and a class that is not exported from the entry
 * is a deploy-time error that reads like a missing binding.
 */
export { RouterDO } from './do/RouterDO';

export default {
  fetch: app.fetch,
  /**
   * The scheduler. Each trigger carries its own cron string, and the run is
   * recorded whether it succeeds or throws.
   */
  async scheduled(event: { cron: string }, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    // Two triggers, nine jobs. The fast one runs the dispatcher; the hourly one
    // asks runTick which of the other eight are due right now.
    ctx.waitUntil(
      event.cron === TRIGGERS.dispatcher ? runScheduled(CRONS.dispatcher, env) : runTick(env),
    );
  },
};
