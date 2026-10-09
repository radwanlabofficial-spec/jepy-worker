/**
 * The single writer for `notifications`.
 *
 * WHY ONE FUNCTION, AND WHY IT CANNOT THROW. A notification is an announcement
 * about work that already happened — the import finished, the quota tipped —
 * and the announcement is always less important than the work. Every caller
 * wraps its write in this function rather than touching the table directly, and
 * this function catches everything, because a D1 write that fails inside a
 * notification path must cost the operator an announcement, never the import
 * that was announcing itself. There is no retry: a failed announcement is
 * silently dropped, and the next poll of the unread count will simply not see
 * it.
 *
 * Returns the row id, or null when the write failed. Callers that need the id
 * (the admin `POST /api/notifications` route) get it; callers that don't can
 * ignore it.
 */

import type { Actor } from '../env';

export interface NotifyInput {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** The actor whose action the notification is about; defaults to null. */
  actor_email?: string | null;
}

export async function notify(db: D1Database, input: NotifyInput): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO notifications (id, kind, title, body, link, actor_email, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, unixepoch())`,
      )
      .bind(id, input.kind, input.title, input.body ?? null, input.link ?? null, input.actor_email ?? null)
      .run();
    return id;
  } catch {
    // Swallowed on purpose — see the header comment. A notification failure is
    // not an event worth reporting through the very channel that just failed.
    return null;
  }
}

/** Convenience: record who the notification is about from the request actor. */
export function notifyActor(c: { get(key: string): Actor | undefined }): string | null {
  const actor = c.get('actor');
  return actor?.email ?? null;
}
