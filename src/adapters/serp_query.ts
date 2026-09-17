/**
 * `serp_query` — a search-engine result page, fetched through a SERP provider.
 *
 * Endpoint and payload shape were confirmed against the live API rather than
 * guessed (BrightData docs, SERP API → direct API access):
 *
 *   POST https://api.brightdata.com/request
 *   { "zone": "<serp zone>", "url": "<full SERP url>", "format": "raw" }
 *
 * THE ZONE IS NOT INVENTED HERE. A BrightData zone is per account and is created
 * in their dashboard; nothing in our schema holds one yet, and the account that
 * has to have it is the STEP 0 calibration account. So the zone is read from the
 * job input, and when it is missing this adapter returns `E_ZONE_MISSING` instead
 * of calling with an empty zone. That choice is deliberate: calling with no zone
 * is exactly the failure the calibration account is in right now — `/status`
 * answers `can_make_requests: false, auth_fail_reason: zone_not_found` — and a
 * named code means the console can say "create the zone" rather than "the scrape
 * failed", which are two completely different jobs for the operator.
 *
 * Cost is one `request` unit per query. That unit is the one the whole budget
 * rests on: STEP 0 exists to measure how many credits a request actually costs,
 * and until those three numbers exist the per-unit price here is a placeholder
 * taken from the capability row, not a measurement.
 */

import type { Adapter } from './shared';
import {
  buildOutcome,
  classifyHttp,
  fetchWithDeadline,
  looksBlocked,
  readPath,
  readSelectorPack,
} from './shared';
import type { AdapterOutcome } from '../router/types';

const REQUEST_ENDPOINT = 'https://api.brightdata.com/request';

/** Where a BrightData SERP payload puts its organic results. Confirmed from the
 *  documented `brd_json` response shape; recorded as config so a different
 *  provider can point elsewhere without a code change. */
const DEFAULT_ORGANIC_PATH = 'organic';

export const serpQueryAdapter: Adapter = {
  name: 'serp_query',

  async run(invocation): Promise<AdapterOutcome> {
    const started = Date.now();
    const selector = readSelectorPack(invocation.source?.selector_json ?? null);

    const zone =
      (typeof invocation.input.zone === 'string' ? invocation.input.zone : null) ??
      // A directory_sources row for a SERP-backed target carries the zone in its
      // url_template, because that is the only free-text slot the schema gives it.
      invocation.source?.url_template ??
      null;

    if (!zone) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_ZONE_MISSING',
        latency_ms: Date.now() - started,
      });
    }

    const query = typeof invocation.input.query === 'string' ? invocation.input.query : null;
    const explicitUrl = typeof invocation.input.url === 'string' ? invocation.input.url : null;
    if (!query && !explicitUrl) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_CONFIG_MISSING',
        latency_ms: Date.now() - started,
      });
    }

    const engine = typeof invocation.input.engine === 'string' ? invocation.input.engine : 'google';
    const num = typeof invocation.input.num === 'number' ? invocation.input.num : 10;
    const targetUrl = explicitUrl ?? `https://www.${engine}.com/search?q=${encodeURIComponent(query!)}&num=${num}`;

    if (!invocation.credential_ref) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_CREDENTIAL_MISSING',
        latency_ms: Date.now() - started,
      });
    }

    const credential = await invocation.resolveCredential();
    if (!credential) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_CREDENTIAL_MISSING',
        latency_ms: Date.now() - started,
      });
    }

    try {
      const response = await fetchWithDeadline(
        REQUEST_ENDPOINT,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
            'User-Agent': 'jepy-worker/1.0',
          },
          body: JSON.stringify({ zone, url: targetUrl, format: 'raw' }),
        },
        invocation.budget.deadline_ms,
      );
      const body = await response.text();
      const latency = Date.now() - started;

      if (!response.ok) {
        const { outcome, error_code } = classifyHttp(response.status);
        return buildOutcome(invocation, {
          outcome,
          error_code,
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'request',
          // The provider's own words are kept: `zone_not_found` and
          // `zone_suspended` need different reactions and the status code alone
          // cannot tell them apart.
          raw_ref_r2: null,
        });
      }

      if (looksBlocked(body)) {
        return buildOutcome(invocation, {
          outcome: 'blocked',
          error_code: 'E_BLOCKED_CAPTCHA',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'request',
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return buildOutcome(invocation, {
          outcome: 'empty',
          error_code: 'E_PARSE_FAILED',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'request',
        });
      }

      const path = selector?.records_path ?? DEFAULT_ORGANIC_PATH;
      const located = readPath(parsed, path);
      const records = Array.isArray(located) ? located : [];

      return buildOutcome(invocation, {
        records,
        outcome: records.length > 0 ? 'success' : 'empty',
        error_code: records.length > 0 ? null : 'E_EMPTY_RESULT',
        http_status: response.status,
        latency_ms: latency,
        units: 1,
        unit_type: 'request',
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      return buildOutcome(invocation, {
        outcome: name === 'AbortError' ? 'timeout' : 'error',
        error_code: name === 'AbortError' ? 'E_TIMEOUT' : 'E_NETWORK',
        latency_ms: Date.now() - started,
        // A timed-out request may still have been billed. Reporting zero here
        // would be a comfortable lie; reporting one keeps the budget honest and
        // the daily guard slightly conservative, which is the safe direction.
        units: 1,
        unit_type: 'request',
      });
    }
  },
};
