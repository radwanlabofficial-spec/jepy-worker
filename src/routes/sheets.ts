/**
 * Google Sheets lead import (Track C, item 4).
 *
 * WHY A SERVER-SIDE BATCH DOOR. Radwan keeps his prospect lists in Google
 * Sheets, and typing them into the console one by one is the slow path. The
 * sheet itself cannot call us — the machine that runs `sheets_import.py` reads
 * the range through the Google Workspace CLI and POSTs ≤1,000 rows here, one
 * batch per call. Google Sheets is not OAuth-connected on that machine yet, so
 * the CLI path is blocked on Radwan's one action; this route is the other half
 * of the same door and works the moment the batches can be read.
 *
 * THE DEDUP CASCADE IS THE SAME ONE (R8). `routes/imports.ts` exports no
 * insert helper — its chunk logic is inline, tangled with the R2 staging the
 * Tier 0 import needs and this door does not — so this route replicates the
 * INSERT...OR IGNORE pattern faithfully rather than importing half of it. The
 * shared-logic follow-up is recorded below; when it lands, both doors should
 * call one function in `lib/ingest.ts` (normalize → dedup → gate → provenance,
 * per R16) instead of carrying their own copies.
 *
 * No D1 migration: this writes only to `leads`, whose `dedup_key` unique index
 * is the whole idempotency story — replaying the same sheet inserts nothing
 * and reports it as deduped, exactly like a replayed import slice.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fail, ok } from '../lib/envelope';
import { requireActor, requireAdmin } from '../middleware/auth';
import { dedupKey, slugify } from '../lib/dedup';
import { NORMALISER, normalisePhone } from '../lib/phone';
import type { Actor, Env } from '../env';

export const sheetsRoutes = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

/** Rows per call. Bounds the request body and the D1 batch, like MAX_ROWS_PER_CHUNK in imports.ts. */
const MAX_ROWS_PER_IMPORT = 1000;

/**
 * The canonical column order Radwan shapes his sheet to. `GET
 * /api/imports/sheets/template` publishes this; `sheets_import.py` maps sheet
 * columns onto it case-insensitively. `company` is the fallback for `name` —
 * a sheet often has the business name under "Company" — and `notes` lands in
 * `provenance_json`, not in a `leads` column (there is none).
 */
export const SHEET_TEMPLATE_COLUMNS = [
  'name',
  'company',
  'email',
  'phone',
  'website',
  'city',
  'niche',
  'notes',
] as const;

const sheetRowSchema = z
  .object({
    name: z.string().max(300).nullish(),
    company: z.string().max(300).nullish(),
    email: z.string().max(320).nullish(),
    phone: z.string().max(60).nullish(),
    website: z.string().max(500).nullish(),
    city: z.string().max(200).nullish(),
    niche: z.string().max(120).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .transform((row) => ({
    name: (row.name ?? '').trim(),
    company: (row.company ?? '').trim(),
    email: (row.email ?? '').trim().toLowerCase(),
    phone: (row.phone ?? '').trim(),
    website: (row.website ?? '').trim(),
    city: (row.city ?? '').trim(),
    niche: (row.niche ?? '').trim(),
    notes: (row.notes ?? '').trim(),
  }))
  // The cascade needs a name — `company` is the sheet-shaped fallback, but a
  // row with neither is not a lead, it is a blank line, and silently dropping
  // it would make `received` lie. Reject the batch so the caller fixes the
  // sheet.
  .refine((row) => row.name !== '' || row.company !== '', {
    message: 'row needs name or company',
  });

const sheetsImportSchema = z.object({
  spreadsheet_id: z.string().max(200).nullish(),
  sheet_name: z.string().max(200).nullish(),
  rows: z.array(sheetRowSchema).min(1).max(MAX_ROWS_PER_IMPORT),
});

/**
 * A domain good enough for the `d:` dedup tier and the `domain` column, and no
 * better. This is not a registrable-domain parser — `sub.example.co.uk` stays
 * `sub.example.co.uk` — because it never decides an identity on its own: it is
 * the fourth tier of a cascade, consulted only when the phone, dataset ids and
 * email tiers all missed. The imports.ts door passes `row.domain` straight from
 * the dump; here the website is all the sheet gives us, so this derives it.
 */
function domainOf(website: string): string | null {
  let host = website.trim().toLowerCase();
  if (host === '') return null;
  host = host.replace(/^https?:\/\//, '');
  host = host.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  host = host.replace(/^www\./, '');
  host = host.split(':')[0]!;
  return host === '' ? null : host;
}

// SHARED-LOGIC FOLLOW-UP: when `lib/ingest.ts` exists (R16 one-ingest-path),
// replace `insertSheetRows` below with a call to it, and have imports.ts do the
// same. The contract to preserve: INSERT OR IGNORE on `dedup_key`, inserted
// counted from `meta.changes`, provenance recording the source. Until then this
// copy is deliberate, not drift — it matches imports.ts statement for
// statement minus the R2 staging this door has no use for.
async function insertSheetRows(
  db: D1Database,
  input: { spreadsheet_id: string | null; sheet_name: string | null; rows: z.infer<typeof sheetRowSchema>[] },
): Promise<{ inserted: number }> {
  const now = Math.floor(Date.now() / 1000);
  const sourceUrl = input.spreadsheet_id
    ? `https://docs.google.com/spreadsheets/d/${input.spreadsheet_id}`
    : null;

  const statements = input.rows.map((row) => {
    const name = row.name !== '' ? row.name : row.company;
    const domain = domainOf(row.website);
    const phone = normalisePhone(row.phone);

    const provenance = JSON.stringify({
      source: 'sheets',
      spreadsheet_id: input.spreadsheet_id,
      sheet_name: input.sheet_name,
      notes: row.notes === '' ? null : row.notes,
      imported_at: now,
    });

    return db.prepare(
      // `INSERT OR IGNORE`, mirroring imports.ts: the `dedup_key` unique index
      // makes a re-POSTed sheet report deduped rows rather than duplicates.
      `INSERT OR IGNORE INTO leads
         (id, name, name_slug, domain, website_url, phone_raw, email, city, niche,
          phone_e164, phone_country, phone_type, phone_valid,
          dedup_key, status, stage, captured_by, source_url, lawful_basis, provenance_json, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'new', 'manual', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      name,
      slugify(name),
      domain,
      row.website === '' ? null : row.website,
      row.phone === '' ? null : row.phone,
      row.email === '' ? null : row.email,
      row.city === '' ? null : row.city,
      row.niche === '' ? null : row.niche,
      phone.e164,
      phone.country,
      phone.type,
      phone.valid,
      dedupKey({
        name,
        city: row.city === '' ? null : row.city,
        phone: row.phone === '' ? null : row.phone,
        email: row.email === '' ? null : row.email,
        domain,
      }),
      sourceUrl,
      'manual_import:sheets',
      provenance,
      now,
    );
  });

  let inserted = 0;
  // Batches of 100, the same ceiling imports.ts respects: a batch has a limit,
  // and a partial batch must under-report rather than over-report.
  const BATCH_SIZE = 100;
  for (let offset = 0; offset < statements.length; offset += BATCH_SIZE) {
    const results = await db.batch(statements.slice(offset, offset + BATCH_SIZE));
    for (const result of results) inserted += result.meta.changes ?? 0;
  }
  return { inserted };
}

sheetsRoutes.get('/imports/sheets/template', requireActor, async (c) => {
  // No D1 read at all: this is a static contract, and a static contract should
  // not spend a query. Radwan shapes his sheet to this order; sheets_import.py
  // maps whatever columns the sheet actually has onto it.
  return c.json(
    ok({
      columns: [...SHEET_TEMPLATE_COLUMNS],
      note: 'Column order is informational — sheets_import.py matches columns by header name (case-insensitive), not position.',
    }),
  );
});

sheetsRoutes.post('/imports/sheets', requireAdmin, async (c) => {
  const parsed = sheetsImportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const { body, status } = fail('E_VALIDATION', { issues: parsed.error.issues.slice(0, 5) });
    return c.json(body, status as 400);
  }
  const input = parsed.data;

  const { inserted } = await insertSheetRows(c.env.DB, {
    spreadsheet_id: input.spreadsheet_id ?? null,
    sheet_name: input.sheet_name ?? null,
    rows: input.rows,
  });

  const received = input.rows.length;
  return c.json(ok({ received, inserted, deduped: received - inserted }));
});
