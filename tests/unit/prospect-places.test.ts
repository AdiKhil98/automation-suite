import { describe, expect, it, vi } from 'vitest';
import { GoogleLocationResolver, LOCATION_FIELD_MASK, PLACES_TEXT_SEARCH_URL, type LocationCache } from '../../src/integrations/prospect/location-resolver.js';
import { GoogleNearbySearch, NEARBY_DISCOVERY_FIELD_MASK, PLACES_NEARBY_SEARCH_URL } from '../../src/integrations/prospect/nearby-search.js';
import { type PlacesTransport } from '../../src/integrations/prospect/places-transport.js';

describe('prospect Places adapters', () => {
  it('uses one cached location result after the initial bounded resolution', async () => {
    const entries = new Map();
    const cache: LocationCache = { find: async (key) => entries.get(key) ?? null, save: async (key, value) => { entries.set(key, value) } };
    const post = vi.fn(async () => ({ places: [{ id: 'place.example', formattedAddress: 'Berlin, Germany', location: { latitude: 52.52, longitude: 13.405 }, types: ['locality'], addressComponents: [{ longText: 'Berlin', types: ['locality'] }, { longText: 'Germany', types: ['country'] }] }] }));
    const resolver = new GoogleLocationResolver({ post } as PlacesTransport, cache);
    expect((await resolver.resolve('Berlin, Germany')).externalRequests).toBe(1);
    expect((await resolver.resolve(' berlin germany ')).externalRequests).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(PLACES_TEXT_SEARCH_URL, { textQuery: 'Berlin, Germany', pageSize: 5 }, LOCATION_FIELD_MASK);
  });

  it('builds the exact Nearby Search request and requests Place IDs only', async () => {
    const post = vi.fn(async () => ({ places: [{ id: 'first.example' }, { id: 'second.example' }] }));
    const result = await new GoogleNearbySearch({ post } as PlacesTransport).discover({ includedTypes: ['dentist', 'dental_clinic'], location: { latitude: 52.52, longitude: 13.405 }, radiusKm: 10, maxCandidates: 5, rankPreference: 'POPULARITY' });
    expect(result.placeIds).toEqual(['first.example', 'second.example']);
    expect(post).toHaveBeenCalledWith(PLACES_NEARBY_SEARCH_URL, { includedTypes: ['dentist', 'dental_clinic'], locationRestriction: { circle: { center: { latitude: 52.52, longitude: 13.405 }, radius: 10000 } }, maxResultCount: 5, rankPreference: 'POPULARITY' }, NEARBY_DISCOVERY_FIELD_MASK);
    expect(JSON.stringify(post.mock.calls)).not.toMatch(/displayName|website|reviews|rating|phone|photo|api.?key/i);
  });
});
