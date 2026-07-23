import { type Database } from './db.js';
import { DemoV2FoundationRepository } from './repositories/demo-v2-foundation.repo.js';

export class DemoV2UnitOfWork {
  constructor(private readonly db: Database) {}

  async run<T>(fn: (repository: DemoV2FoundationRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new DemoV2FoundationRepository(tx)));
  }
}
