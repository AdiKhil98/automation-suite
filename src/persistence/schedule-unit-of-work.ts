import { type ScheduleRecord, type ScheduleTxRepos, type ScheduleUnitOfWork } from '../domain/schedule/schedule-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';
import { ScheduleTxRepository } from './repositories/schedule.repo.js';

/** One atomic transaction per schedule action: schedule row(s) + lead state + event. */
export class DrizzleScheduleUnitOfWork implements ScheduleUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: ScheduleTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const sched = new ScheduleTxRepository(tx);
      return fn({
        leads,
        leadService: new LeadService(leads, events),
        insert: (row: ScheduleRecord) => sched.insert(row),
        supersede: (oldId: string, newId: string, now: Date) => sched.supersede(oldId, newId, now),
        cancel: (id: string, reason: string | null, now: Date) => sched.cancel(id, reason, now),
        events,
      });
    });
  }
}
