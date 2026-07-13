import { type CaptureTxRepos, type CaptureUnitOfWork } from '../domain/capture/capture-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { CaptureRepository } from './repositories/capture.repo.js';
import { LeadFactsRepository } from './repositories/lead-facts.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/**
 * One atomic transaction per lead capture: run + pages + artifact metadata +
 * evidence + errors + fact writes (verification) + state transition + event.
 * Browser/network and artifact staging happen outside this; commit/discard of
 * temp artifacts is handled by the caller based on success/failure.
 */
export class DrizzleCaptureUnitOfWork implements CaptureUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: CaptureTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const repos: CaptureTxRepos = {
        leads,
        leadService: new LeadService(leads, events),
        capture: new CaptureRepository(tx),
        facts: new LeadFactsRepository(tx),
        events,
      };
      return fn(repos);
    });
  }
}
