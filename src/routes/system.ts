/**
 * System metrics: real infrastructure data for the dashboard.
 *
 * `/api/system/d1-usage` returns live D1 row-read/write usage from Cloudflare's
 * GraphQL analytics API. Requires CF_API_TOKEN secret (a token with
 * Account Analytics:read permission).
 */

import { Hono } from 'hono';
import { ok, fail } from '../lib/envelope';
import { requireActor } from '../middleware/auth';
import type { Env } from '../env';

export const systemRoutes = new Hono<{ Bindings: Env }>();

// D1 free tier: 5M row reads/day, 100k row writes/day
const D1_DAILY_READ_LIMIT = 5_000_000;
const D1_DAILY_WRITE_LIMIT = 100_000;

systemRoutes.get('/system/d1-usage', requireActor, async (c) => {
  const token = (c.env as unknown as { CF_API_TOKEN?: string }).CF_API_TOKEN;
  if (!token) {
    const { body, status } = fail('E_INTERNAL', { reason: 'd1_usage_unavailable' });
    return c.json(body, status as 500);
  }

  const today = new Date().toISOString().slice(0, 10);
  const accountId = 'ea891d4883e9cad2f42aebb2c0b415df';
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountId}"}) {
        d1QueriesAdaptiveGroups(limit: 1, filter: {date: "${today}"}) {
          sum { rowsRead rowsWritten }
        }
      }
    }
  }`;

  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json() as any;
    const sum = data?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups?.[0]?.sum;
    const rowsRead = sum?.rowsRead ?? 0;
    const rowsWritten = sum?.rowsWritten ?? 0;

    return c.json(ok({
      date: today,
      rows_read: rowsRead,
      rows_written: rowsWritten,
      read_limit: D1_DAILY_READ_LIMIT,
      write_limit: D1_DAILY_WRITE_LIMIT,
      read_pct: Math.round((rowsRead / D1_DAILY_READ_LIMIT) * 100),
      write_pct: Math.round((rowsWritten / D1_DAILY_WRITE_LIMIT) * 100),
    }));
  } catch (e) {
    const { body, status } = fail('E_INTERNAL', { reason: 'd1_usage_fetch_failed' });
    return c.json(body, status as 500);
  }
});
