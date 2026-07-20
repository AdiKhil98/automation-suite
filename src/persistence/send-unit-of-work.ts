import { type SendAttemptRecord, type SendTxRepos, type SendUnitOfWork } from '../domain/send/send-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';
import { SendTxRepository } from './repositories/send.repo.js';

/** One atomic transaction for a terminal send outcome: attempt completion + schedule state +
 * lead state + event. */
export class DrizzleSendUnitOfWork implements SendUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: SendTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const send = new SendTxRepository(tx);
      return fn({
        leads,
        leadService: new LeadService(leads, events),
        completeAttempt: (id: string, patch: Partial<SendAttemptRecord>) => send.completeAttempt(id, patch),
        markScheduleFulfilled: (scheduleId: string, now: Date) => send.markScheduleFulfilled(scheduleId, now),
        invalidateSchedule: (scheduleId: string, reason: string, now: Date) => send.invalidateSchedule(scheduleId, reason, now),
        events,
      });
    });
  }
}
