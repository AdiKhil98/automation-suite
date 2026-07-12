import { type Logger } from 'pino';
import { postJson } from '../../../utils/http.js';
import { type RateLimiter } from '../../../utils/rate-limiter.js';
import {
  type CollectQuery,
  type LeadSourceProvider,
  type ProviderCaps,
  type ProviderPage,
} from '../provider.js';
import { estimateCostUsd } from './pricing.js';
import { DISCOVERY_FIELD_MASK, PLACES_TEXT_SEARCH_URL, type PlacesTextSearchResponse } from './types.js';

export interface GooglePlacesOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  rateLimiter: RateLimiter;
  logger: Logger;
}

/**
 * Places API (New) Text Search provider — DISCOVERY ONLY.
 *
 * Requests the ID-only field mask (`places.id,nextPageToken`), so it returns Place
 * IDs and a pagination token and nothing else. No display name, address,
 * coordinates, business status or type is requested, processed or stored. Richer
 * context is deferred to a later, in-memory enrichment phase.
 */
export class GooglePlacesProvider implements LeadSourceProvider {
  readonly name = 'google_places';

  constructor(private readonly opts: GooglePlacesOptions) {}

  async *pages(query: CollectQuery, caps: ProviderCaps): AsyncGenerator<ProviderPage> {
    let pageToken: string | undefined;

    for (let pageIndex = 0; pageIndex < caps.maxPages; pageIndex += 1) {
      const requestBody: Record<string, unknown> = {
        textQuery: query.textQuery,
        pageSize: caps.pageSize,
      };
      if (query.locationBias) requestBody.locationBias = query.locationBias;
      if (pageToken) requestBody.pageToken = pageToken;

      // Query metadata we may persist: our own parameters only, never response content.
      const queryMeta = { textQuery: query.textQuery, pageSize: caps.pageSize, pageIndex };
      const startedAt = new Date();

      await this.opts.rateLimiter.acquire();

      let data: PlacesTextSearchResponse;
      try {
        data = await postJson<PlacesTextSearchResponse>(PLACES_TEXT_SEARCH_URL, requestBody, {
          headers: {
            'X-Goog-Api-Key': this.opts.apiKey,
            'X-Goog-FieldMask': DISCOVERY_FIELD_MASK,
          },
          timeoutMs: this.opts.timeoutMs,
          maxRetries: this.opts.maxRetries,
        });
      } catch (err) {
        this.opts.logger.error(
          { pageIndex, err: err instanceof Error ? err.message : String(err) },
          'Places request failed',
        );
        yield {
          candidates: [],
          request: {
            fieldMask: DISCOVERY_FIELD_MASK,
            pageIndex,
            query: queryMeta,
            resultCount: 0,
            billedTier: 'Essentials',
            estimatedCostUsd: estimateCostUsd('Essentials', 1),
            status: 'FAILED',
            startedAt,
            completedAt: new Date(),
          },
        };
        return;
      }

      const ids = (data.places ?? []).map((p) => p.id).filter((id) => id.length > 0);
      yield {
        candidates: ids.map((id) => ({ sourcePlaceId: id, facts: null })),
        request: {
          fieldMask: DISCOVERY_FIELD_MASK,
          pageIndex,
          query: queryMeta,
          resultCount: ids.length,
          billedTier: 'Essentials',
          estimatedCostUsd: estimateCostUsd('Essentials', 1),
          status: ids.length > 0 ? 'OK' : 'EMPTY',
          startedAt,
          completedAt: new Date(),
        },
      };

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
  }
}
