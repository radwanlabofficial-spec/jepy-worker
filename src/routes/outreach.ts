/**
 * Outreach tracking: per-lead reach counts (Track A, Item 7).
 *
 * Deliberately lightweight. The counter (`leads.reach_count`) answers the
 * dashboard's hot questions — "never reached", "reached once", "reached 3+
 * times" — in a single indexed read, while the full history (channel, note,
 * actor, time) goes into `stage_events` where the lead's timeline already
 * lives. Two writes per touch, one `db.batch()` call, no new tables.
 *
 * `stage_events` notes a stage TRANSITION (from_stage/to_stage); an outreach
 * touch is not a transition, so `kind = 'outreach'` (added in 0013) labels it
 * and both stage columns carry the lead's current stage unchanged. The
 * worker's actor kinds ('access'/'admin'/'device') are mapped onto
 * stage_events' own vocabulary ('user'/'cron'/'extension') because that
 * CHECK constraint predates this route.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { badRequest } from '../lib/http';
import type { Actor, Env } from '../env';

export const outreachRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

const reachSchema = z.object({
  channel: z.string().min(1).max(50).optional(),
  note: z.string().max(2000).optional(),
});

/** Worker actor kinds vs stage_events.actor vocabulary. */
function eventActor(kind: Actor['kind']): 'user' | 'cron' | 'extension' {
  if (kind === 'admin') return 'cron';
  if (kind === 'device') return 'extension';
  return 'user';
}

/**
 * `POST /leads/:id/reach` — record one outreach touch: increment the counter,
 * stamp `last_reached_at`, and append a `kind='outreach'` stage_event for
 * history. Returns the new count.
 */
outreachRoutes.post('/leads/:id/reach', async (c) => {
  const leadId = c.req.param('id');
  const parsed = reachSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = badRequest('invalid_reach');
    return c.json(body, status as 400);
  }

  // Single-row lookup by key (D1-read discipline); doubles as the 404 check
  // and sources the stage the event row must echo back.
  const lead = await c.env.DB.prepare(
    `SELECT id, stage, reach_count FROM leads WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(leadId)
    .first<{ id: string; stage: string; reach_count: number }>();
  if (!lead) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'lead_missing', lead_id: leadId });
    return c.json(body, status as 404);
  }

  const now = Math.floor(Date.now() / 1000);
  const newCount = (lead.reach_count ?? 0) + 1;
  // Channel rides in the note as a `[channel]` prefix — stage_events has no
  // channel column, and plain text keeps the timeline human-readable.
  const note =
    parsed.data.channel != null
      ? `[${parsed.data.channel}]${parsed.data.note ? ' ' + parsed.data.note : ''}`
      : (parsed.data.note ?? null);

  const db = c.env.DB;
  await db.batch([
    db
      .prepare(`UPDATE leads SET reach_count = reach_count + 1, last_reached_at = ? WHERE id = ?`)
      .bind(now, leadId),
    db
      .prepare(
        `INSERT INTO stage_events (id, lead_id, from_stage, to_stage, actor, note, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'outreach', ?)`,
      )
      .bind(
        crypto.randomUUID(),
        leadId,
        lead.stage,
        lead.stage,
        eventActor(c.get('actor').kind),
        note,
        now,
      ),
  ]);

  return c.json(ok({ id: leadId, reach_count: newCount, last_reached_at: now }));
});

/**
 * `GET /leads/:id/reach` — the counter plus the recent outreach history for
 * the lead (kind='outreach' stage_events, newest first, capped at 50).
 */
outreachRoutes.get('/leads/:id/reach', async (c) => {
  const leadId = c.req.param('id');

  const lead = await c.env.DB.prepare(
    `SELECT id, reach_count, last_reached_at FROM leads WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(leadId)
    .first<{ id: string; reach_count: number; last_reached_at: number | null }>();
  if (!lead) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'lead_missing', lead_id: leadId });
    return c.json(body, status as 404);
  }

  const events = await c.env.DB.prepare(
    `SELECT id, actor, note, created_at
       FROM stage_events
      WHERE lead_id = ? AND kind = 'outreach'
      ORDER BY created_at DESC
      LIMIT 50`,
  )
    .bind(leadId)
    .all();

  return c.json(
    ok({
      id: lead.id,
      reach_count: lead.reach_count ?? 0,
      last_reached_at: lead.last_reached_at,
      recent: events.results ?? [],
    }),
  );
});
