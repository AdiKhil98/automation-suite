import { type QualificationRules } from '../../config/qualification-rules.js';
import { AppError } from '../../utils/errors.js';
import { type LeadFact } from '../lead-facts/lead-fact.js';
import { type Lead } from '../leads/lead.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type LeadStatus } from '../leads/status.js';
import { evaluateQualification, type QualificationNiche } from './qualify.js';
import { type QualificationNextStep, type QualificationResult } from './qualification-result.js';

export interface FactReader {
  listCurrentFacts(leadId: string): Promise<LeadFact[]>;
}
export interface QualificationResultWriter {
  save(result: QualificationResult): Promise<string>;
}
export interface SuppressionChecker {
  isSuppressed(lead: Pick<Lead, 'normalizedDomain' | 'normalizedPhone' | 'placeId'> & Partial<Pick<Lead, 'id' | 'normalizedName'>>): Promise<boolean>;
}

/** Transaction-scoped repositories for a single atomic qualification. */
export interface QualificationTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  facts: FactReader;
  results: QualificationResultWriter;
  suppression: SuppressionChecker;
}

/**
 * Runs the complete qualification write — result insert, fact-link inserts, lead
 * state transition, and the state-transition event — inside ONE transaction. If any
 * step throws, everything rolls back.
 */
export interface QualificationUnitOfWork {
  transaction<T>(fn: (repos: QualificationTxRepos) => Promise<T>): Promise<T>;
}

const QUALIFIABLE_FROM: LeadStatus[] = [
  'NEW',
  'NORMALIZED',
  'READY_FOR_QUALIFICATION',
  'ENRICHED',
  'NEEDS_MANUAL_REVIEW',
];

function targetState(nextStep: QualificationNextStep): LeadStatus {
  switch (nextStep) {
    case 'AUDIT':
      return 'QUALIFIED';
    case 'WEBSITE_DISCOVERY':
    case 'NEEDS_ENRICHMENT':
      return 'READY_FOR_ENRICHMENT';
    case 'MANUAL_REVIEW':
      return 'NEEDS_MANUAL_REVIEW';
    case 'SKIP':
      return 'REJECTED';
  }
}

async function advanceToReady(leadService: LeadService, lead: Lead): Promise<void> {
  let status: LeadStatus = lead.status;
  if (status === 'NEW') {
    await leadService.transition(lead.id, 'NORMALIZED');
    status = 'NORMALIZED';
  }
  if (status === 'NORMALIZED' || status === 'ENRICHED' || status === 'NEEDS_MANUAL_REVIEW') {
    await leadService.transition(lead.id, 'READY_FOR_QUALIFICATION');
  }
}

/**
 * Orchestrates PRE_AUDIT qualification for one lead atomically: advance to
 * READY_FOR_QUALIFICATION, evaluate deterministically against current facts, append
 * the result (+ fact links), and transition the lead — all in a single transaction.
 */
export class QualificationService {
  constructor(private readonly uow: QualificationUnitOfWork) {}

  static isQualifiable(status: LeadStatus): boolean {
    return QUALIFIABLE_FROM.includes(status);
  }

  async qualify(
    leadId: string,
    campaign: string,
    niche: QualificationNiche,
    rules: QualificationRules,
    now: Date = new Date(),
  ): Promise<QualificationResult> {
    return this.uow.transaction(async (repos) => {
      const lead = await repos.leads.getById(leadId);
      if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead not found: ${leadId}`);
      if (!QualificationService.isQualifiable(lead.status)) {
        throw new AppError('NOT_QUALIFIABLE', `Lead ${leadId} not qualifiable from ${lead.status}`);
      }

      await advanceToReady(repos.leadService, lead);

      const suppressed = await repos.suppression.isSuppressed(lead);
      const facts = await repos.facts.listCurrentFacts(leadId);
      const result = evaluateQualification(facts, { leadId, campaign, niche, suppressed, now }, rules);

      await repos.results.save(result);
      await repos.leadService.transition(leadId, targetState(result.nextStep));
      return result;
    });
  }
}
