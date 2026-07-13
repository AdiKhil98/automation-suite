import { LeadService } from '../domain/leads/lead-service.js';
import {
  type QualificationTxRepos,
  type QualificationUnitOfWork,
} from '../domain/qualification/qualification-service.js';
import { type Database } from './db.js';
import { LeadFactsRepository } from './repositories/lead-facts.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';
import { QualificationResultsRepository } from './repositories/qualification.repo.js';
import { SuppressionRepository } from './repositories/suppression.repo.js';

/**
 * Runs a qualification inside a single PostgreSQL transaction. All writes
 * (qualification_results, qualification_result_facts, lead state update, and the
 * state-transition event) commit together or roll back together.
 */
export class DrizzleQualificationUnitOfWork implements QualificationUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: QualificationTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const repos: QualificationTxRepos = {
        leads,
        leadService: new LeadService(leads, events),
        facts: new LeadFactsRepository(tx),
        results: new QualificationResultsRepository(tx),
        suppression: new SuppressionRepository(tx),
      };
      return fn(repos);
    });
  }
}
