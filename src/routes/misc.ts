/**
 * Audit, devices, geo targets, niches, router weights.
 *
 * `router-weights` is exposed as its own route so the console can disable the
 * edit affordance without parsing JSON, and the reason it is read-only is
 * returned alongside the value rather than left to the client to know.
 */

import { Hono } from 'hono';
import type { Handler } from 'hono';
import { fail, ok } from '../lib/envelope';
import { intParam } from '../lib/http';
import type { Actor, Env } from '../env';

export const miscRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

type AppEnv = { Bindings: Env; Variables: { actor: Actor } };

/**
 * The one audit writer the other route modules share.
 *
 * `routes/vault.ts` keeps its own private helper and should: it hardcodes
 * `entity_type='credential'`, which is correct for every route in that file.
 * Directory transport edits, selector-pack transitions, Class C overrides and
 * provider-account creation are NOT credential changes, and `0006` widened the
 * `audit_log` enums precisely so each can be recorded under its own
 * `entity_type` instead of being smuggled in as a credential with a `kind` in
 * the detail blob. That workaround made "who added a provider account" and "who
 * added a credential" the same question, which is the opposite of why the table
 * exists. This is the shared form; the caller names the entity.
 *
 * Deliberately swallows its own failure: a lost audit row must never turn a
 * successful operator action into an error for the operator, and the error path
 * already records anything that really breaks. `detail` must never carry key
 * material — the same rule the vault helper follows.
 */
export async function auditLog(
  env: Env,
  actor: Actor,
  entry: {
    entityType: string;
    entityId: string | null;
    action: string;
    result?: string;
    detail?: Record<string, unknown>;
  },
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, entity_type, entity_id, action, actor_email, result, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    )
      .bind(
        id,
        entry.entityType,
        entry.entityId,
        entry.action,
        actor.email,
        entry.result ?? 'ok',
        entry.detail ? JSON.stringify(entry.detail) : null,
      )
      .run();
    return id;
  } catch {
    // ignore
    return null;
  }
}

miscRoutes.get('/audit', async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(intParam(url, 'limit') ?? 100, 500);
  const entityType = url.searchParams.get('entity_type');

  // Aliased to the contract's names: `at` and `detail`. Returning created_at and
  // detail_json left the WHEN and DETAIL columns of the audit table empty.
  const columns = `id, entity_type, entity_id, action, actor_email, result,
                   detail_json AS detail, created_at AS at`;

  const result = entityType
    ? await c.env.DB.prepare(
        `SELECT ${columns} FROM audit_log WHERE entity_type = ? ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(entityType, limit)
        .all()
    : await c.env.DB.prepare(`SELECT ${columns} FROM audit_log ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all();

  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/devices', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT d.id, d.device_label, d.mode, d.current_directive, d.pack_epoch, d.last_heartbeat_at,
            d.jobs_completed, d.captures_committed, d.status, d.created_at,
            CASE WHEN d.last_heartbeat_at IS NULL THEN NULL
                 ELSE unixepoch() - d.last_heartbeat_at END AS heartbeat_age_sec
       FROM devices d ORDER BY d.created_at DESC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/geo-targets', async (c) => {
  // The contract declares {id, label, country_code, niche_count, enabled}. `label`
  // is the most specific name the row has, and `niche_count` is counted from the
  // leads actually captured there rather than stored, because a stored counter is
  // one more thing that can drift away from the leads it counts.
  const result = await c.env.DB.prepare(
    `SELECT g.id,
            -- COALESCE takes at least two arguments; wrapping a bare CASE in one
            -- is a syntax error that only shows up at execution time.
            COALESCE(
              CASE WHEN g.city IS NOT NULL AND g.region IS NOT NULL THEN g.city || ', ' || g.region
                   WHEN g.city IS NOT NULL THEN g.city
                   WHEN g.region IS NOT NULL THEN g.region
                   ELSE NULL END,
              g.country_code
            ) AS label,
            g.country_code,
            (SELECT COUNT(DISTINCT l.niche) FROM leads l
              WHERE l.deleted_at IS NULL AND l.country_code = g.country_code
                AND (g.city IS NULL OR l.city = g.city)) AS niche_count,
            g.enabled
       FROM geo_targets g
      ORDER BY g.priority ASC, g.country_code ASC, g.city ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/niches', async (c) => {
  // The contract asks for `string[]`. Returning full rows here crashed nothing
  // but rendered nothing either, because the page maps over the values as
  // strings. Display names it is; a richer shape needs a console change first.
  const result = await c.env.DB.prepare(
    `SELECT display_name AS name FROM niches ORDER BY priority ASC, niche_slug ASC`,
  ).all<{ name: string }>();
  return c.json(ok((result.results ?? []).map((row) => row.name)));
});

/**
 * The error log feed, and the reason this is a named handler rather than an
 * inline route.
 *
 * `11-api-contract.md` §2 and §11 put the same resource at two paths:
 * `/api/settings/errors` (where the Settings page reads it) and
 * `/api/admin/errors` (where an operator or a script looks for it). Two paths
 * over ONE handler, never two copies — the moment they diverge, the console and
 * the operator stop looking at the same rows, and "the dashboard shows no errors"
 * stops being evidence of anything.
 */
const listErrors: Handler<AppEnv> = async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(intParam(url, 'limit') ?? 100, 500);
  const since = intParam(url, 'since');

  // Aliased to the contract: `at`, `reason`, `message`. `scope` is the closest
  // thing error_log has to a reason, and the code stays as it was recorded.
  const result = since
    ? await c.env.DB.prepare(
        `SELECT id, created_at AS at, code, scope AS reason, job_id, provider, message
           FROM error_log WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(since, limit)
        .all()
    : await c.env.DB.prepare(
        `SELECT id, created_at AS at, code, scope AS reason, job_id, provider, message
           FROM error_log ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(limit)
        .all();

  return c.json(ok(result.results ?? []));
};

// The console asks for these under /settings; they were served at /audit and
// /devices, so both paths exist rather than one being moved and breaking the
// other caller.
miscRoutes.get('/settings/errors', listErrors);
miscRoutes.get('/admin/errors', listErrors);

miscRoutes.get('/settings/devices', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT d.id, d.device_label, d.mode, d.current_directive, d.pack_epoch, d.last_heartbeat_at,
            d.jobs_completed, d.captures_committed, d.status, d.created_at,
            CASE WHEN d.last_heartbeat_at IS NULL THEN NULL
                 ELSE unixepoch() - d.last_heartbeat_at END AS heartbeat_age_sec
       FROM devices d ORDER BY d.created_at DESC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

miscRoutes.get('/settings/router-weights', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT value_text FROM settings WHERE key = 'router_weights_json'`,
  ).first<{ value_text: string | null }>();

  // A flat `Record<string, number>`, because that is what the contract declares
  // and the page renders every entry with `toFixed(2)`. Wrapping the weights in
  // an object with metadata put `editable: false` and `reason: 'adr_required'`
  // into those entries, and calling toFixed on a boolean throws — which is
  // exactly how the Settings page broke. Provenance belongs in the UI text, not
  // in a payload that is iterated as numbers.
  try {
    const parsed = row?.value_text ? (JSON.parse(row.value_text) as Record<string, number>) : {};
    return c.json(ok(parsed));
  } catch {
    // Malformed stored JSON is surfaced as a real error rather than an empty
    // object: an empty weight set looks like "not configured" when the truth is
    // "misconfigured", and those need different reactions.
    const { body, status } = fail('E_INTERNAL', { reason: 'router_weights_json_invalid' });
    return c.json(body, status as 500);
  }
});

/**
 * Mode B capture ingest — CLOSED, and closed on purpose.
 *
 * ADR-035 ships Mode B disabled: the operator-driven capture path is not part
 * of this build, so `/api/captures` exists only to say so. It must answer a
 * real 403 with `detail.reason='mode_b_disabled'` rather than 404, because the
 * two are different facts to the console — a 404 reads as "this build is older
 * than the UI", the 403 reads as "the feature is gated", and only the second
 * lets the Captures page render its disabled empty state instead of an error.
 *
 * WHY THESE PATHS ARE NOT IN THE DEVICE SCOPE. ADR-035 fixes a device token to
 * three endpoints (jobs/pending, jobs/:id/result, devices/heartbeat) and names
 * adding `/api/captures` to that scope a forbidden act until the gate is opened.
 * A token that can only fetch queued work and report it back leaks a nuisance;
 * a token that can reach a lead-writing door leaks the lead database. The two
 * routes below therefore sit behind the ordinary human/admin guard — which is
 * ALSO why they are not a device route and why `DEVICE_SCOPE` is untouched.
 *
 * ADR-035's own condition for changing this, verbatim: open Mode B only for a
 * source_key allowlist — class='C' with an overridable block_reason — with
 * batches ≤ 25 records, a two-step preview→commit, and `override_reason` of at
 * least 20 characters. Until all four hold, this handler stays.
 */
const modeBDisabled: Handler<AppEnv> = (c) => {
  const { body, status } = fail('E_FORBIDDEN', { reason: 'mode_b_disabled' });
  return c.json(body, status as 403);
};

miscRoutes.get('/captures', modeBDisabled);
miscRoutes.post('/captures', modeBDisabled);
