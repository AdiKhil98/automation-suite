import { AppError } from '../utils/errors.js';

/**
 * Campaigns are configured in code for Phase 2 (approved deviation): a named niche
 * + geography + query. Run history lives in `pipeline_runs`; DB-backed campaign
 * tables are deferred until a phase needs their persistence.
 */
export interface CampaignNiche {
  allowedCategories: string[];
  excludeChains: boolean;
  chainNames: string[]; // explicit normalized names, or empty (no placeholders)
}

export interface Campaign {
  name: string;
  provider: 'mock' | 'google_places';
  query: { textQuery: string; locationBias?: unknown };
  niche: CampaignNiche;
}

const dentalNiche: CampaignNiche = {
  allowedCategories: ['dentist', 'dental clinic', 'orthodontist'],
  excludeChains: true,
  chainNames: [], // operator maintains explicit normalized chain names
};

export const campaigns: Record<string, Campaign> = {
  'dental-manchester-test': {
    name: 'dental-manchester-test',
    provider: 'mock',
    query: { textQuery: 'dentist in Manchester' },
    niche: dentalNiche,
  },
  'dental-manchester-google': {
    name: 'dental-manchester-google',
    provider: 'google_places',
    query: { textQuery: 'dentist in Manchester UK' },
    niche: dentalNiche,
  },
  // Phase 7A4C-PREP controlled pilot: independent dental clinics, London market.
  'dental-london-google': {
    name: 'dental-london-google',
    provider: 'google_places',
    query: { textQuery: 'dentist in London UK' },
    niche: dentalNiche,
  },
  // Dedicated label for the Phase 6 Gate A single-lead live smoke test.
  'gate-a-zahnaerzte-berlin': {
    name: 'gate-a-zahnaerzte-berlin',
    provider: 'mock',
    query: { textQuery: 'Zahnärzte am Ufer Berlin' },
    niche: dentalNiche,
  },
  'prospect-runtime': {
    name: 'prospect-runtime',
    provider: 'mock',
    query: { textQuery: 'bounded prospect continuation' },
    niche: { allowedCategories: ['dentist', 'dental_clinic', 'lawyer', 'gym', 'fitness_center', 'real_estate_agency'], excludeChains: true, chainNames: [] },
  },
};

export function getCampaign(name: string): Campaign {
  const campaign = campaigns[name];
  if (!campaign) {
    const known = Object.keys(campaigns).join(', ');
    throw new AppError('UNKNOWN_CAMPAIGN', `Unknown campaign "${name}". Known: ${known}`);
  }
  return campaign;
}
