import { assertLiveCallsAllowed } from '../../config/live-call-guard.js';
import { type ContactEnrichmentProvider, EnrichmentProviderNotAllowedError } from '../../domain/contact-enrichment/provider.js';
import { ApolloContactEnrichmentProvider } from '../../integrations/contact-enrichment/apollo-provider.js';
import { HunterContactEnrichmentProvider } from '../../integrations/contact-enrichment/hunter-provider.js';
import { InstantlyContactEnrichmentProvider } from '../../integrations/contact-enrichment/instantly-provider.js';
import { MockContactEnrichmentProvider } from '../../integrations/contact-enrichment/mock-provider.js';
import { type CliContext } from '../context.js';

/**
 * Per-provider builders. Each is independently callable regardless of the single
 * `CONTACT_ENRICHMENT_PROVIDER` env selector — `contact-resolve-batch` needs Instantly AND Hunter
 * constructible in the same run, not just whichever one that env value currently names. Every builder
 * preserves the same three-gate order:
 *  1. Global DRY_RUN kill switch: DRY_RUN=true blocks ALL live network provider construction (even the
 *     non-enriching preview) regardless of the paid flags.
 *  2. CONTACT_ENRICHMENT_ENABLED (feature flag).
 *  3. The provider's own API key.
 * ALLOW_PAID_ENRICHMENT_CALLS is NOT required to construct — it is enforced at the paid enrich() step
 * (each provider fails closed without it); preview needs no credits.
 */

export function buildHunterContactEnrichmentProvider(ctx: CliContext): HunterContactEnrichmentProvider {
  const c = ctx.config;
  assertLiveCallsAllowed(c.DRY_RUN, 'hunter-contact-enrichment');
  if (!c.CONTACT_ENRICHMENT_ENABLED) {
    throw new EnrichmentProviderNotAllowedError('Hunter contact enrichment requires CONTACT_ENRICHMENT_ENABLED=true.');
  }
  if (!c.HUNTER_API_KEY) {
    throw new EnrichmentProviderNotAllowedError('Hunter contact enrichment requires HUNTER_API_KEY (read from env; never hard-coded).');
  }
  return new HunterContactEnrichmentProvider({
    apiKey: c.HUNTER_API_KEY,
    baseUrl: c.HUNTER_API_BASE_URL,
    timeoutMs: c.HUNTER_TIMEOUT_MS,
    allowPaidEnrichment: c.ALLOW_PAID_ENRICHMENT_CALLS,
    logger: ctx.logger,
  });
}

export function buildApolloContactEnrichmentProvider(ctx: CliContext): ApolloContactEnrichmentProvider {
  const c = ctx.config;
  assertLiveCallsAllowed(c.DRY_RUN, 'apollo-contact-enrichment');
  if (!c.CONTACT_ENRICHMENT_ENABLED) {
    throw new EnrichmentProviderNotAllowedError('Apollo contact enrichment requires CONTACT_ENRICHMENT_ENABLED=true.');
  }
  if (!c.APOLLO_API_KEY) {
    throw new EnrichmentProviderNotAllowedError('Apollo contact enrichment requires APOLLO_API_KEY (read from env; never hard-coded).');
  }
  return new ApolloContactEnrichmentProvider({
    apiKey: c.APOLLO_API_KEY,
    baseUrl: c.APOLLO_API_BASE_URL,
    timeoutMs: c.APOLLO_TIMEOUT_MS,
    previewLimit: c.CONTACT_ENRICHMENT_PREVIEW_LIMIT,
    allowPaidEnrichment: c.ALLOW_PAID_ENRICHMENT_CALLS,
    logger: ctx.logger,
  });
}

export function buildInstantlyContactEnrichmentProvider(ctx: CliContext): InstantlyContactEnrichmentProvider {
  const c = ctx.config;
  assertLiveCallsAllowed(c.DRY_RUN, 'instantly-contact-enrichment');
  if (!c.CONTACT_ENRICHMENT_ENABLED) {
    throw new EnrichmentProviderNotAllowedError('Instantly contact enrichment requires CONTACT_ENRICHMENT_ENABLED=true.');
  }
  if (!c.INSTANTLY_API_KEY) {
    throw new EnrichmentProviderNotAllowedError('Instantly contact enrichment requires INSTANTLY_API_KEY (read from env; never hard-coded).');
  }
  return new InstantlyContactEnrichmentProvider({
    apiKey: c.INSTANTLY_API_KEY,
    baseUrl: c.INSTANTLY_API_BASE_URL,
    timeoutMs: c.INSTANTLY_TIMEOUT_MS,
    pollMaxAttempts: c.INSTANTLY_POLL_MAX_ATTEMPTS,
    pollIntervalMs: c.INSTANTLY_POLL_INTERVAL_MS,
    previewLimit: c.CONTACT_ENRICHMENT_PREVIEW_LIMIT,
    allowPaidEnrichment: c.ALLOW_PAID_ENRICHMENT_CALLS,
    logger: ctx.logger,
  });
}

/**
 * Build the SINGLE contact-enrichment provider named by `CONTACT_ENRICHMENT_PROVIDER` (mock default).
 * Used by the single-lead `contact-enrich` CLI. `contact-resolve-batch` instead calls the per-provider
 * builders above directly, since it needs more than one provider available in the same run.
 */
export function buildContactEnrichmentProvider(ctx: CliContext): ContactEnrichmentProvider {
  const c = ctx.config;
  if (c.CONTACT_ENRICHMENT_PROVIDER === 'hunter') return buildHunterContactEnrichmentProvider(ctx);
  if (c.CONTACT_ENRICHMENT_PROVIDER === 'apollo') return buildApolloContactEnrichmentProvider(ctx);
  if (c.CONTACT_ENRICHMENT_PROVIDER !== 'instantly') return new MockContactEnrichmentProvider();
  return buildInstantlyContactEnrichmentProvider(ctx);
}
