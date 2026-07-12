import { AppError } from '../utils/errors.js';

/**
 * Campaigns are configured in code for Phase 2 (approved deviation): a named niche
 * + geography + query. Run history lives in `pipeline_runs`; DB-backed campaign
 * tables are deferred until a phase needs their persistence.
 */
export interface Campaign {
  name: string;
  provider: 'mock' | 'google_places';
  query: { textQuery: string; locationBias?: unknown };
}

export const campaigns: Record<string, Campaign> = {
  'dental-manchester-test': {
    name: 'dental-manchester-test',
    provider: 'mock',
    query: { textQuery: 'dentist in Manchester' },
  },
  'dental-manchester-google': {
    name: 'dental-manchester-google',
    provider: 'google_places',
    query: { textQuery: 'dentist in Manchester UK' },
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
