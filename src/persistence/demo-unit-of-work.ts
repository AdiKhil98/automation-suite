import { type DemoTxRepos, type DemoUnitOfWork } from '../domain/demo/demo-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { DemoRepository } from './repositories/demo.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/** One atomic transaction per lead: demo decision + demo + provenance + state + event. */
export class DrizzleDemoUnitOfWork implements DemoUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: DemoTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      return fn({ leads, leadService: new LeadService(leads, events), demos: new DemoRepository(tx), events });
    });
  }
}
