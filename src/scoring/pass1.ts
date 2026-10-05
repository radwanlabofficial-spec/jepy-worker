/**
 * Pass 1 — gated AI scoring.
 *
 * The provider endpoint is deliberately configuration, not code. Manifest account
 * credentials are stored in the Vault as JSON containing an OpenAI-compatible
 * `endpoint`, `api_key`, and optional `model`; this module never knows or invents
 * a vendor URL. The endpoint must be the complete chat-completions URL.
 *
 * The gate remains deterministic and server-side. This file owns the P3 v2 input
 * and output contract, expiry filtering, exact-batch validation, and the pure
 * candidate-selection rules. Database writes live in `run.ts` and the route.
 */

import { z } from 'zod';

export const PASS1_PROMPT_VERSION = '2';
export const PASS1_BATCH_SIZE = 10;
export const PASS1_TIMEOUT_MS = 120_000;
export const AI_DEFAULT_DAILY_CAP = 200;
export const AI_DEDUPE_SECONDS = 86_400;

const WORD_LIMITS = { reason: 20, angle: 15 } as const;

export const AiScoreOutputSchema = z
  .object({
    id: z.string().min(1),
    ai_score: z.number().int().min(0).max(100),
    reason: z.string().min(1).refine((value) => wordCount(value) <= WORD_LIMITS.reason, 'reason exceeds 20 words'),
    angle: z.string().min(1).refine((value) => wordCount(value) <= WORD_LIMITS.angle, 'angle exceeds 15 words'),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export type AiScoreOutput = z.infer<typeof AiScoreOutputSchema>;

export interface AiLeadInput {
  id: string;
  name: string;
  city: string | null;
  niche: string | null;
  website_url: string | null;
  employee_estimate: number | null;
  geo_priority: number | null;
  source_confidence: number | null;
  signals: {
    psi_mobile: number | null;
    last_change_years: number | null;
    ssl_ok: boolean | null;
    tech_stack: string | null;
    robots_sitemap_ok: boolean | null;
    has_email: boolean | null;
    has_phone: boolean | null;
    mx_type: string | null;
    site_meta_ok: boolean | null;
    hiring_active: boolean | null;
    ads_active: boolean | null;
    funding_recent: boolean | null;
    domain_age_years: number | null;
    review_trend: 'up' | 'flat' | 'down' | null;
  };
}

export interface Pass1GateRow {
  id: string;
  rule_score: number | null;
  is_provisional: number;
  deleted_at: number | null;
  ai_scored_at: number | null;
}

export interface Pass1GateDecision {
  id: string;
  passed: boolean;
  reason: 'threshold' | 'top_20_percent' | 'provisional' | 'deleted' | 'ai_cooldown' | 'below_gate';
}

export interface ManifestCredential {
  endpoint: string;
  api_key: string;
  model: string | null;
}

export interface ManifestCallResult {
  outputs: AiScoreOutput[];
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micro: number | null;
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

/**
 * Selects the eligible leads before batching. Top-20% is calculated against all
 * gradeable, non-deleted, non-cooldown rows supplied by the caller, not against a
 * caller's arbitrary page, so pagination cannot change who gets the fallback gate.
 */
export function selectPass1Candidates(
  rows: Pass1GateRow[],
  threshold: number,
  dailyRemaining: number,
  now: number,
): { candidates: Pass1GateRow[]; decisions: Pass1GateDecision[] } {
  const decisions: Pass1GateDecision[] = [];
  const eligible: Pass1GateRow[] = [];

  for (const row of rows) {
    if (row.deleted_at !== null) {
      decisions.push({ id: row.id, passed: false, reason: 'deleted' });
      continue;
    }
    if (row.is_provisional === 1) {
      decisions.push({ id: row.id, passed: false, reason: 'provisional' });
      continue;
    }
    if (row.ai_scored_at !== null && row.ai_scored_at > now - AI_DEDUPE_SECONDS) {
      decisions.push({ id: row.id, passed: false, reason: 'ai_cooldown' });
      continue;
    }
    if (row.rule_score === null) {
      decisions.push({ id: row.id, passed: false, reason: 'below_gate' });
      continue;
    }
    eligible.push(row);
  }

  const ranked = [...eligible].sort(
    (a, b) => (b.rule_score ?? -1) - (a.rule_score ?? -1) || a.id.localeCompare(b.id),
  );
  const topCount = Math.max(1, Math.ceil(ranked.length * 0.2));
  const topIds = new Set(ranked.slice(0, topCount).map((row) => row.id));

  for (const row of eligible) {
    const thresholdPass = (row.rule_score ?? -1) >= threshold;
    const topPass = topIds.has(row.id);
    if (thresholdPass || topPass) {
      decisions.push({ id: row.id, passed: true, reason: thresholdPass ? 'threshold' : 'top_20_percent' });
    } else {
      decisions.push({ id: row.id, passed: false, reason: 'below_gate' });
    }
  }

  const chosen = eligible
    .filter((row) => (row.rule_score ?? -1) >= threshold || topIds.has(row.id))
    .sort((a, b) => (b.rule_score ?? -1) - (a.rule_score ?? -1) || a.id.localeCompare(b.id));

  // A request consumes one cap unit and must carry exactly ten leads. Never make a
  // short request: the prompt contract says exact batches and a partial batch would
  // make retries and cost accounting ambiguous.
  const maxLeads = Math.floor(Math.max(0, dailyRemaining)) * PASS1_BATCH_SIZE;
  return { candidates: chosen.slice(0, maxLeads), decisions };
}

const SYSTEM_PROMPT =
  'You are a B2B lead qualification analyst for a digital services agency. ' +
  'You score businesses on how likely they are to buy website, SEO, or digital marketing services in the next 90 days. ' +
  'You are conservative: a high score must be justified by concrete signals, not by optimism. ' +
  'You respond only with valid JSON matching the requested schema, with no commentary before or after.';

function buildUserPrompt(inputs: AiLeadInput[]): string {
  return [
    'For each lead return: id, ai_score (integer 0-100), reason (one sentence, max 20 words), angle (max 15 words), confidence (low/medium/high).',
    'Score higher when the business clearly has money to spend AND has a visible digital weakness.',
    'Score lower when there is no website, no contact path, or no evidence of spending.',
    'Treat null as unknown, never as zero or as a negative. Return exactly one object per input lead, in the same order.',
    JSON.stringify(inputs),
  ].join('\n');
}

function parseContent(body: unknown): string {
  if (!body || typeof body !== 'object') throw new Error('provider response is not an object');
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('provider response has no choices');
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as { message?: unknown }).message : null;
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : null;
  if (typeof content !== 'string' || content.trim() === '') throw new Error('provider response has no text content');
  return content;
}

function parseUsage(body: unknown): { tokens_in: number | null; tokens_out: number | null; cost_micro: number | null } {
  if (!body || typeof body !== 'object') return { tokens_in: null, tokens_out: null, cost_micro: null };
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return { tokens_in: null, tokens_out: null, cost_micro: null };
  const value = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; cost_micro?: unknown };
  return {
    tokens_in: typeof value.prompt_tokens === 'number' ? Math.max(0, Math.trunc(value.prompt_tokens)) : null,
    tokens_out: typeof value.completion_tokens === 'number' ? Math.max(0, Math.trunc(value.completion_tokens)) : null,
    // The provider may report this, but we never estimate a price from undocumented
    // model pricing. NULL means the provider did not return a cost.
    cost_micro: typeof value.cost_micro === 'number' ? Math.max(0, Math.trunc(value.cost_micro)) : null,
  };
}

export function parseAiBatch(raw: string, expectedIds: string[]): AiScoreOutput[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('AI output is not valid JSON');
  }
  if (!Array.isArray(value) || value.length !== expectedIds.length) {
    throw new Error(`AI output must contain exactly ${expectedIds.length} objects`);
  }
  const parsed = z.array(AiScoreOutputSchema).length(expectedIds.length).parse(value);
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index]?.id !== expectedIds[index]) throw new Error('AI output order or ids do not match input');
  }
  return parsed;
}

/** Calls the configured complete endpoint. The caller owns retry and logging. */
export async function callManifestBatch(
  credential: ManifestCredential,
  inputs: AiLeadInput[],
  timeoutMs = PASS1_TIMEOUT_MS,
): Promise<ManifestCallResult> {
  if (inputs.length !== PASS1_BATCH_SIZE) throw new Error('Pass 1 requests must contain exactly 10 leads');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(credential.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.api_key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'jepy-worker/1.0',
      },
      body: JSON.stringify({
        model: credential.model ?? undefined,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(inputs) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`manifest endpoint returned HTTP ${response.status}`);
    const body = (await response.json()) as unknown;
    const usage = parseUsage(body);
    const outputs = parseAiBatch(parseContent(body), inputs.map((input) => input.id));
    return { outputs, ...usage };
  } finally {
    clearTimeout(timer);
  }
}

/** Parses the Vault value without ever including the secret in an error. */
export function parseManifestCredential(secret: string): ManifestCredential | null {
  try {
    const raw = JSON.parse(secret) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const object = raw as Record<string, unknown>;
    const endpoint = typeof object.endpoint === 'string' ? object.endpoint : typeof object.base_url === 'string' ? object.base_url : null;
    const apiKey = typeof object.api_key === 'string' ? object.api_key : typeof object.key === 'string' ? object.key : null;
    const model = typeof object.model === 'string' ? object.model : null;
    if (!endpoint || !apiKey) return null;
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) return null;
    return { endpoint, api_key: apiKey, model };
  } catch {
    return null;
  }
}

export function buildAiLeadInput(input: {
  id: string;
  name: string;
  city: string | null;
  niche: string | null;
  website_url: string | null;
  employee_estimate: number | null;
  geo_priority: number | null;
  source_confidence: number | null;
  phone_e164: string | null;
  signals: Array<{ signal_key: string; signal_value_num: number | null; signal_value_text: string | null; expires_at: number | null }>;
  now: number;
}): AiLeadInput {
  const active = new Map<string, { signal_value_num: number | null; signal_value_text: string | null }>();
  for (const signal of input.signals) {
    if (signal.expires_at !== null && signal.expires_at <= input.now) continue;
    // Yelp-derived keys are never eligible prompt input, even if a future caller
    // accidentally includes them in the query.
    if (signal.signal_key.toLowerCase().includes('yelp')) continue;
    active.set(signal.signal_key, signal);
  }
  const get = (key: string) => active.get(key);
  const boolSignal = (key: string, positive: string[] = []) => {
    const row = get(key);
    if (!row) return null;
    const text = (row.signal_value_text ?? '').toLowerCase();
    if (text === 'none' || text === 'absent' || text === 'false' || text === 'no') return false;
    if (positive.length > 0) return positive.some((value) => text.includes(value));
    return row.signal_value_num === null ? true : row.signal_value_num > 0;
  };
  const text = (key: string) => get(key)?.signal_value_text ?? null;
  const num = (key: string) => get(key)?.signal_value_num ?? null;
  const lastChangeDays = num('wayback_last_change');
  const domainAgeDays = num('new_domain_reg');

  return {
    id: input.id,
    name: input.name,
    city: input.city,
    niche: input.niche,
    website_url: input.website_url,
    employee_estimate: input.employee_estimate,
    geo_priority: input.geo_priority,
    source_confidence: input.source_confidence,
    signals: {
      psi_mobile: num('psi_mobile'),
      last_change_years: lastChangeDays === null ? null : Math.round((lastChangeDays / 365) * 100) / 100,
      ssl_ok: boolSignal('ssl_cert', ['ok', 'valid', 'healthy']),
      tech_stack: text('tech_stack'),
      robots_sitemap_ok: boolSignal('robots_sitemap', ['sitemap']),
      has_email: boolSignal('email', ['valid', 'syntax_ok']),
      has_phone: input.phone_e164 !== null && input.phone_e164.startsWith('+') ? true : input.phone_e164 === null ? null : false,
      mx_type: text('dns_mx'),
      site_meta_ok: boolSignal('website_meta', ['contact_found']),
      hiring_active: boolSignal('job_postings_ats', ['active']),
      ads_active: boolSignal('meta_ad_library', ['active']),
      funding_recent: boolSignal('funding_news', ['recent', 'active']),
      domain_age_years: domainAgeDays === null ? null : Math.round((domainAgeDays / 365) * 100) / 100,
      review_trend: (text('review_velocity') as 'up' | 'flat' | 'down' | null) ?? null,
    },
  };
}
