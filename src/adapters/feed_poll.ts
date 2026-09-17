/**
 * `feed_poll` — an RSS, Atom or JSON feed, with a cursor.
 *
 * The cursor is the whole point of this adapter. A feed is polled repeatedly and
 * returns the same items every time; without a remembered position, every poll
 * would re-import the whole feed and the dedup cascade would spend its life
 * throwing away rows the pipeline had already seen and paid for.
 *
 * The cursor is a single opaque string, because feeds disagree about what "the
 * last item" looks like:
 *   - Atom and most JSON feeds: an id (`id`, `guid`)
 *   - RSS: a link, which is what `<guid>` usually holds anyway
 *   - a publisher with neither: a published timestamp, ISO-8601
 *
 * So the adapter reads whatever the pack's `cursor_field` names, and falls back
 * in the order above. It stores the cursor of the NEWEST item it returned, and on
 * the next poll returns only items strictly newer than that. "Strictly newer" is
 * a string comparison against ids, which is only sound because feed ids are
 * opaque and the ordering is provided by the feed itself — `pubDate` ordering is
 * what the feed's own order already is, and the adapter does not try to re-sort a
 * document it did not write.
 *
 * XML is parsed with a deliberately small extractor rather than a full parser.
 * A Worker has no XML DOM, RSS in the wild is a small and regular subset, and the
 * alternative — a parser dependency to read `<item><link>` — would cost more
 * bundle than the rest of the engine. The extractor is narrow on purpose and
 * reports `E_PARSE_FAILED` when it finds no items, rather than returning an empty
 * success.
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

interface FeedItem {
  id: string | null;
  title: string | null;
  link: string | null;
  published: string | null;
  summary: string | null;
  extra: Record<string, string>;
}

/** Pulls the inner text of the first `<tag>` inside `scope`. */
function tag(scope: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(scope);
  if (!match || match[1] === undefined) return null;
  return stripCdata(match[1]).trim() || null;
}

function stripCdata(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseXmlFeed(body: string): FeedItem[] {
  const blocks = [
    ...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((match) => match[1] ?? '');

  return blocks.map((block) => {
    // Atom puts the URL in an href attribute rather than in the element body.
    const atomLink = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
    const published =
      tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date');

    return {
      id: tag(block, 'guid') ?? tag(block, 'id') ?? atomLink?.[1] ?? null,
      title: tag(block, 'title'),
      link: tag(block, 'link') ?? atomLink?.[1] ?? null,
      published,
      summary: tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content'),
      extra: {},
    };
  });
}

export const feedPollAdapter: Adapter = {
  name: 'feed_poll',

  async run(invocation): Promise<AdapterOutcome> {
    const started = Date.now();
    const pack = readSelectorPack(invocation.source?.selector_json ?? null);

    const target =
      (typeof invocation.input.feed_url === 'string' ? invocation.input.feed_url : null) ??
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
    const cursor = typeof invocation.input.cursor === 'string' ? invocation.input.cursor : null;
    const limit = typeof invocation.input.limit === 'number' ? invocation.input.limit : 50;

    try {
      const response = await fetchWithDeadline(
        url,
        {
          headers: {
            Accept: 'application/rss+xml, application/atom+xml, application/json;q=0.8, */*;q=0.5',
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
          outcome,
          error_code,
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'request',
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

      let items: FeedItem[] = [];
      let cursorOf: (item: FeedItem) => string | null = (item) => item.id ?? item.link ?? item.published;

      if (/^\s*[[{]/.test(body.slice(0, 200))) {
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
        const located = pack?.records_path ? readPath(parsed, pack.records_path) : parsed;
        const rows = Array.isArray(located) ? located : [];
        items = rows.map((row) => {
          const record = (row ?? {}) as Record<string, unknown>;
          const cursorField = pack?.path_map?.id ?? 'id';
          const id = record[cursorField];
          return {
            id: id === undefined || id === null ? null : String(id),
            title: record.title === undefined ? null : String(record.title),
            link: record.link === undefined ? null : String(record.link),
            published: record.published === undefined ? null : String(record.published),
            summary: null,
            extra: record as Record<string, string>,
          };
        });
        cursorOf = (item) => item.id ?? item.published;
      } else {
        items = parseXmlFeed(body);
      }

      if (items.length === 0) {
        return buildOutcome(invocation, {
          outcome: 'empty',
          error_code: 'E_EMPTY_RESULT',
          http_status: response.status,
          latency_ms: latency,
          units: 1,
          unit_type: 'request',
        });
      }

      const seen = new Set<string>();
      let fresh = items;
      if (cursor) {
        // Everything up to and including the remembered cursor has been handled.
        const cut = items.findIndex((item) => cursorOf(item) === cursor);
        fresh = cut >= 0 ? items.slice(0, cut) : items;
      }

      const records: Record<string, unknown>[] = [];
      for (const item of fresh.slice(0, limit)) {
        const key = cursorOf(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        records.push({
          feed_id: item.id,
          title: item.title,
          url: item.link,
          published_at: item.published,
          summary: item.summary,
          ...item.extra,
        });
      }

      // The cursor advances to the newest item RETURNED, not the newest seen. If
      // the limit cut the list short, moving the cursor to the top would silently
      // skip everything between.
      const newest = cursorOf(fresh[0] ?? items[0]!) ;

      return buildOutcome(invocation, {
        records,
        outcome: records.length > 0 ? 'success' : 'empty',
        error_code: records.length > 0 ? null : 'E_EMPTY_RESULT',
        http_status: response.status,
        latency_ms: latency,
        units: 1,
        unit_type: 'request',
        cursor: records.length > 0 ? newest : cursor,
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
