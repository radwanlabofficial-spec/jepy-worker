/**
 * Provider credential tests.
 *
 * 06-providers.md §12 lists the test call per provider, and this file implements
 * exactly the ones that section names with a concrete endpoint. Where the
 * document describes the check but not the URL, the entry is honest about it and
 * returns `untested` — a test that reports success without having called anything
 * is worse than no test, because it turns an unknown key into a trusted one and
 * the router then routes real jobs through it.
 *
 * The mapping from HTTP status to outcome follows the same section: 401/403 means
 * the key is refused, and anything that fails to connect leaves the credential
 * untested, because a broken network and a revoked key look identical from here
 * and only one of them means "replace this key".
 */

export type TestStatus = 'ok' | 'failed' | 'untested';

export interface TestOutcome {
  status: TestStatus;
  message: string;
}

const TIMEOUT_MS = 15_000;

async function probe(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps a provider response to an outcome. Only a definitive refusal is `failed`;
 * a 5xx or a timeout leaves the credential as it was, because the key may be
 * perfectly good and the provider merely unwell.
 */
function classify(response: Response, okMessage: string): TestOutcome {
  if (response.ok) return { status: 'ok', message: okMessage };
  if (response.status === 401 || response.status === 403) {
    return { status: 'failed', message: `provider refused the credential (HTTP ${response.status})` };
  }
  return { status: 'untested', message: `provider answered HTTP ${response.status} — inconclusive` };
}

export async function testCredential(provider: string, secret: string): Promise<TestOutcome> {
  try {
    switch (provider) {
      case 'apify': {
        // 06 §12: /v2/users/me — verifies the key, and returns plan and usage.
        const response = await probe(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(secret)}`);
        if (!response.ok) return classify(response, '');
        const body = (await response.json()) as { data?: { plan?: { id?: string }; username?: string } };
        // Same lesson as zerobounce below: 200 is not proof. Without a username in
        // the payload there is no evidence an account answered at all.
        if (!body.data?.username) {
          return { status: 'failed', message: 'provider returned HTTP 200 but no account in the payload — key not accepted' };
        }
        const plan = body.data.plan?.id ?? 'unknown plan';
        return { status: 'ok', message: `key accepted — ${body.data.username} on ${plan}` };
      }

      case 'zerobounce': {
        // 06 §12: /v2/getcredits — the remaining verification count.
        //
        // HTTP status alone is not enough here, and this is not hypothetical: an
        // all-zeros key returned 200 with `Credits: -1`, so a status-only check
        // stored a dead credential and reported it as verified. The payload has
        // to be read: a negative or unparseable credit count is a refusal, not a
        // success with no credits left.
        const response = await probe(`https://api.zerobounce.net/v2/getcredits?api_key=${encodeURIComponent(secret)}`);
        if (!response.ok) return classify(response, '');
        const body = (await response.json()) as { Credits?: string; error?: string };
        if (body.error) {
          return { status: 'failed', message: `provider refused the credential: ${body.error}` };
        }
        const credits = Number(body.Credits);
        if (!Number.isFinite(credits) || credits < 0) {
          return {
            status: 'failed',
            message: `provider returned HTTP 200 but no usable credit count (Credits=${String(body.Credits)}) — treating the key as refused`,
          };
        }
        return { status: 'ok', message: `key accepted — ${credits} credits remaining` };
      }

      case 'google_psi': {
        // 06 §12: a light probe; this provider has no key, so the test only
        // establishes reachability. Any HTTP answer — including a quota refusal
        // — proves the endpoint is there.
        const response = await probe('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fexample.com');
        return {
          status: 'ok',
          message: `key-free endpoint reachable (HTTP ${response.status})`,
        };
      }

      case 'brightdata': {
        // 06 §12 names the check but not the URL. This one was confirmed against
        // the live API with a real key rather than guessed: `/status` answers 200
        // with `status: active`, the customer id, and — the useful part —
        // `can_make_requests` plus `auth_fail_reason`.
        //
        // That distinction matters. A key can be perfectly valid while the account
        // has no zone yet, and those two facts need different reactions: one means
        // "replace this credential", the other means "finish setting the account
        // up". A bare 200 would report both as healthy.
        const response = await probe('https://api.brightdata.com/status', {
          headers: { Authorization: `Bearer ${secret}`, 'User-Agent': 'jepy-worker/1.0' },
        });
        if (!response.ok) return classify(response, '');

        const body = (await response.json()) as {
          status?: string;
          customer?: string;
          can_make_requests?: boolean;
          auth_fail_reason?: string;
        };
        if (!body.customer) {
          return { status: 'failed', message: 'provider answered HTTP 200 but returned no customer — key not accepted' };
        }
        if (body.can_make_requests === false) {
          // `/status` is not the last word, and taking it as one has already
          // produced a wrong answer once: it reported `can_make_requests: false`
          // with `auth_fail_reason: zone_not_found` for an account whose live
          // `/request` call against its existing zone returned 200 with a list
          // page. `can_make_requests` is a cached roll-up, so it lags a zone
          // created after the key was first used.
          //
          // The cheap second opinion is the zone list, which is authoritative
          // about the thing the flag is a proxy for. It is asked only in the
          // disagreeing case, so the common path stays one call.
          const zones = await probe('https://api.brightdata.com/zone/get_active_zones', {
            headers: { Authorization: `Bearer ${secret}`, 'User-Agent': 'jepy-worker/1.0' },
          });
          if (zones.ok) {
            const list = (await zones.json()) as unknown;
            // Shape is checked rather than assumed: anything that is not an
            // array of zone objects proves nothing, and an unverified parse
            // would silently turn "could not tell" into "requests enabled" —
            // the same mistake this branch exists to fix.
            const names = Array.isArray(list)
              ? list
                  .map((z) => (z && typeof z === 'object' && 'name' in z ? String((z as { name: unknown }).name) : ''))
                  .filter((name) => name.length > 0)
              : [];
            if (names.length > 0) {
              return {
                status: 'ok',
                message: `key accepted (${body.customer}) — /status reports "${body.auth_fail_reason ?? 'can_make_requests false'}", but the account has ${names.length} active zone(s): ${names.slice(0, 5).join(', ')}. The flag lags the zone, so requests will work.`,
              };
            }
          }
          return {
            status: 'ok',
            message: `key accepted (${body.customer}) but the account cannot make requests yet: ${body.auth_fail_reason ?? 'unknown reason'} — no active zone was listed, so a zone has to be created in the BrightData dashboard`,
          };
        }
        return { status: 'ok', message: `key accepted — ${body.customer}, requests enabled` };
      }

      // 06 §12 names the check for these providers but no endpoint, and a guessed
      // URL would be indistinguishable from a working one until it silently
      // passed. They stay untested until the URL is confirmed.
      case 'resend':
      case 'yelp':
      case 'mapquest':
      case 'manifest':
        return {
          status: 'untested',
          message: `no test endpoint recorded for ${provider} — 06-providers.md §12 names the check but not the URL, so nothing was called`,
        };

      default:
        return { status: 'untested', message: `unknown provider ${provider} — nothing was called` };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error';
    return { status: 'untested', message: `could not reach ${provider} (${reason}) — credential left untested` };
  }
}

/** Providers this build can genuinely verify, for the UI to be honest about. */
export const TESTABLE_PROVIDERS = ['apify', 'zerobounce', 'google_psi', 'brightdata'] as const;
