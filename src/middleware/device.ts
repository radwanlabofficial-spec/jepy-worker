/**
 * The device door, and the list of exactly where it leads.
 *
 * ADR-035 fixes the scope at THREE endpoints and says so in the security
 * requirements as well: a device token reaches `GET /api/jobs/pending`,
 * `POST /api/jobs/:id/result` and `POST /api/devices/heartbeat`, and nothing
 * else. Adding `/api/captures` to that scope is a named, forbidden act until
 * ADR-035 is superseded — because a token that can only fetch queued work and
 * report it back is a token whose leak is a nuisance, whereas a token that can
 * reach leads is a token whose leak is a breach of the lead database.
 *
 * So the scope is enforced TWICE, on purpose:
 *
 *   1  only three routes mount this middleware at all
 *   2  the middleware itself refuses any path outside DEVICE_SCOPE
 *
 * The second check exists because the first one is a line in a different file.
 * Somebody adding `deviceRoutes.use(requireDevice)` over a wider path is an easy
 * mistake to make and a hard one to notice; with the check here, that mistake
 * produces 403s in the logs instead of an open door.
 *
 * THE DIRECTIVE TRAVELS BACK ON EVERY REPLY. `run` | `pause` | `drain` | `revoke`
 * is read fresh from `devices.current_directive` and returned as
 * `X-Device-Directive`, with `X-Device-Pack-Epoch` beside it. That is the whole
 * kill switch: there is no push channel to a browser extension, so the next poll
 * is the earliest moment a stop can take effect — and an operator watching a
 * runaway capture needs to know that the stop lands within one poll rather than
 * immediately.
 *
 * `revoke` is a hard 403. `pause` and `drain` are NOT errors: they are the
 * operator asking the extension to stop taking NEW work, so the pending endpoint
 * answers honestly with an empty list and the reason attached, rather than
 * failing and letting the extension decide for itself what that meant.
 */

import type { MiddlewareHandler } from 'hono';
import { fail } from '../lib/envelope';
import { hashDeviceToken } from '../lib/device';
import type { Actor, Env } from '../env';

/** The three paths a device token is allowed to reach. ADR-035. */
export const DEVICE_SCOPE: readonly string[] = [
  'GET /api/jobs/pending',
  'POST /api/jobs/:id/result',
  'POST /api/devices/heartbeat',
];

export interface DeviceRow {
  id: string;
  device_label: string;
  mode: 'a' | 'b' | 'both';
  current_directive: 'run' | 'pause' | 'drain' | 'revoke';
  pack_epoch: number;
  status: 'active' | 'stale' | 'revoked';
}

/**
 * The path as the scope list spells it, so one `:id` matches whatever the id is.
 *
 * Deliberately narrow: it rewrites a run of hex-and-dash (a UUID, which is what
 * every id in this system is) and nothing else. Anything it does not recognise
 * stays literal, fails the scope comparison, and gets a 403 — the check fails
 * closed, which is the only acceptable direction for it to fail.
 */
function normalisePath(method: string, path: string): string {
  return `${method} ${path.replace(/\/[0-9a-fA-F-]{8,}\//, '/:id/')}`;
}

/**
 * Is this one of ADR-035's three paths?
 *
 * ONE SOURCE OF TRUTH, USED TWICE. The global `/api/*` guard asks this question
 * to decide whether a request has to carry a human identity, and `requireDevice`
 * asks it to decide whether a device token is allowed here at all. Deriving both
 * from the same list is what stops the two from drifting: the first version of
 * this had the list written out twice, and the paths that reach `requireDevice`
 * never got past the global guard to be checked, so the extension would have been
 * refused on its own endpoints in production while every local test passed —
 * because the dev loopback bypass quietly satisfies the human guard.
 */
export function isDevicePath(method: string, path: string): boolean {
  return DEVICE_SCOPE.includes(normalisePath(method, path));
}

export const requireDevice: MiddlewareHandler<{ Bindings: Env; Variables: { actor: Actor; device: DeviceRow } }> =
  async (c, next) => {
    const token = c.req.header('X-Device-Token');
    if (!token) {
      const { body, status } = fail('E_UNAUTHENTICATED', { reason: 'device_token_required' });
      return c.json(body, status as 401);
    }

    // Second line of defence: refuse anything outside the ADR-035 scope even if a
    // future route accidentally mounts this middleware elsewhere.
    if (!isDevicePath(c.req.method, c.req.path)) {
      const { body, status } = fail('E_FORBIDDEN', { reason: 'outside_device_scope', path: c.req.path });
      return c.json(body, status as 403);
    }

    const device = await c.env.DB.prepare(
      `SELECT id, device_label, mode, current_directive, pack_epoch, status
         FROM devices WHERE token_hash = ?`,
    )
      .bind(await hashDeviceToken(token))
      .first<DeviceRow>();

    // Unknown token and revoked device answer the same way: telling the caller
    // which of the two it was tells a stolen token whether it is still live.
    if (!device) {
      const { body, status } = fail('E_UNAUTHENTICATED', { reason: 'unknown_device_token' });
      return c.json(body, status as 401);
    }

    // The directive is the real gate, so it outranks `status`: an operator who
    // sets `revoke` expects the extension to stop on its next poll, without
    // waiting for anything else to catch up.
    if (device.status === 'revoked' || device.current_directive === 'revoke') {
      const { body, status } = fail('E_FORBIDDEN', { reason: 'device_revoked' });
      return c.json(body, status as 403);
    }

    c.set('actor', { email: `device:${device.id}`, kind: 'device' });
    c.set('device', device);
    await next();

    // Stamped after the handler so the value is on every device reply, including
    // the ones that return early from inside the route.
    c.header('X-Device-Directive', device.current_directive);
    c.header('X-Device-Pack-Epoch', String(device.pack_epoch));
  };

/**
 * True when the operator has asked this device to stop taking NEW work. The
 * pending endpoint answers with an empty list and this reason; it is not an error
 * state, and the extension must not treat it as one.
 */
export function isPaused(device: DeviceRow): boolean {
  return device.current_directive === 'pause' || device.current_directive === 'drain';
}
