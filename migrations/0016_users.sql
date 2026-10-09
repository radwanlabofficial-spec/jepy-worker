-- 0016_users.sql
--
-- Operator identity lives somewhere queryable. The audit log has always recorded
-- `actor_email`, but there is no users table, so "who can act" was answered by
-- Cloudflare Access alone and "who has which role" was not answered at all.
-- This adds the table the console's user management needs.
--
-- WHY EACH ITEM IS HERE
--
-- 1. `users` — email-keyed operator roster. `role` is the only thing the Worker
--    checks: `admin` routes already gate on X-Admin-Secret (middleware/auth.ts
--    `requireAdmin`), and this table is the console's record of WHO holds that
--    secret or an Access seat, and what they are allowed to do in the UI.
--    `status` is a soft kill switch — DELETE sets 'disabled' rather than
--    removing the row, because the audit log points at people and a deleted
--    row turns "who did this" into a dangling id.
--
-- 2. `audit_log` widen — the enum in 0001 (widened by 0006) has no 'user'
--    entity_type, and SQLite cannot ALTER a CHECK. Rebuilding and copying rows,
--    exactly as 0006 did, is the only forward-only way to record user
--    mutations honestly. Without it the users routes would have to skip
--    auditing or lie about the entity type — both worse than a table rebuild.
--
-- AUTHORITY: Track D item 8. This widens one enum and adds one table; it does
-- not change a locked decision, so no new ADR is required.

-- ---------------------------------------------------------------------------
-- 1. The operators table
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER
);

CREATE INDEX idx_users_email ON users(email);

-- ---------------------------------------------------------------------------
-- 2. audit_log — admit 'user' as an entity_type, copy rows, keep the indexes
-- ---------------------------------------------------------------------------

-- Every existing row is a valid row of the widened table: the new enum is a
-- superset, and no column changed name or type.
CREATE TABLE audit_log_new (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL
                 CHECK (entity_type IN ('credential','selector_pack','manual_source','device',
                                        'directory_source','provider_account','user')),
  entity_id    TEXT,
  action       TEXT NOT NULL
                 CHECK (action IN ('add','rotate','delete','test','approve','reject','override',
                                   'revoke','draft','activate','heal','update',
                                   'capture_override','gate_auto_tighten','account_create')),
  actor_email  TEXT,
  result       TEXT,
  detail_json  TEXT,
  ip_hash      TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO audit_log_new
  SELECT id, entity_type, entity_id, action, actor_email, result, detail_json, ip_hash, created_at
    FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at);
CREATE INDEX idx_audit_log_actor  ON audit_log(actor_email, created_at);
