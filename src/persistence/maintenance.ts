import { sql } from 'drizzle-orm';
import { type Database } from './db.js';

/**
 * Destructively clear all local pipeline data. Guarded against production use by
 * the caller (the reset-test-data CLI command). TRUNCATE ... CASCADE resets the
 * four Phase 1 tables together.
 */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE evidence, pipeline_events, pipeline_runs, leads RESTART IDENTITY CASCADE`,
  );
}
