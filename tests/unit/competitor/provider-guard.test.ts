import { describe, expect, it } from 'vitest';
import { assertAllowedProvider, LiveProviderNotAllowedError } from '../../../src/integrations/competitor/provider.js';
import { loadCompetitorSource } from '../../../src/cli/commands/competitor-research-build.js';
import { fromPlacesShaped } from '../../../src/integrations/competitor/places-shaped.js';

describe('competitor provider guard (fail-closed, no silent fallback)', () => {
  it('accepts only fixture and operator_csv', () => {
    expect(assertAllowedProvider('fixture')).toBe('fixture');
    expect(assertAllowedProvider('operator_csv')).toBe('operator_csv');
  });

  it('throws for any live provider request', () => {
    expect(() => assertAllowedProvider('google_places')).toThrow(LiveProviderNotAllowedError);
    expect(() => assertAllowedProvider('places')).toThrow(/no silent fallback/);
  });

  it('loadCompetitorSource fails closed for a live provider (never falls back to fixtures)', async () => {
    await expect(
      loadCompetitorSource({ provider: 'google_places', leadId: 'lead-1', maxInputCandidates: 50 }),
    ).rejects.toThrow(LiveProviderNotAllowedError);
  });
});

describe('places-shaped adapter (contract reuse, no network)', () => {
  it('maps Places-shaped records into domain input candidates', () => {
    const out = fromPlacesShaped([
      {
        id: 'place-1', displayName: 'Acme Dental', websiteUri: 'https://acme.example', primaryType: 'dentist',
        types: ['dentist', 'implants'], location: { latitude: 51.5, longitude: -0.12 }, formattedAddress: '1 High St',
        city: 'London', market: 'london', languageCode: 'en', businessType: 'independent', parentBrand: null, branchId: null,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.rowIndex).toBe(1);
    expect(out[0]?.providerCandidateId).toBe('place-1');
    expect(out[0]?.website).toBe('https://acme.example');
    expect(out[0]?.latitude).toBe(51.5);
  });
});
