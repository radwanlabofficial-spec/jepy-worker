/**
 * RouterDO — the decision engine (09-router.md).
 *
 * ONE INSTANCE PER `target_type`. That is the whole reason this is a Durable
 * Object: two jobs for the same target type would otherwise race for the same
 * provider accounts, and the loser's account claim would either double-spend or
 * come back empty for no visible reason. Serialising per target type keeps
 * different waves parallel while making "who gets account-03" a question with one
 * answer.
 *
 * The DO does NOT make the claim atomic — the SQL does (09 §6). A DO is one
 * instance per key; a key is not a lock on a row. The two defences are
 * independent and both are needed: the DO stops the common case, the conditional
 * UPDATE stops the rest.
 *
 * THE FLOW, in the document's order:
 *
 *   [1] circuit check      — if every candidate is circuit-open, re-enqueue. A
 *                            skip spends no hop, because nothing was called.
 *   [2] candidate build    }  both live in router/candidates.ts, filters first
 *   [3] hard filters       }  and no weight can outvote them
 *   [4] Tier 0 gate (R10)  — free before paid, and the LAST hop must be free too
 *   [5] score & sort       — router/score.ts
 *   [6] account claim      — one conditional UPDATE ... RETURNING
 *   [7] adapter dispatch   — src/adapters, uniform contract out
 *   [8] outcome handling   — the §7 table, per signal
 *   [9] route_attempts row — one per hop, always, opened before the call
 *
 * THE CHAIN IS AT MOST THREE HOPS and its first hop is always credential-free
 * (R10). A target whose candidate set contains no free option at all is not
 * routed: R20 makes a credential-free provider a floor every target type must
 * have, so its absence is a seeding fault, and opening an all-paid chain would
 * turn that fault into money. See the comment on `applyTier0` in
 * router/score.ts for why R20 reads as a floor on the pool, not on the last hop.
 *
 * `empty` IS AN ERROR. It is in the same bucket as a 500: the account's failure
 * streak moves, the circuit counts it, and the router tries the next hop. R19 is
 * explicit, and the reason is that an empty result and a working scrape are
 * indistinguishable from the outside — a page whose selectors stopped matching
 * returns exactly what a page with no listings returns.
 *
 * THE SUB-REQUEST BUDGET IS PER INVOCATION, NOT PER HOP. Workers cap outbound
 * calls, and the plan's number is 40 with a deliberate margin below the platform
 * limit. When a hop would cross it the job is put back with `run_after = now` —
 * it is not failed, it is not counted, and the next tick picks it up at the front
 * of the same queue. Losing a hop to a budget check would be the worst possible
 * bug, so the check happens before anything is claimed or logged.
 */

import { buildCandidates } from '../router/candidates';
import { applyTier0, budgetPressure, loadWeights, rankCandidates, successStats } from '../router/score';
import { bumpAccountFailure, claimAccount, closeAttempt, openAttempt, setAccountState } from '../router/claim';
import { recordAttemptFailure, recordAttemptSuccess } from '../router/circuit';
import { dispatchAdapter } from '../adapters';
import { complete, fail } from '../lib/queue';
import { openSecret } from '../lib/crypto';
import { CRONS, runScheduled } from '../jobs/scheduled';
import type { Env } from '../env';
import type { CredentialRef } from '../adapters/shared';
import type { AdapterOutcome, ScoredCandidate } from '../router/types';
import { emptyOutcome } from '../router/types';

/** Three hops, maximum, without exception (09 §8). */
const MAX_HOPS = 3;

/** Outbound calls allowed per Worker invocation (R15). */
const SUB_REQUEST_BUDGET = 40;

/** Reserve held back so the bookkeeping that closes an attempt can always run. */
const BOOKKEEPING_RESERVE = 6;

export interface RouteInput {
  job_id: string;
  target_type: string;
  runner: string;
  source_id?: string | null;
  payload?: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
}

export interface RouteResult {
  job_id: string;
  status: 'done' | 'pending' | 'needs_manual';
  hops: number;
  note: string;
}

export class RouterDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/route' && request.method === 'POST') {
      const input = (await request.json()) as RouteInput;
      const result = await this.route(input);
      // The alarm is set only when there is work to come back to (R17). An alarm
      // on an empty queue burns an invocation to discover nothing.
      await this.maybeArmAlarm();
      return Response.json(result);
    }

    if (url.pathname === '/health') {
      const alarm = await this.state.storage.getAlarm();
      return Response.json({ ok: true, key: this.state.id.toString(), alarm });
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * The alarm exists so a queue that still has work is looked at again even if a
   * tick were missed. It never sets itself while the queue is empty, which is the
   * only thing standing between this and an invocation every two minutes forever.
   */
  async alarm(): Promise<void> {
    const pending = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_queue
        WHERE status = 'pending' AND (run_after IS NULL OR run_after <= unixepoch())`,
    ).first<{ n: number }>();

    if ((pending?.n ?? 0) > 0) {
      // Reuses the same dispatcher the cron calls. The claim is atomic, so a
      // tick that overlaps this one cannot double-claim; it can only find less
      // work, which is the correct outcome.
      await runScheduled(CRONS.dispatcher, this.env);
    }
  }

  private async maybeArmAlarm(): Promise<void> {
    const pending = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_queue WHERE status = 'pending'`,
    ).first<{ n: number }>();

    if ((pending?.n ?? 0) === 0) {
      // Explicitly clear: leaving a stale alarm set would fire into an empty
      // queue, which is the wasted invocation R17 is about.
      await this.state.storage.deleteAlarm();
      return;
    }

    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + 120_000);
    }
  }

  // ----------------------------------------------------------------- routing --

  async route(input: RouteInput): Promise<RouteResult> {
    const db = this.env.DB;
    const runner = input.runner || 'worker';
    const now = Math.floor(Date.now() / 1000);

    let budget = SUB_REQUEST_BUDGET - BOOKKEEPING_RESERVE;

    const build = await buildCandidates(
      db,
      { job_id: input.job_id, target_type: input.target_type, runner, source_id: input.source_id ?? null },
      now,
    );

    // [1]/[2]/[3] — nothing survived the filters.
    if (build.candidates.length === 0) {
      const reasons = Object.keys(build.rejected).filter((key) => key !== 'no_target_type');

      // A circuit being open is TEMPORARY and is not the job's fault, so the job
      // is put back rather than parked — at the moment the circuit closes, not in
      // sixty seconds, so it does not spin while waiting.
      //
      // The trigger is "at least one candidate was removed by an open circuit",
      // not "circuit_open was the only reason". Requiring it to be the only
      // reason looked tidy and was wrong: a target whose other candidate is
      // dropped for a permanent reason — `app_listing` loses `gha_runner` to a
      // runner mismatch, `email_verify_l3` loses `zerobounce` to a missing
      // credential — would then never reach this branch even though the circuit
      // was the whole reason nothing could run. The job got parked, and the
      // parked job stayed parked after the circuit closed, which is the one
      // outcome a transient condition must not produce.
      //
      // Other reasons are still reported in the note. A job that is waiting on a
      // circuit and also has no credential is a job the operator should hear
      // about before the circuit closes, not after it fails again.
      if ((build.rejected.circuit_open ?? 0) > 0) {
        const reopenAt = await this.earliestReopen(now);
        await this.requeue(input.job_id, reopenAt);
        const others = Object.entries(build.rejected)
          .filter(([key]) => key !== 'circuit_open')
          .map(([key, n]) => `${key}=${n}`)
          .join(', ');
        return {
          job_id: input.job_id,
          status: 'pending',
          hops: 0,
          note: `candidates unavailable: circuit_open=${build.rejected.circuit_open ?? 0}${others ? `; also ${others}` : ''} — re-queued for ${reopenAt}`,
        };
      }

      // Every other empty list is a fact about the target, not a transient
      // condition: a Class C or Class X target will still be Class C tomorrow.
      // The reason names the FILTER, not just "nothing found". An operator who
      // reads `class_c=1` knows to go and look at the source; an operator who
      // reads `no_capability` has nowhere to go.
      const reason = reasons.length > 0
        ? Object.entries(build.rejected).map(([key, n]) => `${key}=${n}`).join(', ')
        : 'no enabled capability row for this target_type at all';
      await fail(
        db,
        { id: input.job_id, attempts: input.attempts, max_attempts: input.max_attempts },
        `no candidate for target_type=${input.target_type} runner=${runner} — ${reason}`,
        'permanent',
      );
      return {
        job_id: input.job_id,
        status: 'needs_manual',
        hops: 0,
        note: `no candidate — ${reason}`,
      };
    }

    // [4]/[5]
    const [weights, stats, pressure] = await Promise.all([
      loadWeights(db),
      successStats(db, now),
      budgetPressure(db),
    ]);

    const { ranked, note: scoreNote } = rankCandidates(build.candidates, weights, stats, pressure);
    const { chain, note: gateNote } = applyTier0(ranked, MAX_HOPS);

    if (chain.length === 0) {
      await fail(
        db,
        { id: input.job_id, attempts: input.attempts, max_attempts: input.max_attempts },
        `R20: no credential-free candidate for ${input.target_type} — refusing to open a paid chain`,
        'permanent',
      );
      return { job_id: input.job_id, status: 'needs_manual', hops: 0, note: gateNote.join('; ') || 'R20' };
    }

    const notes = [...scoreNote, ...gateNote];
    let hops = 0;

    for (const candidate of chain) {
      // A hop is only spent when an adapter actually runs. Checking here, before
      // the claim and before the attempt row, means a budget stop costs nothing.
      if (budget <= 2) {
        await this.requeue(input.job_id, now);
        return {
          job_id: input.job_id,
          status: 'pending',
          hops,
          note: `sub-request budget exhausted after ${hops} hop(s); re-queued`,
        };
      }

      hops += 1;
      // The hop is stamped on the job as it is committed to, not on the way out.
      // `job_queue.hop_count` is the durable answer to "how many providers has
      // this job already burned", and a value only written at the end would let
      // a job that died mid-hop come back with a full budget of three and try
      // the same three providers again.
      await this.recordHop(input.job_id, hops);

      const outcome = await this.runHop(input, candidate, hops, () => {
        budget -= 1;
      });

      notes.push(
        `hop${hops} ${candidate.provider} → ${outcome.outcome}${outcome.error_code ? ` (${outcome.error_code})` : ''}`,
      );

      if (outcome.outcome === 'success') {
        const resultId = await this.saveResult(input, candidate, outcome, hops);
        await complete(db, input.job_id, resultId);
        return {
          job_id: input.job_id,
          status: 'done',
          hops,
          note: notes.join(' | '),
        };
      }
    }

    // [9]/§9 — the chain is spent. The job goes to a human rather than to another
    // automatic attempt, because three providers failing is not a retry problem.
    const hopLines = notes.filter((line) => line.startsWith('hop'));
    await fail(
      db,
      { id: input.job_id, attempts: input.attempts, max_attempts: input.max_attempts },
      `all ${hops} hop(s) failed: ${hopLines.join('; ') || 'none dispatched'}`,
      'permanent',
    );
    return { job_id: input.job_id, status: 'needs_manual', hops, note: notes.join(' | ') };
  }

  /** [6]/[7]/[8]/[9] for one hop. */
  private async runHop(
    input: RouteInput,
    candidate: ScoredCandidate,
    hop: number,
    spend: () => void,
  ): Promise<AdapterOutcome> {
    const db = this.env.DB;
    const now = Math.floor(Date.now() / 1000);
    const sourceId = candidate.source?.source_id ?? null;

    // [6] Claim. A credential-free capability has no account to claim, and that
    // is not a failure — it is the entire point of R10.
    let accountLabel: string | null = null;
    let accountId: string | null = null;

    if (candidate.requires_credential === 1) {
      const account = await claimAccount(db, candidate.provider, now);
      if (!account) {
        // Nothing was called, so nothing is logged and no hop is really spent —
        // but the caller already incremented the hop counter. The attempt row
        // below records `E_NO_ACCOUNT` so the missing hop is visible rather than
        // an unexplained gap in the sequence.
        const attemptId = await openAttempt(db, {
          job_id: input.job_id,
          hop,
          target_type: candidate.target_type,
          provider: candidate.provider,
          account_label: null,
          adapter: candidate.adapter,
          source_id: sourceId,
          pack_version: candidate.source?.pack_version ?? null,
          circuit_scope: `prov:${candidate.provider}`,
          score: candidate.score,
          note: 'no claimable account',
        });
        await closeAttempt(db, attemptId, {
          outcome: 'error',
          http_status: null,
          records_count: 0,
          unit_type: null,
          units: 0,
          cost_micro: 0,
          latency_ms: 0,
          error_text: 'no claimable account — skipped without a call',
        });
        return emptyOutcome({
          provider: candidate.provider,
          account_label: 'unclaimed',
          outcome: 'error',
          error_code: 'E_NO_ACCOUNT',
        });
      }
      accountId = account.id;
      accountLabel = account.account_label;
    }

    // [9] The attempt row is opened BEFORE the call, so a crash leaves evidence.
    const attemptId = await openAttempt(db, {
      job_id: input.job_id,
      hop,
      target_type: candidate.target_type,
      provider: candidate.provider,
      account_label: accountLabel,
      adapter: candidate.adapter,
      source_id: sourceId,
      pack_version: candidate.source?.pack_version ?? null,
      circuit_scope: candidate.requires_credential === 1 ? `prov:${candidate.provider}:${candidate.target_type}` : null,
      score: candidate.score,
      note: null,
    });

    // The Vault is opened here, inside the call frame, and nowhere earlier: no
    // plaintext key ever reaches a payload, a log line or D1 (R1, R2).
    const credentialRef: CredentialRef | null =
      accountId && accountLabel
        ? { credential_id: accountId, provider: candidate.provider, account_label: accountLabel }
        : null;

    const resolveCredential = async (): Promise<string | null> => {
      if (!accountId) return null;
      const row = await db
        .prepare(
          `SELECT ciphertext, iv, auth_tag FROM provider_credentials
            WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(accountId)
        .first<{ ciphertext: string; iv: string; auth_tag: string }>();
      if (!row) return null;
      try {
        return await openSecret(row, this.env.VAULT_KEY);
      } catch {
        // An unopenable row means VAULT_KEY changed. Returning null produces a
        // named credential error instead of a 500 that hides the real cause.
        return null;
      }
    };

    spend();
    const outcome = await dispatchAdapter({
      job_id: input.job_id,
      target_type: candidate.target_type,
      adapter: candidate.adapter,
      hop,
      provider: candidate.provider,
      account_label: accountLabel,
      credential_ref: credentialRef,
      resolveCredential,
      source: candidate.source,
      input: {
        ...(input.payload ?? {}),
        ...(input.source_id ? { source_id: input.source_id } : {}),
      },
      budget: {
        // A single hop never gets the whole budget: the chain needs room for its
        // remaining hops and for the bookkeeping that closes each one.
        remaining_subrequests: 8,
        deadline_ms: 20_000,
      },
    });

    // A 401/403 on a capability that carried NO credential is not a credential
    // problem, and this distinction is worth a branch of its own.
    //
    // `sec_edgar` reads its data with no key at all, and the SEC answers 403 to
    // a client whose User-Agent it does not recognise. The adapter cannot tell
    // that apart from a rejected key — it only sees the status code — but the
    // router can, because the router is the layer that decided whether to attach
    // a credential. Left as `E_CREDENTIAL_INVALID`, the console would send the
    // operator off to find a key for a provider that does not have one, and the
    // real fix (a User-Agent the provider accepts) would stay invisible.
    if (!credentialRef && (outcome.http_status === 401 || outcome.http_status === 403)) {
      outcome.error_code = 'E_PROVIDER_REFUSED';
      outcome.outcome = 'error';
    }

    await closeAttempt(db, attemptId, {
      outcome: outcome.outcome,
      http_status: outcome.http_status,
      records_count: outcome.records_count,
      unit_type: outcome.unit_type,
      units: outcome.units,
      cost_micro: outcome.cost_micro,
      latency_ms: outcome.latency_ms,
      error_text: outcome.error_code,
    });

    await this.applyOutcome(candidate, accountId, outcome, now);
    return outcome;
  }

  /**
   * The 09 §7 table, transcribed.
   *
   * The distinctions that earn their keep:
   *   - 401/403 DISABLES the account. The key is wrong and retrying it spends
   *     quota to be told so again.
   *   - 429 cools the account for an hour but leaves it enabled; the key is fine.
   *   - quota exhaustion marks the account `exhausted`, which the rollover job
   *     reverses by itself when the window turns.
   *   - `empty` counts as a failure (R19), so it moves the streak and the circuit.
   */
  private async applyOutcome(
    candidate: ScoredCandidate,
    accountId: string | null,
    outcome: AdapterOutcome,
    now: number,
  ): Promise<void> {
    const db = this.env.DB;
    const scopeInput = {
      provider: candidate.provider,
      target_type: candidate.target_type,
      source_id: candidate.source?.source_id ?? null,
    };

    if (outcome.outcome === 'success') {
      await recordAttemptSuccess(db, scopeInput);
      if (accountId) {
        await setAccountState(db, accountId, { status: 'active', cooldownUntil: null, resetFailureStreak: true });
      }
      return;
    }

    const code = outcome.error_code ?? '';
    const status = outcome.http_status ?? 0;

    if (status === 401 || status === 403 || code === 'E_CREDENTIAL_INVALID') {
      // Only a capability that actually used a credential can have a bad one.
      // A refusal on a keyless capability is a policy or User-Agent problem, and
      // it belongs in the same bucket as a 5xx: the provider is refusing us and
      // the account is not at fault.
      if (candidate.requires_credential === 1) {
        if (accountId) {
          await setAccountState(db, accountId, { status: 'invalid', enabled: 0, quotaUsedBack: true });
        }
        await this.alert(
          `credential refused by ${candidate.provider} for ${candidate.target_type} (HTTP ${status || 'n/a'})`,
        );
        return;
      }
      await recordAttemptFailure(db, scopeInput);
      return;
    }

    if (status === 429 || code === 'E_RATE_LIMITED' || code === 'E_ZONE_MISSING') {
      // `E_ZONE_MISSING` is grouped here on purpose. The account is not broken —
      // it is not finished. It comes back the moment a zone exists, so it must
      // not be disabled, which is what a 401 would have done.
      if (accountId) {
        await setAccountState(db, accountId, {
          status: 'rate_limited',
          cooldownUntil: now + 3600,
          quotaUsedBack: true,
        });
      }
      await recordAttemptFailure(db, scopeInput);
      return;
    }

    if (code === 'E_QUOTA_EXHAUSTED') {
      if (accountId) {
        await setAccountState(db, accountId, { status: 'exhausted', quotaUsedBack: true });
      }
      await recordAttemptFailure(db, scopeInput);
      return;
    }

    if (outcome.outcome === 'blocked') {
      // Adaptive pacing (R24): no fixed cap, back off on the signal. The circuit
      // carries the back-off, so a blocked source is retried less often without a
      // throughput number anyone would have to guess.
      if (accountId) {
        const streak = await bumpAccountFailure(db, accountId);
        await setAccountState(db, accountId, { cooldownUntil: now + Math.min(3600, 60 * 2 ** streak) });
      }
      await recordAttemptFailure(db, scopeInput);
      return;
    }

    // Everything else — empty, timeout, 5xx, transport — is a failure the account
    // survives. R19 puts `empty` here deliberately.
    if (accountId) await bumpAccountFailure(db, accountId);
    await recordAttemptFailure(db, scopeInput);
  }

  private async alert(message: string): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT INTO error_log (id, code, scope, message, severity, created_at)
         VALUES (?, 'E_CREDENTIAL_INVALID', 'router', ?, 'error', unixepoch())`,
      )
        .bind(crypto.randomUUID(), message.slice(0, 500))
        .run();
    } catch {
      // An alert that fails must not fail the routing decision that raised it.
    }
  }

  private async saveResult(
    input: RouteInput,
    candidate: ScoredCandidate,
    outcome: AdapterOutcome,
    hop: number,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO job_results
         (id, job_id, provider, account_label, records_count, raw_ref_r2, normalized_json, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    )
      .bind(
        id,
        input.job_id,
        candidate.provider,
        outcome.account_label,
        outcome.records_count,
        outcome.raw_ref_r2,
        JSON.stringify({ hop, records: outcome.records, cursor: outcome.cursor }),
        outcome.latency_ms,
      )
      .run();
    return id;
  }

  /** Stamps the hop count the moment a hop is committed to. */
  private async recordHop(jobId: string, hops: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE job_queue SET hop_count = ?, updated_at = unixepoch() WHERE id = ?`,
    )
      .bind(hops, jobId)
      .run();
  }

  private async requeue(jobId: string, runAfter: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE job_queue
          SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
              run_after = ?, updated_at = unixepoch()
        WHERE id = ?`,
    )
      .bind(runAfter, jobId)
      .run();
  }

  /** When the first open circuit closes, so a re-queued job waits the right time. */
  private async earliestReopen(now: number): Promise<number> {
    const row = await this.env.DB.prepare(
      `SELECT MIN(opened_at + reopen_after) AS reopen_at
         FROM circuit_state
        WHERE state = 'open' AND opened_at IS NOT NULL AND opened_at + reopen_after > ?`,
    )
      .bind(now)
      .first<{ reopen_at: number | null }>();
    // A minute's grace past the close, so the job does not arrive in the same
    // second the circuit closes and race the lazy close in `isCircuitOpen`.
    return (row?.reopen_at ?? now + 900) + 60;
  }
}
