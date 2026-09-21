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
  // Phase 7A4C-PREP segment pivot: small independent general-dentistry, outer London (Croydon).
  'dental-croydon-google': {
    name: 'dental-croydon-google',
    provider: 'google_places',
    query: { textQuery: 'dentist in Croydon London UK' },
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

/**
 * Collection-only UK dental geographies. Each area becomes a google_places campaign
 * named `dental-<slug>-google` running `dentist in <area> UK`, reusing dentalNiche.
 * Geographic partitioning works around the Places Text Search per-query result
 * ceiling (20 per page, 3 pages) and reduces overlap between queries. Data only:
 * no new campaign behaviour, no new provider, no orchestration.
 */
const UK_DENTAL_AREAS: readonly string[] = [
  // London boroughs / sub-regions (highest practice density)
  'Camden London', 'Islington London', 'Hackney London', 'Lambeth London',
  'Southwark London', 'Wandsworth London', 'Ealing London', 'Brent London',
  'Barnet London', 'Bromley London', 'Enfield London', 'Hounslow London',
  'Lewisham London', 'Newham London', 'Haringey London', 'Redbridge London',
  'Harrow London', 'Greenwich London', 'Merton London', 'Hillingdon London',
  'Waltham Forest London', 'Barking and Dagenham London', 'Bexley London',
  'Kingston upon Thames London', 'Richmond upon Thames London', 'Havering London',
  // Major cities and large towns across England, Scotland, Wales, Northern Ireland
  'Birmingham', 'Leeds', 'Liverpool', 'Bristol', 'Sheffield', 'Nottingham',
  'Leicester', 'Newcastle upon Tyne', 'Cardiff', 'Edinburgh', 'Glasgow',
  'Coventry', 'Bradford', 'Stoke-on-Trent', 'Wolverhampton', 'Reading',
  'Southampton', 'Portsmouth', 'Brighton', 'Milton Keynes', 'Luton',
  'Northampton', 'Derby', 'Plymouth', 'Kingston upon Hull', 'Aberdeen',
  'Swansea', 'Belfast', 'Oxford', 'Cambridge', 'Norwich', 'Bolton',
  'Sunderland', 'Middlesbrough', 'Preston', 'Blackpool', 'York', 'Ipswich',
  'Exeter', 'Dundee', 'Peterborough', 'Slough', 'Watford', 'Basildon',
  'Doncaster', 'Wigan', 'Huddersfield', 'Warrington', 'Swindon', 'Gloucester',
];

/** `Camden London` -> `dental-camden-london-google`. */
function ukDentalCampaignName(area: string): string {
  const slug = area.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `dental-${slug}-google`;
}

for (const area of UK_DENTAL_AREAS) {
  const name = ukDentalCampaignName(area);
  // Never overwrite a hand-configured campaign (e.g. dental-manchester-google).
  if (name in campaigns) continue;
  campaigns[name] = {
    name,
    provider: 'google_places',
    query: { textQuery: `dentist in ${area} UK` },
    niche: dentalNiche,
  };
}

export function getCampaign(name: string): Campaign {
  const campaign = campaigns[name];
  if (!campaign) {
    const known = Object.keys(campaigns).join(', ');
    throw new AppError('UNKNOWN_CAMPAIGN', `Unknown campaign "${name}". Known: ${known}`);
  }
  return campaign;
}
