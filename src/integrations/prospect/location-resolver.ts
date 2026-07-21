import { AppError } from '../../utils/errors.js';
import { type ResolvedLocation } from '../../domain/prospect/types.js';
import { type PlacesTransport } from './places-transport.js';

export const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
export const LOCATION_FIELD_MASK = 'places.id,places.formattedAddress,places.location,places.addressComponents,places.types';

export interface LocationCache {
  find(normalizedLocation: string): Promise<Omit<ResolvedLocation, 'externalRequests'> | null>;
  save(normalizedLocation: string, location: Omit<ResolvedLocation, 'externalRequests'>): Promise<void>;
}

interface LocationPlace {
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
  types?: string[];
}

export function normalizeLocationQuery(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function searchable(place: LocationPlace): string {
  return normalizeLocationQuery([place.formattedAddress, ...(place.addressComponents ?? []).flatMap((c) => [c.longText, c.shortText])].filter(Boolean).join(' '));
}

function isAdministrative(place: LocationPlace): boolean {
  const allowed = new Set(['locality', 'postal_town', 'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3']);
  return Boolean(place.types?.some((t) => allowed.has(t)) || place.addressComponents?.some((c) => c.types?.some((t) => allowed.has(t))));
}

export class GoogleLocationResolver {
  constructor(private readonly transport: PlacesTransport, private readonly cache: LocationCache) {}

  async resolve(requestedLocation: string): Promise<ResolvedLocation> {
    const key = normalizeLocationQuery(requestedLocation);
    if (!key) throw new AppError('INVALID_PROSPECT_LOCATION', 'location is empty');
    const cached = await this.cache.find(key);
    if (cached) return { ...cached, externalRequests: 0 };
    const response = await this.transport.post<{ places?: LocationPlace[] }>(PLACES_TEXT_SEARCH_URL, { textQuery: requestedLocation.trim(), pageSize: 5 }, LOCATION_FIELD_MASK);
    const tokens = key.split(' ').filter((token) => token.length >= 2);
    const matches = (response.places ?? []).filter((place) => {
      const text = searchable(place); return isAdministrative(place) && tokens.every((token) => text.includes(token));
    });
    if (matches.length !== 1) throw new AppError(matches.length === 0 ? 'LOCATION_MISMATCH' : 'LOCATION_AMBIGUOUS', 'Location could not be resolved unambiguously');
    const match = matches[0];
    const latitude = match?.location?.latitude; const longitude = match?.location?.longitude;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !match?.formattedAddress) throw new AppError('LOCATION_INVALID_RESPONSE', 'Resolved location lacks required fields');
    const stored = { latitude: latitude as number, longitude: longitude as number, formattedLocation: match.formattedAddress, provider: 'google_places' as const, resolvedAt: new Date() };
    await this.cache.save(key, stored);
    return { ...stored, externalRequests: 1 };
  }
}
