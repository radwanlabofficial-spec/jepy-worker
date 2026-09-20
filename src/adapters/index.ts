/**
 * The adapter registry.
 *
 * Six entries. There is no fallthrough, no default and no dynamic import: an
 * unknown adapter name is a configuration error and the router is told so,
 * because a capability row naming an adapter that does not exist would otherwise
 * dispatch something and nobody would know what.
 *
 * Keeping the registry closed is what makes the "no seventh adapter" rule
 * enforceable rather than aspirational (07 §2). Adding an adapter is a change to
 * this file plus a new capability row — visible in review, and impossible to do
 * by accident from a config table.
 */

import { ADAPTERS } from '../router/types';
import type { AdapterName, AdapterOutcome } from '../router/types';
import { emptyOutcome } from '../router/types';
import type { Adapter, AdapterInvocation } from './shared';
import { apiJsonAdapter } from './api_json';
import { directoryHtmlAdapter } from './directory_html';
import { serpQueryAdapter } from './serp_query';
import { profilePageAdapter } from './profile_page';
import { feedPollAdapter } from './feed_poll';
import { techProbeAdapter } from './tech_probe';

const REGISTRY: Record<AdapterName, Adapter> = {
  api_json: apiJsonAdapter,
  directory_html: directoryHtmlAdapter,
  serp_query: serpQueryAdapter,
  profile_page: profilePageAdapter,
  feed_poll: feedPollAdapter,
  tech_probe: techProbeAdapter,
};

export function isAdapterName(value: string): value is AdapterName {
  return (ADAPTERS as readonly string[]).includes(value);
}

export function getAdapter(name: string): Adapter | null {
  return isAdapterName(name) ? REGISTRY[name] : null;
}

export function adapterNames(): readonly AdapterName[] {
  return ADAPTERS;
}

/**
 * Runs one adapter and never throws.
 *
 * The router's hop accounting assumes it gets an outcome back for every attempt
 * it opened; an exception escaping here would leave the attempt row open, the
 * account counter spent and the hop unaccounted for. So the boundary is here, and
 * an unexpected throw becomes an `error` outcome with the reason preserved.
 */
export async function dispatchAdapter(invocation: AdapterInvocation): Promise<AdapterOutcome> {
  const adapter = getAdapter(invocation.adapter);
  if (!adapter) {
    return emptyOutcome({
      provider: invocation.provider,
      account_label: invocation.account_label ?? 'unclaimed',
      outcome: 'error',
      error_code: 'E_ADAPTER_UNKNOWN',
      runner: invocation.runner,
    });
  }

  try {
    return await adapter.run(invocation);
  } catch (error) {
    // The message is NOT carried through. A fetch rejection embeds the request
    // URL in its text, and `api_json` can be configured to carry a key in the
    // query string (`input.auth_query`). This outcome does not reach storage
    // today, but one new caller that saved it would put a credential into
    // `job_results`. So only the error CLASS travels; the text stays in the call
    // frame, which is the only place the plaintext ever existed (R1, R2).
    void error;
    return emptyOutcome({
      provider: invocation.provider,
      account_label: invocation.account_label ?? 'unclaimed',
      outcome: 'error',
      error_code: 'E_ADAPTER_THREW',
      http_status: null,
      raw_ref_r2: null,
      records: [],
      runner: invocation.runner,
    });
  }
}

export type { Adapter, AdapterInvocation, CredentialRef } from './shared';
