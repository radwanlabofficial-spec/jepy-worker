/**
 * Three ways in, and no fourth (11-api-contract.md §1).
 *
 *   access — a human in the console. Cloudflare Access has already authenticated
 *            them and added `Cf-Access-Jwt-Assertion`; we verify that JWT against
 *            the team's JWKS and take the email from it. There is no users table
 *            and no password anywhere (R1).
 *   admin  — cron and GitHub Actions, with `X-Admin-Secret`. Never a human path.
 *   device — the Chrome extension, on exactly three endpoints (added in Phase 12).
 *
 * The Worker's own workers.dev hostname is NOT behind Access, because cron and
 * GitHub Actions have no browser session. The JWT check below is what protects
 * it, and the host is not the entry point the console uses — the console calls
 * `/api/*` on its own Pages origin, which proxies here and forwards the header.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Context, MiddlewareHandler } from 'hono';
import { fail } from '../lib/envelope';
import type { Actor, Env } from '../env';

const JWKS_CACHE = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  const cached = JWKS_CACHE.get(teamDomain);
  if (cached) return cached;
  // createRemoteJWKSet caches keys internally and re-fetches on an unknown kid,
  // so a key rotation is picked up without a redeploy.
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  JWKS_CACHE.set(teamDomain, jwks);
  return jwks;
}

/** Length-independent comparison, so a wrong secret leaks no timing signal. */
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function isLoopback(requestUrl: string): boolean {
  const host = new URL(requestUrl).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export async function resolveActor(c: Context<{ Bindings: Env }>): Promise<Actor | null> {
  const env = c.env;

  const adminHeader = c.req.header('X-Admin-Secret');
  if (adminHeader && env.ADMIN_SECRET && safeEqual(adminHeader, env.ADMIN_SECRET)) {
    return { email: 'cron@jepy.local', kind: 'admin' };
  }

  const assertion = c.req.header('Cf-Access-Jwt-Assertion');
  if (assertion) {
    try {
      const { payload } = await jwtVerify(assertion, jwksFor(env.ACCESS_TEAM_DOMAIN), {
        issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
        audience: env.ACCESS_AUD,
      });
      const email = typeof payload.email === 'string' ? payload.email : null;
      if (email) return { email, kind: 'access' };
      return null;
    } catch {
      // An expired or mis-signed assertion is exactly as unauthenticated as none
      // at all; the reason is not echoed back, because it is not the operator's
      // problem and it would only help someone probing.
      return null;
    }
  }

  // Local development only, and only over the loopback interface. `wrangler dev`
  // serves on 127.0.0.1, so a request from anywhere else cannot reach this path.
  if (env.ENVIRONMENT === 'dev' && isLoopback(c.req.url)) {
    return { email: 'dev@localhost', kind: 'access' };
  }

  return null;
}

/** Put a verified actor on the context, or answer 401. */
export const requireActor: MiddlewareHandler<{ Bindings: Env; Variables: { actor: Actor } }> = async (c, next) => {
  const actor = await resolveActor(c as unknown as Context<{ Bindings: Env }>);
  if (!actor) {
    const { body, status } = fail('E_UNAUTHENTICATED');
    return c.json(body, status as 401);
  }
  c.set('actor', actor);
  await next();
};

/**
 * Admin only: cron and GitHub Actions. A human session is explicitly refused so
 * that a leaked console session can never trigger a cost-bearing job.
 */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: { actor: Actor } }> = async (c, next) => {
  const actor = await resolveActor(c as unknown as Context<{ Bindings: Env }>);
  if (!actor || actor.kind !== 'admin') {
    const { body, status } = fail('E_FORBIDDEN', { reason: 'admin_only' });
    return c.json(body, status as 403);
  }
  c.set('actor', actor);
  await next();
};
