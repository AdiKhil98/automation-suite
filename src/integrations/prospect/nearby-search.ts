import { AppError } from '../../utils/errors.js';
import { type ProspectRank, type ResolvedLocation } from '../../domain/prospect/types.js';
import { type PlacesTransport } from './places-transport.js';

export const PLACES_NEARBY_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';
export const NEARBY_DISCOVERY_FIELD_MASK = 'places.id';

export interface NearbySearchInput {
  includedTypes: string[];
  location: Pick<ResolvedLocation, 'latitude' | 'longitude'>;
  radiusKm: number;
  maxCandidates: number;
  rankPreference: ProspectRank;
}

export interface NearbyDiscovery { placeIds: string[]; requests: 1 }

export class GoogleNearbySearch {
  constructor(private readonly transport: PlacesTransport) {}

  async discover(input: NearbySearchInput): Promise<NearbyDiscovery> {
    const data = await this.transport.post<{ places?: Array<{ id?: string }> }>(
      PLACES_NEARBY_SEARCH_URL,
      {
        includedTypes: input.includedTypes,
        locationRestriction: { circle: { center: { latitude: input.location.latitude, longitude: input.location.longitude }, radius: input.radiusKm * 1000 } },
        maxResultCount: input.maxCandidates,
        rankPreference: input.rankPreference,
      },
      NEARBY_DISCOVERY_FIELD_MASK,
    );
    const seen = new Set<string>();
    const placeIds = (data.places ?? []).flatMap((place) => {
      const id = place.id?.trim(); if (!id || seen.has(id)) return []; seen.add(id); return [id];
    }).slice(0, input.maxCandidates);
    if (placeIds.some((id) => id.length > 256)) throw new AppError('PLACES_INVALID_RESPONSE', 'Nearby response contains an invalid Place ID');
    return { placeIds, requests: 1 };
  }
}
