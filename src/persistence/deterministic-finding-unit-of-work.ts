import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { DeterministicFindingRepository } from './repositories/deterministic-finding.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/** Repositories available inside one deterministic-finding approval transaction. */
export interface DeterministicFindingTxRepos {
  leads: LeadsRepository;
  leadService: LeadService;
  deterministic: DeterministicFindingRepository;
  events: PipelineRepository;
}

export interface DeterministicFindingUnitOfWork {
  transaction<T>(fn: (repos: DeterministicFindingTxRepos) => Promise<T>): Promise<T>;
}

/**
 * One atomic transaction for approving a deterministic finding: insert finding + evidence links,
 * transition the lead through the supported edge, and record the operator NOTE. If anything throws,
 * the whole thing rolls back — no half-approved finding and no orphaned state transition.
 */
export class DrizzleDeterministicFindingUnitOfWork implements DeterministicFindingUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: DeterministicFindingTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const repos: DeterministicFindingTxRepos = {
        leads,
        leadService: new LeadService(leads, events),
        deterministic: new DeterministicFindingRepository(tx),
        events,
      };
      return fn(repos);
    });
  }
}
