import { type OutreachTxRepos, type OutreachUnitOfWork } from '../domain/outreach/outreach-service.js';
import { type Database } from './db.js';
import { OutreachTxRepository } from './repositories/outreach.repo.js';

/**
 * One atomic transaction per outreach action. The whole action — record + message +
 * follow-up + reply + event(s) — commits or rolls back together, so the immutable
 * timeline can never record a half-applied change.
 */
export class DrizzleOutreachUnitOfWork implements OutreachUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: OutreachTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new OutreachTxRepository(tx)));
  }
}
