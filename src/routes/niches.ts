/**
 * Niche/category folders (Track A, Item 6).
 *
 * The `niches` table (0001) is the scraper's taxonomy — which niches exist.
 * These routes add the operator layer: creating/renaming/disabling niches and
 * assigning leads to niche folders via the `lead_niche_assignments` join
 * table (0012). A lead may sit in several folders; the single-valued
 * `leads.niche` column is kept as the backward-compatible primary folder and
 * is written on every assign so all existing `WHERE niche = ?` filters keep
 * working.
 *
 * Auth split, deliberately: creating/deleting the taxonomy itself is
 * admin-only (it changes what the scraper and filters can reference), while
 * assigning leads to folders is everyday operator work on the console actor.
 * PATCH (rename/description) sits with the operator — it changes labels, not
 * structure — matching the Item 6 spec.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { badRequest, decodeCursor, encodeCursor, readPage } from '../lib/http';
import { requireAdmin } from '../middleware/auth';
import type { Actor, Env } from '../env';

export const nicheRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

const createNicheSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .optional(),
  description: z.string().max(2000).nullish(),
});

const patchNicheSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  priority: z.number().int().min(1).max(10).optional(),
  enabled: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
});

const assignSchema = z.object({
  lead_ids: z.array(z.string().min(1).max(64)).min(1).max(500),
});

const ASSIGN_CHUNK = 100;

/** Derive a URL-safe slug from a display name when the caller omits one. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'niche'
  );
}

/**
 * `GET /niches` — every niche with its live-lead count, in ONE grouped query.
 * Counts are hot-only (deleted and archived leads excluded) so the folder
 * badges match what the operator actually sees in the leads list.
 */
nicheRoutes.get('/niches', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT n.niche_slug AS slug,
            n.display_name AS name,
            n.description AS description,
            n.priority AS priority,
            n.enabled AS enabled,
            COUNT(l.id) AS lead_count
       FROM niches n
       LEFT JOIN lead_niche_assignments a ON a.niche_slug = n.niche_slug
       LEFT JOIN leads l
              ON l.id = a.lead_id AND l.deleted_at IS NULL AND l.archived_at IS NULL
      GROUP BY n.niche_slug
      ORDER BY n.priority ASC, n.display_name ASC`,
  ).all();

  return c.json(ok({ niches: rows.results ?? [] }));
});

/**
 * `POST /niches` (admin) — create a taxonomy entry. The slug is the permanent
 * key referenced by assignments and filters; it is immutable after creation
 * (rename the display name via PATCH instead), because a slug rename would
 * orphan every assignment row silently.
 */
nicheRoutes.post('/niches', requireAdmin, async (c) => {
  const parsed = createNicheSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = badRequest('invalid_niche');
    return c.json(body, status as 400);
  }
  const slug = parsed.data.slug ?? slugify(parsed.data.name);

  const existing = await c.env.DB.prepare(`SELECT 1 FROM niches WHERE niche_slug = ?`)
    .bind(slug)
    .first();
  if (existing) {
    const { body, status } = fail('E_CONFLICT', { reason: 'niche_slug_taken', slug });
    return c.json(body, status as 409);
  }

  await c.env.DB.prepare(
    `INSERT INTO niches (id, niche_slug, display_name, description)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), slug, parsed.data.name, parsed.data.description ?? null)
    .run();

  return c.json(ok({ slug, name: parsed.data.name, description: parsed.data.description ?? null }));
});

/**
 * `PATCH /niches/:slug` — rename / describe / reprioritise / disable a niche.
 * The slug itself is not patchable (see POST above).
 */
nicheRoutes.patch('/niches/:slug', async (c) => {
  const slug = c.req.param('slug');
  const parsed = patchNicheSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = badRequest('invalid_niche_patch');
    return c.json(body, status as 400);
  }

  const niche = await c.env.DB.prepare(`SELECT 1 FROM niches WHERE niche_slug = ?`)
    .bind(slug)
    .first();
  if (!niche) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'niche_missing', slug });
    return c.json(body, status as 404);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (parsed.data.name !== undefined) {
    sets.push('display_name = ?');
    params.push(parsed.data.name);
  }
  if (parsed.data.description !== undefined) {
    sets.push('description = ?');
    params.push(parsed.data.description);
  }
  if (parsed.data.priority !== undefined) {
    sets.push('priority = ?');
    params.push(parsed.data.priority);
  }
  if (parsed.data.enabled !== undefined) {
    // Stored as 0/1 (0001 CHECK), accepted as boolean or 0/1 for the UI's sake.
    sets.push('enabled = ?');
    params.push(parsed.data.enabled === true || parsed.data.enabled === 1 ? 1 : 0);
  }
  if (sets.length === 0) {
    const { body, status } = badRequest('nothing_to_patch');
    return c.json(body, status as 400);
  }

  await c.env.DB.prepare(`UPDATE niches SET ${sets.join(', ')} WHERE niche_slug = ?`)
    .bind(...params, slug)
    .run();

  return c.json(ok({ slug, updated: sets.length }));
});

/**
 * `DELETE /niches/:slug` (admin) — remove the taxonomy entry AND its
 * assignments in one batch, so no assignment row ever points at a niche that
 * no longer exists. `leads.niche` values referencing the slug are nulled for
 * the same reason (backward-compat column, no FK to cascade).
 */
nicheRoutes.delete('/niches/:slug', requireAdmin, async (c) => {
  const slug = c.req.param('slug');

  const niche = await c.env.DB.prepare(`SELECT 1 FROM niches WHERE niche_slug = ?`)
    .bind(slug)
    .first();
  if (!niche) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'niche_missing', slug });
    return c.json(body, status as 404);
  }

  const db = c.env.DB;
  await db.batch([
    db.prepare(`DELETE FROM lead_niche_assignments WHERE niche_slug = ?`).bind(slug),
    db.prepare(`UPDATE leads SET niche = NULL WHERE niche = ?`).bind(slug),
    db.prepare(`DELETE FROM niches WHERE niche_slug = ?`).bind(slug),
  ]);

  return c.json(ok({ slug, deleted: true }));
});

/**
 * `POST /niches/:slug/assign` — put up to 500 leads into the folder.
 * `INSERT OR IGNORE` makes the call idempotent (re-assigning the same lead is
 * a no-op), and a single UPDATE sets `leads.niche` for the same ids so the
 * legacy single-niche filters see the primary folder. Everything goes through
 * one `db.batch()` call: chunked INSERTs plus the one UPDATE.
 */
nicheRoutes.post('/niches/:slug/assign', async (c) => {
  const slug = c.req.param('slug');
  const parsed = assignSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = badRequest('invalid_assign');
    return c.json(body, status as 400);
  }

  const niche = await c.env.DB.prepare(`SELECT 1 FROM niches WHERE niche_slug = ?`)
    .bind(slug)
    .first();
  if (!niche) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'niche_missing', slug });
    return c.json(body, status as 404);
  }

  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const ids = [...new Set(parsed.data.lead_ids)];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += ASSIGN_CHUNK) {
    const chunk = ids.slice(i, i + ASSIGN_CHUNK);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO lead_niche_assignments (lead_id, niche_slug, assigned_at)
           VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
        )
        .bind(...chunk.flatMap((id) => [id, slug, now])),
    );
  }
  // Backward compat: the primary folder column follows the assignment, so the
  // pre-existing `WHERE niche = ?` filters (leads list, stats) keep working.
  statements.push(
    db
      .prepare(`UPDATE leads SET niche = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(slug, ...ids),
  );
  await db.batch(statements);

  return c.json(ok({ slug, assigned: ids.length }));
});

/**
 * `DELETE /niches/:slug/assign` — remove leads from the folder. `leads.niche`
 * is nulled only where it still points at this slug, so an operator moving a
 * lead between folders (assign to B, unassign from A) cannot wipe the newer
 * primary folder.
 */
nicheRoutes.delete('/niches/:slug/assign', async (c) => {
  const slug = c.req.param('slug');
  const parsed = assignSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = badRequest('invalid_unassign');
    return c.json(body, status as 400);
  }

  const db = c.env.DB;
  const ids = [...new Set(parsed.data.lead_ids)];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += ASSIGN_CHUNK) {
    const chunk = ids.slice(i, i + ASSIGN_CHUNK);
    statements.push(
      db
        .prepare(
          `DELETE FROM lead_niche_assignments
            WHERE niche_slug = ? AND lead_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(slug, ...chunk),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE leads SET niche = NULL
          WHERE niche = ? AND id IN (${ids.map(() => '?').join(',')})`,
      )
      .bind(slug, ...ids),
  );
  await db.batch(statements);

  return c.json(ok({ slug, unassigned: ids.length }));
});

/**
 * `GET /niches/:slug/leads` — leads in the folder, keyset-paginated on
 * (assigned_at, lead_id). Minimal columns only; `company` is an alias for
 * `name` because in this dataset the lead's name IS the business name (the
 * leads table has no separate company column — see 0001). Hot leads only.
 */
nicheRoutes.get('/niches/:slug/leads', async (c) => {
  const slug = c.req.param('slug');
  const url = new URL(c.req.url);
  const { limit, cursor } = readPage(url);

  const niche = await c.env.DB.prepare(`SELECT 1 FROM niches WHERE niche_slug = ?`)
    .bind(slug)
    .first();
  if (!niche) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'niche_missing', slug });
    return c.json(body, status as 404);
  }

  const where: string[] = [
    'a.niche_slug = ?',
    'l.deleted_at IS NULL',
    'l.archived_at IS NULL',
  ];
  const params: unknown[] = [slug];
  if (cursor) {
    const parts = decodeCursor(cursor);
    const at = parts ? Number(parts[0]) : NaN;
    const lastId = parts && parts[1] ? parts[1] : null;
    if (!Number.isFinite(at) || !lastId) {
      const { body, status } = badRequest('invalid_cursor');
      return c.json(body, status as 400);
    }
    // Keyset on (assigned_at DESC, lead_id ASC): strictly before the last row.
    where.push('(a.assigned_at < ? OR (a.assigned_at = ? AND a.lead_id > ?))');
    params.push(Math.trunc(at), Math.trunc(at), lastId);
  }

  const rows = await c.env.DB.prepare(
    `SELECT l.id AS id, l.name AS name, l.name AS company, l.email AS email,
            l.tier AS tier, l.status AS status, a.assigned_at AS assigned_at
       FROM lead_niche_assignments a
       JOIN leads l ON l.id = a.lead_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.assigned_at DESC, a.lead_id ASC
      LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all();

  const results = (rows.results ?? []) as Array<Record<string, unknown>>;
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const last = page[page.length - 1];

  return c.json(
    ok(
      {
        slug,
        // assigned_at is the pagination key, not lead data — strip it.
        leads: page.map((row) => ({
          id: row['id'],
          name: row['name'],
          company: row['company'],
          email: row['email'],
          tier: row['tier'],
          status: row['status'],
        })),
      },
      {
        next_cursor:
          hasMore && last
            ? encodeCursor([last['assigned_at'] as number, last['id'] as string])
            : null,
        has_more: hasMore,
      },
    ),
  );
});
