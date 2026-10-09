/**
 * Cold-lead archive job (Track A, Item 2: R2 hybrid cold storage).
 *
 * The free-tier D1 budget (5M reads/day, 100k writes/day) is the project's
 * scarcest resource, and leads older than 90 days are history, not pipeline:
 * they are read rarely but keep paying index and scan cost on every hot query.
 * This job moves them to R2 (`jepy-raw`, `archives/leads/<YYYY-MM-DD>/batch-<epoch>.jsonl`)
 * and marks them `archived_at` in D1, so hot queries stay `archived_at IS NULL`
 * and the dashboard never slows down as the table grows.
 *
 * Idempotency: the candidate SELECT only ever picks `archived_at IS NULL`
 * leads, and the mark is applied by id, so a lead already archived is never
 * re-selected. If the run crashes between the R2 put and the D1 mark, the next
 * run writes a fresh batch (the old one is harmless — the log records both);
 * R2 is written FIRST precisely so the bytes are addressable and diagnosable
 * even if D1 then fails.
 *
 * D1-read discipline: one capped SELECT on the partial index
 * `idx_leads_archive_candidate`, then ONE `db.batch()` call carrying the mark
 * UPDATEs (chunked to 100 ids per IN clause, because D1 binds and SQLite
 * parameter handling degrade past a few hundred) plus the archive-log INSERT.
 * No polling loops; at most 500 leads move per run.
 */

import type { Env } from '../env';

/** Age at which a lead becomes archive-eligible. */
const ARCHIVE_AGE_SECONDS = 90 * 86_400;
/** Cap per run: keeps one run's R2 object small and the D1 mark cheap. */
const MAX_LEADS_PER_RUN = 500;
/** IN-clause chunk size for the mark UPDATEs. */
const MARK_CHUNK_SIZE = 100;

export async function archiveColdLeads(env: Env): Promise<{ archived: number; batches: string[] }> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - ARCHIVE_AGE_SECONDS;
  const db = env.DB;

  // Oldest first: the archive frontier advances monotonically, so a run that
  // is interrupted leaves no old lead permanently stranded behind newer ones.
  const rows = await db
    .prepare(
      `SELECT * FROM leads
        WHERE created_at < ? AND archived_at IS NULL AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(cutoff, MAX_LEADS_PER_RUN)
    .all();
  const leads = (rows.results ?? []) as Record<string, unknown>[];

  if (leads.length === 0) {
    return { archived: 0, batches: [] };
  }

  // Full lead row JSON per line — the archive is a restore source, so it must
  // survive future column additions; a SELECT * snapshot carries whatever the
  // row holds at archive time.
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const key = `archives/leads/${day}/batch-${now}.jsonl`;
  const jsonl = leads.map((lead) => JSON.stringify(lead)).join('\n') + '\n';
  await env.RAW.put(key, jsonl, {
    httpMetadata: { contentType: 'application/x-ndjson' },
  });

  const ids = leads.map((lead) => lead['id'] as string);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += MARK_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + MARK_CHUNK_SIZE);
    statements.push(
      db
        .prepare(`UPDATE leads SET archived_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`)
        .bind(now, ...chunk),
    );
  }

  // The log is what makes the two-system write auditable: which R2 key holds
  // which leads, and the exact created_at window it covered.
  const createdAts = leads.map((lead) => Number(lead['created_at'] ?? now));
  statements.push(
    db
      .prepare(
        `INSERT INTO lead_archive_log
           (id, r2_key, lead_count, oldest_created_at, newest_created_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), key, leads.length, Math.min(...createdAts), Math.max(...createdAts), now),
  );

  await db.batch(statements);

  return { archived: leads.length, batches: [key] };
}
