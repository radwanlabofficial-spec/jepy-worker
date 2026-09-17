/**
 * `api_json` — a JSON REST endpoint, with the field mapping supplied as config.
 *
 * Used by SEC EDGAR, MapQuest, the Meta Ad Library, PageSpeed Insights, Yelp and
 * the Overture/Foursquare bulk path. There is nothing in this file that knows
 * what any of those are: the URL comes from `source.url_template` (or from the
 * job's own `url`), the record location from `selector.records_path`, and the
 * fields from `selector.path_map`. Adding a seventh JSON source is a config row,
 * not a new file.
 *
 * `path_map` is `{ output_field: "dotted.path.in.body" }`. An entry whose path
 * finds nothing is omitted from the record rather than written as `null`: the
 * normalizer must be able to tell "the site does not publish this" from "the site
 * published an empty value", and a null erases that distinction.
 */

import type { Adapter } from './shared';
import {
  buildOutcome,
  classifyHttp,
  fetchWithDeadline,
  fillTemplate,
  looksBlocked,
  readPath,
  readSelectorPack,
} from './shared';
import type { AdapterOutcome } from '../router/types';

function asRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

export const apiJsonAdapter: Adapter = {
  name: 'api_json',

  async run(invocation): Promise<AdapterOutcome> {
    const started = Date.now();
    const selector = readSelectorPack(invocation.source?.selector_json ?? null);

    const template =
      (typeof invocation.input.url === 'string' ? invocation.input.url : null) ??
      invocation.source?.url_template ??
      invocation.source?.base_url;

    if (!template) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_CONFIG_MISSING',
        latency_ms: Date.now() - started,
      });
    }

    const url = fillTemplate(template, {
      ...invocation.input,
      cursor: invocation.input.cursor ?? '',
    });

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'jepy-leads/1.0 (contact: operator)',
    };

    // Only reach for the Vault when the call actually needs a key.
    let credential: string | null = null;
    if (invocation.credential_ref) {
      credential = await invocation.resolveCredential();
      if (!credential) {
        return buildOutcome(invocation, {
          outcome: 'error',
          error_code: 'E_CREDENTIAL_MISSING',
          latency_ms: Date.now() - started,
        });
      }
    }

    // Where a key goes is provider-specific, so it comes from config too. The
    // header name is not a secret and does not belong in code.
    const keyHeader = typeof invocation.input.auth_header === 'string'
      ? invocation.input.auth_header
      : typeof invocation.input.auth_query === 'string'
        ? null
        : 'Authorization';
    let finalUrl = url;
    if (credential && keyHeader) {
      headers[keyHeader] =
        keyHeader.toLowerCase() === 'authorization' && !/^(basic|bearer) /i.test(credential)
          ? `Bearer ${credential}`
          : credential;
    } else if (credential && typeof invocation.input.auth_query === 'string') {
      const withKey = new URL(url);
      withKey.searchParams.set(invocation.input.auth_query, credential);
      finalUrl = withKey.toString();
    }

    try {
      const response = await fetchWithDeadline(
        finalUrl,
        { method: typeof invocation.input.method === 'string' ? invocation.input.method : 'GET', headers },
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
          unit_type: invocation.credential_ref ? (invocation.source?.source_key ? 'request' : 'request') : null,
        });
      }

      if (looksBlocked(body)) {
        return buildOutcome(invocation, {
          outcome: 'blocked',
          error_code: 'E_BLOCKED_CAPTCHA',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        // A 200 that is not JSON is an empty read, not a success (R19).
        return buildOutcome(invocation, {
          outcome: 'empty',
          error_code: 'E_PARSE_FAILED',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
        });
      }

      const located = selector?.records_path ? readPath(parsed, selector.records_path) : parsed;
      const raw = asRecords(located);

      // An explicit `records_path` that found nothing is a hard empty: the
      // document is JSON, the path is configured, and the path produced no list.
      if (selector?.records_path && raw.length === 0) {
        return buildOutcome(invocation, {
          outcome: 'empty',
          error_code: 'E_EMPTY_RESULT',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
        });
      }

      let records: unknown[] = raw;
      if (selector?.path_map) {
        records = raw.map((row) => {
          const mapped: Record<string, unknown> = {};
          for (const [field, path] of Object.entries(selector.path_map!)) {
            const value = readPath(row, path);
            if (value !== undefined) mapped[field] = value;
          }
          return mapped;
        });
      }

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
      });
    }
  },
};
