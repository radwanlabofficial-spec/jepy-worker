/**
 * Bindings and configuration.
 *
 * Two Worker secrets only (R1): VAULT_KEY and ADMIN_SECRET. Everything else that
 * looks like a credential — brightdata, apify, zerobounce, resend, yelp — lives
 * encrypted in D1 and is only ever decrypted inside a request that needs it.
 */

export interface Env {
  /** D1: the single source of truth for leads, jobs, quota and the Vault. */
  DB: D1Database;

  /**
   * RouterDO, one instance per `target_type` (09 §3).
   *
   * The binding is declared rather than optional: a missing binding would make
   * the dispatcher silently fall back to "no router", and a job queue that looks
   * healthy while routing nothing is the failure this project can least afford.
   */
  ROUTER_DO: DurableObjectNamespace;

  /**
   * KV: cache only, never a source of truth.
   *
   * robots.txt, the 24-hour Yelp window, domain enrichment and the credential
   * cache live here, each entry carrying a `cache_epoch`. The test of a correct
   * KV entry is that wiping the namespace changes nothing but latency — if a
   * value survives only in KV, that is a bug in where it was stored, not a
   * property of the cache.
   *
   * Declared rather than optional, for the same reason as `ROUTER_DO`: a missing
   * binding should fail loudly, while `CACHE?.get(...)` would answer "no cached
   * value" forever and every request would quietly pay full price.
   */
  CACHE: KVNamespace;

  /**
   * R2: job payloads, parquet staging for the import workflow, raw adapter
   * bodies worth re-parsing, and the weekly vault export.
   *
   * One bucket per account, not per environment: objects are addressed by key,
   * so `preview/` and production can share `jepy-raw`, and a lifecycle rule
   * expires the `preview/` prefix after seven days. KV cannot be shared this
   * way — `cache_epoch` and credential-cache entries would leak across
   * environments — which is why there are two namespaces and one bucket.
   */
  RAW: R2Bucket;

  /** Cloudflare Access: the Zero Trust team domain, e.g. `hidden-mouse-a469.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN: string;
  /** Cloudflare Access: this application's `aud`, checked on every human request. */
  ACCESS_AUD: string;
  /** `production` or `dev`. The dev path additionally requires a loopback host. */
  ENVIRONMENT: string;
  /** Comma-separated allow-list for CORS, used only if a direct call is ever made. */
  CONSOLE_ORIGIN: string;

  /** AES-256-GCM key for the Vault, base64 of 32 bytes. Secret. */
  VAULT_KEY: string;
  /** Server-to-server auth for cron and GitHub Actions. Secret. */
  ADMIN_SECRET: string;
}

/** What a verified Cloudflare Access identity looks like downstream. */
export interface Actor {
  email: string;
  /** `access` for a human, `admin` for cron/GHA, `device` for the extension. */
  kind: 'access' | 'admin' | 'device';
}
