import { type GmailDraftRecord, type GmailTxRepos, type GmailUnitOfWork } from '../domain/gmail/gmail-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { GmailTxRepository } from './repositories/gmail.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/** One atomic transaction for the terminal Gmail write: draft-run completion + lead state + event. */
export class DrizzleGmailUnitOfWork implements GmailUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: GmailTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const gmail = new GmailTxRepository(tx);
      return fn({
        leads,
        leadService: new LeadService(leads, events),
        completeRun: (runId: string, patch: Partial<GmailDraftRecord>) => gmail.completeRun(runId, patch),
        events,
      });
    });
  }
}
