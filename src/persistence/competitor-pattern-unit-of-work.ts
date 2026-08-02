import { type CompetitorPatternStore, type CompetitorPatternUnitOfWork } from '../domain/competitor/pattern-service.js';
import { type Database } from './db.js';
import { CompetitorPatternRepository } from './repositories/competitor-pattern.repo.js';

/**
 * Runs one competitor pattern-package apply inside a single transaction: idempotency check +
 * prior-DRAFT supersession + package insert + patterns + contrasts + evidence refs. Any failure
 * rolls back. No email/Gmail/Sheets/sending path exists here.
 */
export class DrizzleCompetitorPatternUnitOfWork implements CompetitorPatternUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: { pattern: CompetitorPatternStore }) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const repos: { pattern: CompetitorPatternStore } = {
        pattern: new CompetitorPatternRepository(tx),
      };
      return fn(repos);
    });
  }
}
