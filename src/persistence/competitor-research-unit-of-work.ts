import {
  type CompetitorResearchTxRepos,
  type CompetitorResearchUnitOfWork,
} from '../domain/competitor/research-service.js';
import { type Database } from './db.js';
import { CompetitorResearchRepository } from './repositories/competitor-research.repo.js';

/**
 * Runs one competitor-research apply inside a single transaction: idempotency check +
 * prior-DRAFT supersession + run insert + candidate inserts. Any failure rolls back.
 */
export class DrizzleCompetitorResearchUnitOfWork implements CompetitorResearchUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: CompetitorResearchTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const repos: CompetitorResearchTxRepos = {
        research: new CompetitorResearchRepository(tx),
      };
      return fn(repos);
    });
  }
}
