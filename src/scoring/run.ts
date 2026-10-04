/**
 * Running Pass 0 against a real lead, and writing the result down.
 *
 * `pass0.ts` is arithmetic. This file is the part that touches D1, and it exists
 * separately because the arithmetic has to be replayable: the breakdown endpoint
 * and a historical rescore both need to reproduce a score from the rows that were
 * there at the time, without going near the write path.
 *
 * THREE WRITES, ONE TRANSACTION'S WORTH OF INTENT
 *
 * A scoring run has to leave three traces and they must agree:
 *   - `lead_scores` — the snapshot, immutable, one row per run. This is the
 *     audit trail and the input to the breakdown endpoint.
 *   - `leads.rule_score / ai_score / final_score / tier` — the denormalised copy
 *     the list page sorts and filters on (`idx_leads_tier_score`).
 *   - `activity_log` — so the lead's timeline shows what happened to it.
 *
 * If the first lands and the second does not, the console shows one number in the
 * table and a different one in the detail panel, and there is no way to tell
 * which is current. D1 has no multi-statement transaction across `prepare()`
 * calls, so the three are issued inside one `batch()` — which D1 runs as a single
 * implicit transaction — and the whole run is idempotent under the id supplied by
 * the caller.
 *
 * WHAT IS DELIBERATELY NOT HERE: the AI pass. Pass 1 is gated, budgeted and
 * batched, and mixing it into this function would mean either every lead paid for
 * a token or the gate check got skipped on a hurried edit. `pass=0` rows are
 * written now and upgraded in place by STEP 12.
 */

import type { SignalInput, ScoreContext, WeightRow } from './pass0';
import { computeFinalScore, computeRuleScore, resolveTier } from './pass0';
import {
  AI_DEFAULT_DAILY_CAP,
  AI_DEDUPE_SECONDS,
  PASS1_BATCH_SIZE,
  PASS1_PROMPT_VERSION,
  buildAiLeadInput,
  callManifestBatch,
  parseManifestCredential,
  selectPass1Candidates,
  type AiLeadInput,
  type ManifestCallResult,
} from './pass1';
import { claimAccount, setAccountState } from '../router/claim';
import { openSecret } from '../lib/crypto';

interface LeadRow {
  id: string;
  niche: string | null;
  country_code: string | null;
  city: string | null;
  phone_e164: string | null;
  has_website: number | null;
  overture_id: string | null;
  fsq_id: string | null;
  tier: string | null;
  status: string | null;
  is_manual_edited: number;
  rule_score: number | null;
}

export interface ScoreRunResult {
  lead_id: string;
  score_version: number;
  weights_version: number;
  rule_score: number;
  final_score: number;
  tier: string | null;
  coverage: number;
  is_provisional: number;
  available_weight: number;
  features: ReturnType<typeof computeRuleScore>['features'];
}

export interface Pass1BatchResult {
  batch_id: string;
  account_label: string | null;
  lead_count: number;
  scored: number;
  outcome: 'ok' | 'parse_fail' | 'timeout' | 'error';
  next_after_id: string | null;
  skipped: number;
  reason: string | null;
}

interface Pass1LeadRow extends LeadRow {
  name: string;
  website_url: string | null;
  employee_estimate: number | null;
  source_confidence: number | null;
  ai_scored_at: number | null;
  deleted_at: number | null;
}

/**
 * Loads the active weight set.
 *
 * A version whose weights do not sum to 100 is refused rather than normalised.
 * The score renormalises over whatever is AVAILABLE but it must never quietly
 * compensate for a weights version that is simply wrong — 12-scoring.md §9.3
 * makes "the active version sums to 100" a seed invariant precisely so that a
 * broken version fails loudly here instead of producing plausible numbers.
 */
export async function loadActiveWeights(
  db: D1Database,
): Promise<{ version: number; weights: WeightRow[] } | null> {
  const active = await db
    .prepare(`SELECT value_num AS version FROM settings WHERE key = 'active_weights_version'`)
    .first<{ version: number | null }>();

  const version = active?.version;
  if (version === null || version === undefined) return null;

  const rows = await db
    .prepare(`SELECT feature_key, weight FROM score_weights WHERE version = ?`)
    .bind(version)
    .all<WeightRow>();

  const weights = rows.results ?? [];
  if (weights.length === 0) return null;

  const total = weights.reduce((sum, row) => sum + row.weight, 0);
  if (Math.abs(total - 100) > 0.01) {
    throw new Error(
      `active score_weights v${version} sums to ${total}, not 100 (12-scoring.md §9.3)`,
    );
  }

  return { version, weights };
}

/** The non-signal inputs to the score: things already known about the lead. */
async function loadContext(db: D1Database, lead: LeadRow): Promise<ScoreContext> {
  const [nicheRow, geoRow] = await Promise.all([
    lead.niche
      ? db
          .prepare(`SELECT priority FROM niches WHERE niche_slug = ? AND enabled = 1`)
          .bind(lead.niche)
          .first<{ priority: number | null }>()
      : Promise.resolve(null),
    lead.country_code
      ? db
          .prepare(
            `SELECT priority FROM geo_targets
               WHERE country_code = ? AND enabled = 1
                 AND (city IS NULL OR city = '' OR city = ?)
               ORDER BY priority ASC LIMIT 1`,
          )
          .bind(lead.country_code, lead.city ?? '')
          .first<{ priority: number | null }>()
      : Promise.resolve(null),
  ]);

  const overture = Boolean(lead.overture_id);
  const fsq = Boolean(lead.fsq_id);

  return {
    hasWebsite: lead.has_website,
    phoneE164: lead.phone_e164,
    nichePriority: nicheRow?.priority ?? null,
    geoPriority: geoRow?.priority ?? null,
    dualSourced: overture && fsq,
    singleSourced: overture !== fsq,
  };
}

/**
 * Scores one lead and writes the three traces.
 *
 * Returns null when the lead does not exist or is soft-deleted — a scoring job
 * that has outlived the lead it names is a normal outcome, not an error, and the
 * dispatcher should not retry it.
 */
export async function scoreLeadPass0(
  db: D1Database,
  leadId: string,
  options: { now?: number } = {},
): Promise<ScoreRunResult | null> {
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const lead = await db
    .prepare(
      `SELECT id, niche, country_code, city, phone_e164, has_website,
              overture_id, fsq_id, tier, status, is_manual_edited, rule_score
         FROM leads WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(leadId)
    .first<LeadRow>();

  if (!lead) return null;

  const active = await loadActiveWeights(db);
  if (!active) return null;

  const signalRows = await db
    .prepare(
      `SELECT signal_key, signal_value_num, signal_value_text, collected_at, expires_at
         FROM lead_signals WHERE lead_id = ?`,
    )
    .bind(leadId)
    .all<SignalInput>();

  const context = await loadContext(db, lead);

  const result = computeRuleScore({
    weights: active.weights,
    signals: signalRows.results ?? [],
    weightsVersion: active.version,
    context,
    now,
  });

  // Pass 1 has not run, so the final score IS the rule score and the row is
  // written with `pass=0`. 12-scoring.md §8 makes "pass=0 with an ai_score" an
  // invariant violation, which is why ai_score is written as NULL rather than 0.
  const finalScore = computeFinalScore(result.rule_score, null);

  const tier = resolveTier({
    finalScore,
    isProvisional: result.is_provisional,
    currentStatus: lead.status,
    currentTier: lead.tier,
    isManualEdited: lead.is_manual_edited,
  });

  // The counter is bumped by the scoring run itself, so two runs in the same
  // second cannot share a version. R6: atomic, never read-then-write.
  const bumped = await db
    .prepare(
      `UPDATE settings SET value_num = value_num + 1, updated_at = unixepoch()
        WHERE key = 'score_version' RETURNING value_num`,
    )
    .first<{ value_num: number }>();

  const scoreVersion = Math.round(bumped?.value_num ?? 1);
  const scoreId = crypto.randomUUID();

  await db.batch([
    db
      .prepare(
        `INSERT INTO lead_scores
           (id, lead_id, pass, rule_score, ai_score, final_score, tier,
            weights_version, score_version, is_provisional, ai_scored_at,
            features_json, model, created_at)
         VALUES (?, ?, 0, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
      )
      .bind(
        scoreId,
        leadId,
        result.rule_score,
        finalScore,
        tier,
        result.weights_version,
        scoreVersion,
        result.is_provisional,
        JSON.stringify({
          coverage: result.coverage,
          available_weight: result.available_weight,
          features: result.features,
        }),
        now,
      ),

    // `status` moves to 'scored' only from 'new'/'enriched'. A lead further down
    // the pipeline keeps its status: scoring is not a reason to forget that
    // somebody has already emailed it.
    db
      .prepare(
        `UPDATE leads
            SET rule_score = ?, final_score = ?, tier = ?,
                status = CASE WHEN status IN ('new','enriched') THEN 'scored' ELSE status END,
                updated_at = unixepoch()
          WHERE id = ?`,
      )
      .bind(result.rule_score, finalScore, tier, leadId),

    db
      .prepare(
        `INSERT INTO activity_log (id, lead_id, event_type, actor, detail_json, created_at)
         VALUES (?, ?, 'scored', 'system', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        leadId,
        JSON.stringify({
          pass: 0,
          rule_score: result.rule_score,
          coverage: result.coverage,
          tier,
          weights_version: result.weights_version,
          score_version: scoreVersion,
        }),
        now,
      ),
  ]);

  return {
    lead_id: leadId,
    score_version: scoreVersion,
    weights_version: result.weights_version,
    rule_score: result.rule_score,
    final_score: finalScore,
    tier,
    coverage: result.coverage,
    is_provisional: result.is_provisional,
    available_weight: result.available_weight,
    features: result.features,
  };
}

async function reserveAiRequest(db: D1Database, now: number): Promise<boolean> {
  const capRow = await db
    .prepare(`SELECT value_num AS cap FROM settings WHERE key = 'ai_daily_cap'`)
    .first<{ cap: number | null }>();
  const limit = Math.max(0, Math.trunc(capRow?.cap ?? AI_DEFAULT_DAILY_CAP));
  const windowKey = `day:${Math.floor(now / 86400)}`;

  await db
    .prepare(
      `INSERT OR IGNORE INTO quota_counters
         (id, provider, account_label, window_key, used, limit_value, updated_at)
       VALUES (?, 'manifest', '*', ?, 0, ?, ?)`,
    )
    .bind(crypto.randomUUID(), windowKey, limit, now)
    .run();

  const row = await db
    .prepare(
      `UPDATE quota_counters
          SET used = used + 1, updated_at = ?
        WHERE provider = 'manifest' AND account_label = '*' AND window_key = ?
          AND used < limit_value
        RETURNING used, limit_value`,
    )
    .bind(now, windowKey)
    .first<{ used: number; limit_value: number | null }>();
  return Boolean(row);
}

async function releaseAiRequest(db: D1Database, now: number): Promise<void> {
  const windowKey = `day:${Math.floor(now / 86400)}`;
  await db
    .prepare(
      `UPDATE quota_counters
          SET used = MAX(used - 1, 0), updated_at = ?
        WHERE provider = 'manifest' AND account_label = '*' AND window_key = ?`,
    )
    .bind(now, windowKey)
    .run();
}

async function loadPass1Lead(db: D1Database, id: string, now: number): Promise<{
  lead: Pass1LeadRow;
  input: AiLeadInput;
  ruleScore: number;
  isProvisional: number;
  weightsVersion: number;
  currentTier: string | null;
} | null> {
  const lead = await db
    .prepare(
      `SELECT id, name, niche, country_code, city, phone_e164, website_url,
              employee_estimate, has_website, overture_id, fsq_id, tier, status,
              is_manual_edited, rule_score, ai_scored_at, deleted_at,
              NULL AS source_confidence
         FROM leads WHERE id = ?`,
    )
    .bind(id)
    .first<Pass1LeadRow>();
  if (!lead || lead.deleted_at !== null || lead.rule_score === null) return null;
  if (lead.ai_scored_at !== null && lead.ai_scored_at > now - AI_DEDUPE_SECONDS) return null;

  const snapshot = await db
    .prepare(
      `SELECT is_provisional, weights_version FROM lead_scores
        WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(id)
    .first<{ is_provisional: number | null; weights_version: number | null }>();
  const isProvisional = Number(snapshot?.is_provisional ?? 0);
  if (isProvisional === 1) return null;

  const [signals, geo] = await Promise.all([
    db
      .prepare(
        `SELECT signal_key, signal_value_num, signal_value_text, expires_at
           FROM lead_signals WHERE lead_id = ?`,
      )
      .bind(id)
      .all<{ signal_key: string; signal_value_num: number | null; signal_value_text: string | null; expires_at: number | null }>(),
    lead.country_code
      ? db
          .prepare(
            `SELECT priority FROM geo_targets
               WHERE country_code = ? AND enabled = 1
                 AND (city IS NULL OR city = '' OR city = ?)
               ORDER BY priority ASC LIMIT 1`,
          )
          .bind(lead.country_code, lead.city ?? '')
          .first<{ priority: number | null }>()
      : Promise.resolve(null),
  ]);

  const input = buildAiLeadInput({
    id: lead.id,
    name: lead.name,
    city: lead.city,
    niche: lead.niche,
    website_url: lead.website_url,
    employee_estimate: lead.employee_estimate,
    geo_priority: geo?.priority ?? null,
    source_confidence: lead.source_confidence,
    phone_e164: lead.phone_e164,
    signals: signals.results ?? [],
    now,
  });
  return {
    lead,
    input,
    ruleScore: Number(lead.rule_score),
    isProvisional,
    weightsVersion: Number(snapshot?.weights_version ?? 0),
    currentTier: lead.tier,
  };
}

async function bumpScoreVersion(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE settings SET value_num = value_num + 1, updated_at = unixepoch()
        WHERE key = 'score_version' RETURNING value_num`,
    )
    .first<{ value_num: number }>();
  return Math.round(row?.value_num ?? 1);
}

function classifyPass1Error(error: unknown): 'parse_fail' | 'timeout' | 'error' {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('AI output') || message.includes('AI output must') || message.includes('AI output order')) return 'parse_fail';
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout';
  if (message.toLowerCase().includes('abort')) return 'timeout';
  return 'error';
}

/**
 * Runs one exact ten-lead Pass 1 batch. The endpoint/base URL comes from the
 * encrypted Vault credential; no provider URL or key is present in source code.
 */
export async function scoreLeadPass1Batch(
  db: D1Database,
  vaultKey: string,
  leadIds: string[],
  options: { now?: number } = {},
): Promise<Pass1BatchResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const batchId = crypto.randomUUID();
  if (leadIds.length !== PASS1_BATCH_SIZE) {
    return {
      batch_id: batchId,
      account_label: null,
      lead_count: leadIds.length,
      scored: 0,
      outcome: 'error',
      next_after_id: leadIds[leadIds.length - 1] ?? null,
      skipped: leadIds.length,
      reason: 'exactly 10 leads are required per Pass 1 request',
    };
  }

  const thresholdRow = await db
    .prepare(`SELECT value_num AS threshold FROM settings WHERE key = 'gate_threshold'`)
    .first<{ threshold: number | null }>();
  const gateRows = await db
    .prepare(
      `SELECT l.id, l.rule_score, l.deleted_at, l.ai_scored_at,
              COALESCE((
                SELECT ls.is_provisional FROM lead_scores ls
                 WHERE ls.lead_id = l.id
                 ORDER BY ls.created_at DESC, ls.rowid DESC LIMIT 1
              ), 0) AS is_provisional
         FROM leads l
        WHERE l.deleted_at IS NULL AND l.rule_score IS NOT NULL`,
    )
    .all<{
      id: string;
      rule_score: number | null;
      is_provisional: number;
      deleted_at: number | null;
      ai_scored_at: number | null;
    }>();
  const gate = selectPass1Candidates(
    gateRows.results ?? [],
    Number(thresholdRow?.threshold ?? 55),
    Math.max(1, gateRows.results?.length ?? 1),
    now,
  );
  const gateIds = new Set(gate.candidates.map((row) => row.id));
  if (leadIds.some((id) => !gateIds.has(id))) {
    return {
      batch_id: batchId,
      account_label: null,
      lead_count: PASS1_BATCH_SIZE,
      scored: 0,
      outcome: 'error',
      next_after_id: leadIds[leadIds.length - 1] ?? null,
      skipped: PASS1_BATCH_SIZE,
      reason: 'server-side AI gate rejected one or more leads',
    };
  }

  const loaded = (await Promise.all(leadIds.map((id) => loadPass1Lead(db, id, now)))).filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  if (loaded.length !== PASS1_BATCH_SIZE) {
    return {
      batch_id: batchId,
      account_label: null,
      lead_count: leadIds.length,
      scored: 0,
      outcome: 'error',
      next_after_id: leadIds[leadIds.length - 1] ?? null,
      skipped: leadIds.length - loaded.length,
      reason: 'one or more leads are provisional, deleted, unscored, or in the 24-hour AI cooldown',
    };
  }

  const reserved = await reserveAiRequest(db, now);
  if (!reserved) {
    return {
      batch_id: batchId,
      account_label: null,
      lead_count: PASS1_BATCH_SIZE,
      scored: 0,
      outcome: 'error',
      next_after_id: leadIds[leadIds.length - 1] ?? null,
      skipped: PASS1_BATCH_SIZE,
      reason: 'daily AI cap exhausted',
    };
  }

  const account = await claimAccount(db, 'manifest', now, true);
  if (!account) {
    await releaseAiRequest(db, now);
    return {
      batch_id: batchId,
      account_label: null,
      lead_count: PASS1_BATCH_SIZE,
      scored: 0,
      outcome: 'error',
      next_after_id: leadIds[leadIds.length - 1] ?? null,
      skipped: PASS1_BATCH_SIZE,
      reason: 'no claimable manifest account',
    };
  }

  let outcome: 'ok' | 'parse_fail' | 'timeout' | 'error' = 'ok';
  let call: ManifestCallResult | null = null;
  let errorMessage: string | null = null;
  const started = Date.now();

  const credential = await db
    .prepare(
      `SELECT c.ciphertext, c.iv, c.auth_tag
         FROM provider_credentials c
        WHERE c.account_id = ? AND c.test_status = 'ok'
        ORDER BY c.rotated_at IS NULL DESC, c.created_at DESC LIMIT 1`,
    )
    .bind(account.id)
    .first<{ ciphertext: string; iv: string; auth_tag: string }>();
  try {
    if (!credential) throw new Error('manifest account has no tested credential');
    const secret = await openSecret(credential, vaultKey);
    const parsed = parseManifestCredential(secret);
    if (!parsed) throw new Error('manifest credential is not a valid endpoint configuration');
    call = await callManifestBatch(parsed, loaded.map((item) => item.input));
  } catch (firstError) {
    // P3 v2 permits exactly one retry for parse/schema failures. A second attempt
    // uses the same account and batch; no speculative fallback score is written.
    if (classifyPass1Error(firstError) === 'parse_fail' && credential) {
      try {
        const secret = await openSecret(credential, vaultKey);
        const parsed = parseManifestCredential(secret);
        if (!parsed) throw new Error('manifest credential is not a valid endpoint configuration');
        call = await callManifestBatch(parsed, loaded.map((item) => item.input));
      } catch (secondError) {
        outcome = classifyPass1Error(secondError);
        errorMessage = secondError instanceof Error ? secondError.message : String(secondError);
      }
    } else {
      outcome = classifyPass1Error(firstError);
      errorMessage = firstError instanceof Error ? firstError.message : String(firstError);
    }
  }

  await db
    .prepare(
      `INSERT INTO ai_score_log
         (id, batch_id, provider, account_label, lead_count, prompt_version,
          tokens_in, tokens_out, cost_micro, latency_ms, outcome, created_at)
       VALUES (?, ?, 'manifest', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      batchId,
      account.account_label,
      PASS1_BATCH_SIZE,
      PASS1_PROMPT_VERSION,
      call?.tokens_in ?? null,
      call?.tokens_out ?? null,
      call?.cost_micro ?? null,
      Date.now() - started,
      outcome,
      now,
    )
    .run();

  if (!call || outcome !== 'ok') {
    await setAccountState(db, account.id, { quotaUsedBack: false });
    return {
      batch_id: batchId,
      account_label: account.account_label,
      lead_count: PASS1_BATCH_SIZE,
      scored: 0,
      outcome,
      next_after_id: leadIds[leadIds.length - 1] ?? null,
      skipped: PASS1_BATCH_SIZE,
      reason: errorMessage ?? 'AI batch did not produce a valid result',
    };
  }

  const outputById = new Map(call.outputs.map((output) => [output.id, output]));
  const statements: D1PreparedStatement[] = [];
  for (const item of loaded) {
    const output = outputById.get(item.lead.id);
    if (!output) continue;
    const finalScore = computeFinalScore(item.ruleScore, output.ai_score);
    const tier = resolveTier({
      finalScore,
      isProvisional: item.isProvisional,
      currentStatus: item.lead.status,
      currentTier: item.currentTier,
      isManualEdited: item.lead.is_manual_edited,
    });
    const scoreVersion = await bumpScoreVersion(db);
    statements.push(
      db
        .prepare(
          `INSERT INTO lead_scores
             (id, lead_id, pass, rule_score, ai_score, final_score, tier,
              weights_version, score_version, is_provisional, ai_scored_at,
              features_json, model, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(), item.lead.id, item.ruleScore, output.ai_score, finalScore, tier,
          item.weightsVersion, scoreVersion, item.isProvisional, now,
          JSON.stringify({ reason: output.reason, angle: output.angle, confidence: output.confidence }),
          'manifest', now,
        ),
      db
        .prepare(
          `UPDATE leads SET ai_score = ?, final_score = ?, tier = ?, ai_scored_at = ?, updated_at = unixepoch()
             WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(output.ai_score, finalScore, tier, now, item.lead.id),
      db
        .prepare(
          `INSERT INTO activity_log (id, lead_id, event_type, actor, detail_json, created_at)
           VALUES (?, ?, 'scored', 'system', ?, ?)`,
        )
        .bind(crypto.randomUUID(), item.lead.id, JSON.stringify({ pass: 1, ai_score: output.ai_score, final_score: finalScore, tier, reason: output.reason, angle: output.angle }), now),
    );
  }
  await db.batch(statements);
  await setAccountState(db, account.id, { status: 'active', resetFailureStreak: true });

  return {
    batch_id: batchId,
    account_label: account.account_label,
    lead_count: PASS1_BATCH_SIZE,
    scored: outputById.size,
    outcome: 'ok',
    next_after_id: leadIds[leadIds.length - 1] ?? null,
    skipped: PASS1_BATCH_SIZE - outputById.size,
    reason: null,
  };
}
