import { describe, expect, it } from 'vitest';
import { googleTypesForNiche } from '../../src/domain/prospect/niches.js';
import { validateProspectInput } from '../../src/domain/prospect/validation.js';

const valid = { niche: 'dentists', location: 'Berlin, Germany', radiusKm: 10, targetQualified: 1, maxCandidates: 5, rankPreference: 'POPULARITY' as const, continuePipeline: false };

describe('prospect input and niche mapping', () => {
  it('maps only approved operator niches to Table A types', () => {
    expect(googleTypesForNiche('dentists')).toEqual(['dentist', 'dental_clinic']);
    expect(googleTypesForNiche('lawyers')).toEqual(['lawyer']);
    expect(googleTypesForNiche('gyms')).toEqual(['gym', 'fitness_center']);
    expect(googleTypesForNiche('real estate')).toEqual(['real_estate_agency']);
  });
  it('rejects an unknown niche before providers are involved', () => expect(() => validateProspectInput({ ...valid, niche: 'arbitrary_type' })).toThrow(/Unknown prospect niche/));
  it.each([0, -1, 50.1])('rejects invalid radius %s', (radiusKm) => expect(() => validateProspectInput({ ...valid, radiusKm })).toThrow(/radiusKm/));
  it('accepts 50 km and rejects more than 20 candidates', () => {
    expect(validateProspectInput({ ...valid, radiusKm: 50, maxCandidates: 20 }).maxCandidates).toBe(20);
    expect(() => validateProspectInput({ ...valid, maxCandidates: 21 })).toThrow(/maxCandidates/);
  });
  it('requires the target to fit inside the candidate budget', () => expect(() => validateProspectInput({ ...valid, targetQualified: 6 })).toThrow(/targetQualified/));
  it('validates rank and paired coordinates', () => {
    expect(() => validateProspectInput({ ...valid, rankPreference: 'OTHER' as 'POPULARITY' })).toThrow(/rankPreference/);
    expect(() => validateProspectInput({ ...valid, latitude: 52.5 })).toThrow(/together/);
  });
});
