import { type Logger } from 'pino';
import { decideMatch, type DedupInput } from '../domain/leads/dedup.js';
import { buildCandidateLead, buildLeadFromFacts } from '../domain/leads/lead-factory.js';
import {
  normalizeAddress,
  normalizeDomain,
  normalizeName,
  normalizePhone,
} from '../domain/leads/normalize.js';
import { type ObservationMatchTier, type ProcessingResult } from '../domain/lead-sources/source-observation.js';
import {
  type CollectQuery,
  type LeadSourceProvider,
  type RawCandidate,
} from '../integrations/lead-source/provider.js';
import { type CollectTxRepos, type SourceRequestStore, type UnitOfWork } from './ports.js';

export interface CollectDeps {
  provider: LeadSourceProvider;
  requests: SourceRequestStore;
  uow: UnitOfWork;
  logger: Logger;
  now?: () => Date;
}

export interface CollectOptions {
  runId: string;
  campaign: string;
  query: CollectQuery;
  caps: { maxLeads: number; pageSize: number; maxPages: number };
  nearMeters: number;
  /** Provenance for durable facts from non-Google providers. Never 'google_places'. */
  factsSource: 'mock' | 'manual';
}

export interface CollectSummary {
  created: number;
  duplicates: number;
  refreshed: number;
  ambiguous: number;
  branches: number;
  rejected: number;
  failed: number;
  requests: number;
  pages: number;
  stoppedAtCap: boolean;
  interrupted: boolean;
}

interface CandidateOutcome {
  result: ProcessingResult | 'REJECTED' | 'BRANCH';
  newLead: boolean;
}

function factsToDedupInput(facts: NonNullable<RawCandidate['facts']>): DedupInput {
  return {
    normalizedName: normalizeName(facts.businessName),
    normalizedDomain: normalizeDomain(facts.domain),
    normalizedPhone: normalizePhone(facts.phone),
    normalizedAddress: normalizeAddress(facts.formattedAddress),
    latitude: facts.latitude,
    longitude: facts.longitude,
    city: facts.city,
  };
}

function hasIdentity(facts: NonNullable<RawCandidate['facts']>): boolean {
  return Boolean(facts.businessName?.trim() || facts.domain?.trim() || facts.phone?.trim());
}

/**
 * Collect leads from a provider: page through results, record one source_request
 * per page (cost accounted here), and process each candidate in its own
 * transaction. Idempotent via source_entities; reruns append observations and never
 * duplicate leads. On provider failure the run stops safely (rerun from page 1).
 */
export async function collectLeads(
  deps: CollectDeps,
  opts: CollectOptions,
): Promise<CollectSummary> {
  const now = deps.now ?? ((): Date => new Date());
  const provider = deps.provider.name;
  const summary: CollectSummary = {
    created: 0,
    duplicates: 0,
    refreshed: 0,
    ambiguous: 0,
    branches: 0,
    rejected: 0,
    failed: 0,
    requests: 0,
    pages: 0,
    stoppedAtCap: false,
    interrupted: false,
  };

  const newLeadCount = (): number => summary.created + summary.ambiguous + summary.branches;

  try {
    for await (const page of deps.provider.pages(opts.query, {
      pageSize: opts.caps.pageSize,
      maxPages: opts.caps.maxPages,
    })) {
      summary.pages += 1;

      const requestId = await deps.requests.record({
        runId: opts.runId,
        campaign: opts.campaign,
        provider,
        query: page.request.query,
        fieldMask: page.request.fieldMask,
        pageIndex: page.request.pageIndex,
        resultCount: page.request.resultCount,
        billedTier: page.request.billedTier,
        estimatedCostUsd: page.request.estimatedCostUsd,
        status: page.request.status,
        startedAt: page.request.startedAt,
        completedAt: page.request.completedAt,
      });
      summary.requests += 1;

      if (page.request.status === 'FAILED') {
        summary.interrupted = true;
        deps.logger.warn({ pageIndex: page.request.pageIndex }, 'provider page failed; stopping run');
        break;
      }

      for (const candidate of page.candidates) {
        if (newLeadCount() >= opts.caps.maxLeads) {
          summary.stoppedAtCap = true;
          break;
        }

        try {
          const outcome = await deps.uow.transaction((repos) =>
            processCandidate(repos, candidate, requestId, provider, opts, now()),
          );
          switch (outcome.result) {
            case 'CREATED':
              summary.created += 1;
              break;
            case 'DUPLICATE':
              summary.duplicates += 1;
              break;
            case 'REFRESHED':
              summary.refreshed += 1;
              break;
            case 'AMBIGUOUS':
              summary.ambiguous += 1;
              break;
            case 'BRANCH':
              summary.branches += 1;
              break;
            case 'REJECTED':
              summary.rejected += 1;
              break;
          }
        } catch (err) {
          summary.failed += 1;
          deps.logger.error(
            { sourcePlaceId: candidate.sourcePlaceId, err: err instanceof Error ? err.message : String(err) },
            'candidate processing failed and rolled back',
          );
        }
      }

      if (summary.stoppedAtCap) break;
    }
  } catch (err) {
    summary.interrupted = true;
    deps.logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'collection interrupted; rerun from page 1 (idempotent)',
    );
  }

  return summary;
}

async function processCandidate(
  repos: CollectTxRepos,
  candidate: RawCandidate,
  requestId: string,
  provider: string,
  opts: CollectOptions,
  now: Date,
): Promise<CandidateOutcome> {
  const sourcePlaceId = candidate.sourcePlaceId.trim();

  // Validation: reject malformed candidates (recorded as an event, no entity).
  const invalid =
    sourcePlaceId.length === 0 || (candidate.facts !== null && !hasIdentity(candidate.facts));
  if (invalid) {
    await repos.events.record({
      leadId: null,
      runId: opts.runId,
      type: 'LEAD_REJECTED',
      fromStatus: null,
      toStatus: null,
      message: `Malformed candidate rejected (placeId="${candidate.sourcePlaceId}")`,
      data: null,
    });
    return { result: 'REJECTED', newLead: false };
  }

  // Idempotency: known (provider, Place ID) => reuse the same lead, append observation.
  const existing = await repos.entities.findByProviderPlaceId(provider, sourcePlaceId);
  if (existing) {
    await repos.entities.touchLastSeen(existing.id, now);
    await repos.observations.create({
      sourceEntityId: existing.id,
      sourceRequestId: requestId,
      processingResult: 'REFRESHED',
      matchTier: 'PLACE_ID',
    });
    await repos.events.record({
      leadId: existing.leadId,
      runId: opts.runId,
      type: 'SOURCE_REFRESHED',
      fromStatus: null,
      toStatus: null,
      message: `Re-observed ${provider} place ${sourcePlaceId}`,
      data: null,
    });
    return { result: 'REFRESHED', newLead: false };
  }

  let leadId: string;
  let result: ProcessingResult | 'BRANCH';
  let matchTier: ObservationMatchTier | null;
  let eventType:
    | 'LEAD_COLLECTED'
    | 'LEAD_DUPLICATE'
    | 'LEAD_BRANCH'
    | 'LEAD_AMBIGUOUS';
  let message: string;

  if (candidate.facts === null) {
    // Google discovery: Place-ID-only candidate. No dedup fields, no facts stored.
    const lead = buildCandidateLead({ sourcePlaceId, source: provider, now });
    await repos.leads.create(lead);
    leadId = lead.id;
    result = 'CREATED';
    matchTier = 'NONE';
    eventType = 'LEAD_COLLECTED';
    message = `Candidate created from ${provider} place ${sourcePlaceId}`;
  } else {
    const input = factsToDedupInput(candidate.facts);
    const candidates = await repos.leads.findDedupCandidates(input);
    const decision = decideMatch(input, candidates, { nearMeters: opts.nearMeters });

    if (decision.kind === 'DUPLICATE') {
      leadId = decision.leadId;
      result = 'DUPLICATE';
      matchTier = decision.tier;
      eventType = 'LEAD_DUPLICATE';
      message = `Duplicate of ${decision.leadId} (${decision.tier})`;
    } else if (decision.kind === 'BRANCH') {
      const lead = buildLeadFromFacts(candidate.facts, {
        factsSource: opts.factsSource,
        source: provider,
        placeId: sourcePlaceId,
        now,
      });
      await repos.leads.create(lead);
      leadId = lead.id;
      result = 'BRANCH';
      matchTier = 'BRANCH';
      eventType = 'LEAD_BRANCH';
      message = `Separate branch; related to ${decision.relatedLeadId} (not merged)`;
    } else if (decision.kind === 'AMBIGUOUS') {
      const base = buildLeadFromFacts(candidate.facts, {
        factsSource: opts.factsSource,
        source: provider,
        placeId: sourcePlaceId,
        now,
      });
      const lead = { ...base, dedupStatus: 'AMBIGUOUS' as const, duplicateOf: decision.candidateLeadId };
      await repos.leads.create(lead);
      leadId = lead.id;
      result = 'AMBIGUOUS';
      matchTier = 'AMBIGUOUS';
      eventType = 'LEAD_AMBIGUOUS';
      message = `Ambiguous vs ${decision.candidateLeadId}; flagged for review (not merged)`;
    } else {
      const lead = buildLeadFromFacts(candidate.facts, {
        factsSource: opts.factsSource,
        source: provider,
        placeId: sourcePlaceId,
        now,
      });
      await repos.leads.create(lead);
      leadId = lead.id;
      result = 'CREATED';
      matchTier = 'NONE';
      eventType = 'LEAD_COLLECTED';
      message = `Lead created from ${provider} (${candidate.facts.businessName ?? 'unnamed'})`;
    }
  }

  const entity = await repos.entities.create({ provider, sourcePlaceId, leadId });
  await repos.observations.create({
    sourceEntityId: entity.id,
    sourceRequestId: requestId,
    processingResult: result === 'BRANCH' ? 'CREATED' : result,
    matchTier,
  });
  await repos.events.record({
    leadId,
    runId: opts.runId,
    type: eventType,
    fromStatus: null,
    toStatus: result === 'DUPLICATE' ? null : 'NEW',
    message,
    data: null,
  });

  const newLead = result === 'CREATED' || result === 'BRANCH' || result === 'AMBIGUOUS';
  return { result, newLead };
}
