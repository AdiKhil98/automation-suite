import { AppError } from '../../utils/errors.js';

export const PROSPECT_NICHES = {
  dentists: ['dentist', 'dental_clinic'],
  lawyers: ['lawyer'],
  gyms: ['gym', 'fitness_center'],
  real_estate: ['real_estate_agency'],
} as const satisfies Record<string, readonly string[]>;

export type ProspectNiche = keyof typeof PROSPECT_NICHES;

export function normalizeProspectNiche(value: string): ProspectNiche {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!(normalized in PROSPECT_NICHES)) {
    throw new AppError('UNKNOWN_PROSPECT_NICHE', `Unknown prospect niche: ${normalized || '[empty]'}`);
  }
  return normalized as ProspectNiche;
}

export function googleTypesForNiche(value: string): string[] {
  return [...PROSPECT_NICHES[normalizeProspectNiche(value)]];
}
