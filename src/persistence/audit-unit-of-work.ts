import { type AuditTxRepos, type AuditUnitOfWork } from '../domain/audit/audit-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { AuditRepository } from './repositories/audit.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/** One atomic transaction per audit: run + findings + evidence links + review +
 * opportunity + model calls + state transition + event. Model calls happen outside. */
export class DrizzleAuditUnitOfWork implements AuditUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: AuditTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const repos: AuditTxRepos = {
        leads,
        leadService: new LeadService(leads, events),
        audit: new AuditRepository(tx),
        events,
      };
      return fn(repos);
    });
  }
}
