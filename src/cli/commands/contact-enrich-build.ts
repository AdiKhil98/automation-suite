import { type ContactEnrichmentProvider, EnrichmentProviderNotAllowedError } from '../../domain/contact-enrichment/provider.js';
import { InstantlyContactEnrichmentProvider } from '../../integrations/contact-enrichment/instantly-provider.js';
import { MockContactEnrichmentProvider } from '../../integrations/contact-enrichment/mock-provider.js';
import { type CliContext } from '../context.js';

/**
 * Build the contact-enrichment provider. Paid (Instantly) construction is hard-gated: it requires
 * CONTACT_ENRICHMENT_PROVIDER=instantly AND CONTACT_ENRICHMENT_ENABLED=true AND
 * ALLOW_PAID_ENRICHMENT_CALLS=true AND INSTANTLY_API_KEY. Any missing piece throws HERE — before a
 * lead is touched and before any request could be made. The default (mock) never spends or calls out.
 */
export function buildContactEnrichmentProvider(ctx: CliContext): ContactEnrichmentProvider {
  const c = ctx.config;
  if (c.CONTACT_ENRICHMENT_PROVIDER !== 'instantly') {
    return new MockContactEnrichmentProvider();
  }
  if (!c.CONTACT_ENRICHMENT_ENABLED) {
    throw new EnrichmentProviderNotAllowedError('CONTACT_ENRICHMENT_PROVIDER=instantly requires CONTACT_ENRICHMENT_ENABLED=true.');
  }
  if (!c.ALLOW_PAID_ENRICHMENT_CALLS) {
    throw new EnrichmentProviderNotAllowedError('CONTACT_ENRICHMENT_PROVIDER=instantly requires ALLOW_PAID_ENRICHMENT_CALLS=true (paid-call kill switch is off).');
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
    logger: ctx.logger,
  });
}
