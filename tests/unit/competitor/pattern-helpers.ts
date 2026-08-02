import { type EvidenceCategory } from '../../../src/domain/competitor/evidence-types.js';
import {
  type PatternBuildInput,
  type PatternCompetitorInput,
  type PatternEvidenceItem,
  type ProspectEvidenceInput,
  type ProspectEvidenceRef,
} from '../../../src/domain/competitor/pattern-types.js';

/** Deterministic clock for freshness. Evidence captured at NOW is age 0 (FRESH). */
export const NOW = new Date('2026-02-01T00:00:00.000Z');
export const MAX_AGE_DAYS = 30;

let seq = 0;
const nextId = (): string => `id-${String(++seq)}`;

/** Build one competitor evidence item with sensible eligible defaults. */
export function ev(overrides: Partial<PatternEvidenceItem> = {}): PatternEvidenceItem {
  return {
    id: overrides.id ?? nextId(),
    captureRunId: overrides.captureRunId ?? 'cap-1',
    competitorCandidateId: overrides.competitorCandidateId ?? 'cand-x',
    evidenceCategory: (overrides.evidenceCategory ?? 'BOOKING_CTA_VISIBLE') as EvidenceCategory,
    observationKind: overrides.observationKind ?? 'DIRECT_OBSERVATION',
    confidence: overrides.confidence ?? 'HIGH',
    storedFreshness: overrides.storedFreshness ?? 'FRESH',
    safeForOutreach: overrides.safeForOutreach ?? true,
    active: overrides.active ?? true,
    sourcePageUrl: overrides.sourcePageUrl ?? 'https://competitor.example/',
    numericValue: overrides.numericValue ?? null,
    capturedAt: overrides.capturedAt ?? NOW,
    polarity: overrides.polarity ?? 'PRESENT',
    inspectionScope: overrides.inspectionScope ?? null,
  };
}

/** An explicit, scoped negative (verified-absent) competitor evidence item for a category. */
export function negEv(evidenceCategory: string, overrides: Partial<PatternEvidenceItem> = {}): PatternEvidenceItem {
  return ev({ evidenceCategory: evidenceCategory as EvidenceCategory, polarity: 'ABSENT', inspectionScope: overrides.inspectionScope ?? 'mobile-initial-viewport', ...overrides });
}

/** Build one selected+active+captured competitor with the given evidence. */
export function comp(overrides: Partial<PatternCompetitorInput> & { competitorCandidateId: string; brandKey: string }): PatternCompetitorInput {
  const evidence = (overrides.evidence ?? []).map((e) => ({ ...e, competitorCandidateId: overrides.competitorCandidateId }));
  return {
    competitorCandidateId: overrides.competitorCandidateId,
    brandKey: overrides.brandKey,
    businessName: overrides.businessName ?? null,
    parentBrand: overrides.parentBrand ?? null,
    selected: overrides.selected ?? true,
    captureActive: overrides.captureActive ?? true,
    capturedOk: overrides.capturedOk ?? true,
    evidence,
  };
}

export function noProspect(leadId = 'lead-1'): ProspectEvidenceInput {
  return { leadId, captureRunId: null, capturedAt: null, capturedOk: false, refs: [], negatives: [] };
}

export function prospect(refs: ProspectEvidenceRef[], overrides: Partial<ProspectEvidenceInput> = {}): ProspectEvidenceInput {
  return {
    leadId: overrides.leadId ?? 'lead-1',
    captureRunId: overrides.captureRunId ?? 'prospect-cap-1',
    capturedAt: overrides.capturedAt ?? NOW,
    capturedOk: overrides.capturedOk ?? true,
    refs,
    negatives: overrides.negatives ?? [],
  };
}

export function pref(evidenceType: string, overrides: Partial<ProspectEvidenceRef> = {}): ProspectEvidenceRef {
  return {
    id: overrides.id ?? nextId(),
    evidenceType,
    sourceUrl: overrides.sourceUrl ?? 'https://prospect.example/',
    normalizedValue: overrides.normalizedValue ?? null,
    profile: overrides.profile ?? 'mobile',
  };
}

export function buildInput(
  competitors: PatternCompetitorInput[],
  prospectInput: ProspectEvidenceInput = noProspect(),
  overrides: Partial<PatternBuildInput> = {},
): PatternBuildInput {
  return {
    leadId: overrides.leadId ?? 'lead-1',
    researchRunId: overrides.researchRunId ?? 'research-1',
    captureRunIds: overrides.captureRunIds ?? ['cap-1'],
    competitors,
    prospect: prospectInput,
    now: overrides.now ?? NOW,
    maxAgeDays: overrides.maxAgeDays ?? MAX_AGE_DAYS,
  };
}

/** Capture-time that is stale relative to NOW (>= 30 days old). */
export const STALE_AT = new Date('2025-12-01T00:00:00.000Z');
