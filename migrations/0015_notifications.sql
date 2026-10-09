-- 0015_notifications.sql — in-dashboard system notifications.
--
-- Why this exists: until now there was nowhere for the Worker to say "your
-- import finished" or "quota is nearly gone" — everything operator-facing went
-- to chat. That is fine for a chat-driven operator, but the dashboard's
-- unread-badge (the number it will poll) needs a table, and a table makes the
-- messages queryable rather than ephemeral. This is the operator's inbox.
--
-- `read_at` is a timestamp, not a boolean: marking a row read is an event with
-- a time, and "when did the operator first see the quota warning" is exactly
-- the kind of question an incident post-mortem asks. `created_at` is
-- unixepoch() like the rest of the schema, not a DEFAULT, because D1 rows
-- written through the Workers API and through the migration runner should carry
-- the same clock.
--
-- `kind` is deliberately free text, not a CHECK enum: the producer that invents
-- a new kind (tomorrow's cron failure, the vault export) should not need a
-- migration to say it. The closed error-code enum in `lib/envelope.ts` is the
-- one that stays closed — this one is an open vocabulary on purpose.
--
-- WRITE SAFETY: the only writer is `lib/notify.ts`, which catches and swallows
-- its own failures. A notification must never break its caller — the import
-- that just finished is more important than the row announcing it.
--
-- READ DISCIPLINE: the dashboard polls exactly one query,
-- `GET /api/notifications/unread-count`, which is a single COUNT filtered on
-- `read_at IS NULL` and served by `idx_notifications_unread`. The list route
-- runs one query. There is no per-row lookup and no polling added anywhere
-- else.

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  actor_email TEXT,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);

-- Covers both dashboard queries: WHERE read_at IS NULL (the unread count) and
-- the list's ORDER BY (read_at IS NOT NULL), created_at DESC. Rows are tiny and
-- few — a few hundred at most — so this one index is the whole read path.
CREATE INDEX idx_notifications_unread ON notifications(read_at, created_at);
