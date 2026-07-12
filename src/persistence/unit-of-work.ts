import { type CollectTxRepos, type UnitOfWork } from '../pipeline/ports.js';
import { type Database } from './db.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';
import { SourceEntitiesRepository, SourceObservationsRepository } from './repositories/source.repo.js';

/**
 * Runs collection work inside a real PostgreSQL transaction. If the callback
 * throws, Drizzle rolls the whole transaction back — no partial lead/entity/
 * observation is persisted for a failed candidate.
 */
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: CollectTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const repos: CollectTxRepos = {
        leads: new LeadsRepository(tx),
        entities: new SourceEntitiesRepository(tx),
        observations: new SourceObservationsRepository(tx),
        events: new PipelineRepository(tx),
      };
      return fn(repos);
    });
  }
}
