/**
 * Settings.
 *
 * Three keys are editable, and the rest are refused with a reason rather than
 * silently ignored — a PATCH that appears to succeed and changes nothing is how
 * an operator ends up believing a threshold was raised when it was not.
 *
 * `router_weights_json` needs a written decision because it moves money
 * (`w_cost` is 0.40 of the router score); `cache_epoch` and `vault_epoch` are
 * system-managed. Everything else is `setting_locked`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import type { Actor, Env } from '../env';

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

/** The five keys the console renders. Values are returned as raw columns. */
const READABLE_KEYS = [
  'dispatcher_paused',
  'gate_threshold',
  'ai_daily_cap',
  'active_weights_version',
  'router_weights_json',
] as const;

const EDITABLE_KEYS = new Set(['dispatcher_paused', 'gate_threshold', 'ai_daily_cap']);

interface SettingRow {
  key: string;
  value_text: string | null;
  value_num: number | null;
  updated_at: number;
}

settingsRoutes.get('/settings', async (c) => {
  const placeholders = READABLE_KEYS.map(() => '?').join(',');
  const result = await c.env.DB.prepare(
    `SELECT key, value_text, value_num, updated_at FROM settings WHERE key IN (${placeholders})`,
  )
    .bind(...READABLE_KEYS)
    .all<SettingRow>();

  const byKey = new Map((result.results ?? []).map((row) => [row.key, row]));
  const data: Record<string, unknown> = {};
  for (const key of READABLE_KEYS) {
    const row = byKey.get(key);
    data[key] = row ? (row.value_text !== null ? row.value_text : row.value_num) : null;
    data[`${key}_updated_at`] = row?.updated_at ?? null;
  }
  return c.json(ok(data));
});

const patchSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

settingsRoutes.patch('/settings', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const { key, value } = parsed.data;

  if (!EDITABLE_KEYS.has(key)) {
    // Two different refusals, because they mean different things to the reader:
    // one needs an ADR, the other is simply not the UI's to change.
    const reason = key === 'router_weights_json' ? 'adr_required' : 'setting_locked';
    const { body, status } = fail('E_FORBIDDEN', { reason });
    return c.json(body, status as 403);
  }

  const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  const asNumber = typeof numeric === 'number' ? numeric : Number(numeric);
  const isNumeric = Number.isFinite(asNumber);

  await c.env.DB.prepare(
    `UPDATE settings
        SET value_num = CASE WHEN ?1 = 1 THEN ?2 ELSE NULL END,
            value_text = CASE WHEN ?1 = 1 THEN NULL ELSE ?3 END,
            updated_at = unixepoch()
      WHERE key = ?4`,
  )
    .bind(isNumeric ? 1 : 0, isNumeric ? asNumber : null, String(value), key)
    .run();

  return c.json(ok({ key, value: isNumeric ? asNumber : String(value), updated_at: Math.floor(Date.now() / 1000) }));
});
