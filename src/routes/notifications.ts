/**
 * In-dashboard system notifications (Track C, item 9).
 *
 * READ DISCIPLINE. The dashboard polls exactly one query —
 * `GET /api/notifications/unread-count`, a single COUNT on `read_at IS NULL`
 * served by `idx_notifications_unread`. The list runs one query: unread first,
 * then newest, keyset-paginated by an opaque cursor. Mutations are admin-only
 * (X-Admin-Secret); reads are console-compatible so the dashboard can poll
 * them through the Pages proxy.
 *
 * WRITES go through `lib/notify.ts`, which never throws. The one exception is
 * `POST /api/notifications` itself — an admin deliberately creating an
 * announcement — which also calls `notify()` so the failure-swallow holds for
 * every writer without exception.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { notify } from '../lib/notify';
import { requireActor, requireAdmin } from '../middleware/auth';
import type { Actor, Env } from '../env';

export const notificationsRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Keyset cursor: {ir: 1 if the row was already read, ca: created_at, id}. */
interface PageCursor {
  ir: 0 | 1;
  ca: number;
  id: string;
}

function encodeCursor(c: PageCursor): string {
  // btoa, not Node's Buffer: the codebase idiom (see lib/device.ts), and the
  // payload is ASCII-only JSON (a UUID id), so no UTF-8 dance is needed.
  return btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(raw: string): PageCursor | null {
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      ((parsed as PageCursor).ir === 0 || (parsed as PageCursor).ir === 1) &&
      typeof (parsed as PageCursor).ca === 'number' &&
      typeof (parsed as PageCursor).id === 'string'
    ) {
      return parsed as PageCursor;
    }
    return null;
  } catch {
    return null;
  }
}

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  actor_email: string | null;
  read_at: number | null;
  created_at: number;
}

notificationsRoutes.get('/notifications', requireActor, async (c) => {
  // Clamp, don't reject: a dashboard asking for 500 rows is a dashboard that
  // got a wrong default from somewhere, and a clamped page is kinder than a
  // 400 nobody reads.
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), MAX_LIMIT) : DEFAULT_LIMIT;

  const cursorRaw = c.req.query('cursor');
  let cursor: PageCursor | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      const { body, status } = fail('E_VALIDATION', { reason: 'bad_cursor' });
      return c.json(body, status as 400);
    }
  }

  // One query for the page. Unread first (`read_at IS NULL` sorts 0 before 1),
  // then newest — so the operator sees what they have not seen, in the order
  // it happened. The keyset WHERE mirrors the ORDER BY term for term, which is
  // what makes the cursor stable: a new notification landing between page 1
  // and page 2 pushes the page boundary, not the rows already served.
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, title, body, link, actor_email, read_at, created_at
       FROM notifications
      WHERE (? IS NULL)
         OR ((read_at IS NOT NULL) > ?)
         OR ((read_at IS NOT NULL) = ? AND created_at < ?)
         OR ((read_at IS NOT NULL) = ? AND created_at = ? AND id < ?)
      ORDER BY (read_at IS NOT NULL), created_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(
      cursor ? null : 'first',
      cursor?.ir ?? 0,
      cursor?.ir ?? 0,
      cursor?.ca ?? 0,
      cursor?.ir ?? 0,
      cursor?.ca ?? 0,
      cursor?.id ?? '',
      limit + 1,
    )
    .all<NotificationRow>();

  const all = rows.results ?? [];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;

  // The next cursor is the last row's position — a real row, not a computed
  // offset — so concurrent reads and inserts cannot skip or duplicate a row.
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ ir: last.read_at === null ? 0 : 1, ca: last.created_at, id: last.id }) : null;

  return c.json(ok({ notifications: page }, { next_cursor: nextCursor, has_more: hasMore }));
});

notificationsRoutes.get('/notifications/unread-count', requireActor, async (c) => {
  // This is THE polled query: one COUNT, served by idx_notifications_unread.
  // If the dashboard ever needs more than a number, it opens the list route;
  // this endpoint stays one query on purpose.
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL`).first<{ n: number }>();
  return c.json(ok({ unread: row?.n ?? 0 }));
});

const createSchema = z.object({
  kind: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  body: z.string().max(4000).nullish(),
  link: z.string().max(1000).nullish(),
  actor_email: z.string().max(320).nullish(),
});

notificationsRoutes.post('/notifications', requireAdmin, async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const input = parsed.data;

  // Goes through notify() like every other writer, so the never-throws
  // guarantee covers the admin path too.
  const id = await notify(c.env.DB, {
    kind: input.kind,
    title: input.title,
    body: input.body,
    link: input.link,
    actor_email: input.actor_email,
  });
  if (!id) {
    const { body, status } = fail('E_INTERNAL', { reason: 'notify_failed' });
    return c.json(body, status as 500);
  }
  return c.json(ok({ id }));
});

notificationsRoutes.post('/notifications/:id/read', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    `UPDATE notifications SET read_at = unixepoch() WHERE id = ? AND read_at IS NULL`,
  )
    .bind(id)
    .run();

  // `read_at IS NULL` in the WHERE keeps this idempotent: reading an already-
  // read row is a no-op success, but an unknown id is a 404 — the caller asked
  // about a notification that does not exist, and that is a fact worth
  // knowing.
  if ((result.meta.changes ?? 0) === 0) {
    const known = await c.env.DB.prepare(`SELECT id FROM notifications WHERE id = ?`).bind(id).first<{ id: string }>();
    if (!known) {
      const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_notification' });
      return c.json(body, status as 404);
    }
  }
  return c.json(ok({ id, read: true }));
});

notificationsRoutes.post('/notifications/read-all', requireAdmin, async (c) => {
  const result = await c.env.DB.prepare(
    `UPDATE notifications SET read_at = unixepoch() WHERE read_at IS NULL`,
  ).run();
  return c.json(ok({ marked_read: result.meta.changes ?? 0 }));
});
