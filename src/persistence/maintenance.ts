import { sql } from 'drizzle-orm';
import { type Database } from './db.js';
import { assertDestructiveTestDatabasePermit, type DestructiveTestDatabasePermit } from './test-database-guard.js';

/**
 * Destructively clear all local pipeline data. Guarded against production use by
 * the caller (the reset-test-data CLI command). Rows are deleted child-first.
 * Test identifiers are application-generated text values, so no sequence reset
 * is required. DELETE avoids PostgreSQL's costly recursive TRUNCATE dependency
 * planning as the additive schema grows.
 */
export async function truncateAll(db: Database, permit: DestructiveTestDatabasePermit | undefined): Promise<void> {
  assertDestructiveTestDatabasePermit(permit);
  await db.execute(sql.raw(`
    DELETE FROM demo_v2_approval_invalidations;
    DELETE FROM demo_v2_approval_decisions;
    DELETE FROM demo_v2_approval_asset_inputs;
    DELETE FROM demo_v2_approval_translation_inputs;
    DELETE FROM demo_v2_approval_packages;
    DELETE FROM demo_v2_experience_plan_assets;
    DELETE FROM demo_v2_experience_plan_translations;
    DELETE FROM demo_v2_experience_plans;
    DELETE FROM demo_v2_creative_briefs;
    DELETE FROM demo_v2_asset_reuse_reviews;
    DELETE FROM demo_v2_asset_selections;
    DELETE FROM demo_v2_assets;
    DELETE FROM demo_v2_asset_catalogs;
    DELETE FROM demo_v2_translation_records;
    DELETE FROM demo_v2_translation_packages;
    DELETE FROM demo_v2_content_item_sources;
    DELETE FROM demo_v2_content_items;
    DELETE FROM demo_v2_primary_content_packages;
    DELETE FROM demo_v2_clinic_intelligence_sources;
    DELETE FROM demo_v2_clinic_intelligence_packages;
    DELETE FROM demo_v2_artifacts;
    DELETE FROM controlled_test_evaluations;
    DELETE FROM controlled_test_artifact_approvals;
    DELETE FROM controlled_test_runs;
    DELETE FROM prospect_candidates;
    DELETE FROM prospect_runs;
    DELETE FROM prospect_location_cache;
    DELETE FROM send_attempts;
    DELETE FROM sending_readiness_approvals;
    DELETE FROM send_schedules;
    DELETE FROM gmail_drafts;
    DELETE FROM email_draft_finalizations;
    DELETE FROM demo_deployment_runs;
    DELETE FROM email_finding_inputs;
    DELETE FROM email_fact_inputs;
    DELETE FROM email_drafts;
    DELETE FROM demo_design_specs;
    DELETE FROM demo_finding_inputs;
    DELETE FROM demo_fact_inputs;
    DELETE FROM demos;
    DELETE FROM demo_decisions;
    DELETE FROM prompt_versions;
    DELETE FROM model_calls;
    DELETE FROM opportunity_assessments;
    DELETE FROM audit_review_findings;
    DELETE FROM audit_reviews;
    DELETE FROM audit_finding_evidence;
    DELETE FROM audit_findings;
    DELETE FROM audit_runs;
    DELETE FROM capture_errors;
    DELETE FROM capture_evidence;
    DELETE FROM capture_artifacts;
    DELETE FROM captured_pages;
    DELETE FROM website_capture_runs;
    DELETE FROM website_verification_attempts;
    DELETE FROM enrichment_signals;
    DELETE FROM enrichment_candidates;
    DELETE FROM enrichment_attempts;
    DELETE FROM qualification_result_facts;
    DELETE FROM qualification_results;
    DELETE FROM lead_facts;
    DELETE FROM suppression_list;
    DELETE FROM source_observations;
    DELETE FROM source_requests;
    DELETE FROM source_entities;
    DELETE FROM evidence;
    DELETE FROM pipeline_events;
    DELETE FROM pipeline_runs;
    DELETE FROM leads;
  `));
}
