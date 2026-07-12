import { type MockBusiness } from '../integrations/lead-source/mock-lead-source.js';

/**
 * Synthetic businesses for the mock lead source (the `dental-manchester-test`
 * campaign). This is NOT Google content — it is local test data, so full facts may
 * be stored. Includes an intentional exact duplicate (different mock id, same
 * domain + address) to exercise deduplication during manual runs.
 */
export const mockBusinesses: MockBusiness[] = [
  {
    sourcePlaceId: 'mock-0001',
    businessName: 'Bright Smile Dental Practice',
    domain: 'https://www.brightsmiledental.example',
    phone: '0161 496 0001',
    city: 'Manchester',
    country: 'GB',
    formattedAddress: '12 Oxford Road, Manchester, M1 5QA',
    latitude: 53.4739,
    longitude: -2.2352,
  },
  {
    sourcePlaceId: 'mock-0002',
    businessName: 'Riverside Family Dentistry',
    domain: 'riversidefamilydentistry.example',
    phone: '+44 161 496 0002',
    city: 'Manchester',
    country: 'GB',
    formattedAddress: '5 Deansgate, Manchester, M3 2AA',
    latitude: 53.4795,
    longitude: -2.2506,
  },
  {
    sourcePlaceId: 'mock-0003',
    businessName: 'City Centre Orthodontics',
    domain: null,
    phone: '0161 496 0003',
    city: 'Manchester',
    country: 'GB',
    formattedAddress: '88 Piccadilly, Manchester, M1 2BN',
    latitude: 53.4808,
    longitude: -2.2372,
  },
  {
    // Duplicate of mock-0001: same domain + same address, different mock id + URL variant.
    sourcePlaceId: 'mock-0004',
    businessName: 'Bright Smile Dental',
    domain: 'http://brightsmiledental.example/',
    phone: '(0161) 496-0001',
    city: 'Manchester',
    country: 'GB',
    formattedAddress: '12 Oxford Road, Manchester, M1 5QA',
    latitude: 53.4739,
    longitude: -2.2352,
  },
];
