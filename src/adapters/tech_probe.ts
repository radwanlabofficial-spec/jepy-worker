/**
 * `tech_probe` — the cheap technical checks that run before any money is spent.
 *
 * These are the Wave 1 free probes, and they are the reason the budget works:
 * `has_website = 0`, an expired certificate, a missing MX record and a mobile
 * PageSpeed score are four signals that cost nothing to collect and each one is
 * worth more than most of what a paid directory returns. R10's whole design —
 * free work first, paid work only after a candidate scores — depends on this
 * adapter being genuinely free, so every probe here uses an endpoint that needs
 * no credential.
 *
 * A probe is dispatched by `probe_kind`, and the set of kinds is closed. That is
 * not site-specific branching (which R23 forbids) — a probe kind is a *transport*
 * choice, like which HTTP method to use. What this file must never learn is a
 * domain name.
 *
 * WHAT EACH PROBE ACTUALLY MEASURES, and what it does not:
 *
 *   dns_mx          MX records, via DNS-over-HTTPS JSON. A missing MX is a strong
 *                   "this business has no real mail" signal.
 *   ssl_cert        Whether TLS completes and what the response headers say.
 *                   Certificate EXPIRY is not observable from a Worker fetch —
 *                   the platform does not expose the peer certificate — so this
 *                   probe returns `E_PARTIAL_PROBE` naming that gap rather than
 *                   reporting a healthy certificate it never inspected.
 *   tech_stack      `server`, `x-powered-by`, `via` and a `<meta name="generator">`
 *                   read, which is what identifies a WordPress or Shopify site.
 *   robots_sitemap  `/robots.txt` parsed for `Sitemap:` lines, then the first
 *                   sitemap counted. Doubles as the robots check behind
 *                   `directory_sources.robots_ok`.
 *   email_pattern   `mailto:` links on the homepage, from which the address shape
 *                   is inferred. It reports the shape it actually saw with the
 *                   number of examples behind it; it never synthesises an address.
 *   psi             Google PageSpeed Insights, which is keyless. A failed score
 *                   is still a signal.
 */

import type { Adapter } from './shared';
import {
  buildOutcome,
  classifyHttp,
  fetchWithDeadline,
  fillTemplate,
} from './shared';
import type { AdapterOutcome } from '../router/types';

const PROBE_KINDS = ['dns_mx', 'ssl_cert', 'tech_stack', 'robots_sitemap', 'email_pattern', 'psi'] as const;
type ProbeKind = (typeof PROBE_KINDS)[number];

function isProbeKind(value: unknown): value is ProbeKind {
  return typeof value === 'string' && (PROBE_KINDS as readonly string[]).includes(value);
}

/** Accepts `example.com`, `www.example.com` or a full URL, and returns the
 *  registrable-ish host plus a normalised origin. Not a public-suffix parser —
 *  it does not need to be, because it never guesses a registrable domain. */
function hostOf(input: string): { host: string; origin: string } | null {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    return { host: url.hostname.replace(/^www\./i, ''), origin: `https://${url.hostname}` };
  } catch {
    return null;
  }
}

export const techProbeAdapter: Adapter = {
  name: 'tech_probe',

  async run(invocation): Promise<AdapterOutcome> {
    const started = Date.now();

    const rawKind = invocation.input.probe_kind ?? invocation.input.kind;
    if (!isProbeKind(rawKind)) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_UNSUPPORTED_PROBE',
        latency_ms: Date.now() - started,
      });
    }
    const kind: ProbeKind = rawKind;

    const target =
      (typeof invocation.input.url === 'string' ? invocation.input.url : null) ??
      (typeof invocation.input.domain === 'string' ? invocation.input.domain : null) ??
      invocation.source?.url_template ??
      invocation.source?.base_url;

    if (!target) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_CONFIG_MISSING',
        latency_ms: Date.now() - started,
      });
    }

    const filled = fillTemplate(target, invocation.input);
    const parsed = hostOf(filled);
    if (!parsed) {
      return buildOutcome(invocation, {
        outcome: 'error',
        error_code: 'E_BAD_REQUEST',
        latency_ms: Date.now() - started,
      });
    }

    const deadline = invocation.budget.deadline_ms;

    try {
      switch (kind) {
        case 'dns_mx':
          return await probeDns(invocation, parsed, deadline, started);
        case 'ssl_cert':
          return await probeTls(invocation, parsed, deadline, started);
        case 'tech_stack':
          return await probeStack(invocation, parsed, deadline, started);
        case 'robots_sitemap':
          return await probeRobots(invocation, parsed, deadline, started);
        case 'email_pattern':
          return await probeEmail(invocation, parsed, deadline, started);
        case 'psi':
          return await probePsi(invocation, parsed, deadline, started);
      }
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

type Invocation = Parameters<Adapter['run']>[0];

/**
 * A probe that found nothing is still an ANSWER, not a failure.
 *
 * "This domain has no MX record" is one of the most valuable signals in Wave 1,
 * and reporting it as `empty` — which R19 makes a failure — would send the router
 * hunting for another provider to re-ask the same question. So a successful probe
 * that found nothing returns `success` with the absence recorded as a field. Only
 * a probe that could not be completed is a failure.
 */
async function probeDns(
  invocation: Invocation,
  host: { host: string; origin: string },
  deadline: number,
  started: number,
): Promise<AdapterOutcome> {
  const response = await fetchWithDeadline(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host.host)}&type=MX`,
    { headers: { Accept: 'application/dns-json' } },
    deadline,
  );
  const latency = Date.now() - started;

  if (!response.ok) {
    const { outcome, error_code } = classifyHttp(response.status);
    return buildOutcome(invocation, { outcome, error_code, http_status: response.status, latency_ms: latency, units: 1 });
  }

  const body = (await response.json()) as { Answer?: { data?: string }[] };
  const exchanges = (body.Answer ?? [])
    .map((answer) => answer.data)
    .filter((value): value is string => typeof value === 'string');

  return buildOutcome(invocation, {
    records: [{ domain: host.host, has_mx: exchanges.length > 0 ? 1 : 0, mx_count: exchanges.length, mx_hosts: exchanges }],
    outcome: 'success',
    http_status: response.status,
    latency_ms: latency,
    units: 1,
    // Free, so no unit_type: the schema's unit enum describes paid units.
    unit_type: null,
  });
}

async function probeTls(
  invocation: Invocation,
  host: { host: string; origin: string },
  deadline: number,
  started: number,
): Promise<AdapterOutcome> {
  let reachable = 0;
  let status: number | null = null;
  let server: string | null = null;
  let hsts = 0;

  try {
    const response = await fetchWithDeadline(host.origin, { method: 'GET' }, deadline);
    reachable = 1;
    status = response.status;
    server = response.headers.get('server');
    hsts = response.headers.get('strict-transport-security') ? 1 : 0;
  } catch {
    reachable = 0;
  }

  return buildOutcome(invocation, {
    records: [
      {
        domain: host.host,
        tls_reachable: reachable,
        http_status: status,
        server,
        hsts,
        // Stated explicitly so a downstream consumer cannot read `tls_reachable`
        // as "the certificate is valid": the platform never handed us one.
        certificate_expiry_checked: 0,
      },
    ],
    outcome: 'success',
    error_code: 'E_PARTIAL_PROBE',
    http_status: status,
    latency_ms: Date.now() - started,
    units: 1,
  });
}

async function probeStack(
  invocation: Invocation,
  host: { host: string; origin: string },
  deadline: number,
  started: number,
): Promise<AdapterOutcome> {
  const response = await fetchWithDeadline(host.origin, { method: 'GET' }, deadline);
  const body = await response.text();
  const latency = Date.now() - started;

  if (!response.ok) {
    const { outcome, error_code } = classifyHttp(response.status);
    return buildOutcome(invocation, { outcome, error_code, http_status: response.status, latency_ms: latency, units: 1 });
  }

  const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(body)?.[1] ?? null;
  const poweredBy = response.headers.get('x-powered-by');
  const server = response.headers.get('server');
  const via = response.headers.get('via');

  const markers: string[] = [];
  if (/wp-content|wp-includes/i.test(body)) markers.push('wordpress');
  if (/cdn\.shopify\.com|shopify\.theme/i.test(body)) markers.push('shopify');
  if (/squarespace/i.test(body)) markers.push('squarespace');
  if (/wix\.com|wixstatic/i.test(body)) markers.push('wix');
  if (markers.length === 0 && generator) markers.push(generator.toLowerCase());

  return buildOutcome(invocation, {
    records: [
      {
        domain: host.host,
        server,
        powered_by: poweredBy,
        via,
        generator,
        stack_markers: markers,
        // The single most valuable free signal in the whole plan (STEP 8).
        has_website: 1,
      },
    ],
    outcome: 'success',
    http_status: response.status,
    latency_ms: latency,
    units: 1,
  });
}

async function probeRobots(
  invocation: Invocation,
  host: { host: string; origin: string },
  deadline: number,
  started: number,
): Promise<AdapterOutcome> {
  const robotsUrl = `${host.origin}/robots.txt`;
  let robotsStatus: number | null = null;
  let robotsBody = '';
  try {
    const response = await fetchWithDeadline(robotsUrl, { method: 'GET' }, deadline);
    robotsStatus = response.status;
    if (response.ok) robotsBody = await response.text();
  } catch {
    robotsStatus = null;
  }

  const sitemaps = [...robotsBody.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1] ?? '');
  const disallowAll = /^\s*disallow:\s*\/\s*$/im.test(robotsBody) && !/^\s*allow:/im.test(robotsBody);

  let sitemapUrls = 0;
  let sitemapStatus: number | null = null;
  const firstSitemap = sitemaps[0] ?? `${host.origin}/sitemap.xml`;
  try {
    const response = await fetchWithDeadline(firstSitemap, { method: 'GET' }, deadline);
    sitemapStatus = response.status;
    if (response.ok) {
      const xml = await response.text();
      sitemapUrls = (xml.match(/<loc>/gi) ?? []).length;
    }
  } catch {
    sitemapStatus = null;
  }

  return buildOutcome(invocation, {
    records: [
      {
        domain: host.host,
        robots_status: robotsStatus,
        robots_ok: robotsStatus === 200 && !disallowAll ? 1 : 0,
        disallow_all: disallowAll ? 1 : 0,
        sitemap_count: sitemaps.length,
        sitemap_url: sitemaps[0] ?? null,
        sitemap_status: sitemapStatus,
        sitemap_urls: sitemapUrls,
      },
    ],
    outcome: 'success',
    http_status: robotsStatus,
    latency_ms: Date.now() - started,
    // Two fetches, and this is a free probe, so still no paid unit.
    units: 2,
  });
}

async function probeEmail(
  invocation: Invocation,
  host: { host: string; origin: string },
  deadline: number,
  started: number,
): Promise<AdapterOutcome> {
  const response = await fetchWithDeadline(host.origin, { method: 'GET' }, deadline);
  const body = await response.text();
  const latency = Date.now() - started;

  // Only addresses the site itself publishes. Nothing is generated here: a
  // guessed address is a bounce and a deliverability hit, and 16-compliance.md
  // treats a synthesised address as a different thing from a published one.
  const found = [...body.matchAll(/mailto:([^"'?>\s]+@[^"'?>\s]+)/gi)]
    .map((match) => (match[1] ?? '').toLowerCase())
    .filter((address) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(address));

  const unique = [...new Set(found)];
  const sameDomain = unique.filter((address) => address.endsWith(`@${host.host}`));
  const localParts = sameDomain.map((address) => address.split('@')[0] ?? '');
  const pattern = localParts.length > 0 ? [...new Set(localParts)].join('|') : null;

  return buildOutcome(invocation, {
    records: [
      {
        domain: host.host,
        published_addresses: sameDomain.length,
        pattern,
        // The number of examples the pattern rests on. A pattern inferred from one
        // address is a guess; from four it is a convention.
        pattern_evidence: localParts.length,
        sample_masked: sameDomain.slice(0, 3).map((address) => {
          const [local, domain] = address.split('@');
          return `${(local ?? '').slice(0, 1)}***@${domain ?? ''}`;
        }),
      },
    ],
    outcome: 'success',
    http_status: response.status,
    latency_ms: latency,
    units: 1,
  });
}

async function probePsi(
  invocation: Invocation,
  host: { host: string; origin: string },
  deadline: number,
  started: number,
): Promise<AdapterOutcome> {
  const strategy = typeof invocation.input.strategy === 'string' ? invocation.input.strategy : 'mobile';
  const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(host.origin)}&strategy=${strategy}`;

  const response = await fetchWithDeadline(url, { method: 'GET' }, deadline);
  const latency = Date.now() - started;

  // PageSpeed is keyless and rate-limited, and a quota refusal is a normal
  // outcome rather than a fault. Even a refusal proves the endpoint answered, so
  // the record says which happened instead of pretending either way.
  if (!response.ok) {
    return buildOutcome(invocation, {
      records: [{ domain: host.host, strategy, psi_status: response.status, score: null, reachable: 1 }],
      outcome: 'success',
      error_code: 'E_PARTIAL_PROBE',
      http_status: response.status,
      latency_ms: latency,
      units: 1,
    });
  }

  const body = (await response.json()) as {
    lighthouseResult?: { categories?: { performance?: { score?: number } } };
    loadingExperience?: { overall_category?: string };
  };

  const score = body.lighthouseResult?.categories?.performance?.score;
  const numeric = typeof score === 'number' ? Math.round(score * 100) : null;

  return buildOutcome(invocation, {
    records: [
      {
        domain: host.host,
        strategy,
        psi_status: response.status,
        reachable: 1,
        // The plan's own words: a FAILED score is still a signal.
        score: numeric,
        field_category: body.loadingExperience?.overall_category ?? null,
      },
    ],
    outcome: 'success',
    http_status: response.status,
    latency_ms: latency,
    units: 1,
  });
}
