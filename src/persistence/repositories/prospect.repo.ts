import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { type ProspectStore } from '../../domain/prospect/prospect-service.js';
import { type ResolvedLocation } from '../../domain/prospect/types.js';
import { type LocationCache } from '../../integrations/prospect/location-resolver.js';
import { type DbExecutor } from '../db.js';
import { leads, prospectCandidates, prospectLocationCache, prospectRuns, sourceEntities } from '../schema.js';
import { SourceRequestsRepository } from './source.repo.js';

export class ProspectRepository implements ProspectStore, LocationCache {
  constructor(private readonly db: DbExecutor) {}

  async find(normalizedLocation: string): Promise<Omit<ResolvedLocation, 'externalRequests'> | null> {
    const rows = await this.db.select().from(prospectLocationCache).where(eq(prospectLocationCache.normalizedLocation, normalizedLocation)).limit(1);
    const row = rows[0];
    if (!row || Date.now() - row.resolvedAt.getTime() > 30 * 24 * 60 * 60 * 1000) return null;
    return { latitude: row.latitude, longitude: row.longitude, formattedLocation: row.formattedLocation, provider: 'google_places', resolvedAt: row.resolvedAt };
  }

  async save(normalizedLocation: string, location: Omit<ResolvedLocation, 'externalRequests'>): Promise<void> {
    if (location.provider !== 'google_places') return;
    await this.db.insert(prospectLocationCache).values({ id: randomUUID(), normalizedLocation, formattedLocation: location.formattedLocation, latitude: location.latitude, longitude: location.longitude, provider: location.provider, resolvedAt: location.resolvedAt }).onConflictDoNothing({ target: prospectLocationCache.normalizedLocation });
  }

  async start(input: Parameters<ProspectStore['start']>[0]): Promise<void> {
    await this.db.insert(prospectRuns).values({
      id: input.id, pipelineRunId: input.pipelineRunId, operatorNiche: input.options.niche,
      includedTypes: input.options.includedTypes, requestedLocation: input.options.location,
      formattedLocation: input.location.formattedLocation, latitude: input.location.latitude,
      longitude: input.location.longitude, locationProvider: input.location.provider,
      radiusKm: input.options.radiusKm, rankPreference: input.options.rankPreference,
      targetQualified: input.options.targetQualified, maxCandidates: input.options.maxCandidates,
      continuePipeline: input.options.continuePipeline, status: 'RUNNING',
      externalCalls: { locationResolution: input.location.externalRequests, nearbySearch: 0, placeDetails: 0, websiteVerification: 0 },
      discoveredAt: input.discoveredAt,
    });
  }

  async recordDiscoveryRequest(input: Parameters<ProspectStore['recordDiscoveryRequest']>[0]): Promise<string> {
    return new SourceRequestsRepository(this.db).record({
      runId: input.pipelineRunId, campaign: input.campaign, provider: 'google_places',
      query: { niche: input.options.niche, includedTypes: input.options.includedTypes, center: { latitude: input.location.latitude, longitude: input.location.longitude }, radiusKm: input.options.radiusKm, rankPreference: input.options.rankPreference, maxResultCount: input.options.maxCandidates },
      fieldMask: 'places.id', pageIndex: 0, resultCount: input.resultCount, billedTier: 'Pro', estimatedCostUsd: null,
      status: input.resultCount > 0 ? 'OK' : 'EMPTY', startedAt: input.startedAt, completedAt: input.completedAt,
    });
  }

  async saveCandidates(runId: string, placeIds: string[]): Promise<void> {
    if (placeIds.length === 0) return;
    await this.db.insert(prospectCandidates).values(placeIds.map((placeId, position) => ({ id: randomUUID(), prospectRunId: runId, placeId, position, outcome: 'DISCOVERED' })));
  }

  async updateCandidate(runId: string, position: number, result: Parameters<ProspectStore['updateCandidate']>[2]): Promise<void> {
    await this.db.update(prospectCandidates).set({ leadId: result.leadId, outcome: result.outcome, skipReason: result.reason, websiteFailureStage: result.failureStage ?? null, websiteFailureCode: result.failureCode ?? null, websiteFailureElapsedMs: result.failureElapsedMs ?? null, processedAt: new Date() }).where(and(eq(prospectCandidates.prospectRunId, runId), eq(prospectCandidates.position, position)));
  }

  async finish(input: Parameters<ProspectStore['finish']>[0]): Promise<void> {
    await this.db.update(prospectRuns).set({ status: input.result === 'SYSTEMIC_FAILURE' ? 'FAILED' : 'COMPLETED', result: input.result, qualifiedCount: input.qualifiedCount, processedCount: input.processedCount, externalCalls: input.externalCalls, circuitBreakerReason: input.circuitBreakerReason, completedAt: input.completedAt }).where(eq(prospectRuns.id, input.runId));
  }

  async existingLeadForPlace(placeId: string): Promise<{ leadId: string; status: string } | null> {
    const entityRows = await this.db.select({ leadId: sourceEntities.leadId, status: leads.status }).from(sourceEntities).innerJoin(leads, eq(leads.id, sourceEntities.leadId)).where(and(eq(sourceEntities.provider, 'google_places'), eq(sourceEntities.sourcePlaceId, placeId))).limit(1);
    if (entityRows[0]) return entityRows[0];
    const leadRows = await this.db.select({ leadId: leads.id, status: leads.status }).from(leads).where(eq(leads.placeId, placeId)).limit(1);
    return leadRows[0] ?? null;
  }

  async attachedToOtherActiveRun(placeId: string, currentRunId: string): Promise<boolean> {
    const rows = await this.db.select({ id: prospectCandidates.id }).from(prospectCandidates).innerJoin(prospectRuns, eq(prospectRuns.id, prospectCandidates.prospectRunId)).where(and(eq(prospectCandidates.placeId, placeId), ne(prospectCandidates.prospectRunId, currentRunId), eq(prospectRuns.status, 'RUNNING'))).limit(1);
    return rows.length > 0;
  }
}
