import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/** Repositories available inside one lead-requeue transaction. */
export interface LeadRequeueTxRepos {
  leads: LeadsRepository;
  leadService: LeadService;
  events: PipelineRepository;
}

export interface LeadRequeueUnitOfWork {
  transaction<T>(fn: (repos: LeadRequeueTxRepos) => Promise<T>): Promise<T>;
}

/**
 * One atomic transaction for an operator requeue: re-read the lead, transition it
 * through the supported edge, and record the recovery NOTE. If anything throws, the
 * whole thing rolls back — a state transition never survives without its NOTE, and
 * the eligibility re-read happens inside the same transaction as the write (no
 * check-then-act gap against a concurrent pipeline run).
 */
export class DrizzleLeadRequeueUnitOfWork implements LeadRequeueUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: LeadRequeueTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      return fn({ leads, leadService: new LeadService(leads, events), events });
    });
  }
}
