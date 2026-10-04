/**
 * Wave 1 — the free probes, and the write that makes them count.
 *
 * 03-execution.md STEP 10 is the milestone the entire plan rests on: "1,000 leads
 * with rule_score filled in, and a distribution you can look at, for $0". The
 * probes themselves already exist — `adapters/tech_probe.ts` has measured MX
 * records, TLS, stack markers, robots/sitemap, published mailto addresses and
 * PageSpeed since STEP 7. What was missing, and what this file is, is the step
 * that runs them against a lead and PERSISTS the answers as `lead_signals` rows.
 *
 * WHY THIS IS NOT INSIDE THE ADAPTER. An adapter is a transport: it takes an
 * invocation and returns records. It has no opinion about which lead the records
 * belong to, and it never writes to D1 — 09-router.md gives the write path to the
 * job layer. Keeping the mapping here means a probe can be re-run against a
 * different lead, or the same lead re-probed next month, without touching the
 * adapter.
 *
 * THE TTLs ARE NOT DECORATION. 12-scoring.md §2.5 gives tech-probe signals 30 days
 * and makes an expired signal count as ABSENT rather than zero. A PageSpeed score
 * from four months ago is not evidence about today's site, and the scoring engine
 * reads `expires_at` itself — this file only has to be honest about when the
 * measurement stops being one.
 *
 * WHAT RUNS, AND WHY EACH ONE IS WORTH ITS REQUEST
 *
 *   dns_mx          No MX record is the strongest reachability signal there is:
 *                   a business with no mail cannot be emailed.
 *   ssl_cert        Whether TLS completes at all. NOT certificate expiry — a
 *                   Worker cannot read a peer certificate, and the adapter says
 *                   so rather than implying otherwise.
 *   tech_stack      Old CMS vs modern, plus whether anything is measuring traffic.
 *   robots_sitemap  A site with no sitemap or fewer than five pages is a site
 *                   nobody maintains.
 *   email_pattern   Published `mailto:` addresses. Whether one exists sets 10 of
 *                   the 100 points; the ADDRESS is not stored here (see below).
 *   psi             Mobile PageSpeed, the 12-point feature. A failed score is
 *                   still a signal, so a quota refusal is recorded as such.
 *   wayback         How long since the archive last saw the site — 8 points.
 *   website_meta    Whether the site publishes a contact route — 4 points.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not store the email ADDRESS it
 * finds. `email_pattern` reports the shape it saw and masked samples, and
 * verification and address capture are STEP 11's job (L1/L2/L3, `contacts`). The
 * `email` SIGNAL written here is a reachability statement — "this business
 * publishes a way to be contacted" — which is exactly what §2.2 weights. Storing
 * an address here would mean shipping an unverified address into `leads.email`
 * with no verification layer and no `lawful_basis`, which is a compliance
 * decision this step is not entitled to make.
 */

import { techProbeAdapter } from '../../adapters/tech_probe';
import type { AdapterInvocation } from '../../adapters/shared';
import type { AdapterOutcome } from '../../router/types';

/** 12-scoring.md §2.5: technical signals are good for 30 days. */
const TECH_PROBE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Where a probe's start time is needed for webhook-free metrics. */
const PROVIDER = 'probe';

interface LeadRow {
  id: string;
  domain: string | null;
  website_url: string | null;
  phone_e164: string | null;
  niche: string | null;
  employee_estimate: number | null;
  overture_id: string | null;
  fsq_id: string | null;
}

export interface SignalWrite {
  signal_key: string;
  signal_value_num: number | null;
  signal_value_text: string | null;
  expires_at: number | null;
}

export interface Wave1Result {
  lead_id: string;
  has_website: number;
  probed: string[];
  failed: { probe: string; error: string | null }[];
  signals_written: number;
}

/**
 * Builds the invocation an adapter expects.
 *
 * The free probes hold no credential, so `credential_ref` is null and
 * `resolveCredential` returns null — R20's credential-free floor, made concrete.
 * `unit_cost_micro` is 0 because these endpoints are genuinely free; the
 * `cost_micro` that `buildOutcome` computes from it will therefore be 0, which is
 * the truth and is why none of these probes can move the budget guard.
 */
function invocationFor(input: {
  leadId: string;
  probeKind: string;
  target: string;
  timeoutMs: number;
  strategy?: string;
}): AdapterInvocation {
  return {
    job_id: `wave1:${input.leadId}`,
    target_type: 'tech_probe',
    adapter: 'tech_probe',
    hop: 1,
    provider: PROVIDER,
    account_label: null,
    runner: 'worker',
    unit_cost_micro: 0,
    credential_ref: null,
    resolveCredential: async () => null,
    source: null,
    input: {
      probe_kind: input.probeKind,
      url: input.target,
      ...(input.strategy ? { strategy: input.strategy } : {}),
    },
    budget: { remaining_subrequests: 40, deadline_ms: Date.now() + input.timeoutMs },
  };
}

/** The first record of an outcome, typed loosely — every probe returns one row. */
function firstRecord(outcome: AdapterOutcome): Record<string, unknown> | null {
  const record = outcome.records[0];
  return record && typeof record === 'object' ? (record as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Runs the probes for one lead and returns the signal rows to write.
 *
 * Pure with respect to the database: it fetches and it maps, and the caller does
 * the insert. That split is what lets the mapping be replayed against a stored
 * outcome when a probe turns out to have been misread.
 */
async function collectSignals(
  lead: LeadRow,
  options: { timeoutMs: number; probes?: string[] },
): Promise<{ hasWebsite: number; signals: SignalWrite[]; probed: string[]; failed: { probe: string; error: string | null }[] }> {
  const signals: SignalWrite[] = [];
  const probed: string[] = [];
  const failed: { probe: string; error: string | null }[] = [];

  const site = lead.website_url ?? lead.domain ?? null;
  const hasWebsite = site ? 1 : 0;

  // Signals that are facts about the lead rather than measurements of a website.
  // They carry no `expires_at` because they do not go stale — an imported phone
  // number is still the phone number that was imported.
  signals.push({
    signal_key: 'phone_e164',
    signal_value_num: lead.phone_e164 && lead.phone_e164.startsWith('+') ? 100 : 0,
    signal_value_text: lead.phone_e164 ?? null,
    expires_at: null,
  });

  if (lead.employee_estimate !== null && lead.employee_estimate > 0) {
    signals.push({
      signal_key: 'employee_estimate',
      signal_value_num: lead.employee_estimate,
      signal_value_text: null,
      expires_at: null,
    });
  }

  const overture = Boolean(lead.overture_id);
  const fsq = Boolean(lead.fsq_id);
  signals.push({
    signal_key: 'dataset_confidence',
    signal_value_num: overture && fsq ? 100 : overture !== fsq ? 50 : 0,
    signal_value_text: overture && fsq ? 'dual_source' : overture || fsq ? 'single_source' : 'none',
    expires_at: null,
  });

  // A lead with no website is not "unprobed", it is the strongest website-pain
  // signal the system has. §2.1 allocates its points to `tech_stack`, so the row
  // is written here to make the feature PRESENT and therefore part of coverage —
  // otherwise every no-website lead would look thin and land in provisional.
  if (hasWebsite === 0) {
    signals.push({
      signal_key: 'tech_stack',
      signal_value_num: null,
      signal_value_text: 'no_website',
      expires_at: null,
    });
    return { hasWebsite, signals, probed, failed };
  }

  const wanted = options.probes ?? [
    'dns_mx',
    'ssl_cert',
    'tech_stack',
    'robots_sitemap',
    'email_pattern',
    'psi',
    'wayback',
    'website_meta',
  ];

  for (const probeKind of wanted) {
    let outcome: AdapterOutcome;
    try {
      outcome = await techProbeAdapter.run(
        invocationFor({
          leadId: lead.id,
          probeKind,
          target: site as string,
          timeoutMs: options.timeoutMs,
          strategy: probeKind === 'psi' ? 'mobile' : undefined,
        }),
      );
    } catch (error) {
      failed.push({ probe: probeKind, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    probed.push(probeKind);
    const row = firstRecord(outcome);
    if (!row) {
      failed.push({ probe: probeKind, error: outcome.error_code ?? 'no_record' });
      continue;
    }

    const expiresAt = Math.floor(Date.now() / 1000) + TECH_PROBE_TTL_SECONDS;

    switch (probeKind) {
      case 'dns_mx': {
        const count = num(row.mx_count) ?? 0;
        const hosts = Array.isArray(row.mx_hosts) ? (row.mx_hosts as unknown[]).map(String) : [];
        signals.push({
          signal_key: 'dns_mx',
          signal_value_num: count,
          // The scorer needs to tell business mail from a generic provider, and
          // the hosts are the only place that distinction exists.
          signal_value_text: hosts.length > 0 ? hosts.join(',').toLowerCase() : 'none',
          expires_at: expiresAt,
        });
        break;
      }

      case 'ssl_cert': {
        const reachable = num(row.tls_reachable) ?? 0;
        const hsts = num(row.hsts) ?? 0;
        signals.push({
          signal_key: 'ssl_cert',
          // 1/0 for "TLS completed", and the text carries the HSTS detail the
          // scorer bands on. The adapter's own `certificate_expiry_checked: 0`
          // is why no expiry value is written: it was never observed.
          signal_value_num: reachable,
          signal_value_text: reachable === 0 ? 'tls_unreachable' : hsts === 1 ? 'tls_ok' : 'tls_ok_no_hsts',
          expires_at: expiresAt,
        });
        break;
      }

      case 'tech_stack': {
        const markers = Array.isArray(row.stack_markers) ? (row.stack_markers as unknown[]).map(String) : [];
        const generator = str(row.generator);
        if (generator && !markers.includes(generator.toLowerCase())) markers.push(generator.toLowerCase());
        if (markers.length === 0) {
          failed.push({ probe: probeKind, error: 'no_markers' });
          break;
        }
        signals.push({
          signal_key: 'tech_stack',
          signal_value_num: null,
          signal_value_text: markers.join(','),
          expires_at: expiresAt,
        });
        break;
      }

      case 'robots_sitemap': {
        const pageCount = num(row.sitemap_urls) ?? 0;
        const hasSitemap = (num(row.sitemap_count) ?? 0) > 0;
        signals.push({
          signal_key: 'robots_sitemap',
          signal_value_num: pageCount,
          signal_value_text: hasSitemap ? 'sitemap' : 'none',
          expires_at: expiresAt,
        });
        break;
      }

      case 'email_pattern': {
        const published = num(row.published_addresses) ?? 0;
        signals.push({
          signal_key: 'email',
          // 'syntax_ok' and never 'valid': the address has passed a shape check
          // and nothing else. L1/L2/L3 belong to STEP 11 and R13 gates L3 on HOT.
          signal_value_text: published > 0 ? 'syntax_ok' : 'none',
          signal_value_num: published,
          expires_at: expiresAt,
        });
        break;
      }

      case 'psi': {
        const score = num(row.score);
        if (score === null) {
          // A quota refusal is recorded as a probe that produced no score rather
          // than as a score of zero, which would read as "this site is terrible".
          failed.push({ probe: probeKind, error: outcome.error_code ?? 'psi_no_score' });
          break;
        }
        signals.push({
          signal_key: 'psi_mobile',
          signal_value_num: score,
          signal_value_text: str(row.field_category),
          expires_at: expiresAt,
        });
        break;
      }

      case 'wayback': {
        const ageDays = num(row.age_days);
        if (ageDays === null) {
          // No snapshot is not a stale site (§2.5) — the signal is simply absent.
          failed.push({ probe: probeKind, error: 'no_snapshot' });
          break;
        }
        signals.push({
          signal_key: 'wayback_last_change',
          signal_value_num: ageDays,
          signal_value_text: str(row.last_capture),
          expires_at: expiresAt,
        });
        break;
      }

      case 'website_meta': {
        const contactHref = str(row.contact_href);
        const mailtoCount = num(row.mailto_count) ?? 0;
        signals.push({
          signal_key: 'website_meta',
          signal_value_num: contactHref || mailtoCount > 0 ? 1 : 0,
          signal_value_text: contactHref ? 'contact_found' : 'contact_absent',
          expires_at: expiresAt,
        });
        break;
      }

      default:
        // An unreachable branch: `wanted` is a closed list. Kept so a future
        // probe kind added without a mapping here fails loudly as a `failed`
        // entry instead of silently contributing nothing to coverage.
        failed.push({ probe: probeKind, error: 'no_mapping' });
    }
  }

  return { hasWebsite, signals, probed, failed };
}

/**
 * Probes one lead and writes the result.
 *
 * `INSERT OR REPLACE` on `(lead_id, signal_key)` — the pair is the only unique
 * key `lead_signals` has, and re-probing must supersede the previous measurement
 * rather than accumulate duplicates that the scorer would then pick from at
 * random. The old row is replaced because the new one is strictly better evidence
 * about the same subject.
 */
export async function collectWave1(
  db: D1Database,
  leadId: string,
  options: { timeoutMs?: number; probes?: string[] } = {},
): Promise<Wave1Result | null> {
  const lead = await db
    .prepare(
      `SELECT id, domain, website_url, phone_e164, niche, employee_estimate,
              overture_id, fsq_id
         FROM leads WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(leadId)
    .first<LeadRow>();

  if (!lead) return null;

  const { hasWebsite, signals, probed, failed } = await collectSignals(lead, {
    timeoutMs: options.timeoutMs ?? 20_000,
    probes: options.probes,
  });

  const now = Math.floor(Date.now() / 1000);

  const statements = [
    db
      .prepare(
        `UPDATE leads
            SET has_website = ?,
                status = CASE WHEN status = 'new' THEN 'enriched' ELSE status END,
                updated_at = unixepoch()
          WHERE id = ?`,
      )
      .bind(hasWebsite, leadId),
  ];

  for (const signal of signals) {
    statements.push(
      db
        .prepare(
          `INSERT INTO lead_signals
             (id, lead_id, signal_key, signal_value_num, signal_value_text,
              confidence, collected_at, expires_at, source_provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (lead_id, signal_key) DO UPDATE SET
             signal_value_num  = excluded.signal_value_num,
             signal_value_text = excluded.signal_value_text,
             confidence        = excluded.confidence,
             collected_at      = excluded.collected_at,
             expires_at        = excluded.expires_at,
             source_provider   = excluded.source_provider`,
        )
        .bind(
          crypto.randomUUID(),
          leadId,
          signal.signal_key,
          signal.signal_value_num,
          signal.signal_value_text,
          1,
          now,
          signal.expires_at,
          PROVIDER,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO activity_log (id, lead_id, event_type, actor, detail_json, created_at)
         VALUES (?, ?, 'enriched', 'system', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        leadId,
        JSON.stringify({ wave: 1, probed, failed, signals: signals.length, has_website: hasWebsite }),
        now,
      ),
  );

  await db.batch(statements);

  return {
    lead_id: leadId,
    has_website: hasWebsite,
    probed,
    failed,
    signals_written: signals.length,
  };
}

/**
 * Picks the next leads that still need probing.
 *
 * Ordered by `id` so a batch run is resumable and so two concurrent runs do not
 * fight over the same rows; the caller passes the last id it handled. `status IN
 * ('new','enriched')` keeps already-contacted leads out of the queue — re-probing
 * a lead somebody is mid-conversation with spends requests to learn nothing the
 * operator needs.
 */
export async function nextLeadsToProbe(
  db: D1Database,
  options: { limit: number; afterId?: string | null },
): Promise<string[]> {
  const limit = Math.max(1, Math.min(options.limit, 25));
  const rows = await db
    .prepare(
      `SELECT id FROM leads
        WHERE deleted_at IS NULL
          AND status IN ('new','enriched')
          AND has_website IS NULL
          AND id > ?
        ORDER BY id ASC LIMIT ?`,
    )
    .bind(options.afterId ?? '', limit)
    .all<{ id: string }>();

  return (rows.results ?? []).map((row) => row.id);
}
