import { assertLiveCallsAllowed } from '../../config/live-call-guard.js';
import { type ContactEnrichmentProvider, EnrichmentProviderNotAllowedError } from '../../domain/contact-enrichment/provider.js';
import { ApolloContactEnrichmentProvider } from '../../integrations/contact-enrichment/apollo-provider.js';
import { HunterContactEnrichmentProvider } from '../../integrations/contact-enrichment/hunter-provider.js';
import { InstantlyContactEnrichmentProvider } from '../../integrations/contact-enrichment/instantly-provider.js';
import { MockContactEnrichmentProvider } from '../../integrations/contact-enrichment/mock-provider.js';
import { type CliContext } from '../context.js';

/**
 * Build the contact-enrichment provider. Live providers (Instantly, Hunter) are hard-gated:
 *  - Global DRY_RUN kill switch: DRY_RUN=true blocks ALL live network provider construction (even the
 *    non-enriching preview) regardless of the paid flags.
 *  - Live construction requires CONTACT_ENRICHMENT_ENABLED + the provider's own API key.
 *    Preview needs no credits, so ALLOW_PAID_ENRICHMENT_CALLS is NOT required to construct — it is
 *    enforced at the paid enrich() step (each provider fails closed without it).
 * The default (mock) never spends or calls out.
 */
export function buildContactEnrichmentProvider(ctx: CliContext): ContactEnrichmentProvider {
  const c = ctx.config;
  if (c.CONTACT_ENRICHMENT_PROVIDER === 'hunter') {
    assertLiveCallsAllowed(c.DRY_RUN, 'hunter-contact-enrichment');
    if (!c.CONTACT_ENRICHMENT_ENABLED) {
      throw new EnrichmentProviderNotAllowedError('CONTACT_ENRICHMENT_PROVIDER=hunter requires CONTACT_ENRICHMENT_ENABLED=true.');
    }
    if (!c.HUNTER_API_KEY) {
      throw new EnrichmentProviderNotAllowedError('CONTACT_ENRICHMENT_PROVIDER=hunter requires HUNTER_API_KEY (read from env; never hard-coded).');
    }
    return new HunterContactEnrichmentProvider({
      apiKey: c.HUNTER_API_KEY,
      baseUrl: c.HUNTER_API_BASE_URL,
      timeoutMs: c.HUNTER_TIMEOUT_MS,
      // Paid enrichment gate: preview is a zero-network echo; enrich() fails closed unless this is true.
      allowPaidEnrichment: c.ALLOW_PAID_ENRICHMENT_CALLS,
      logger: ctx.logger,
    });
  }
  if (c.CONTACT_ENRICHMENT_PROVIDER === 'apollo') {
    assertLiveCallsAllowed(c.DRY_RUN, 'apollo-contact-enrichment');
    if (!c.CONTACT_ENRICHMENT_ENABLED) {
      throw new EnrichmentProviderNotAllowedError('CONTACT_ENRICHMENT_PROVIDER=apollo requires CONTACT_ENRICHMENT_ENABLED=true.');
    }
    if (!c.APOLLO_API_KEY) {
      throw new EnrichmentProviderNotAllowedError('CONTACT_ENRICHMENT_PROVIDER=apollo requires APOLLO_API_KEY (read from env; never hard-coded).');
    }
    return new ApolloContactEnrichmentProvider({
      apiKey: c.APOLLO_API_KEY,
      baseUrl: c.APOLLO_API_BASE_URL,
      timeoutMs: c.APOLLO_TIMEOUT_MS,
      previewLimit: c.CONTACT_ENRICHMENT_PREVIEW_LIMIT,
      // Paid enrichment gate: preview is free (0 credits); enrich() fails closed unless this is true.
      allowPaidEnrichment: c.ALLOW_PAID_ENRICHMENT_CALLS,
      logger: ctx.logger,
    });
  }
  if (c.CONTACT_ENRICHMENT_PROVIDER !== 'instantly') {
    return new MockContactEnrichmentProvider();
  }
  // Global dry-run kill switch — before any credential/flag check that could construct a network client.
  assertLiveCallsAllowed(c.DRY_RUN, 'instantly-contact-enrichment');
  if (!c.CONTACT_ENRICHMENT_ENABLED) {
    throw new EnrichmentProviderNotAllowedError('CONTACT_ENRICHMENT_PROVIDER=instantly requires CONTACT_ENRICHMENT_ENABLED=true.');
  }
  if (!c.INSTANTLY_API_KEY) {
    throw new EnrichmentProviderNotAllowedError('CONTACT_ENRICHMENT_PROVIDER=instantly requires INSTANTLY_API_KEY (read from env; never hard-coded).');
  }
  return new InstantlyContactEnrichmentProvider({
    apiKey: c.INSTANTLY_API_KEY,
    baseUrl: c.INSTANTLY_API_BASE_URL,
    timeoutMs: c.INSTANTLY_TIMEOUT_MS,
    pollMaxAttempts: c.INSTANTLY_POLL_MAX_ATTEMPTS,
    pollIntervalMs: c.INSTANTLY_POLL_INTERVAL_MS,
    previewLimit: c.CONTACT_ENRICHMENT_PREVIEW_LIMIT,
    // Paid enrichment gate: preview always allowed; enrich() fails closed unless this is true.
    allowPaidEnrichment: c.ALLOW_PAID_ENRICHMENT_CALLS,
    logger: ctx.logger,
  });
}
