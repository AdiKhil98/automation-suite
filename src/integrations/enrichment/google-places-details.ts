import { type Logger } from 'pino';
import { estimateCostUsd } from '../lead-source/google-places/pricing.js';

/**
 * Minimal Place Details (New) result. Approved fields may be persisted with
 * google_places provenance before independent website verification.
 */
export interface PlaceDetails {
  displayName?: string | null;
  formattedAddress?: string | null;
  locality?: string | null;
  country?: string | null;
  primaryType?: string | null;
  types?: string[];
  businessStatus?: string | null;
  nationalPhoneNumber?: string | null;
  websiteUri?: string | null;
}

export interface PlacesDetailsClient {
  /** Fetch minimal identification/discovery fields for a Place ID. */
  details(placeId: string, options?: { includePhone?: boolean }): Promise<PlaceDetails | null>;
}

// Endpoint + field mask verified against Places API (New) Place Details docs (2026-07).
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
export const PLACE_DETAILS_FIELD_MASK =
  'displayName,formattedAddress,addressComponents,primaryType,types,businessStatus,websiteUri';
export const PLACE_DETAILS_APPROVED_PHONE_FIELD_MASK = `${PLACE_DETAILS_FIELD_MASK},nationalPhoneNumber`;
/** The selected website and identity fields are conservatively budgeted at the Enterprise tier. */
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

  async details(placeId: string, options: { includePhone?: boolean } = {}): Promise<PlaceDetails | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}`, {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': options.includePhone
            ? PLACE_DETAILS_APPROVED_PHONE_FIELD_MASK
            : PLACE_DETAILS_FIELD_MASK,
        },
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
        addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
        primaryType?: string;
        types?: string[];
        businessStatus?: string;
        nationalPhoneNumber?: string;
        websiteUri?: string;
      };
      const component = (wanted: string[]): string | null => {
        const found = data.addressComponents?.find((item) => item.types?.some((type) => wanted.includes(type)));
        return found?.longText ?? found?.shortText ?? null;
      };
      return {
        displayName: data.displayName?.text ?? null,
        formattedAddress: data.formattedAddress ?? null,
        locality: component(['locality', 'postal_town', 'administrative_area_level_3']),
        country: component(['country']),
        primaryType: data.primaryType ?? null,
        types: data.types ?? [],
        businessStatus: data.businessStatus ?? null,
        nationalPhoneNumber: data.nationalPhoneNumber ?? null,
        websiteUri: data.websiteUri ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
