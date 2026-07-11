import { type NewLead } from '../domain/leads/lead.js';

/**
 * Deterministic sample leads used by the `create-sample-leads` CLI command for
 * local development. Dentistry is used purely as example data (per the spec —
 * never a hardcoded permanent niche). Qualification/scoring is a later phase.
 */
export const sampleLeads: NewLead[] = [
  {
    businessName: 'Bright Smile Dental Practice',
    domain: 'https://www.brightsmiledental.example',
    placeId: 'sample-place-0001',
    city: 'Manchester',
    country: 'GB',
    priority: null,
    source: 'fixture',
  },
  {
    businessName: 'Riverside Family Dentistry',
    domain: 'riversidefamilydentistry.example',
    placeId: 'sample-place-0002',
    city: 'Manchester',
    country: 'GB',
    priority: null,
    source: 'fixture',
  },
  {
    businessName: 'City Centre Orthodontics',
    domain: null,
    placeId: 'sample-place-0003',
    city: 'Manchester',
    country: 'GB',
    priority: null,
    source: 'fixture',
  },
  {
    businessName: 'Parkview Dental Care',
    domain: 'http://parkviewdentalcare.example/home',
    placeId: 'sample-place-0004',
    city: 'Salford',
    country: 'GB',
    priority: null,
    source: 'fixture',
  },
];
