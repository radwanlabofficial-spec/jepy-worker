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
