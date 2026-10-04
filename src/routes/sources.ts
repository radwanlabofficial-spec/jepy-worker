/**
 * Sources — directories, Class C manual rows, Class X blocks, import ledger.
 *
 * Field names here are the CONTRACT's, not the database's, and the translation
 * happens in SQL aliases. The console's types are the contract
 * (13-ui-contract.md), so `rate_limit_per_min` leaves as `rate_limit_rpm`,
 * `last_success_at` as `last_ok_at`, and the pagination blob is unpacked into the
 * three flat fields the table renders. Returning database column names instead
 * produced `undefined` cells and, where a page mapped over the result, a blank
 * screen — the two most visible faults in the console.
 *
 * `block_reason` and `class` travel on every row so the UI never has to infer a
 * gate from a missing field, and Class X is returned like any other row rather
 * than filtered out: its `enabled` flag is what makes it unusable, and hiding it
 * would make the registry lie by omission.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { intParam } from '../lib/http';
import { enqueue } from '../lib/queue';
import { auditLog } from './misc';
import type { Actor, Env } from '../env';

export const sourceRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

/**
 * Shared projection. `active_pack_version` is a correlated subquery rather than a
 * join so a source with two active packs (which should never happen) still yields
 * one row here instead of multiplying.
 */
const DIRECTORY_SELECT = `
  SELECT d.source_key, d.display_name, d.base_url, d.target_type, d.adapter,
         COALESCE(d.rate_limit_per_min, 0) AS rate_limit_rpm,
         d.url_template,
         json_extract(d.pagination_json, '$.mode')      AS pagination_mode,
         json_extract(d.pagination_json, '$.param')     AS pagination_param,
         json_extract(d.pagination_json, '$.max_pages') AS max_pages,
         d.enabled, d.health, d.consecutive_failures,
         d.last_success_at AS last_ok_at,
         d.class, d.block_reason, d.why_manual, d.manual_url_template,
         d.attribution_html, d.robots_ok, d.requires_credential, d.note,
         (SELECT MAX(p.version) FROM selector_packs p
           WHERE p.source_key = d.source_key AND p.status = 'active') AS active_pack_version
    FROM directory_sources d`;

sourceRoutes.get('/sources/directories', async (c) => {
  const url = new URL(c.req.url);
  const sourceClass = url.searchParams.get('class');

  const result = sourceClass
    ? await c.env.DB.prepare(`${DIRECTORY_SELECT} WHERE d.class = ? AND d.deleted_at IS NULL ORDER BY d.class ASC, d.source_key ASC`)
        .bind(sourceClass)
        .all()
    : await c.env.DB.prepare(`${DIRECTORY_SELECT} WHERE d.deleted_at IS NULL ORDER BY d.class ASC, d.source_key ASC`).all();

  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/manual', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT d.source_key, d.display_name, d.block_reason, d.why_manual,
            d.manual_url_template, d.attribution_html,
            -- The override lives on the capture batch, not on the source: a
            -- permission is granted per capture session, never once and for all.
            COALESCE((SELECT b.override_ack FROM capture_batches b
                       WHERE b.source_key = d.source_key
                       ORDER BY b.created_at DESC LIMIT 1), 0) AS override_ack,
            (SELECT b.override_reason FROM capture_batches b
              WHERE b.source_key = d.source_key
              ORDER BY b.created_at DESC LIMIT 1) AS override_reason
       FROM directory_sources d
      WHERE d.class = 'C' AND d.deleted_at IS NULL
      ORDER BY d.source_key ASC`,
  ).all();
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/blocked', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT d.source_key, d.display_name, d.block_reason,
            -- The console labels this column "explanation"; the registry stores
            -- the same idea as why_manual.
            COALESCE(d.why_manual, d.note, '') AS explanation,
            d.class
       FROM directory_sources d
      WHERE d.block_reason <> 'none' AND d.deleted_at IS NULL
      ORDER BY d.class ASC, d.source_key ASC`,
  ).all();

  // An array, because the console declares `BlockedSource[]`. Wrapping it in an
  // object was a mistake of mine and it crashed the tab that maps over it — the
  // rule is simple: the declared type wins, every time.
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/imports', async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(intParam(url, 'limit') ?? 50, 200);
  const result = await c.env.DB.prepare(
    `SELECT id, dataset, release_version,
            rows_read      AS rows_scanned,
            rows_inserted  AS rows_ingested,
            rows_deduped   AS rows_merged,
            COALESCE(rows_read, 0) - COALESCE(rows_kept, 0) AS rows_skipped,
            min_confidence, duration_sec, status, started_at
       FROM dataset_imports ORDER BY started_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/selector-packs', async (c) => {
  const url = new URL(c.req.url);
  const sourceKey = url.searchParams.get('source_key');

  const sql = `
    SELECT id, source_key, version, status, field_count, success_rate, runs, empty_runs,
           generated_by, heal_reason, sample_ref, approved_by, approved_at, created_at,
           -- A short preview so the approve step is not a blind click.
           substr(COALESCE(selector_json, ''), 1, 160) AS selector_preview
      FROM selector_packs
     ${sourceKey ? 'WHERE source_key = ?' : ''}
     ORDER BY source_key ASC, version DESC`;

  const result = sourceKey
    ? await c.env.DB.prepare(sql).bind(sourceKey).all()
    : await c.env.DB.prepare(sql).all();

  return c.json(ok(result.results ?? []));
});

// The per-source form the console uses once a source is chosen. Registered as
// its own route because Hono treats an empty parameter and a missing segment as
// different paths, and the console is allowed to ask either way.
sourceRoutes.get('/sources/directories/:sourceKey/selector-packs', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, source_key, version, status, field_count, success_rate, runs, empty_runs,
            generated_by, heal_reason, sample_ref, approved_by, approved_at, created_at,
            substr(COALESCE(selector_json, ''), 1, 160) AS selector_preview
       FROM selector_packs WHERE source_key = ? ORDER BY version DESC`,
  )
    .bind(c.req.param('sourceKey'))
    .all();
  return c.json(ok(result.results ?? []));
});

sourceRoutes.get('/sources/health', async (c) => {
  const url = new URL(c.req.url);
  const since = intParam(url, 'since') ?? Math.floor(Date.now() / 1000) - 14 * 86_400;
  const result = await c.env.DB.prepare(
    `SELECT source_key, day, requests, success, blocked, empty, avg_latency_ms
       FROM source_health_log WHERE day >= date(?, 'unixepoch') ORDER BY day DESC, source_key ASC`,
  )
    .bind(since)
    .all();
  return c.json(ok(result.results ?? []));
});

// ---------------------------------------------------------------------------
// Transport edits (ADR-032) and the selector-pack lifecycle (ADR-030, R23)
// ---------------------------------------------------------------------------
//
// The split ADR-032 draws is the whole reason these routes are separate. A
// `directory_sources` row answers "how do we REACH the page" — base URL, URL
// template, pagination, rate, robots, enabled — and a `selector_packs` row
// answers "how do we READ it". Only the first is editable in place. The second
// is append-only by version, because a selector that is edited in place has no
// history, and the entire value of the heal flow is being able to roll back to
// the version that worked.

/** The pack projection both the list and the lifecycle routes return. */
const PACK_COLUMNS = `id, source_key, version, status, field_count, success_rate, runs, empty_runs,
       generated_by, heal_reason, sample_ref, approved_by, approved_at, created_at,
       substr(COALESCE(selector_json, ''), 1, 160) AS selector_preview`;

function readPack(db: Env['DB'], id: string) {
  return db.prepare(`SELECT ${PACK_COLUMNS} FROM selector_packs WHERE id = ?`).bind(id).first();
}

/** A stored pagination blob that will not parse is treated as absent, not fatal. */
function jsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `field_count` for the list column: how many fields a selector object maps. */
function countFields(selector: unknown): number | null {
  if (Array.isArray(selector)) return selector.length;
  if (selector && typeof selector === 'object') return Object.keys(selector as Record<string, unknown>).length;
  return null;
}

/**
 * Edit a Class B directory's TRANSPORT only.
 *
 * `base_url`, `url_template`, `pagination_*`, `enabled` and `robots_ok` are
 * transport; `selector_json` and `pack_version` are extraction and belong to a
 * new pack version, never to this row (ADR-032, R23). The schema is strict so a
 * selector field in the body is a 400 rather than a silently-ignored key — a
 * dropped field would look to the operator like the edit worked.
 *
 * Class C and Class X are refused outright. Their URLs are not automation
 * settings: a C row is fetched by a human and an X row is never fetched (R25),
 * so a transport edit could only misrepresent an automated door that must stay
 * shut. The row is loaded before the body is parsed so the refusal is about the
 * source, not about whether the caller sent well-formed JSON.
 */
const transportSchema = z
  .object({
    base_url: z.string().max(2000).nullable().optional(),
    url_template: z.string().max(2000).nullable().optional(),
    pagination_mode: z.string().max(40).nullable().optional(),
    pagination_param: z.string().max(60).nullable().optional(),
    max_pages: z.number().int().nonnegative().nullable().optional(),
    enabled: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
    robots_ok: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
  })
  .strict();

sourceRoutes.patch('/sources/directories/:sourceKey', async (c) => {
  const sourceKey = c.req.param('sourceKey');
  const row = await c.env.DB.prepare(
    `SELECT source_key, class, pagination_json FROM directory_sources WHERE source_key = ? AND deleted_at IS NULL`,
  )
    .bind(sourceKey)
    .first<{ source_key: string; class: string; pagination_json: string | null }>();

  if (!row) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }
  if (row.class === 'C' || row.class === 'X') {
    const { body, status } = fail('E_VALIDATION', { class: row.class, reason: 'class_not_editable' });
    return c.json(body, status as 400);
  }

  const parsed = transportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }
  const input = parsed.data;

  // Pagination is one blob on disk and three flat fields in the contract, so a
  // partial edit merges: changing only `max_pages` must not blank `mode`/`param`.
  let paginationJson: string | null | undefined;
  if (input.pagination_mode !== undefined || input.pagination_param !== undefined || input.max_pages !== undefined) {
    const current = jsonObject(row.pagination_json) ?? {};
    paginationJson = JSON.stringify({
      mode: input.pagination_mode !== undefined ? input.pagination_mode : current.mode ?? null,
      param: input.pagination_param !== undefined ? input.pagination_param : current.param ?? null,
      max_pages: input.max_pages !== undefined ? input.max_pages : current.max_pages ?? null,
    });
  }

  // Built as an explicit SET list rather than COALESCE, because a PATCH must be
  // able to CLEAR a field: `url_template: null` means "take the template away",
  // and COALESCE would read that null as "no change" and keep it. R5 holds —
  // updated_at is unix seconds.
  const sets: string[] = [];
  const params: unknown[] = [];
  const assign = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (input.base_url !== undefined) assign('base_url', input.base_url);
  if (input.url_template !== undefined) assign('url_template', input.url_template);
  if (paginationJson !== undefined) assign('pagination_json', paginationJson);
  if (input.enabled !== undefined) assign('enabled', input.enabled === true || input.enabled === 1 ? 1 : 0);
  if (input.robots_ok !== undefined) assign('robots_ok', input.robots_ok === true || input.robots_ok === 1 ? 1 : 0);

  if (sets.length === 0) {
    const { body, status } = fail('E_VALIDATION', { reason: 'empty_patch' });
    return c.json(body, status as 400);
  }
  sets.push('updated_at = unixepoch()');

  await c.env.DB.prepare(`UPDATE directory_sources SET ${sets.join(', ')} WHERE source_key = ?`)
    .bind(...params, sourceKey)
    .run();

  await auditLog(c.env, c.get('actor'), {
    entityType: 'directory_source',
    entityId: sourceKey,
    action: 'update',
    detail: { ...input },
  });

  const updated = await c.env.DB.prepare(`${DIRECTORY_SELECT} WHERE d.source_key = ?`).bind(sourceKey).first();
  return c.json(ok(updated));
});

const packDraftSchema = z.object({
  selector_json: z.unknown(),
  pagination_json: z.unknown().optional(),
  domain_pattern: z.string().max(200).nullable().optional(),
  heal_reason: z.string().max(500).nullable().optional(),
});

/**
 * Draft a NEW pack version. Never an edit, and never an activation.
 *
 * `max(version)+1` is chosen inside the INSERT, not by a SELECT before it, so
 * two drafts racing cannot both read the same maximum and collide on the unique
 * `(source_key, version)` index. The row is born `status='draft'`; nothing here
 * makes it run — `draft` from `active` is a human's approve step and only a
 * human's (ADR-030, R23). `generated_by='manual'` records that it came from the
 * console rather than a heal.
 */
sourceRoutes.post('/sources/directories/:sourceKey/selector-packs', async (c) => {
  const sourceKey = c.req.param('sourceKey');
  const source = await c.env.DB.prepare(
    `SELECT source_key FROM directory_sources WHERE source_key = ? AND deleted_at IS NULL`,
  )
    .bind(sourceKey)
    .first<{ source_key: string }>();
  if (!source) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const parsed = packDraftSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const id = crypto.randomUUID();
  const selectorJson = JSON.stringify(parsed.data.selector_json);
  const paginationJson = parsed.data.pagination_json === undefined ? null : JSON.stringify(parsed.data.pagination_json);

  await c.env.DB.prepare(
    `INSERT INTO selector_packs
       (id, source_key, domain_pattern, version, selector_json, pagination_json, field_count,
        status, generated_by, heal_reason, created_at)
     VALUES (?1, ?2, ?3,
             (SELECT COALESCE(MAX(version), 0) + 1 FROM selector_packs WHERE source_key = ?2),
             ?4, ?5, ?6, 'draft', 'manual', ?7, unixepoch())`,
  )
    .bind(
      id,
      sourceKey,
      parsed.data.domain_pattern ?? null,
      selectorJson,
      paginationJson,
      countFields(parsed.data.selector_json),
      parsed.data.heal_reason ?? null,
    )
    .run();

  const pack = await readPack(c.env.DB, id);
  await auditLog(c.env, c.get('actor'), {
    entityType: 'selector_pack',
    entityId: id,
    action: 'draft',
    detail: { source_key: sourceKey, version: (pack as { version?: number } | null)?.version ?? null },
  });

  return c.json(ok(pack));
});

/**
 * Promote a draft to active.
 *
 * The demotion of the previous active pack and the promotion of this one are
 * ONE `DB.batch`, so there is no instant where the source has two active packs
 * or none. ADR-032 requires exactly one `status='active'` per source, and a
 * two-statement sequence leaves a window where a concurrent read sees the
 * violation. The superseded pack is marked `broken`, which is also the status
 * `activate` rolls back from — that is what makes a rollback possible at all.
 */
sourceRoutes.post('/sources/selector-packs/:id/approve', async (c) => {
  const id = c.req.param('id');
  const pack = await c.env.DB.prepare(`SELECT id, source_key, version, status FROM selector_packs WHERE id = ?`)
    .bind(id)
    .first<{ id: string; source_key: string; version: number; status: string }>();
  if (!pack) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE selector_packs SET status = 'broken' WHERE source_key = ? AND status = 'active' AND id <> ?`,
    ).bind(pack.source_key, id),
    c.env.DB.prepare(`UPDATE selector_packs SET status = 'active', approved_by = ?, approved_at = ? WHERE id = ?`).bind(
      c.get('actor').email,
      now,
      id,
    ),
  ]);

  await auditLog(c.env, c.get('actor'), {
    entityType: 'selector_pack',
    entityId: id,
    action: 'approve',
    detail: { source_key: pack.source_key, version: pack.version },
  });
  return c.json(ok({ id, status: 'active' }));
});

/**
 * Reject a pack. The reason is optional here and recorded when present: the
 * console's reject button sends none, and a check that required one would turn a
 * working button into an error. `heal_reason` is deliberately not overwritten —
 * it records why a heal produced the pack, which is a different fact from why a
 * human declined it.
 */
sourceRoutes.post('/sources/selector-packs/:id/reject', async (c) => {
  const id = c.req.param('id');
  const pack = await c.env.DB.prepare(`SELECT id, source_key, version FROM selector_packs WHERE id = ?`)
    .bind(id)
    .first<{ id: string; source_key: string; version: number }>();
  if (!pack) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason : null;

  await c.env.DB.prepare(`UPDATE selector_packs SET status = 'rejected' WHERE id = ?`).bind(id).run();
  await auditLog(c.env, c.get('actor'), {
    entityType: 'selector_pack',
    entityId: id,
    action: 'reject',
    detail: { source_key: pack.source_key, version: pack.version, reason },
  });
  return c.json(ok({ id, status: 'rejected' }));
});

/**
 * Roll an OLDER version back to active — the recovery path for a bad heal.
 *
 * This is not a second approve. A pack is only activatable once a human has
 * already put it live at least once, which is why `draft` and `rejected` are
 * refused: activating either would be an auto-activation in disguise, and that
 * is exactly what ADR-030 forbids. It is kept a separate endpoint from approve
 * so the audit trail distinguishes "first time live" from "we went back"
 * (11-api-contract.md §15).
 */
sourceRoutes.post('/sources/selector-packs/:id/activate', async (c) => {
  const id = c.req.param('id');
  const pack = await c.env.DB.prepare(`SELECT id, source_key, version, status FROM selector_packs WHERE id = ?`)
    .bind(id)
    .first<{ id: string; source_key: string; version: number; status: string }>();
  if (!pack) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }
  if (pack.status !== 'broken' && pack.status !== 'active') {
    const { body, status } = fail('E_CONFLICT', { reason: 'pack_not_approved', status: pack.status });
    return c.json(body, status as 409);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE selector_packs SET status = 'broken' WHERE source_key = ? AND status = 'active' AND id <> ?`,
    ).bind(pack.source_key, id),
    c.env.DB.prepare(`UPDATE selector_packs SET status = 'active' WHERE id = ?`).bind(id),
  ]);

  await auditLog(c.env, c.get('actor'), {
    entityType: 'selector_pack',
    entityId: id,
    action: 'activate',
    detail: { source_key: pack.source_key, version: pack.version },
  });
  return c.json(ok({ id, status: 'active' }));
});

/**
 * Trigger a selector heal.
 *
 * The endpoint ENQUEUES and stops. Re-sampling the page, deciding whether the
 * sample clears the dry-run threshold (≥5 valid records and ≥80% fill on the
 * failing fields, 15-P4) and writing a candidate pack are the job's work, on the
 * job queue where every provider call belongs (R16). Nothing here creates an
 * ACTIVE pack — a heal can only produce a `draft`, and a human approves it
 * (ADR-030). The reply is the enqueued job id, because the sample has not run
 * yet and claiming otherwise would be a lie the console then renders.
 */
sourceRoutes.post('/sources/directories/:sourceKey/heal', async (c) => {
  const sourceKey = c.req.param('sourceKey');
  const source = await c.env.DB.prepare(
    `SELECT source_key, target_type FROM directory_sources WHERE source_key = ? AND deleted_at IS NULL`,
  )
    .bind(sourceKey)
    .first<{ source_key: string; target_type: string | null }>();
  if (!source) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  const body = (await c.req.json().catch(() => null)) as { pack_id?: unknown } | null;
  const packId = typeof body?.pack_id === 'string' ? body.pack_id : null;

  const jobId = await enqueue(c.env.DB, {
    jobType: 'scrape',
    targetType: source.target_type,
    payload: { source_key: sourceKey, kind: 'selector_heal', pack_id: packId, runner: 'worker' },
    priority: 6,
  });

  await auditLog(c.env, c.get('actor'), {
    entityType: 'directory_source',
    entityId: sourceKey,
    action: 'heal',
    detail: { job_id: jobId, pack_id: packId },
  });
  return c.json(ok({ job_id: jobId, source_key: sourceKey, status: 'pending' }));
});

/**
 * Class C override — the one place a human can authorise a fetch a rule blocks.
 *
 * Two refusals live here and they are not the same refusal.
 *
 * `tos_no_storage` is absolute (R21, R25). That reason means the terms forbid
 * STORING the data at all, so there is no version of the operator's intent that
 * makes it lawful and no acknowledgement can open it. It is checked BEFORE the
 * body is read, so a hand-crafted `override_ack` cannot reach a code path that
 * would weigh it.
 *
 * Every other blocked reason is a risk decision that belongs to the operator,
 * not to this code, so it is allowed with an explicit acknowledgement and a
 * written reason of at least 20 characters — the 20 is not arbitrary: six
 * months later the reason is the answer to "why is this data in our database"
 * (ADR-031). The two failures share `E_CONFLICT` and differ by `detail.reason`,
 * because the UI treats them differently: a missing ack is a form the operator
 * can complete, a short reason is a sentence they have to write more of.
 *
 * A successful override does NOT open capture. Mode B is gated by ADR-035, so
 * the endpoint records the decision and says so; `/api/captures` answers
 * `mode_b_disabled` regardless.
 */
sourceRoutes.post('/sources/manual/:sourceKey/override', async (c) => {
  const sourceKey = c.req.param('sourceKey');
  const row = await c.env.DB.prepare(
    `SELECT source_key, class, block_reason FROM directory_sources WHERE source_key = ? AND deleted_at IS NULL`,
  )
    .bind(sourceKey)
    .first<{ source_key: string; class: string; block_reason: string }>();
  if (!row) {
    const { body, status } = fail('E_NOT_FOUND');
    return c.json(body, status as 404);
  }

  if (row.block_reason === 'tos_no_storage') {
    const { body, status } = fail('E_COMPLIANCE_BLOCK', { reason: 'class_x', source_key: sourceKey });
    return c.json(body, status as 403);
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const ack = body?.override_ack === true;
  // R25 names the field `override_reason`; the console has always posted `reason`.
  // Accepting both is what lets the existing button work unchanged.
  const reason =
    typeof body?.override_reason === 'string'
      ? body.override_reason
      : typeof body?.reason === 'string'
        ? body.reason
        : '';

  if (!ack) {
    const { body: out, status } = fail('E_CONFLICT', { reason: 'override_ack_required', source_key: sourceKey });
    return c.json(out, status as 409);
  }
  if (reason.trim().length < 20) {
    const { body: out, status } = fail('E_CONFLICT', {
      reason: 'override_reason_required',
      min_length: 20,
      source_key: sourceKey,
    });
    return c.json(out, status as 409);
  }

  const auditId = await auditLog(c.env, c.get('actor'), {
    entityType: 'directory_source',
    entityId: sourceKey,
    action: 'override',
    detail: { reason, class: row.class, block_reason: row.block_reason },
  });

  // 202: the decision is recorded, and nothing is fetched — Mode B ingests only
  // after ADR-035 is lifted.
  return c.json(
    ok({ ok: true as const, audit_id: auditId, note: 'override recorded; capture stays closed until ADR-035 is lifted' }),
    202,
  );
});
