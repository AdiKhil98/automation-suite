import { AppError } from '../../utils/errors.js';
import { googleTypesForNiche, normalizeProspectNiche } from './niches.js';
import { PROSPECT_RANKS, type ProspectInput, type ResolvedProspectInput } from './types.js';

function finite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new AppError('INVALID_PROSPECT_INPUT', `${field} must be finite`);
}

export function validateProspectInput(input: ProspectInput): ResolvedProspectInput {
  const niche = normalizeProspectNiche(input.niche);
  const location = input.location.trim();
  finite(input.radiusKm, 'radiusKm');
  if (input.radiusKm <= 0 || input.radiusKm > 50) throw new AppError('INVALID_PROSPECT_RADIUS', 'radiusKm must be greater than 0 and no more than 50');
  if (!Number.isInteger(input.maxCandidates) || input.maxCandidates < 1 || input.maxCandidates > 20) throw new AppError('INVALID_PROSPECT_CANDIDATE_CAP', 'maxCandidates must be an integer from 1 to 20');
  if (!Number.isInteger(input.targetQualified) || input.targetQualified < 1 || input.targetQualified > input.maxCandidates) throw new AppError('INVALID_PROSPECT_TARGET', 'targetQualified must be from 1 to maxCandidates');
  if (!PROSPECT_RANKS.includes(input.rankPreference)) throw new AppError('INVALID_PROSPECT_RANK', 'rankPreference must be POPULARITY or DISTANCE');
  const hasLatitude = input.latitude !== undefined;
  const hasLongitude = input.longitude !== undefined;
  if (hasLatitude !== hasLongitude) throw new AppError('INVALID_PROSPECT_COORDINATES', 'latitude and longitude must be supplied together');
  if (hasLatitude && hasLongitude) {
    finite(input.latitude as number, 'latitude'); finite(input.longitude as number, 'longitude');
    if ((input.latitude as number) < -90 || (input.latitude as number) > 90 || (input.longitude as number) < -180 || (input.longitude as number) > 180) throw new AppError('INVALID_PROSPECT_COORDINATES', 'coordinates are outside valid bounds');
  } else if (!location) throw new AppError('INVALID_PROSPECT_LOCATION', 'location is required when coordinates are not supplied');
  return { ...input, niche, location, includedTypes: googleTypesForNiche(niche) };
}
