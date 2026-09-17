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
import { fail } from './lib/envelope';
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

export default app;
