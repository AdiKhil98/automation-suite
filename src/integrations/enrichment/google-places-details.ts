import { type Logger } from 'pino';
import { estimateCostUsd } from '../lead-source/google-places/pricing.js';

/**
 * Minimal Place Details (New) result used ONLY as in-memory discovery context.
 * None of these values may be persisted as durable facts (see docs/SECURITY.md).
 */
export interface PlaceDetails {
  displayName?: string | null;
  formattedAddress?: string | null;
  nationalPhoneNumber?: string | null;
  websiteUri?: string | null;
}

export interface PlacesDetailsClient {
  /** Fetch minimal identification/discovery fields for a Place ID. */
  details(placeId: string): Promise<PlaceDetails | null>;
}

// Endpoint + field mask verified against Places API (New) Place Details docs (2026-07).
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
export const PLACE_DETAILS_FIELD_MASK = 'displayName,formattedAddress,nationalPhoneNumber,websiteUri';
/** websiteUri + nationalPhoneNumber put this request in the Enterprise SKU tier. */
export const PLACE_DETAILS_TIER = 'Enterprise' as const;

export function placeDetailsCostUsd(requestCount: number): number {
  return estimateCostUsd(PLACE_DETAILS_TIER, requestCount);
}

/** Real Places Details client. Only called when ALLOW_PAID_READS=true and a key is set. */
export class GooglePlacesDetailsClient implements PlacesDetailsClient {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  async details(placeId: string): Promise<PlaceDetails | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}`, {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': PLACE_DETAILS_FIELD_MASK },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Never log response bodies (may contain restricted content) — status only.
        this.logger.warn({ placeId, status: res.status }, 'places details non-OK');
        return null;
      }
      const data = (await res.json()) as {
        displayName?: { text?: string };
        formattedAddress?: string;
        nationalPhoneNumber?: string;
        websiteUri?: string;
      };
      return {
        displayName: data.displayName?.text ?? null,
        formattedAddress: data.formattedAddress ?? null,
        nationalPhoneNumber: data.nationalPhoneNumber ?? null,
        websiteUri: data.websiteUri ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
