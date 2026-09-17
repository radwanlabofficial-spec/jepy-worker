/**
 * `directory_html` — a Class B directory list page, walked with pagination.
 *
 * The transport comes from `directory_sources` and the site's markup from the
 * active `selector_packs` row; this file contains neither. That separation is the
 * whole point of ADR-032: when a directory changes its markup, the fix is a new
 * pack version approved by a human, not a deploy. A pack that breaks can be
 * rolled back by pointing at the previous version, and `route_attempts.pack_version`
 * is what makes that rollback traceable — without it, "the new pack broke it" and
 * "the site changed" are the same evidence.
 *
 * PAGINATION IS BOUNDED BY BOTH THE PACK AND THE DEADLINE. `max_pages` limits how
 * many pages a single attempt will fetch, and the router's remaining sub-request
 * budget limits it again. Whichever is smaller wins: a pack that claims 50 pages
 * still stops at the budget, and the returned cursor records where it stopped so
 * the next attempt continues instead of starting over.
 *
 * `empty` means "the row selector matched nothing", which R19 treats as failure.
 * It is the single most common scrape failure — the page loaded, the shape
 * changed, and the run looks clean — so it is reported as `E_EMPTY_RESULT` and
 * never as a successful zero-row fetch.
 */

import type { Adapter } from './shared';
import {
  buildOutcome,
  classifyHttp,
  fetchWithDeadline,
  fillTemplate,
  looksBlocked,
  readSelectorPack,
} from './shared';
import { extractRows } from './html-extract';
import type { AdapterOutcome } from '../router/types';

export const directoryHtmlAdapter: Adapter = {
  name: 'directory_html',

  async run(invocation): Promise<AdapterOutcome> {
    const started = Date.now();
    const pack = readSelectorPack(invocation.source?.selector_json ?? null);

    if (!pack?.row) {
      // No active pack is a configuration state, not a site failure. Saying so
      // precisely is what lets the console tell the operator to approve a pack
      // rather than to investigate the site.
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_NO_SELECTOR_PACK',
        latency_ms: Date.now() - started,
      });
    }

    const template = invocation.source?.url_template ?? invocation.source?.base_url;
    if (!template) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_CONFIG_MISSING',
        latency_ms: Date.now() - started,
      });
    }

    const pageParam = invocation.source?.pagination_param ?? 'page';
    const startPage = typeof invocation.input.page === 'number' ? invocation.input.page : 1;
    const declaredMax = invocation.source?.max_pages ?? 1;

    // Never more pages than the attempt can pay for. Each page is one fetch.
    const budgetPages = Math.max(1, Math.floor(invocation.budget.remaining_subrequests / 2));
    const pageLimit = Math.max(1, Math.min(declaredMax, budgetPages));

    const collected: Record<string, unknown>[] = [];
    let failedFields: string[] = [];
    let lastStatus: number | null = null;
    let pagesDone = 0;
    let blocked = false;
    let timedOut = false;

    for (let page = startPage; page < startPage + pageLimit; page += 1) {
      const url = fillTemplate(template, { ...invocation.input, page });

      try {
        const response = await fetchWithDeadline(
          url,
          {
            headers: {
              Accept: 'text/html,application/xhtml+xml',
              'User-Agent': 'jepy-leads/1.0 (contact: operator)',
            },
          },
          invocation.budget.deadline_ms,
        );
        lastStatus = response.status;

        if (!response.ok) {
          const { outcome, error_code } = classifyHttp(response.status);
          // A failure on the first page is the attempt's outcome. A failure on a
          // later page keeps what was already collected: throwing away four good
          // pages because the fifth 500'd would waste the credits already spent.
          if (collected.length === 0) {
            return buildOutcome(invocation, {
              outcome: error_code === 'E_CREDENTIAL_INVALID' ? 'error' : outcome,
              error_code,
              http_status: response.status,
              latency_ms: Date.now() - started,
              units: page - startPage + 1,
              unit_type: invocation.credential_ref ? 'page' : null,
            });
          }
          break;
        }

        const html = await response.text();

        if (looksBlocked(html)) {
          blocked = true;
          break;
        }

        const extracted = await extractRows(html, pack, invocation.source?.base_url ?? url);
        if (extracted.failed_fields.length > 0) failedFields = extracted.failed_fields;

        // A page with no rows ends the walk. Paginating past the last page is how
        // a bounded scrape turns into an unbounded one.
        if (extracted.rows.length === 0) {
          pagesDone += 1;
          break;
        }

        collected.push(...extracted.rows);
        pagesDone += 1;
      } catch (error) {
        const name = error instanceof Error ? error.name : 'UnknownError';
        if (name === 'AbortError') timedOut = true;
        break;
      }
    }

    const latency = Date.now() - started;
    const units = pagesDone;

    if (blocked) {
      return buildOutcome(invocation, {
        records: collected,
        outcome: 'blocked',
        error_code: 'E_BLOCKED_CAPTCHA',
        http_status: lastStatus,
        latency_ms: latency,
        units,
        unit_type: 'page',
      });
    }

    if (timedOut && collected.length === 0) {
      return buildOutcome(invocation, {
        outcome: 'timeout',
        error_code: 'E_TIMEOUT',
        http_status: lastStatus,
        latency_ms: latency,
        units,
        unit_type: 'page',
      });
    }

    const nextCursor = collected.length > 0 ? String(startPage + pagesDone) : null;

    return buildOutcome(invocation, {
      records: collected,
      outcome: collected.length > 0 ? 'success' : 'empty',
      error_code: collected.length > 0
        ? failedFields.length > 0
          ? `E_FIELDS_MISSING:${failedFields.join(',')}`
          : null
        : 'E_EMPTY_RESULT',
      http_status: lastStatus,
      latency_ms: latency,
      units,
      unit_type: 'page',
      cursor: nextCursor,
    });
  },
};
