/**
 * Health and identity.
 *
 * `/api/health` is the only unauthenticated route and is deliberately thin: the
 * contract forbids config, secrets and counts here, and a health endpoint that
 * reports row counts is a slow information leak. It answers one question — is
 * this Worker alive and can it reach D1.
 */

import { Hono } from 'hono';
import { ok } from '../lib/envelope';
import type { Actor, Env } from '../env';

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get('/health', async (c) => {
  let d1 = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    d1 = 'unreachable';
  }

  const metadata = (c.env as unknown as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA;

  return c.json(
    ok({
      service: 'jepy-worker',
      version: 'phase-3',
      build: metadata?.id ?? 'dev',
      d1,
      time: Math.floor(Date.now() / 1000),
    }),
  );
});

export const meRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

meRoutes.get('/me', (c) => {
  const actor = c.get('actor');
  return c.json(
    ok({
      email: actor.email,
      // There is no role table: Access decides who gets in, and anyone who gets
      // in is the operator (R1). `admin` is the cron/GHA path, not a person.
      role: actor.kind === 'admin' ? 'admin' : 'operator',
      auth_kind: actor.kind,
      session_valid: true,
      // The topbar's badge. `demo` is always false here: this is the API, and an
      // answer from it is by definition live data.
      env: c.env.ENVIRONMENT === 'production' ? 'prod' : 'dev',
      demo: false,
    }),
  );
});
