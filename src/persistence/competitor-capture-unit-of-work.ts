import { type CompetitorCaptureUnitOfWork } from '../domain/competitor/capture-service.js';
import { type CompetitorCaptureStore } from '../domain/competitor/capture-service.js';
import { type Database } from './db.js';
import { CompetitorCaptureRepository } from './repositories/competitor-capture.repo.js';

/**
 * Runs one competitor-capture apply inside a single transaction: idempotency check +
 * prior-DRAFT supersession + run insert + page inserts + evidence inserts. Any failure rolls back.
 */
export class DrizzleCompetitorCaptureUnitOfWork implements CompetitorCaptureUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: { capture: CompetitorCaptureStore }) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const repos: { capture: CompetitorCaptureStore } = {
        capture: new CompetitorCaptureRepository(tx),
      };
      return fn(repos);
    });
  }
}
