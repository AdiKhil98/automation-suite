import { LeadService } from '../domain/leads/lead-service.js';
import {
  type EnrichmentTxRepos,
  type EnrichmentUnitOfWork,
} from '../domain/enrichment/enrichment-service.js';
import { type Database } from './db.js';
import { EnrichmentRepository } from './repositories/enrichment.repo.js';
import { LeadFactsRepository } from './repositories/lead-facts.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/**
 * Runs one lead's enrichment write inside a single transaction: attempt +
 * candidates + signals + fact writes + projection refresh + state transition +
 * event. Any failure rolls the whole thing back.
 */
export class DrizzleEnrichmentUnitOfWork implements EnrichmentUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: EnrichmentTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const repos: EnrichmentTxRepos = {
        leads,
        leadService: new LeadService(leads, events),
        facts: new LeadFactsRepository(tx),
        enrichment: new EnrichmentRepository(tx),
        events,
      };
      return fn(repos);
    });
  }
}
