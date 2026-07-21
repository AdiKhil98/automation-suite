import { type Logger } from 'pino';
import { type EnrichmentService } from '../domain/enrichment/enrichment-service.js';
import { type VerifyOptions } from '../domain/enrichment/verify-domain.js';
import { type ProspectCandidateProcessor } from '../domain/prospect/prospect-service.js';
import { type ProspectCandidateResult } from '../domain/prospect/types.js';
import { type QualificationService } from '../domain/qualification/qualification-service.js';
import { type PlacesDetailsClient } from '../integrations/enrichment/google-places-details.js';
import { processCandidate } from './collect-leads.js';
import { DrizzleUnitOfWork } from '../persistence/unit-of-work.js';
import { type Database } from '../persistence/db.js';
import { DrizzleGooglePlaceDetailsStore } from '../persistence/google-place-details-store.js';
import { LeadFactsRepository } from '../persistence/repositories/lead-facts.repo.js';
import { EnrichmentRepository } from '../persistence/repositories/enrichment.repo.js';
import { ProspectRepository } from '../persistence/repositories/prospect.repo.js';
import { SuppressionRepository } from '../persistence/repositories/suppression.repo.js';
import { QUALIFICATION_RULES } from '../config/qualification-rules.js';

const TERMINAL_DISQUALIFIED = new Set(['DUPLICATE', 'REJECTED_AUTOMATICALLY', 'REJECTED', 'UNSUBSCRIBED', 'FAILED']);

function validWebsite(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname) } catch { return false }
}

export class ProductionProspectCandidateProcessor implements ProspectCandidateProcessor {
  private readonly prospects: ProspectRepository;
  private readonly suppression: SuppressionRepository;
  private readonly detailsStore: DrizzleGooglePlaceDetailsStore;
  private readonly facts: LeadFactsRepository;
  private readonly enrichmentAttempts: EnrichmentRepository;

  constructor(private readonly deps: { db: Database; details: PlacesDetailsClient; enrichment: EnrichmentService; verify: VerifyOptions; qualification: QualificationService; nearMeters: number; logger: Logger }) {
    this.prospects = new ProspectRepository(deps.db); this.suppression = new SuppressionRepository(deps.db);
    this.detailsStore = new DrizzleGooglePlaceDetailsStore(deps.db); this.facts = new LeadFactsRepository(deps.db);
    this.enrichmentAttempts = new EnrichmentRepository(deps.db);
  }

  async process(input: Parameters<ProspectCandidateProcessor['process']>[0]): Promise<ProspectCandidateResult> {
    const calls = { details: 0, website: 0 };
    try { return await this.processCandidate(input, calls) } catch (error) {
      this.deps.logger.error({ code: error instanceof Error ? error.name : 'unknown' }, 'prospect candidate failed closed');
      return this.result('SYSTEMIC_FAILURE', null, 'database_configuration_or_processing_failure', calls.details, calls.website);
    }
  }

  private async processCandidate(input: Parameters<ProspectCandidateProcessor['process']>[0], calls: { details: number; website: number }): Promise<ProspectCandidateResult> {
    if (await this.prospects.attachedToOtherActiveRun(input.placeId, input.prospectRunId)) return this.result('DUPLICATE', null, 'attached_to_another_active_run');
    const existing = await this.prospects.existingLeadForPlace(input.placeId);
    if (existing) return this.result(TERMINAL_DISQUALIFIED.has(existing.status) ? 'DISQUALIFIED' : 'DUPLICATE', existing.leadId, TERMINAL_DISQUALIFIED.has(existing.status) ? 'terminal_disqualification_exists' : 'place_id_already_exists');
    if (await this.suppression.isIdentitySuppressed({ placeId: input.placeId })) return this.result('SUPPRESSED', null, 'place_id_suppressed');

    const collected = await new DrizzleUnitOfWork(this.deps.db).transaction((repos) => processCandidate(repos, { sourcePlaceId: input.placeId, facts: null }, input.sourceRequestId, 'google_places', { runId: input.pipelineRunId, campaign: input.campaign, query: { textQuery: input.campaign }, caps: { maxLeads: 1, pageSize: 1, maxPages: 1 }, nearMeters: this.deps.nearMeters, factsSource: 'manual' }, new Date()));
    if (!collected.leadId || collected.result !== 'CREATED') return this.result('DUPLICATE', collected.leadId, 'candidate_not_created');
    const leadId = collected.leadId;

    let details; calls.details = 1;
    try { details = await this.deps.details.details(input.placeId, { includePhone: false }) } catch (error) {
      this.deps.logger.error({ leadId, code: error instanceof Error ? error.name : 'unknown' }, 'prospect Place Details failed');
      return this.result('SYSTEMIC_FAILURE', leadId, 'place_details_provider_failure', 1);
    }
    if (!details) return this.result('SYSTEMIC_FAILURE', leadId, 'place_details_missing_response', 1);
    await this.detailsStore.persist({ leadId, placeId: input.placeId, provider: 'google_places', retrievedAt: new Date(), details, persistApprovedPhone: false });

    const initial = await this.deps.qualification.qualify(leadId, input.campaign, { allowedCategories: input.includedTypes, excludeChains: true, chainNames: [] }, QUALIFICATION_RULES);
    if (initial.triggeredRules.includes('gate.suppressed')) return this.result('SUPPRESSED', leadId, 'business_or_domain_suppressed', 1);
    if (initial.triggeredRules.includes('gate.permanentlyClosed')) return this.result('CLOSED', leadId, 'business_closed_permanently', 1);
    if (initial.decision === 'REJECT') return this.result('DISQUALIFIED', leadId, initial.reasons.join('; '), 1);
    const website = details.websiteUri?.trim();
    if (!website) return this.result('NO_WEBSITE', leadId, 'place_details_has_no_website', 1);
    if (!validWebsite(website)) return this.result('WEBSITE_INVALID', leadId, 'invalid_candidate_website_url', 1);

    calls.website = 1;
    const enrichment = await this.deps.enrichment.enrich({ leadId, placeId: input.placeId, currentFacts: await this.facts.listCurrentFacts(leadId), manual: { candidateUrls: [website] } }, input.pipelineRunId, this.deps.verify);
    const diagnostic = await this.enrichmentAttempts.latestVerificationForLead(leadId);
    if (enrichment.outcome !== 'VERIFIED') {
      const outcome = enrichment.outcome === 'TRANSIENT_ERROR' ? 'WEBSITE_TRANSIENT' : enrichment.outcome === 'AMBIGUOUS' || enrichment.conflict ? 'MANUAL_REVIEW' : 'WEBSITE_INVALID';
      return { outcome, leadId, reason: `website_verification:${enrichment.outcome}`, detailsRequests: 1, websiteVerifications: 1, failureStage: diagnostic?.failureStage ?? null, failureCode: diagnostic?.errorCode ?? null, failureElapsedMs: diagnostic?.elapsedMs ?? null };
    }
    const final = await this.deps.qualification.qualify(leadId, input.campaign, { allowedCategories: input.includedTypes, excludeChains: true, chainNames: [] }, QUALIFICATION_RULES);
    if (final.decision === 'ACCEPT' && final.nextStep === 'AUDIT') return this.result('QUALIFIED', leadId, final.reasons.join('; '), 1, 1);
    if (final.decision === 'REJECT') return this.result('DISQUALIFIED', leadId, final.reasons.join('; '), 1, 1);
    return this.result('MANUAL_REVIEW', leadId, final.reasons.join('; '), 1, 1);
  }

  private result(outcome: ProspectCandidateResult['outcome'], leadId: string | null, reason: string, detailsRequests = 0, websiteVerifications = 0): ProspectCandidateResult {
    return { outcome, leadId, reason, detailsRequests, websiteVerifications };
  }
}
