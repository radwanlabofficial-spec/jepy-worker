/**
 * User management — the console's operator roster (Track D item 8).
 *
 * THE AUDIT LOG TRACKED PEOPLE WHO DID NOT EXIST. Every audit row names an
 * `actor_email`, but there was no users table, so the console had nowhere to
 * show "who the operators are" and nowhere to record roles. This router is
 * that table's door; the table itself is migration 0016.
 *
 * ALL ROUTES ARE ADMIN-ONLY (`requireAdmin`, i.e. X-Admin-Secret). A human
 * console session is refused, exactly like the other admin doors: a leaked
 * session must never be able to promote itself. DELETE is a soft disable, not
 * a row removal — audit rows point at users by id, and a removed row turns
 * "who did this" into a dangling reference.
 *
 * Mounted by the coordinator at /api (index.ts owns the mount; this file owns
 * the routes), so the paths below read GET /api/users and friends.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { requireAdmin } from '../middleware/auth';
import { auditLog } from './misc';
import type { Actor, Env } from '../env';

export const userRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

// The whole router is admin-only: there is no read half for humans, because a
// roster of operators is itself sensitive (it names the people whose sessions
// are worth stealing).
userRoutes.use('*', requireAdmin);

const ROLE = z.enum(['admin', 'operator', 'viewer']);
const STATUS = z.enum(['active', 'disabled']);

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  created_at: number;
  updated_at: number | null;
}

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(200).nullish(),
  role: ROLE.optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).nullish(),
  role: ROLE.optional(),
  status: STATUS.optional(),
});

/**
 * The roster, one query. Deleted users are not removed — they come back with
 * status='disabled' — because the audit trail points at them.
 */
userRoutes.get('/users', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, email, name, role, status, created_at, updated_at
       FROM users ORDER BY email ASC`,
  ).all<UserRow>();
  return c.json(ok(rows.results ?? []));
});

/**
 * Add an operator. Idempotent by email: adding someone who is already on the
 * roster returns the existing row (with `created: false`) rather than erroring,
 * because the console's "add" button and a retry must not produce duplicates.
 */
userRoutes.post('/users', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const { email, name, role } = parsed.data;

  const existing = await c.env.DB.prepare(
    `SELECT id, email, name, role, status, created_at, updated_at FROM users WHERE email = ?`,
  )
    .bind(email)
    .first<UserRow>();
  if (existing) {
    return c.json(ok({ user: existing, created: false as const }));
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', unixepoch())`,
  )
    .bind(id, email, name ?? null, role ?? 'viewer')
    .run();

  const user = await c.env.DB.prepare(
    `SELECT id, email, name, role, status, created_at, updated_at FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<UserRow>();

  await auditLog(c.env, c.get('actor'), {
    entityType: 'user',
    entityId: id,
    action: 'add',
    detail: { email, role: role ?? 'viewer' },
  });

  return c.json(ok({ user, created: true as const }));
});

/**
 * Rename, re-role, or re-enable/disable an operator. Only the fields present
 * are touched; an absent field is not a reset.
 */
userRoutes.patch('/users/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    const { body, status } = fail('E_VALIDATION', { reason: 'nothing_to_update' });
    return c.json(body, status as 400);
  }

  const id = c.req.param('id');
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (parsed.data.name !== undefined) {
    sets.push('name = ?');
    binds.push(parsed.data.name ?? null);
  }
  if (parsed.data.role !== undefined) {
    sets.push('role = ?');
    binds.push(parsed.data.role);
  }
  if (parsed.data.status !== undefined) {
    sets.push('status = ?');
    binds.push(parsed.data.status);
  }
  sets.push('updated_at = unixepoch()');

  const result = await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds, id)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_user' });
    return c.json(body, status as 404);
  }

  const user = await c.env.DB.prepare(
    `SELECT id, email, name, role, status, created_at, updated_at FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<UserRow>();

  await auditLog(c.env, c.get('actor'), {
    entityType: 'user',
    entityId: id,
    action: 'update',
    detail: { changed: Object.keys(parsed.data) },
  });

  return c.json(ok({ user }));
});

/**
 * Soft-delete: the row stays, the status becomes 'disabled'. A hard delete
 * would orphan every audit row that names this operator's email/id, and "who
 * did this" is the one question the audit log must always answer.
 */
userRoutes.delete('/users/:id', async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    `UPDATE users SET status = 'disabled', updated_at = unixepoch() WHERE id = ?`,
  )
    .bind(id)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_user' });
    return c.json(body, status as 404);
  }

  await auditLog(c.env, c.get('actor'), {
    entityType: 'user',
    entityId: id,
    action: 'delete',
    detail: { status: 'disabled' },
  });

  return c.json(ok({ id, status: 'disabled' as const }));
});
