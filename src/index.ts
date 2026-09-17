/**
 * Jepy Leads API — Worker entry point.
 *
 * Phase 3 replaces this stub with the Hono router, the Cloudflare Access
 * middleware and the Vault. For now it proves two things end to end: that the
 * Worker deploys at all, and that the D1 binding from wrangler.toml resolves.
 *
 * Everything answers with the same envelope the console already expects
 * (11-api-contract.md): `{ ok: true, data }` or `{ ok: false, error }`.
 */

export interface Env {
  DB: D1Database;
}

const ENVELOPE = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      // Counting tables is the cheapest real proof that the binding works: a
      // binding that resolves but points at an empty database would still
      // return ok, and that is exactly the failure worth catching early.
      let tables: number | null = null;
      let schemaReady = false;
      try {
        // D1 keeps its own tables (`d1_migrations`, `_cf_METADATA`, `_cf_KV`,
        // `sqlite_sequence`), so they are filtered by prefix rather than by a
        // fixed deny-list: a raw count is 46 or 47 and both are correct.
        const row = await env.DB
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' " +
              "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
          )
          .first<{ n: number }>();
        tables = row?.n ?? null;
        schemaReady = tables === 44;
      } catch (error) {
        return Response.json(
          { ok: false, error: { code: 'E_INTERNAL', message: 'D1 binding failed', detail: { reason: String(error) } } },
          { status: 500, headers: ENVELOPE },
        );
      }

      return Response.json(
        {
          ok: true,
          data: {
            service: 'jepy-worker',
            phase: 2,
            schema_ready: schemaReady,
            tables,
          },
        },
        { headers: ENVELOPE },
      );
    }

    return Response.json(
      { ok: false, error: { code: 'E_NOT_FOUND', message: 'This route does not exist yet' } },
      { status: 404, headers: ENVELOPE },
    );
  },
};
