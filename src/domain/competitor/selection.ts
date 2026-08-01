import { MAX_SELECTED_COMPETITORS, PROXIMITY_FALLBACK_KM, PROXIMITY_PRIMARY_KM } from './constants.js';
import { normalizeName } from '../leads/normalize.js';
import { normalizeCandidate, prepareProspect, scoreCandidate, type PreparedProspect } from './scoring.js';
import {
  type ActiveRadius,
  type CompetitorInputCandidate,
  type EvaluatedCandidate,
  type ProspectProfileInput,
  type RejectionReason,
  type ResearchOutcome,
  type SelectionResult,
} from './types.js';

export interface SelectionConfig {
  primaryRadiusKm: number;
  fallbackRadiusKm: number;
  maxSelected: number;
}

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  primaryRadiusKm: PROXIMITY_PRIMARY_KM,
  fallbackRadiusKm: PROXIMITY_FALLBACK_KM,
  maxSelected: MAX_SELECTED_COMPETITORS,
};

function rejectedShell(
  input: CompetitorInputCandidate,
  reason: RejectionReason,
  detail: string,
): EvaluatedCandidate {
  const cand = normalizeCandidate(input);
  return {
    input,
    normalizedDomain: cand.normalizedDomain,
    normalizedName: cand.normalizedName,
    normalizedParentBrand: cand.normalizedParentBrand,
    brandKey: cand.brandKey,
    normalizedPrimaryCategory: cand.normalizedCategory,
    normalizedServices: cand.normalizedServices,
    distanceMeters: null,
    categoryMatch: null,
    comparabilityScore: null,
    confidence: null,
    scoreBreakdown: [],
    gateResults: [{ gate: 'dedup', passed: false, detail }],
    disposition: 'REJECTED',
    rejectionReason: reason,
    reasonDetail: detail,
    acceptanceRank: null,
  };
}

/** Deterministic within-set deduplication. First occurrence wins; later duplicates are rejected. */
function deduplicate(inputs: CompetitorInputCandidate[]): {
  survivors: CompetitorInputCandidate[];
  duplicates: EvaluatedCandidate[];
} {
  const seenProviderIds = new Set<string>();
  const seenDomains = new Set<string>();
  const seenIdentities = new Set<string>();
  const survivors: CompetitorInputCandidate[] = [];
  const duplicates: EvaluatedCandidate[] = [];

  for (const input of [...inputs].sort((a, b) => a.rowIndex - b.rowIndex)) {
    const cand = normalizeCandidate(input);
    const providerId = input.providerCandidateId?.trim() || null;
    const normCity = normalizeName(input.city);
    const identity = cand.normalizedName && normCity ? `${cand.normalizedName}|${normCity}` : null;

    if (providerId && seenProviderIds.has(providerId)) {
      duplicates.push(rejectedShell(input, 'DUPLICATE_PROVIDER_ID', `duplicate provider candidate id ${providerId}`));
      continue;
    }
    if (cand.normalizedDomain && seenDomains.has(cand.normalizedDomain)) {
      duplicates.push(rejectedShell(input, 'DUPLICATE_DOMAIN', `duplicate normalized domain ${cand.normalizedDomain}`));
      continue;
    }
    if (identity && seenIdentities.has(identity)) {
      duplicates.push(rejectedShell(input, 'DUPLICATE_IDENTITY', `duplicate business identity ${identity}`));
      continue;
    }

    if (providerId) seenProviderIds.add(providerId);
    if (cand.normalizedDomain) seenDomains.add(cand.normalizedDomain);
    if (identity) seenIdentities.add(identity);
    survivors.push(input);
  }
  return { survivors, duplicates };
}

/** Deterministic ranking: score desc, then distance asc, then normalized domain asc. */
function rankAccepted(a: EvaluatedCandidate, b: EvaluatedCandidate): number {
  const sa = a.comparabilityScore ?? -1;
  const sb = b.comparabilityScore ?? -1;
  if (sb !== sa) return sb - sa;
  const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
  const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return (a.normalizedDomain ?? '').localeCompare(b.normalizedDomain ?? '');
}

interface Pass {
  results: EvaluatedCandidate[];
  acceptedCount: number;
}

function runPass(prospect: PreparedProspect, survivors: CompetitorInputCandidate[], radiusKm: number): Pass {
  const results = survivors.map((input) => scoreCandidate(prospect, input, radiusKm));
  return { results, acceptedCount: results.filter((r) => r.disposition === 'ACCEPTED').length };
}

/**
 * Run the full deterministic candidate-selection foundation for one prospect.
 * Dedup → two-pass radius (5 km, expand to 10 km only when < 2 valid inside 5 km) →
 * rank → one-branch-per-parent-brand → cap at maxSelected. No AI, no network.
 */
export function selectCompetitors(
  profile: ProspectProfileInput,
  rawInputs: CompetitorInputCandidate[],
  config: SelectionConfig = DEFAULT_SELECTION_CONFIG,
): SelectionResult {
  const prospect = prepareProspect(profile);
  const { survivors, duplicates } = deduplicate(rawInputs);

  const primary = runPass(prospect, survivors, config.primaryRadiusKm);
  const useFallback = primary.acceptedCount < 2;
  const pass = useFallback ? runPass(prospect, survivors, config.fallbackRadiusKm) : primary;
  const activeRadius: ActiveRadius = useFallback ? 'FALLBACK_10KM' : 'PRIMARY_5KM';

  // Rank accepted, enforce one branch per brand, cap at maxSelected.
  const accepted = pass.results.filter((r) => r.disposition === 'ACCEPTED').sort(rankAccepted);
  const usedBrands = new Set<string>();
  const selected: EvaluatedCandidate[] = [];
  const brandLimited = new Set<CompetitorInputCandidate>();
  const notSelected = new Set<CompetitorInputCandidate>();

  for (const cand of accepted) {
    if (usedBrands.has(cand.brandKey)) {
      brandLimited.add(cand.input);
      continue;
    }
    if (selected.length >= config.maxSelected) {
      notSelected.add(cand.input);
      continue;
    }
    usedBrands.add(cand.brandKey);
    selected.push(cand);
  }

  const selectedSet = new Set(selected.map((s) => s.input));
  let rank = 0;
  const finalized: EvaluatedCandidate[] = pass.results.map((r) => {
    if (r.disposition !== 'ACCEPTED') return r;
    if (selectedSet.has(r.input)) {
      rank += 1;
      return { ...r, acceptanceRank: rank };
    }
    if (brandLimited.has(r.input)) {
      return { ...r, disposition: 'REJECTED', rejectionReason: 'CHAIN_BRANCH_LIMIT', reasonDetail: `only one branch per brand selected (brand ${r.brandKey})` };
    }
    if (notSelected.has(r.input)) {
      return { ...r, disposition: 'REJECTED', rejectionReason: 'NOT_SELECTED', reasonDetail: `scored ${String(r.comparabilityScore)} but only top ${String(config.maxSelected)} selected` };
    }
    return r;
  });

  const candidates = [...finalized, ...duplicates].sort((a, b) => a.input.rowIndex - b.input.rowIndex);
  const finalSelected = finalized
    .filter((c) => c.disposition === 'ACCEPTED')
    .sort((a, b) => (a.acceptanceRank ?? 0) - (b.acceptanceRank ?? 0));
  const acceptedCount = finalSelected.length;
  const rejectedCount = candidates.length - acceptedCount;

  let outcome: ResearchOutcome;
  if (rawInputs.length === 0) outcome = 'NO_CANDIDATES_FOUND';
  else if (acceptedCount >= 2) outcome = 'RESEARCHED';
  else outcome = 'INSUFFICIENT_COMPARABLE';

  return { outcome, activeRadius, candidates, selected: finalSelected, acceptedCount, rejectedCount };
}
