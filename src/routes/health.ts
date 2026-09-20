/**
 * Health and identity.
 *
 * `/api/health` is the only unauthenticated route and is deliberately thin: the
 * contract forbids config, secrets and counts here, and a health endpoint that
 * reports row counts is a slow information leak. It answers one question — is
 * this Worker alive and can it reach the four bindings it cannot work without.
 *
 * That is four, not one. A deployment that lost a binding used to fail later as
 * a confusing 500 in whichever request touched it first; checking D1, KV, R2 and
 * the Durable Object up front turns that into one honest line here, and it is
 * what the foundation gate asks this route to prove.
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

  // KV is checked by reading, never by writing. A `put` per health call would
  // spend KV's 1,000 daily free writes — a one-minute timer on this route would
  // burn more than a third of that budget discovering nothing. A `get` of a key
  // that is allowed not to exist still proves the namespace is reachable, and
  // reachability is the whole question.
  let kv = 'ok';
  try {
    await c.env.CACHE.get('health:probe');
  } catch {
    kv = 'unreachable';
  }

  // `head` on a key nothing writes. R2 answers `null` for a miss, one Class B
  // operation, and 10 million of those are free each month — so this proves the
  // bucket is bound and reachable at no cost.
  let r2 = 'ok';
  try {
    await c.env.RAW.head('health/probe');
  } catch {
    r2 = 'unreachable';
  }

  // A namespace that can mint an id is not a Durable Object that answers:
  // `idFromName` succeeds for any key whether or not a class sits behind it. So
  // the probe fetches the object's own `/health`. A bound-but-broken RouterDO —
  // the failure R17 describes, a DO declared without SQLite storage on a plan
  // that requires it — looks identical to a healthy one until something calls
  // it, and this is the cheapest call that can.
  let router_do = 'ok';
  try {
    const stub = c.env.ROUTER_DO.get(c.env.ROUTER_DO.idFromName('health-probe'));
    const response = await stub.fetch('https://router.internal/health');
    if (!response.ok) router_do = `http ${response.status}`;
  } catch {
    router_do = 'unreachable';
  }

  const metadata = (c.env as unknown as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA;

  return c.json(
    ok({
      service: 'jepy-worker',
      version: 'phase-3',
      build: metadata?.id ?? 'dev',
      env: c.env.ENVIRONMENT,
      d1,
      kv,
      r2,
      router_do,
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
