/**
 * Apify actor invocation configs for Wave 2 buying signals.
 *
 * The adapter registry is closed, so Apify runs go through the generic
 * `api_json` adapter. These builders produce the `source` + `input` shape that
 * adapter expects for the Apify "synchronously run actor and get dataset items"
 * endpoint:
 *
 *   POST https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items?token=…
 *
 * Auth: the Apify API token goes in the query string (`input.auth_query`), the
 * same pattern other key-in-query providers use. The token itself is resolved
 * from the Vault at call time by `resolveCredential()` — it never appears in
 * these configs or in any log line (R1, R2).
 *
 * Actor IDs below are the well-known public actors for each signal family.
 * They are defaults, not hard requirements: the router's capability rows carry
 * the actual actor per provider account, and these builders accept an override.
 * If an actor is renamed or removed, the failure surfaces as an adapter error
 * with the actor name in the source config — visible in review, not silent.
 */

export interface ApifyRunConfig {
  /** api_json source.url_template */
  url_template: string;
  /** api_json selector.records_path — the dataset items array */
  records_path: string;
  /** input fields merged into the api_json invocation input */
  input: {
    method: 'POST';
    auth_query: 'token';
    json_body: Record<string, unknown>;
  };
}

export const DEFAULT_ACTORS = {
  hiring: 'apify/linkedin-jobs-scraper',
  ads: 'apify/facebook-ads-scraper',
  funding: 'apify/news-scraper',
} as const;

function runSyncUrl(actor: string): string {
  // timeout=300: the actor RUN budget in seconds, not an HTTP timeout.
  // Free-plan actors need ~2min (cold start + scrape); the 60s default
  // kills them mid-flight and returns empty. 300s stays under the Worker's
  // own limits while giving the actor room to finish.
  return `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token={token}&timeout=300`;
}

/**
 * Build the api_json invocation for a hiring-signal Apify run.
 *
 * @param actor    actor ID, defaults to the LinkedIn jobs scraper
 * @param company  company name to search jobs for
 * @param maxItems cap on dataset items (Apify-side limit)
 */
export function hiringRunConfig(
  company: string,
  actor: string = DEFAULT_ACTORS.hiring,
  maxItems = 50,
): ApifyRunConfig {
  return {
    url_template: runSyncUrl(actor),
    records_path: '',
    input: {
      method: 'POST',
      auth_query: 'token',
      json_body: {
        companyName: company,
        datePosted: 'month',
        pagesToFetch: 2,
      },
    },
  };
}

/** Build the api_json invocation for an ads-library Apify run. */
export function adsRunConfig(
  company: string,
  actor: string = DEFAULT_ACTORS.ads,
  maxItems = 50,
): ApifyRunConfig {
  return {
    url_template: runSyncUrl(actor),
    records_path: '',
    input: {
      method: 'POST',
      auth_query: 'token',
      json_body: {
        searchTerms: [company],
        maxItems,
      },
    },
  };
}

/** Build the api_json invocation for a funding/news Apify run. */
export function fundingRunConfig(
  company: string,
  actor: string = DEFAULT_ACTORS.funding,
  maxItems = 30,
): ApifyRunConfig {
  return {
    url_template: runSyncUrl(actor),
    records_path: '',
    input: {
      method: 'POST',
      auth_query: 'token',
      json_body: {
        query: `${company} funding raised investment`,
        maxItems,
      },
    },
  };
}
