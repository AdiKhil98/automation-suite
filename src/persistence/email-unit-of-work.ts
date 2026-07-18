import { type EmailTxRepos, type EmailUnitOfWork } from '../domain/email/email-writer-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { EmailRepository } from './repositories/email.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/** One atomic transaction per lead: email draft + provenance + model_calls + state + event. */
export class DrizzleEmailUnitOfWork implements EmailUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: EmailTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      return fn({ leads, leadService: new LeadService(leads, events), emails: new EmailRepository(tx), events });
    });
  }
}
