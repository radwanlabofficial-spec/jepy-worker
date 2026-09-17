/**
 * `profile_page` — one specific profile or business URL, structured extract.
 *
 * The difference from `directory_html` is the unit of work, not the technique:
 * this adapter is given a URL it already knows is interesting and returns one
 * record, where `directory_html` is given a list page and returns many. That
 * difference is why they are separate adapters — a target that needs one business
 * page should not drag in list-page pagination and a `max_pages` it will never
 * use.
 *
 * Two response kinds, both config-driven:
 *   - HTML (Instagram, TikTok, LinkedIn, Shopify storefronts): a `selector_packs`
 *     row with `fields`, exactly as a directory uses.
 *   - JSON (a storefront's `/products.json`, a platform's public API): a
 *     `selector_packs` row with `json_map`.
 *
 * The adapter picks between them by asking what the response actually is, not by
 * asking which site it is. A pack that maps `json_map` against an HTML response
 * gets `E_PARSE_FAILED` and an empty record, which is a config error the console
 * can name — as opposed to a site-specific branch, which would be a rule breach.
 *
 * A record with no fields is `empty`, not `success` (R19). A profile page that
 * loads and yields nothing is the failure this whole adapter exists to detect.
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
import { extractRows } from './html-extract';
import type { AdapterOutcome } from '../router/types';

export const profilePageAdapter: Adapter = {
  name: 'profile_page',

  async run(invocation): Promise<AdapterOutcome> {
    const started = Date.now();
    const pack = readSelectorPack(invocation.source?.selector_json ?? null);

    const target =
      (typeof invocation.input.url === 'string' ? invocation.input.url : null) ??
      invocation.source?.url_template ??
      invocation.source?.base_url;

    if (!target) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_CONFIG_MISSING',
        latency_ms: Date.now() - started,
      });
    }

    const url = fillTemplate(target, invocation.input);

    try {
      const response = await fetchWithDeadline(
        url,
        {
          headers: {
            Accept: 'text/html,application/json;q=0.9',
            'User-Agent': 'jepy-leads/1.0 (contact: operator)',
          },
        },
        invocation.budget.deadline_ms,
      );
      const body = await response.text();
      const latency = Date.now() - started;

      if (!response.ok) {
        const { outcome, error_code } = classifyHttp(response.status);
        return buildOutcome(invocation, {
          outcome: outcome === 'empty' ? 'error' : outcome,
          error_code,
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'page',
        });
      }

      if (looksBlocked(body)) {
        return buildOutcome(invocation, {
          outcome: 'blocked',
          error_code: 'E_BLOCKED_CAPTCHA',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'page',
        });
      }

      const contentType = response.headers.get('content-type') ?? '';
      const looksJson = contentType.includes('json') || /^\s*[[{]/.test(body.slice(0, 200));

      if (looksJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return buildOutcome(invocation, {
            outcome: 'error',
            error_code: 'E_PARSE_FAILED',
            http_status: response.status,
            latency_ms: latency,
            units: 1,
            unit_type: 'page',
          });
        }

        const source = pack?.records_path ? readPath(parsed, pack.records_path) : parsed;
        const first = Array.isArray(source)
          ? (source[0] as Record<string, unknown> | undefined)
          : (source as Record<string, unknown> | null);
        const record = pack?.json_map && first ? mapJson(first, pack.json_map) : first;

        const hasFields = record !== null && record !== undefined && Object.keys(record).length > 0;
        return buildOutcome(invocation, {
          records: hasFields ? [record] : [],
          outcome: hasFields ? 'success' : 'empty',
          error_code: hasFields ? null : 'E_EMPTY_RESULT',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'page',
        });
      }

      if (!pack?.fields || Object.keys(pack.fields).length === 0) {
        return buildOutcome(invocation, {
          outcome: 'error',
          error_code: 'E_NO_SELECTOR_PACK',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'page',
        });
      }

      // Reuse the directory extractor with a single synthetic row: a profile page
      // is a list page with exactly one row, so the selector that names that row
      // is the pack's own `row`, defaulted to `body` when the pack only maps
      // fields. That default is deliberate — `body` always matches, so a
      // fields-only pack works without the author having to invent a wrapper.
      const single = await extractRows(
        body,
        { ...pack, row: pack.row ?? 'body' },
        invocation.source?.base_url ?? url,
      );

      const record = single.rows[0] ?? null;
      const hasFields = record !== null && Object.keys(record).length > 0;

      return buildOutcome(invocation, {
        records: hasFields ? [record] : [],
        outcome: hasFields ? 'success' : 'empty',
        error_code: hasFields
          ? single.failed_fields.length > 0
            ? `E_FIELDS_MISSING:${single.failed_fields.join(',')}`
            : null
          : 'E_EMPTY_RESULT',
        http_status: response.status,
        latency_ms: latency,
        units: 1,
        unit_type: 'page',
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

function mapJson(row: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(map)) {
    const value = readPath(row, path);
    if (value !== undefined) out[field] = value;
  }
  return out;
}
