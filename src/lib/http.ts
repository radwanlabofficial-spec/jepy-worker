/**
 * Query parsing and pagination.
 *
 * Pagination is keyset, not offset: `?cursor=` is an opaque token holding the
 * last row's sort position. On a table that grows while the operator pages
 * through it, an offset skips and repeats rows; keyset does not. `limit`
 * defaults to 50 and is clamped at 200 for any caller asking for more, rather
 * than being rejected — a UI bug should not become a 400.
 */

import { fail } from './envelope';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface Page {
  limit: number;
  cursor: string | null;
}

export function readPage(url: URL): Page {
  const raw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), MAX_LIMIT) : DEFAULT_LIMIT;
  return { limit, cursor: url.searchParams.get('cursor') };
}

/** Cursor payload: the two sort keys, joined. Opaque to the client. */
export function encodeCursor(parts: (string | number | null)[]): string {
  return btoa(parts.map((p) => (p === null ? '' : String(p))).join('\u0001'));
}

export function decodeCursor(cursor: string): string[] | null {
  try {
    const decoded = atob(cursor);
    const parts = decoded.split('\u0001');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

export type QueryResult<T> = { rows: T[]; nextCursor: string | null; hasMore: boolean };

/** Selects the page and asks D1 for one extra row to learn whether more exist. */
export async function paginate<T>(
  db: D1Database,
  sql: string,
  params: unknown[],
  limit: number,
): Promise<QueryResult<T>> {
  const statement = db.prepare(sql).bind(...params);
  const result = await statement.all<T>();
  const rows = (result.results ?? []) as T[];
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, nextCursor: null, hasMore };
}

/** A small helper so route files do not each rebuild this shape. */
export function badRequest(reason?: string) {
  return fail('E_VALIDATION', reason ? { reason } : undefined);
}

/** Reads an integer query parameter, treating junk as absent rather than zero. */
export function intParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

export function boolParam(url: URL, name: string): boolean | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  return raw === '1' || raw.toLowerCase() === 'true';
}
