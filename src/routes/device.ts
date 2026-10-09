/**
 * The three endpoints a device token may reach, and the console's control over
 * the devices that hold one. ADR-035 fixes both halves.
 *
 * WHY THE EXTENSION HAS ITS OWN DOOR AT ALL. Every other caller in this system is
 * either a human with an Access session or a machine holding the admin secret.
 * The extension is neither: it runs in the operator's own browser, it cannot keep
 * a secret, and its whole reason for existing is that the operator is already
 * looking at the page it needs to read. So it gets an identity of its own, one
 * that can be revoked, and a scope small enough that a leak costs a nuisance
 * rather than the lead database (R2, R16's exception).
 *
 * WHAT IS NOT HERE, DELIBERATELY. `/api/captures` — the Mode B door that would
 * turn a hand-driven capture into leads — is not in this file and not in the
 * device scope. ADR-035 names adding it as a forbidden act until the gate is
 * opened, and the gate is a decision rather than a code change. Nothing in this
 * file writes to `leads`.
 *
 * THE HOURLY CAP IS ENFORCED HERE TOO. The plan puts a ceiling of thirty jobs per
 * rolling sixty minutes on the extension and says it is applied on both sides.
 * The client half is a courtesy — a buggy or hostile client ignores it — so the
 * count that matters is this one, taken from `job_queue` where the claims are
 * already recorded.
 */

import { Hono } from 'hono';
import type { Handler } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { requireAdmin } from '../middleware/auth';
import { requireDevice, isPaused } from '../middleware/device';
import type { DeviceRow } from '../middleware/device';
import { newDeviceToken } from '../lib/device';
import { claim, complete, fail as failJob } from '../lib/queue';
import type { Actor, Env } from '../env';

export const deviceRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor; device: DeviceRow } }>();

type AppEnv = { Bindings: Env; Variables: { actor: Actor } };

/** Mode A opens one tab at a time, so a batch would only be queued client-side. */
const PENDING_DEFAULT = 1;
const PENDING_MAX = 5;

/** The plan's rolling ceiling, applied on the server because the client's is a courtesy. */
const JOBS_PER_HOUR = 30;

const resultSchema = z.object({
  status: z.enum(['done', 'failed']),
  result_ref: z.string().max(500).nullish(),
  reason: z.string().max(500).nullish(),
  kind: z.enum(['transient', 'permanent']).nullish(),
  url: z.string().max(2000).nullish(),
  dom: z.unknown().nullish(),
  pack_version: z.number().int().nullish(),
  duration_ms: z.number().int().nullish(),
});

const issueSchema = z.object({
  device_label: z.string().min(1).max(100),
  mode: z.enum(['a', 'b', 'both']).nullish(),
});

const directiveSchema = z.object({ directive: z.enum(['run', 'pause', 'drain', 'revoke']) });

deviceRoutes.use('/jobs/pending', requireDevice);
deviceRoutes.use('/jobs/:id/result', requireDevice);
deviceRoutes.use('/devices/heartbeat', requireDevice);

deviceRoutes.use('/admin/devices', requireAdmin);
deviceRoutes.use('/admin/devices/*', requireAdmin);

/**
 * The extension asks for its next job. This is Mode A's whole loop start.
 *
 * A paused or draining device gets an empty list and the reason, not an error:
 * the operator asked it to stop taking NEW work, and the extension should render
 * "paused" rather than a failure it might retry through.
 */
deviceRoutes.get('/jobs/pending', async (c) => {
  const device = c.get('device');

  if (isPaused(device)) {
    return c.json(ok({ jobs: [], directive: device.current_directive, reason: 'device_paused' }));
  }

  const requested = Number(c.req.query('limit') ?? PENDING_DEFAULT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), PENDING_MAX)
    : PENDING_DEFAULT;

  // job_queue is small — a few rows at a time by design, because the dispatcher
  // drains it every two minutes — so this count does not need its own index.
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM job_queue WHERE claimed_by = ? AND claimed_at >= unixepoch() - 3600`,
  )
    .bind(`device:${device.id}`)
    .first<{ n: number }>();

  if ((recent?.n ?? 0) >= JOBS_PER_HOUR) {
    return c.json(
      ok({
        jobs: [],
        directive: device.current_directive,
        reason: 'hourly_cap',
        cap: JOBS_PER_HOUR,
        window_seconds: 3600,
      }),
    );
  }

  const jobs = await claim(c.env.DB, `device:${device.id}`, Math.min(limit, JOBS_PER_HOUR - (recent?.n ?? 0)), 'extension');

  return c.json(
    ok({
      directive: device.current_directive,
      jobs: jobs.map((job) => ({
        id: job.id,
        job_type: job.job_type,
        target_type: job.target_type,
        pack_epoch: device.pack_epoch,
        payload: job.payload_json ? safeParse(job.payload_json) : null,
      })),
    }),
  );
});

/**
 * The extension reports what happened to a job it was given.
 *
 * The job must have been claimed BY THIS DEVICE. Without that check any valid
 * token could close any job in the queue — including one the router is midway
 * through — and the failure would look like a queue bug rather than a
 * cross-device write. `claimed_by` is stamped with `device:<id>` at claim time,
 * so the check is a comparison and not a new column.
 *
 * When a capture is reported, the extracted payload is recorded in
 * `dom_captures`. It does NOT become a lead here: that is the ingest door
 * ADR-035 gates, and pretending otherwise by writing `leads` directly would be
 * exactly the second path R16 forbids.
 */
deviceRoutes.post('/jobs/:id/result', async (c) => {
  const device = c.get('device');
  const parsed = resultSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const job = await c.env.DB.prepare(
    `SELECT id, status, claimed_by, attempts, max_attempts FROM job_queue WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; status: string; claimed_by: string | null; attempts: number; max_attempts: number }>();

  if (!job) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_job' });
    return c.json(body, status as 404);
  }
  if (job.claimed_by !== `device:${device.id}`) {
    const { body, status } = fail('E_FORBIDDEN', { reason: 'not_your_job' });
    return c.json(body, status as 403);
  }

  const input = parsed.data;
  const now = Math.floor(Date.now() / 1000);

  // The record of the extraction, written before the outcome so that a job which
  // succeeded but failed to report leaves evidence of what was taken.
  if (input.url || input.dom !== undefined) {
    await c.env.DB.prepare(
      `INSERT INTO dom_captures (id, job_id, capture_batch_id, device_id, mode, url, extracted_json, pack_version, duration_ms, created_at)
       VALUES (?, ?, NULL, ?, 'a', ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        job.id,
        device.id,
        input.url ?? null,
        input.dom === undefined ? null : JSON.stringify(input.dom),
        input.pack_version ?? null,
        input.duration_ms ?? null,
        now,
      )
      .run();
  }

  if (input.status === 'done') {
    await complete(c.env.DB, job.id, input.result_ref ?? null);
    await c.env.DB.prepare(
      `UPDATE devices SET jobs_completed = jobs_completed + 1, last_heartbeat_at = ? WHERE id = ?`,
    )
      .bind(now, device.id)
      .run();
    return c.json(ok({ id: job.id, status: 'done' }));
  }

  // A device reporting a failure is reporting, not deciding: `kind` chooses
  // between "try again" and "a person must look", and the queue owns what that
  // means (backoff, attempt ceiling, needs_manual).
  const outcome = await failJob(
    c.env.DB,
    job,
    input.reason ?? 'device reported failure',
    input.kind ?? 'transient',
  );
  return c.json(ok({ id: job.id, status: outcome.status, run_after: outcome.run_after }));
});

/**
 * Heartbeat, every five minutes. Returns the directive, which is how a change
 * made in the console reaches a browser that has no push channel.
 */
deviceRoutes.post('/devices/heartbeat', async (c) => {
  const device = c.get('device');
  const now = Math.floor(Date.now() / 1000);

  // `stale` is a statement about silence, so a heartbeat that arrives is by
  // definition the end of it — unless the operator has revoked the device, which
  // the middleware already refused above.
  await c.env.DB.prepare(
    `UPDATE devices SET last_heartbeat_at = ?, status = CASE WHEN status = 'stale' THEN 'active' ELSE status END
      WHERE id = ?`,
  )
    .bind(now, device.id)
    .run();

  return c.json(
    ok({
      directive: device.current_directive,
      pack_epoch: device.pack_epoch,
      mode: device.mode,
      server_time: now,
    }),
  );
});

/**
 * Issues a device and returns its token. The plaintext appears in this response
 * and nowhere else, ever — no log line, no column, no second read. An operator
 * who loses it issues a new device; there is no recovery path, which is the point.
 */
/**
 * Console alias for device registration. The dashboard calls `POST /api/devices`
 * (not `/api/admin/devices`), so this is the endpoint the "Register a device"
 * button actually hits. Same handler, same validation, same one-time token.
 */
deviceRoutes.post('/devices', async (c) => {
  const parsed = issueSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const { token, hash } = await newDeviceToken();
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO devices (id, device_label, token_hash, mode, current_directive, pack_epoch, status)
     VALUES (?, ?, ?, ?, 'run', 0, 'active')`,
  )
    .bind(id, parsed.data.device_label, hash, parsed.data.mode ?? 'both')
    .run();

  return c.json(
    ok({
      id,
      device_label: parsed.data.device_label,
      token,
      note: 'This token is shown once and is stored only as a SHA-256 hash. Copy it now.',
    }),
  );
});

deviceRoutes.post('/admin/devices', async (c) => {
  const parsed = issueSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const { token, hash } = await newDeviceToken();
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO devices (id, device_label, token_hash, mode, current_directive, pack_epoch, status)
     VALUES (?, ?, ?, ?, 'run', 0, 'active')`,
  )
    .bind(id, parsed.data.device_label, hash, parsed.data.mode ?? 'both')
    .run();

  return c.json(
    ok({
      id,
      device_label: parsed.data.device_label,
      token,
      note: 'This token is shown once and is stored only as a SHA-256 hash. Copy it now.',
    }),
  );
});

/**
 * The kill switch. `revoke` also closes the device permanently.
 *
 * ONE handler, two paths, and they are NOT the same door. The `/admin/` form is
 * for cron and GitHub Actions and is wrapped in `requireAdmin` above, so a human
 * console session is refused it. The console's Devices page needs the same
 * action with a human Access identity, which is why `/api/devices/:id/directive`
 * exists as a second mount of this exact function rather than a copy — the
 * update it performs is identical, and only the guard in front of it differs.
 * A copy is how a later fix to the update (say, auditing the directive) lands on
 * one path and not the other.
 */
const setDirective: Handler<AppEnv> = async (c) => {
  const parsed = directiveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION');
    return c.json(body, status as 400);
  }

  const directive = parsed.data.directive;
  const result = await c.env.DB.prepare(
    `UPDATE devices
        SET current_directive = ?,
            status = CASE WHEN ? = 'revoke' THEN 'revoked' ELSE status END
      WHERE id = ?`,
  )
    .bind(directive, directive, c.req.param('id'))
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_device' });
    return c.json(body, status as 404);
  }

  return c.json(ok({ id: c.req.param('id'), directive, landed: 'next poll' }));
};

deviceRoutes.post('/admin/devices/:id/directive', setDirective);
// Human path for the console. Deliberately NOT added to the device scope in
// middleware/device.ts: this is an operator action, not something the extension
// token may reach.
deviceRoutes.post('/devices/:id/directive', setDirective);

/** A payload that will not parse is passed through as null rather than thrown on. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Revoke a device. DELETE is the dashboard's "Revoke" button; it is equivalent
 * to setting the directive to 'revoke' — the device row stays for audit, the
 * token stops working on the next heartbeat.
 */
deviceRoutes.delete('/devices/:id', async (c) => {
  const result = await c.env.DB.prepare(
    `UPDATE devices SET current_directive = 'revoke', status = 'revoked' WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_device' });
    return c.json(body, status as 404);
  }
  return c.json(ok({ id: c.req.param('id'), status: 'revoked' }));
});
deviceRoutes.delete('/admin/devices/:id', async (c) => {
  const result = await c.env.DB.prepare(
    `UPDATE devices SET current_directive = 'revoke', status = 'revoked' WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    const { body, status } = fail('E_NOT_FOUND', { reason: 'unknown_device' });
    return c.json(body, status as 404);
  }
  return c.json(ok({ id: c.req.param('id'), status: 'revoked' }));
});

/**
 * On-demand stale-device sweep (Track D item 11).
 *
 * ON-DEMAND COPY of the canonical sweep in `src/jobs/scheduled.ts`
 * (`sweepStaleDevices`), which the hourly trigger runs and records as
 * `device_sweep` in `cron_runs`. Cloudflare offers no way to fire a cron on
 * demand, so this admin route lets the console run the same UPDATE by hand.
 * The 48-hour rule and the exact predicate live in scheduled.ts — this route
 * duplicates only the UPDATE, and if the rule changes there it must change
 * here too. Covered by the existing `deviceRoutes.use('/admin/devices/*',
 * requireAdmin)` guard above; no second registration needed.
 */
deviceRoutes.post('/admin/devices/sweep', async (c) => {
  const DEVICE_STALE_AFTER_SECONDS = 48 * 3600;
  const result = await c.env.DB.prepare(
    `UPDATE devices
        SET status = 'stale'
      WHERE status = 'active'
        AND current_directive != 'revoke'
        AND COALESCE(last_heartbeat_at, created_at) <= unixepoch() - ?`,
  )
    .bind(DEVICE_STALE_AFTER_SECONDS)
    .run();

  return c.json(ok({ marked_stale: result.meta.changes ?? 0 }));
});

/**
 * Request backend scraping when manual (extension) scraping fails.
 *
 * Flow: Extension tries manual scrape → fails → calls this endpoint →
 * Worker creates a job for Apify/BrightData → AI (Manifest) decides which
 * provider to use → result comes back to dashboard.
 */
const requestScrapeSchema = z.object({
  url: z.string().url().max(2000),
  reason: z.string().max(500).nullish(), // why manual scraping failed
  priority: z.enum(['low', 'normal', 'high']).nullish(),
});

/**
 * Extension-facing priority words mapped onto job_queue's 1–10 integer scale
 * (the CHECK refuses anything else). 'normal' is the queue default of 5.
 */
const SCRAPE_PRIORITY: Record<'low' | 'normal' | 'high', number> = { low: 3, normal: 5, high: 8 };

deviceRoutes.post('/devices/request-scrape', requireDevice, async (c) => {
  const device = c.get('device');
  const body = await c.req.json().catch(() => ({}));
  const parsed = requestScrapeSchema.safeParse(body);

  if (!parsed.success) {
    const { body: errBody, status } = fail('E_VALIDATION', { reason: 'invalid_request' });
    return c.json(errBody, status as 400);
  }

  const { url, reason, priority } = parsed.data;

  // WHY THIS SHAPE. The first version of this endpoint inserted
  // (id, job_type, target_url, ...) with job_type='backend_scrape' and a string
  // priority — and `target_url` does not exist in job_queue (0001 has
  // payload_json for that), 'backend_scrape' is not in the job_type CHECK, and
  // priority must be INTEGER 1–10. Every call 500'd. This insert matches the
  // canonical queue shape in lib/queue.ts: job_type='scrape' (in the CHECK),
  // the URL and the failure reason ride in payload_json, and
  // `requested_by_device` (migration 0017) records which extension asked.
  const jobId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `INSERT INTO job_queue (id, job_type, target_type, payload_json, priority, status, run_after,
                            created_at, updated_at, requested_by_device)
     VALUES (?, 'scrape', 'extension_backend_request', ?, ?, 'pending', ?, ?, ?, ?)`,
  )
    .bind(
      jobId,
      JSON.stringify({ url, manual_failure_reason: reason ?? null, requested_by_device: device.id }),
      SCRAPE_PRIORITY[priority ?? 'normal'],
      now,
      now,
      now,
      device.id,
    )
    .run();

  return c.json(
    ok({
      job_id: jobId,
      status: 'queued',
      message: 'Backend scrape requested. AI will select Apify or BrightData.',
      manual_failure_reason: reason ?? null,
    }),
  );
});
