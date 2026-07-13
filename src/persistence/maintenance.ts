import { sql } from 'drizzle-orm';
import { type Database } from './db.js';

/**
 * Destructively clear all local pipeline data. Guarded against production use by
 * the caller (the reset-test-data CLI command). TRUNCATE ... CASCADE resets the
 * four Phase 1 tables together.
 */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE
      capture_errors, capture_evidence, capture_artifacts, captured_pages, website_capture_runs,
      enrichment_signals, enrichment_candidates, enrichment_attempts,
      qualification_result_facts, qualification_results, lead_facts, suppression_list,
      source_observations, source_requests, source_entities,
      evidence, pipeline_events, pipeline_runs, leads
      RESTART IDENTITY CASCADE`,
  );
}
