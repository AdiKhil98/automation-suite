import { randomUUID } from 'node:crypto';
import { ProspectCircuitBreaker } from './circuit-breaker.js';
import { validateProspectInput } from './validation.js';
import {
  type ProspectCandidateOutcome, type ProspectCandidateResult, type ProspectExternalCalls,
  type ProspectInput, type ProspectRunResult, type ProspectRunSummary, type ResolvedLocation,
  type ResolvedProspectInput,
} from './types.js';

export interface ProspectLocationResolver { resolve(location: string): Promise<ResolvedLocation> }
export interface ProspectNearbySearch { discover(input: { includedTypes: string[]; location: ResolvedLocation; radiusKm: number; maxCandidates: number; rankPreference: ResolvedProspectInput['rankPreference'] }): Promise<{ placeIds: string[]; requests: 1 }> }
export interface ProspectCandidateProcessor { process(input: { prospectRunId: string; pipelineRunId: string; sourceRequestId: string; campaign: string; niche: string; includedTypes: string[]; placeId: string; position: number }): Promise<ProspectCandidateResult> }
export interface ProspectContinuation { continueFirstQualified(leadId: string): Promise<void> }

export interface ProspectStore {
  start(input: { id: string; pipelineRunId: string; options: ResolvedProspectInput; location: ResolvedLocation; discoveredAt: Date }): Promise<void>;
  recordDiscoveryRequest(input: { pipelineRunId: string; campaign: string; options: ResolvedProspectInput; location: ResolvedLocation; resultCount: number; startedAt: Date; completedAt: Date }): Promise<string>;
  saveCandidates(runId: string, placeIds: string[]): Promise<void>;
  updateCandidate(runId: string, position: number, result: ProspectCandidateResult): Promise<void>;
  finish(input: { runId: string; result: ProspectRunResult; qualifiedCount: number; processedCount: number; externalCalls: ProspectExternalCalls; circuitBreakerReason: string | null; completedAt: Date }): Promise<void>;
}

export interface ProspectLimits { maxDetails: number; maxWebsiteVerifications: number }

export class ProspectService {
  constructor(private readonly deps: { locationResolver: ProspectLocationResolver; nearby: ProspectNearbySearch; processor: ProspectCandidateProcessor; store: ProspectStore; limits: ProspectLimits; continuation?: ProspectContinuation; now?: () => Date }) {}

  async run(input: ProspectInput, pipelineRunId: string): Promise<ProspectRunSummary> {
    const options = validateProspectInput(input);
    const now = this.deps.now ?? (() => new Date());
    const location = options.latitude !== undefined && options.longitude !== undefined
      ? { latitude: options.latitude, longitude: options.longitude, formattedLocation: options.location || 'manual coordinates', provider: 'manual' as const, resolvedAt: now(), externalRequests: 0 }
      : await this.deps.locationResolver.resolve(options.location);
    const runId = randomUUID();
    await this.deps.store.start({ id: runId, pipelineRunId, options, location, discoveredAt: now() });
    const discoveryStarted = now();
    let discovery;
    try {
      discovery = await this.deps.nearby.discover({ includedTypes: options.includedTypes, location, radiusKm: options.radiusKm, maxCandidates: options.maxCandidates, rankPreference: options.rankPreference });
    } catch {
      const externalCalls: ProspectExternalCalls = { locationResolution: location.externalRequests, nearbySearch: 1, placeDetails: 0, websiteVerification: 0 };
      await this.deps.store.finish({ runId, result: 'SYSTEMIC_FAILURE', qualifiedCount: 0, processedCount: 0, externalCalls, circuitBreakerReason: 'nearby_provider_failure', completedAt: now() });
      return { runId, result: 'SYSTEMIC_FAILURE', discovered: 0, processed: 0, qualifiedLeadIds: [], externalCalls, circuitBreakerReason: 'nearby_provider_failure' };
    }
    const sourceRequestId = await this.deps.store.recordDiscoveryRequest({ pipelineRunId, campaign: `prospect:${options.niche}`, options, location, resultCount: discovery.placeIds.length, startedAt: discoveryStarted, completedAt: now() });
    await this.deps.store.saveCandidates(runId, discovery.placeIds);

    const externalCalls: ProspectExternalCalls = { locationResolution: location.externalRequests, nearbySearch: discovery.requests, placeDetails: 0, websiteVerification: 0 };
    const qualifiedLeadIds: string[] = [];
    const breaker = new ProspectCircuitBreaker();
    let processed = 0; let result: ProspectRunResult = 'CANDIDATE_BUDGET_EXHAUSTED'; let circuitBreakerReason: string | null = null;

    for (let position = 0; position < discovery.placeIds.length && position < options.maxCandidates; position += 1) {
      if (externalCalls.placeDetails >= this.deps.limits.maxDetails || externalCalls.websiteVerification >= this.deps.limits.maxWebsiteVerifications) { result = 'EXTERNAL_BUDGET_EXHAUSTED'; break }
      const placeId = discovery.placeIds[position] as string;
      let candidate: ProspectCandidateResult;
      try {
        candidate = await this.deps.processor.process({ prospectRunId: runId, pipelineRunId, sourceRequestId, campaign: `prospect:${options.niche}`, niche: options.niche, includedTypes: options.includedTypes, placeId, position });
      } catch {
        candidate = { outcome: 'SYSTEMIC_FAILURE', leadId: null, reason: 'candidate_processor_failure', detailsRequests: 0, websiteVerifications: 0 };
      }
      processed += 1;
      externalCalls.placeDetails += candidate.detailsRequests;
      externalCalls.websiteVerification += candidate.websiteVerifications;
      await this.deps.store.updateCandidate(runId, position, candidate);
      if (candidate.outcome === 'QUALIFIED' && candidate.leadId) qualifiedLeadIds.push(candidate.leadId);
      if (candidate.outcome === 'SYSTEMIC_FAILURE') { result = 'SYSTEMIC_FAILURE'; circuitBreakerReason = candidate.reason; break }
      const observed = breaker.observe(candidate);
      if (observed.tripped) { result = 'SYSTEMIC_FAILURE'; circuitBreakerReason = observed.reason; break }
      if (qualifiedLeadIds.length >= options.targetQualified) { result = 'TARGET_REACHED'; break }
    }
    if (qualifiedLeadIds.length < options.targetQualified && result === 'CANDIDATE_BUDGET_EXHAUSTED' && processed < discovery.placeIds.length) result = 'EXTERNAL_BUDGET_EXHAUSTED';
    await this.deps.store.finish({ runId, result, qualifiedCount: qualifiedLeadIds.length, processedCount: processed, externalCalls, circuitBreakerReason, completedAt: now() });
    if (options.continuePipeline && qualifiedLeadIds[0] && this.deps.continuation) await this.deps.continuation.continueFirstQualified(qualifiedLeadIds[0]);
    return { runId, result, discovered: discovery.placeIds.length, processed, qualifiedLeadIds, externalCalls, circuitBreakerReason };
  }
}

export function isCandidateSpecificOutcome(outcome: ProspectCandidateOutcome): boolean {
  return outcome !== 'SYSTEMIC_FAILURE';
}
