import { type Database } from './db.js';
import { DemoV2FoundationRepository } from './repositories/demo-v2-foundation.repo.js';
import { DemoV2OrchestrationRepository } from './repositories/demo-v2-orchestration.repo.js';
import { DemoV2RenderRepository } from './repositories/demo-v2-render.repo.js';

export class DemoV2UnitOfWork {
  constructor(private readonly db: Database) {}

  async run<T>(fn: (repository: DemoV2FoundationRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new DemoV2FoundationRepository(tx)));
  }

  async orchestrate<T>(fn: (repository: DemoV2OrchestrationRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new DemoV2OrchestrationRepository(tx)));
  }

  /** One atomic transaction for render-version / screenshot / review-package persistence. */
  async render<T>(fn: (repository: DemoV2RenderRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new DemoV2RenderRepository(tx)));
  }
}
