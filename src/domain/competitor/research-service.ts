import { randomUUID } from 'node:crypto';
import { COMPARABILITY_RULES_VERSION } from './constants.js';
import { computeConfigHash, computeInputHash } from './hash.js';
import { DEFAULT_SELECTION_CONFIG, selectCompetitors, type SelectionConfig } from './selection.js';
import {
  type CompetitorInputCandidate,
  type EvaluatedCandidate,
  type ProspectProfileInput,
  type SelectionResult,
} from './types.js';

/** Persisted run header (immutable once written; superseded, never deleted). */
export interface NewCompetitorResearchRun {
  id: string;
  leadId: string;
  runId: string | null;
  provider: string;
  status: 'DRAFT';
  outcome: SelectionResult['outcome'];
  activeRadius: SelectionResult['activeRadius'];
  inputHash: string;
  configHash: string;
  rulesVersion: string;
  version: number;
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  primaryRadiusKm: number;
  fallbackRadiusKm: number;
  maxSelected: number;
}

/** Persisted per-candidate row (raw + normalized + outcome + reasons). */
export interface NewCompetitorCandidate {
  id: string;
  researchRunId: string;
  rowIndex: number;
  providerCandidateId: string | null;
  businessName: string | null;
  normalizedName: string | null;
  rawDomain: string | null;
  normalizedDomain: string | null;
  primaryCategory: string | null;
  normalizedPrimaryCategory: string | null;
  secondaryCategories: string[];
  normalizedServices: string[];
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  market: string | null;
  language: string | null;
  businessType: string | null;
  parentBrand: string | null;
  normalizedParentBrand: string | null;
  branchId: string | null;
  brandKey: string;
  distanceMeters: number | null;
  categoryMatch: string | null;
  comparabilityScore: number | null;
  confidence: string | null;
  disposition: string;
  rejectionReason: string | null;
  reasonDetail: string;
  acceptanceRank: number | null;
  scoreBreakdown: EvaluatedCandidate['scoreBreakdown'];
  gateResults: EvaluatedCandidate['gateResults'];
}

export interface ExistingRunRef {
  id: string;
  version: number;
  outcome: string;
  status: string;
}

export interface CompetitorResearchStore {
  findRunByHashes(leadId: string, inputHash: string, configHash: string): Promise<ExistingRunRef | null>;
  maxVersionForLead(leadId: string): Promise<number>;
  supersedePriorDraftRuns(leadId: string, newRunId: string): Promise<void>;
  insertRun(run: NewCompetitorResearchRun): Promise<void>;
  insertCandidates(rows: NewCompetitorCandidate[]): Promise<void>;
}

export interface CompetitorResearchTxRepos {
  research: CompetitorResearchStore;
}
export interface CompetitorResearchUnitOfWork {
  transaction<T>(fn: (repos: CompetitorResearchTxRepos) => Promise<T>): Promise<T>;
}

export interface ResearchRunOptions {
  runId?: string | null;
  provider: string;
  apply: boolean;
  config?: SelectionConfig;
}

export interface ResearchRunResult {
  selection: SelectionResult;
  inputHash: string;
  configHash: string;
  persisted: boolean;
  reusedExisting: boolean;
  runRecordId: string | null;
  version: number | null;
}

function toCandidateRows(runId: string, evaluated: EvaluatedCandidate[]): NewCompetitorCandidate[] {
  return evaluated.map((c) => ({
    id: randomUUID(),
    researchRunId: runId,
    rowIndex: c.input.rowIndex,
    providerCandidateId: c.input.providerCandidateId,
    businessName: c.input.businessName,
    normalizedName: c.normalizedName,
    rawDomain: c.input.website,
    normalizedDomain: c.normalizedDomain,
    primaryCategory: c.input.primaryCategory,
    normalizedPrimaryCategory: c.normalizedPrimaryCategory,
    secondaryCategories: c.input.secondaryCategories,
    normalizedServices: c.normalizedServices,
    latitude: c.input.latitude,
    longitude: c.input.longitude,
    city: c.input.city,
    market: c.input.market,
    language: c.input.language,
    businessType: c.input.businessType,
    parentBrand: c.input.parentBrand,
    normalizedParentBrand: c.normalizedParentBrand,
    branchId: c.input.branchId,
    brandKey: c.brandKey,
    distanceMeters: c.distanceMeters,
    categoryMatch: c.categoryMatch,
    comparabilityScore: c.comparabilityScore,
    confidence: c.confidence,
    disposition: c.disposition,
    rejectionReason: c.rejectionReason,
    reasonDetail: c.reasonDetail,
    acceptanceRank: c.acceptanceRank,
    scoreBreakdown: c.scoreBreakdown,
    gateResults: c.gateResults,
  }));
}

/**
 * Phase 7A1 orchestration: deterministic selection (always) + optional idempotent persistence of a
 * DRAFT run. A dry run computes and returns the selection with ZERO writes. An apply run persists
 * inside one transaction: identical (leadId,inputHash,configHash) reuses the existing run (no
 * duplicate); materially changed input creates the next immutable version and supersedes prior
 * DRAFT runs (never deletes). Never captures websites, calls AI, sends, or touches Gmail/Sheets.
 */
export class CompetitorResearchService {
  constructor(private readonly uow: CompetitorResearchUnitOfWork) {}

  async run(
    profile: ProspectProfileInput,
    candidates: CompetitorInputCandidate[],
    options: ResearchRunOptions,
  ): Promise<ResearchRunResult> {
    const config = options.config ?? DEFAULT_SELECTION_CONFIG;
    const selection = selectCompetitors(profile, candidates, config);
    const inputHash = computeInputHash(profile, candidates);
    const configHash = computeConfigHash(config);

    if (!options.apply) {
      return { selection, inputHash, configHash, persisted: false, reusedExisting: false, runRecordId: null, version: null };
    }

    return this.uow.transaction(async ({ research }) => {
      const existing = await research.findRunByHashes(profile.leadId, inputHash, configHash);
      if (existing) {
        return { selection, inputHash, configHash, persisted: false, reusedExisting: true, runRecordId: existing.id, version: existing.version };
      }
      const runRecordId = randomUUID();
      const version = (await research.maxVersionForLead(profile.leadId)) + 1;
      await research.supersedePriorDraftRuns(profile.leadId, runRecordId);
      await research.insertRun({
        id: runRecordId,
        leadId: profile.leadId,
        runId: options.runId ?? null,
        provider: options.provider,
        status: 'DRAFT',
        outcome: selection.outcome,
        activeRadius: selection.activeRadius,
        inputHash,
        configHash,
        rulesVersion: COMPARABILITY_RULES_VERSION,
        version,
        candidateCount: selection.candidates.length,
        acceptedCount: selection.acceptedCount,
        rejectedCount: selection.rejectedCount,
        primaryRadiusKm: config.primaryRadiusKm,
        fallbackRadiusKm: config.fallbackRadiusKm,
        maxSelected: config.maxSelected,
      });
      await research.insertCandidates(toCandidateRows(runRecordId, selection.candidates));
      return { selection, inputHash, configHash, persisted: true, reusedExisting: false, runRecordId, version };
    });
  }
}
