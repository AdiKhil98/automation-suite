import { type ReviewTxRepos, type ReviewUnitOfWork } from '../domain/review/review-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';
import { ReviewWriteRepository } from './repositories/review.repo.js';

/** One atomic transaction per review action: demo/email decision + lead state + event. */
export class DrizzleReviewUnitOfWork implements ReviewUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: ReviewTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      return fn({ leads, leadService: new LeadService(leads, events), write: new ReviewWriteRepository(tx), events });
    });
  }
}
