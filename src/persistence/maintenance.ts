import { sql } from 'drizzle-orm';
import { type Database } from './db.js';
import { assertDestructiveTestDatabasePermit, type DestructiveTestDatabasePermit } from './test-database-guard.js';

/**
 * Destructively clear all local pipeline data. Guarded against production use by
 * the caller (the reset-test-data CLI command). TRUNCATE ... CASCADE resets the
 * four Phase 1 tables together.
 */
export async function truncateAll(db: Database, permit: DestructiveTestDatabasePermit | undefined): Promise<void> {
  assertDestructiveTestDatabasePermit(permit);
  await db.execute(
    sql`TRUNCATE TABLE
      send_attempts, sending_readiness_approvals, send_schedules, gmail_drafts,
      email_draft_finalizations, demo_deployment_runs, email_finding_inputs, email_fact_inputs, email_drafts,
      demo_finding_inputs, demo_fact_inputs, demos, demo_decisions,
      prompt_versions, model_calls, opportunity_assessments, audit_review_findings, audit_reviews,
      audit_finding_evidence, audit_findings, audit_runs,
      capture_errors, capture_evidence, capture_artifacts, captured_pages, website_capture_runs,
      enrichment_signals, enrichment_candidates, enrichment_attempts,
      qualification_result_facts, qualification_results, lead_facts, suppression_list,
      source_observations, source_requests, source_entities,
      evidence, pipeline_events, pipeline_runs, leads
      RESTART IDENTITY CASCADE`,
  );
}
