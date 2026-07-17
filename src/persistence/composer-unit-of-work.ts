import { type ComposerTxRepos, type ComposerUnitOfWork } from '../domain/demo/composer/demo-composer-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { ComposerRepository } from './repositories/composer.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/** One atomic transaction per lead: demo decision + demo + design spec + provenance +
 * model_calls + lead state + event. */
export class DrizzleComposerUnitOfWork implements ComposerUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: ComposerTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      return fn({ leads, leadService: new LeadService(leads, events), composer: new ComposerRepository(tx), events });
    });
  }
}
