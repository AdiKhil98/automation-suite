import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Database schema. Phase 1: leads, evidence, pipeline_runs, pipeline_events.
 * Phase 2 adds collection + dedup fields to leads and three source tables.
 *
 * Google Place Details fields approved for operational use are persisted only in
 * lead_facts with field-level google_places provenance. Candidate website data is
 * distinct from website-verified official facts.
 */

export const leads = pgTable(
  'leads',
  {
    id: text('id').primaryKey(),
    // Business facts — nullable; populated only from non-Google sources.
    businessName: text('business_name'),
    normalizedName: text('normalized_name'),
    domain: text('domain'),
    normalizedDomain: text('normalized_domain'),
    phone: text('phone'),
    normalizedPhone: text('normalized_phone'),
    formattedAddress: text('formatted_address'),
    normalizedAddress: text('normalized_address'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    placeId: text('place_id'),
    city: text('city'),
    country: text('country'),
    status: text('status').notNull().default('NEW'),
    priority: text('priority'),
    source: text('source'),
    factsSource: text('facts_source'),
    factsSourceUrl: text('facts_source_url'),
    factsCapturedAt: timestamp('facts_captured_at', { withTimezone: true }),
    dedupStatus: text('dedup_status').notNull().default('UNIQUE'),
    duplicateOf: text('duplicate_of').references((): AnyPgColumn => leads.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    placeIdIdx: index('leads_place_id_idx').on(t.placeId),
    domainIdx: index('leads_normalized_domain_idx').on(t.normalizedDomain),
    phoneIdx: index('leads_normalized_phone_idx').on(t.normalizedPhone),
  }),
);

export const pipelineRuns = pgTable('pipeline_runs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('RUNNING'),
  dryRun: text('dry_run').notNull().default('true'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  notes: text('notes'),
});

export const pipelineEvents = pgTable('pipeline_events', {
  id: text('id').primaryKey(),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
  type: text('type').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  message: text('message'),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const evidence = pgTable('evidence', {
  id: text('id').primaryKey(),
  leadId: text('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').notNull(),
  sourceUrl: text('source_url'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  claim: text('claim').notNull(),
  rawEvidence: text('raw_evidence').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  screenshotPath: text('screenshot_path'),
  selector: text('selector'),
});

// --- Phase 2: source identity / accounting / observations ---

export const sourceEntities = pgTable(
  'source_entities',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    sourcePlaceId: text('source_place_id').notNull(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerPlaceIdUk: uniqueIndex('source_entities_provider_placeid_uk').on(
      t.provider,
      t.sourcePlaceId,
    ),
  }),
);

export const sourceRequests = pgTable(
  'source_requests',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    campaign: text('campaign').notNull(),
    provider: text('provider').notNull(),
    query: jsonb('query'),
    fieldMask: text('field_mask').notNull(),
    pageIndex: integer('page_index').notNull(),
    resultCount: integer('result_count').notNull().default(0),
    billedTier: text('billed_tier'),
    estimatedCostUsd: doublePrecision('estimated_cost_usd'),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    runIdx: index('source_requests_run_idx').on(t.runId),
  }),
);

export const sourceObservations = pgTable(
  'source_observations',
  {
    id: text('id').primaryKey(),
    sourceEntityId: text('source_entity_id')
      .notNull()
      .references(() => sourceEntities.id, { onDelete: 'cascade' }),
    sourceRequestId: text('source_request_id')
      .notNull()
      .references(() => sourceRequests.id, { onDelete: 'cascade' }),
    processingResult: text('processing_result').notNull(),
    matchTier: text('match_tier'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('source_observations_entity_idx').on(t.sourceEntityId),
    requestIdx: index('source_observations_request_idx').on(t.sourceRequestId),
  }),
);

// --- Production prospecting: cached location resolution + ordered radius runs ---

export const prospectLocationCache = pgTable(
  'prospect_location_cache',
  {
    id: text('id').primaryKey(),
    normalizedLocation: text('normalized_location').notNull(),
    formattedLocation: text('formatted_location').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    provider: text('provider').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    locationUk: uniqueIndex('prospect_location_cache_location_uk').on(t.normalizedLocation),
    latitudeCk: check('prospect_location_cache_latitude_ck', sql`${t.latitude} >= -90 AND ${t.latitude} <= 90`),
    longitudeCk: check('prospect_location_cache_longitude_ck', sql`${t.longitude} >= -180 AND ${t.longitude} <= 180`),
    providerCk: check('prospect_location_cache_provider_ck', sql`${t.provider} IN ('google_places')`),
  }),
);

export const prospectRuns = pgTable(
  'prospect_runs',
  {
    id: text('id').primaryKey(),
    pipelineRunId: text('pipeline_run_id').notNull().references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    operatorNiche: text('operator_niche').notNull(),
    includedTypes: jsonb('included_types').notNull(),
    requestedLocation: text('requested_location').notNull(),
    formattedLocation: text('formatted_location').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    locationProvider: text('location_provider').notNull(),
    radiusKm: doublePrecision('radius_km').notNull(),
    rankPreference: text('rank_preference').notNull(),
    targetQualified: integer('target_qualified').notNull(),
    maxCandidates: integer('max_candidates').notNull(),
    continuePipeline: boolean('continue_pipeline').notNull().default(false),
    status: text('status').notNull().default('RUNNING'),
    result: text('result'),
    qualifiedCount: integer('qualified_count').notNull().default(0),
    processedCount: integer('processed_count').notNull().default(0),
    externalCalls: jsonb('external_calls').notNull(),
    circuitBreakerReason: text('circuit_breaker_reason'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    pipelineRunUk: uniqueIndex('prospect_runs_pipeline_run_uk').on(t.pipelineRunId),
    statusIdx: index('prospect_runs_status_idx').on(t.status),
    statusCk: check('prospect_runs_status_ck', sql`${t.status} IN ('RUNNING','COMPLETED','FAILED')`),
    resultCk: check('prospect_runs_result_ck', sql`${t.result} IS NULL OR ${t.result} IN ('TARGET_REACHED','CANDIDATE_BUDGET_EXHAUSTED','EXTERNAL_BUDGET_EXHAUSTED','SYSTEMIC_FAILURE')`),
    radiusCk: check('prospect_runs_radius_ck', sql`${t.radiusKm} > 0 AND ${t.radiusKm} <= 50`),
    candidateCapCk: check('prospect_runs_candidate_cap_ck', sql`${t.maxCandidates} BETWEEN 1 AND 20`),
    targetCk: check('prospect_runs_target_ck', sql`${t.targetQualified} >= 1 AND ${t.targetQualified} <= ${t.maxCandidates}`),
    rankCk: check('prospect_runs_rank_ck', sql`${t.rankPreference} IN ('POPULARITY','DISTANCE')`),
  }),
);

export const prospectCandidates = pgTable(
  'prospect_candidates',
  {
    id: text('id').primaryKey(),
    prospectRunId: text('prospect_run_id').notNull().references(() => prospectRuns.id, { onDelete: 'cascade' }),
    placeId: text('place_id').notNull(),
    position: integer('position').notNull(),
    leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    outcome: text('outcome').notNull().default('DISCOVERED'),
    skipReason: text('skip_reason'),
    websiteFailureStage: text('website_failure_stage'),
    websiteFailureCode: text('website_failure_code'),
    websiteFailureElapsedMs: integer('website_failure_elapsed_ms'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => ({
    runPositionUk: uniqueIndex('prospect_candidates_run_position_uk').on(t.prospectRunId, t.position),
    runPlaceUk: uniqueIndex('prospect_candidates_run_place_uk').on(t.prospectRunId, t.placeId),
    placeIdx: index('prospect_candidates_place_idx').on(t.placeId),
    outcomeCk: check('prospect_candidates_outcome_ck', sql`${t.outcome} IN ('DISCOVERED','QUALIFIED','DUPLICATE','SUPPRESSED','NO_WEBSITE','CLOSED','WEBSITE_TRANSIENT','WEBSITE_INVALID','DISQUALIFIED','MANUAL_REVIEW','SYSTEMIC_FAILURE')`),
    positionCk: check('prospect_candidates_position_ck', sql`${t.position} >= 0`),
    elapsedCk: check('prospect_candidates_elapsed_ck', sql`${t.websiteFailureElapsedMs} IS NULL OR ${t.websiteFailureElapsedMs} >= 0`),
  }),
);

// --- Phase 3: per-fact provenance, qualification, suppression ---
//
// NOTE: leads.facts_source / facts_source_url / facts_captured_at are DEPRECATED as
// of Phase 3 (lead-level provenance replaced by lead_facts). They are no longer
// written and will be dropped in a later migration after verification.

const FACT_TYPES = [
  'business_name',
  'official_domain',
  'official_website_url',
  'candidate_website_url',
  'google_place_id',
  'official_location_page_url',
  'domain',
  'phone',
  'contact_email',
  'contact_form_url',
  'formatted_address',
  'latitude',
  'longitude',
  'city',
  'country',
  'category',
  'rating',
  'review_count',
  'business_status',
  'ownership_type',
  'services',
  'opening_hours',
  'booking_url',
  'contact_timezone',
] as const;

const factTypeList = FACT_TYPES.map((t) => `'${t}'`).join(', ');

export const leadFacts = pgTable(
  'lead_facts',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    factType: text('fact_type').notNull(),
    value: text('value').notNull(),
    normalizedValue: text('normalized_value'),
    sourceType: text('source_type').notNull(),
    sourceUrl: text('source_url'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    confidence: doublePrecision('confidence').notNull().default(1),
    supersededBy: text('superseded_by').references((): AnyPgColumn => leadFacts.id),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (t) => ({
    // At most one CURRENT fact per (lead, fact_type).
    currentUk: uniqueIndex('lead_facts_current_uk')
      .on(t.leadId, t.factType)
      .where(sql`${t.isCurrent}`),
    leadTypeIdx: index('lead_facts_lead_type_idx').on(t.leadId, t.factType),
    confidenceCk: check('lead_facts_confidence_ck', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    sourceTypeCk: check('lead_facts_source_type_ck', sql`${t.sourceType} IN ('mock', 'manual', 'website', 'google_places')`),
    factTypeCk: check('lead_facts_fact_type_ck', sql.raw(`fact_type IN (${factTypeList})`)),
  }),
);

export const qualificationResults = pgTable(
  'qualification_results',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    campaign: text('campaign').notNull(),
    qualificationStage: text('qualification_stage').notNull(),
    rulesVersion: text('rules_version').notNull(),
    rulesConfigHash: text('rules_config_hash').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
    businessViabilityScore: doublePrecision('business_viability_score'),
    auditabilityScore: doublePrecision('auditability_score'),
    contactabilityScore: doublePrecision('contactability_score'),
    opportunityScore: doublePrecision('opportunity_score'),
    deterministicScore: doublePrecision('deterministic_score'),
    decision: text('decision').notNull(),
    priority: text('priority').notNull(),
    nextStep: text('next_step').notNull(),
    triggeredRules: jsonb('triggered_rules').notNull(),
    missingRequiredFacts: jsonb('missing_required_facts').notNull(),
    reasons: jsonb('reasons').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
  },
  (t) => ({
    leadIdx: index('qualification_results_lead_idx').on(t.leadId),
    stageCk: check('qr_stage_ck', sql`${t.qualificationStage} IN ('PRE_AUDIT')`),
    decisionCk: check('qr_decision_ck', sql`${t.decision} IN ('ACCEPT', 'REVIEW', 'REJECT')`),
    priorityCk: check(
      'qr_priority_ck',
      sql`${t.priority} IN ('HIGH', 'MEDIUM', 'LOW', 'UNASSIGNED')`,
    ),
    nextStepCk: check(
      'qr_next_step_ck',
      sql`${t.nextStep} IN ('AUDIT', 'WEBSITE_DISCOVERY', 'NEEDS_ENRICHMENT', 'MANUAL_REVIEW', 'SKIP')`,
    ),
    scoreCk: check(
      'qr_score_ck',
      sql`(${t.businessViabilityScore} IS NULL OR (${t.businessViabilityScore} >= 0 AND ${t.businessViabilityScore} <= 100))
        AND (${t.auditabilityScore} IS NULL OR (${t.auditabilityScore} >= 0 AND ${t.auditabilityScore} <= 100))
        AND (${t.contactabilityScore} IS NULL OR (${t.contactabilityScore} >= 0 AND ${t.contactabilityScore} <= 100))
        AND (${t.opportunityScore} IS NULL OR (${t.opportunityScore} >= 0 AND ${t.opportunityScore} <= 100))
        AND (${t.deterministicScore} IS NULL OR (${t.deterministicScore} >= 0 AND ${t.deterministicScore} <= 100))`,
    ),
  }),
);

// Authoritative relationship: which lead_facts fed a qualification result.
export const qualificationResultFacts = pgTable(
  'qualification_result_facts',
  {
    qualificationResultId: text('qualification_result_id')
      .notNull()
      .references(() => qualificationResults.id, { onDelete: 'cascade' }),
    leadFactId: text('lead_fact_id')
      .notNull()
      .references(() => leadFacts.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.qualificationResultId, t.leadFactId] }),
  }),
);

export const suppressionList = pgTable(
  'suppression_list',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
      value: text('value').notNull(),
      reason: text('reason'),
      createdBy: text('created_by').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      revokedAt: timestamp('revoked_at', { withTimezone: true }),
      revokedBy: text('revoked_by'),
      revokeReason: text('revoke_reason'),
  },
  (t) => ({
    scopeValueUk: uniqueIndex('suppression_list_scope_value_uk').on(t.scope, t.value),
      scopeCk: check('suppression_scope_ck', sql`${t.scope} IN ('domain', 'phone', 'place_id', 'email', 'business')`),
      revocationCk: check('suppression_revocation_ck', sql`(${t.revokedAt} IS NULL AND ${t.revokedBy} IS NULL AND ${t.revokeReason} IS NULL) OR (${t.revokedAt} IS NOT NULL AND ${t.revokedBy} IS NOT NULL AND ${t.revokeReason} IS NOT NULL)`),
  }),
);

// --- Phase 4: enrichment attempts / candidates / structured signals ---

const ENRICHMENT_OUTCOMES =
  "'VERIFIED','AMBIGUOUS','INSUFFICIENT_CONTEXT','NO_CANDIDATE','NO_VERIFIED_CANDIDATE','BROWSER_REQUIRED','TRANSIENT_ERROR','POLICY_BLOCKED','INVALID_INPUT'";
const DISCOVERY_SOURCES =
  "'website_hint','directory','search','social','google_hint','manual','mock'";
const SIGNAL_TYPES =
  "'exact_phone','name_address','branch_location','structured_data','legal_footer','name_tokens','category_text','city_mention','mailto','plaintext_email','contact_form'";

export const enrichmentAttempts = pgTable(
  'enrichment_attempts',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    outcome: text('outcome').notNull(),
    chosenDomain: text('chosen_domain'),
    chosenWebsiteUrl: text('chosen_website_url'),
    chosenLocationPageUrl: text('chosen_location_page_url'),
    confidence: doublePrecision('confidence'),
    candidateCount: integer('candidate_count').notNull().default(0),
    contextProvider: text('context_provider'),
    candidateProvider: text('candidate_provider'),
    notes: text('notes'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    leadIdx: index('enrichment_attempts_lead_idx').on(t.leadId),
    outcomeCk: check('enrichment_outcome_ck', sql.raw(`outcome IN (${ENRICHMENT_OUTCOMES})`)),
    candidateCountCk: check('enrichment_candidate_count_ck', sql`${t.candidateCount} >= 0`),
    confidenceCk: check(
      'enrichment_attempt_confidence_ck',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
    // chosen_* may be populated only for a VERIFIED attempt.
    chosenCk: check(
      'enrichment_chosen_only_verified_ck',
      sql`${t.outcome} = 'VERIFIED' OR (${t.chosenDomain} IS NULL AND ${t.chosenWebsiteUrl} IS NULL AND ${t.chosenLocationPageUrl} IS NULL)`,
    ),
  }),
);

export const enrichmentCandidates = pgTable(
  'enrichment_candidates',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => enrichmentAttempts.id, { onDelete: 'cascade' }),
    discoveredUrl: text('discovered_url').notNull(),
    finalUrl: text('final_url'),
    host: text('host'),
    httpStatus: integer('http_status'),
    discoverySource: text('discovery_source'),
    isDirectory: boolean('is_directory'),
    decision: text('decision').notNull(),
    confidence: doublePrecision('confidence'),
    rejectedReason: text('rejected_reason'),
  },
  (t) => ({
    attemptIdx: index('enrichment_candidates_attempt_idx').on(t.attemptId),
    decisionCk: check('enrichment_candidate_decision_ck', sql`${t.decision} IN ('VERIFIED','REJECTED','AMBIGUOUS')`),
    sourceCk: check('enrichment_discovery_source_ck', sql.raw(`discovery_source IS NULL OR discovery_source IN (${DISCOVERY_SOURCES})`)),
    confidenceCk: check(
      'enrichment_candidate_confidence_ck',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  }),
);

export const websiteVerificationAttempts = pgTable(
  'website_verification_attempts',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    enrichmentAttemptId: text('enrichment_attempt_id')
      .notNull()
      .references(() => enrichmentAttempts.id, { onDelete: 'cascade' }),
    candidateUrl: text('candidate_url').notNull(),
    hostname: text('hostname'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    finalClassification: text('final_classification').notNull(),
    failureStage: text('failure_stage'),
    errorCode: text('error_code'),
    httpStatus: integer('http_status'),
    redirectCount: integer('redirect_count').notNull().default(0),
    elapsedMs: integer('elapsed_ms').notNull(),
    resolvedIpFamily: integer('resolved_ip_family'),
    retryable: boolean('retryable').notNull(),
  },
  (t) => ({
    leadAttemptedIdx: index('website_verification_attempts_lead_attempted_idx').on(t.leadId, t.attemptedAt),
    enrichmentAttemptIdx: index('website_verification_attempts_enrichment_attempt_idx').on(t.enrichmentAttemptId),
    classificationCk: check('website_verification_classification_ck', sql`${t.finalClassification} IN ('OK','TRANSIENT','INVALID','POLICY_BLOCKED')`),
    stageCk: check('website_verification_failure_stage_ck', sql`${t.failureStage} IS NULL OR ${t.failureStage} IN ('DNS','TCP_CONNECT','TLS','HTTP','REDIRECT','TIMEOUT','POLICY','UNKNOWN')`),
    statusCk: check('website_verification_http_status_ck', sql`${t.httpStatus} IS NULL OR (${t.httpStatus} >= 100 AND ${t.httpStatus} <= 599)`),
    redirectsCk: check('website_verification_redirect_count_ck', sql`${t.redirectCount} >= 0`),
    elapsedCk: check('website_verification_elapsed_ms_ck', sql`${t.elapsedMs} >= 0`),
    familyCk: check('website_verification_ip_family_ck', sql`${t.resolvedIpFamily} IS NULL OR ${t.resolvedIpFamily} IN (4,6)`),
    successCk: check('website_verification_success_ck', sql`(${t.finalClassification} = 'OK' AND ${t.failureStage} IS NULL AND ${t.errorCode} IS NULL) OR ${t.finalClassification} <> 'OK'`),
  }),
);

export const enrichmentSignals = pgTable(
  'enrichment_signals',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => enrichmentCandidates.id, { onDelete: 'cascade' }),
    matchedFactId: text('matched_fact_id').references(() => leadFacts.id, { onDelete: 'set null' }),
    signalType: text('signal_type').notNull(),
    pageUrl: text('page_url').notNull(),
    extractedValue: text('extracted_value'),
    normalizedValue: text('normalized_value'),
    selector: text('selector'),
    confidence: doublePrecision('confidence'),
  },
  (t) => ({
    candidateIdx: index('enrichment_signals_candidate_idx').on(t.candidateId),
    signalTypeCk: check('enrichment_signal_type_ck', sql.raw(`signal_type IN (${SIGNAL_TYPES})`)),
    confidenceCk: check(
      'enrichment_signal_confidence_ck',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  }),
);

// --- Phase 5: website capture & evidence extraction ---

// COMPETITOR_CAPTURE (Phase 7A2) is additive to the shared purpose vocabulary (migration 0030). The
// lead-bound website_capture_runs never uses it; competitor evidence has its own dedicated tables.
const CAPTURE_PURPOSES = "'AUDIT_CAPTURE','VERIFICATION_CAPTURE','COMPETITOR_CAPTURE'";
const CAPTURE_OUTCOMES =
  "'CAPTURED','PARTIAL_CAPTURE','BROWSER_BLOCKED','BOT_CHALLENGE','AUTH_REQUIRED','NO_RENDERABLE_CONTENT','TRANSIENT_ERROR','POLICY_BLOCKED','INVALID_TARGET'";
const CAPTURE_EVIDENCE_TYPES =
  "'title','meta_description','lang','canonical','heading','nav_label','cta','link','mailto','tel','form','image_alt','structured_data','footer_legal','horizontal_overflow'";

export const websiteCaptureRuns = pgTable(
  'website_capture_runs',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    outcome: text('outcome').notNull(),
    primaryUrl: text('primary_url'),
    sourceEnrichmentCandidateId: text('source_enrichment_candidate_id').references(() => enrichmentCandidates.id, { onDelete: 'set null' }),
    desktopPrimaryComplete: boolean('desktop_primary_complete').notNull().default(false),
    mobilePrimaryComplete: boolean('mobile_primary_complete').notNull().default(false),
    secondaryPagesAttempted: integer('secondary_pages_attempted').notNull().default(0),
    secondaryPagesCompleted: integer('secondary_pages_completed').notNull().default(0),
    partialReason: text('partial_reason'),
    normalizedEvidenceFingerprint: text('normalized_evidence_fingerprint'),
    playwrightVersion: text('playwright_version'),
    browser: text('browser'),
    browserVersion: text('browser_version'),
    chromiumRevision: text('chromium_revision'),
    dockerImageTag: text('docker_image_tag'),
    emulationProfileVersion: text('emulation_profile_version'),
    pageSelectionPolicyVersion: text('page_selection_policy_version'),
    extractorVersion: text('extractor_version'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    leadIdx: index('website_capture_runs_lead_idx').on(t.leadId),
    purposeCk: check('capture_purpose_ck', sql.raw(`purpose IN (${CAPTURE_PURPOSES})`)),
    outcomeCk: check('capture_outcome_ck', sql.raw(`outcome IN (${CAPTURE_OUTCOMES})`)),
    secAttemptedCk: check('capture_sec_attempted_ck', sql`${t.secondaryPagesAttempted} >= 0`),
    secCompletedCk: check('capture_sec_completed_ck', sql`${t.secondaryPagesCompleted} >= 0`),
  }),
);

export const capturedPages = pgTable(
  'captured_pages',
  {
    id: text('id').primaryKey(),
    captureRunId: text('capture_run_id').notNull().references(() => websiteCaptureRuns.id, { onDelete: 'cascade' }),
    requestedUrl: text('requested_url').notNull(),
    finalUrl: text('final_url'),
    canonicalUrl: text('canonical_url'),
    httpStatus: integer('http_status'),
    role: text('role'),
    profile: text('profile').notNull(),
    ok: boolean('ok').notNull(),
    loadMs: integer('load_ms'),
    hasHorizontalOverflow: boolean('has_horizontal_overflow').notNull().default(false),
    rawDomHash: text('raw_dom_hash'),
  },
  (t) => ({
    runIdx: index('captured_pages_run_idx').on(t.captureRunId),
    profileCk: check('captured_page_profile_ck', sql`${t.profile} IN ('desktop','mobile')`),
  }),
);

export const captureArtifacts = pgTable(
  'capture_artifacts',
  {
    id: text('id').primaryKey(),
    capturedPageId: text('captured_page_id').notNull().references(() => capturedPages.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    kind: text('kind').notNull(),
    profile: text('profile').notNull(),
  },
  (t) => ({
    pageIdx: index('capture_artifacts_page_idx').on(t.capturedPageId),
    shaIdx: index('capture_artifacts_sha_idx').on(t.sha256),
    kindCk: check('capture_artifact_kind_ck', sql`${t.kind} IN ('viewport','fullpage')`),
    profileCk: check('capture_artifact_profile_ck', sql`${t.profile} IN ('desktop','mobile')`),
    sizeCk: check('capture_artifact_size_ck', sql`${t.bytes} >= 0 AND ${t.width} >= 0 AND ${t.height} >= 0`),
  }),
);

export const captureEvidence = pgTable(
  'capture_evidence',
  {
    id: text('id').primaryKey(),
    capturedPageId: text('captured_page_id').notNull().references(() => capturedPages.id, { onDelete: 'cascade' }),
    evidenceType: text('evidence_type').notNull(),
    sourceUrl: text('source_url'),
    profile: text('profile').notNull(),
    selector: text('selector'),
    extractedValue: text('extracted_value'),
    normalizedValue: text('normalized_value'),
  },
  (t) => ({
    pageIdx: index('capture_evidence_page_idx').on(t.capturedPageId),
    typeCk: check('capture_evidence_type_ck', sql.raw(`evidence_type IN (${CAPTURE_EVIDENCE_TYPES})`)),
    profileCk: check('capture_evidence_profile_ck', sql`${t.profile} IN ('desktop','mobile')`),
  }),
);

export const captureErrors = pgTable(
  'capture_errors',
  {
    id: text('id').primaryKey(),
    captureRunId: text('capture_run_id').notNull().references(() => websiteCaptureRuns.id, { onDelete: 'cascade' }),
    capturedPageId: text('captured_page_id').references(() => capturedPages.id, { onDelete: 'set null' }),
    pageUrl: text('page_url'),
    profile: text('profile'),
    kind: text('kind').notNull(),
    detail: text('detail'),
  },
  (t) => ({
    runIdx: index('capture_errors_run_idx').on(t.captureRunId),
  }),
);

// --- Phase 6: AI website audit & opportunity analysis ---

const AUDIT_OUTCOMES_SQL =
  "'AUDITED','AUDITED_NO_ACTIONABLE_FINDINGS','INSUFFICIENT_EVIDENCE','CAPTURE_CONFLICT','MODEL_REFUSAL','SCHEMA_INVALID','VALIDATION_FAILED','INPUT_TOO_LARGE','TRANSIENT_PROVIDER_ERROR','RATE_LIMITED','BUDGET_BLOCKED','MANUAL_REVIEW_REQUIRED'";
const AUDIT_CATEGORIES_SQL =
  "'CTA_CLARITY','BOOKING_FRICTION','CONTACT_FRICTION','MOBILE_USABILITY','SERVICE_CLARITY','TRUST_SIGNALS','SOCIAL_PROOF','NAVIGATION','READABILITY','LOCAL_INFORMATION','VISUAL_HIERARCHY','TECHNICAL_RENDERING','ACCESSIBILITY_INDICATOR','DESKTOP_MOBILE_CONSISTENCY','OTHER'";

export const auditRuns = pgTable(
  'audit_runs',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    captureRunId: text('capture_run_id').references(() => websiteCaptureRuns.id, { onDelete: 'set null' }),
    outcome: text('outcome').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    generatorPromptVersion: text('generator_prompt_version').notNull(),
    reviewerPromptVersion: text('reviewer_prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    opportunityRulesVersion: text('opportunity_rules_version').notNull(),
    opportunityRulesHash: text('opportunity_rules_hash').notNull(),
    provider: text('provider').notNull(),
    requestedAuditModel: text('requested_audit_model').notNull(),
    resolvedAuditModel: text('resolved_audit_model'),
    reasoningEffort: text('reasoning_effort').notNull(),
    reasoningMode: text('reasoning_mode').notNull(),
    imageDetail: text('image_detail').notNull(),
    responseStore: boolean('response_store').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    generatorResponseId: text('generator_response_id'),
    reviewerResponseId: text('reviewer_response_id'),
    totalInputTokens: integer('total_input_tokens').notNull().default(0),
    totalOutputTokens: integer('total_output_tokens').notNull().default(0),
    totalCostUsd: doublePrecision('total_cost_usd').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    leadIdx: index('audit_runs_lead_idx').on(t.leadId),
    outcomeCk: check('audit_outcome_ck', sql.raw(`outcome IN (${AUDIT_OUTCOMES_SQL})`)),
  }),
);

export const auditFindings = pgTable(
  'audit_findings',
  {
    id: text('id').primaryKey(),
    auditRunId: text('audit_run_id').notNull().references(() => auditRuns.id, { onDelete: 'cascade' }),
    findingRef: text('finding_ref').notNull(),
    category: text('category').notNull(),
    observation: text('observation').notNull(),
    affectedUrls: jsonb('affected_urls').notNull(),
    affectedProfiles: jsonb('affected_profiles').notNull(),
    severity: text('severity').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    businessImpact: text('business_impact').notNull(),
    recommendation: text('recommendation').notNull(),
    safeForOutreach: boolean('safe_for_outreach').notNull(),
    outreachAngle: text('outreach_angle'),
    uncertainty: text('uncertainty'),
    reviewDecision: text('review_decision').notNull(),
  },
  (t) => ({
    runIdx: index('audit_findings_run_idx').on(t.auditRunId),
    categoryCk: check('audit_finding_category_ck', sql.raw(`category IN (${AUDIT_CATEGORIES_SQL})`)),
    severityCk: check('audit_finding_severity_ck', sql`${t.severity} IN ('LOW','MEDIUM','HIGH')`),
    confidenceCk: check('audit_finding_confidence_ck', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
  }),
);

export const auditFindingEvidence = pgTable(
  'audit_finding_evidence',
  {
    auditFindingId: text('audit_finding_id').notNull().references(() => auditFindings.id, { onDelete: 'cascade' }),
    captureEvidenceId: text('capture_evidence_id').notNull().references(() => captureEvidence.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.auditFindingId, t.captureEvidenceId] }) }),
);

export const auditReviews = pgTable('audit_reviews', {
  id: text('id').primaryKey(),
  auditRunId: text('audit_run_id').notNull().references(() => auditRuns.id, { onDelete: 'cascade' }),
  overallDecision: text('overall_decision').notNull(),
});

export const auditReviewFindings = pgTable('audit_review_findings', {
  id: text('id').primaryKey(),
  auditReviewId: text('audit_review_id').notNull().references(() => auditReviews.id, { onDelete: 'cascade' }),
  findingRef: text('finding_ref').notNull(),
  decision: text('decision').notNull(),
  evidenceSupported: boolean('evidence_supported').notNull(),
  impactSupported: boolean('impact_supported').notNull(),
  safeForOutreach: boolean('safe_for_outreach').notNull(),
  problems: jsonb('problems').notNull(),
  revisedObservation: text('revised_observation'),
  revisedBusinessImpact: text('revised_business_impact'),
  revisedRecommendation: text('revised_recommendation'),
  revisedOutreachAngle: text('revised_outreach_angle'),
});

export const opportunityAssessments = pgTable(
  'opportunity_assessments',
  {
    id: text('id').primaryKey(),
    auditRunId: text('audit_run_id').notNull().references(() => auditRuns.id, { onDelete: 'cascade' }),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    conversionScore: integer('conversion_score').notNull(),
    mobileScore: integer('mobile_score').notNull(),
    trustScore: integer('trust_score').notNull(),
    contactabilityScore: integer('contactability_score').notNull(),
    overallScore: integer('overall_score').notNull(),
    rulesVersion: text('rules_version').notNull(),
    rulesHash: text('rules_hash').notNull(),
    breakdown: jsonb('breakdown').notNull(),
    capsApplied: jsonb('caps_applied').notNull(),
  },
  (t) => ({
    runIdx: index('opportunity_assessments_run_idx').on(t.auditRunId),
    scoreCk: check(
      'opportunity_score_ck',
      sql`${t.conversionScore} >= 0 AND ${t.conversionScore} <= 100 AND ${t.mobileScore} >= 0 AND ${t.mobileScore} <= 100 AND ${t.trustScore} >= 0 AND ${t.trustScore} <= 100 AND ${t.contactabilityScore} >= 0 AND ${t.contactabilityScore} <= 100 AND ${t.overallScore} >= 0 AND ${t.overallScore} <= 100`,
    ),
  }),
);

export const modelCalls = pgTable(
  'model_calls',
  {
    id: text('id').primaryKey(),
    auditRunId: text('audit_run_id').references(() => auditRuns.id, { onDelete: 'cascade' }),
    leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    requestedModel: text('requested_model').notNull(),
    resolvedModel: text('resolved_model'),
    promptVersion: text('prompt_version'),
    schemaVersion: text('schema_version'),
    requestId: text('request_id'),
    responseId: text('response_id'),
    inputTokens: integer('input_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    estimatedCostUsd: doublePrecision('estimated_cost_usd'),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(),
    classification: text('classification'),
    retryNumber: integer('retry_number').notNull().default(0),
    imageDetail: text('image_detail'),
    validationViolations: jsonb('validation_violations'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ runIdx: index('model_calls_run_idx').on(t.auditRunId) }),
);

export const promptVersions = pgTable('prompt_versions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  role: text('role').notNull(),
  rubricVersion: text('rubric_version'),
  schemaVersion: text('schema_version'),
  modelFamily: text('model_family'),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull(),
});

// --- Phase 8: demo decision & generation ---

export const demoDecisions = pgTable(
  'demo_decisions',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    decision: text('decision').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason').notNull(),
    opportunityScore: integer('opportunity_score'),
    minOpportunity: integer('min_opportunity').notNull(),
    justifiedByScore: boolean('justified_by_score').notNull(),
    justifiedByFinding: boolean('justified_by_finding').notNull(),
    briefRulesVersion: text('brief_rules_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index('demo_decisions_lead_idx').on(t.leadId),
    decisionCk: check('demo_decision_ck', sql`${t.decision} IN ('BUILD_DEMO','NO_DEMO')`),
  }),
);

export const demos = pgTable(
  'demos',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    demoDecisionId: text('demo_decision_id').notNull().references(() => demoDecisions.id, { onDelete: 'cascade' }),
    templateId: text('template_id').notNull(),
    templateVersion: text('template_version').notNull(),
    path: text('path').notNull(),
    status: text('status').notNull(),
    noindexVerified: boolean('noindex_verified').notNull().default(false),
    disclosurePresent: boolean('disclosure_present').notNull().default(false),
    contentHash: text('content_hash'),
    ctaKind: text('cta_kind'),
    factsUsed: jsonb('facts_used'),
    findingRefs: jsonb('finding_refs'),
    // Approval metadata (populated by a later human-review phase; never in Phase 8).
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvalSource: text('approval_source'),
    approvalNotes: text('approval_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index('demos_lead_idx').on(t.leadId),
    statusCk: check('demo_status_ck', sql`${t.status} IN ('GENERATED_PENDING_REVIEW','APPROVED','REJECTED','SUPERSEDED','BUILD_FAILED')`),
  }),
);

// Relational provenance (amendment 4): authoritative FK links, not JSON-only.
export const demoFactInputs = pgTable(
  'demo_fact_inputs',
  {
    id: text('id').primaryKey(),
    demoId: text('demo_id').notNull().references(() => demos.id, { onDelete: 'cascade' }),
    leadFactId: text('lead_fact_id').notNull().references(() => leadFacts.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
  },
  (t) => ({ demoIdx: index('demo_fact_inputs_demo_idx').on(t.demoId) }),
);

export const demoFindingInputs = pgTable(
  'demo_finding_inputs',
  {
    id: text('id').primaryKey(),
    demoId: text('demo_id').notNull().references(() => demos.id, { onDelete: 'cascade' }),
    auditFindingId: text('audit_finding_id').notNull().references(() => auditFindings.id, { onDelete: 'cascade' }),
    directive: text('directive').notNull(),
  },
  (t) => ({ demoIdx: index('demo_finding_inputs_demo_idx').on(t.demoId) }),
);

// --- Phase 8B: AI Demo Composer — the structured design spec behind a composed demo. ---

export const demoDesignSpecs = pgTable(
  'demo_design_specs',
  {
    id: text('id').primaryKey(),
    demoId: text('demo_id').notNull().references(() => demos.id, { onDelete: 'cascade' }),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    specVersion: text('spec_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    generatorPromptVersion: text('generator_prompt_version').notNull(),
    reviewerPromptVersion: text('reviewer_prompt_version').notNull(),
    visualDirection: text('visual_direction').notNull(),
    heroStrategy: text('hero_strategy').notNull(),
    headerVariant: text('header_variant').notNull(),
    footerVariant: text('footer_variant').notNull(),
    primaryCtaIntent: text('primary_cta_intent').notNull(),
    primaryCtaLabelKey: text('primary_cta_label_key').notNull(),
    componentIds: jsonb('component_ids').notNull(),
    reviewerDecision: text('reviewer_decision').notNull(),
    fabricationRisk: boolean('fabrication_risk').notNull(),
    evidenceConsistent: boolean('evidence_consistent').notNull(),
    ctaHonest: boolean('cta_honest').notNull(),
    reviewerProblems: jsonb('reviewer_problems').notNull(),
    spec: jsonb('spec').notNull(),
    provider: text('provider').notNull(),
    requestedGeneratorModel: text('requested_generator_model').notNull(),
    requestedReviewerModel: text('requested_reviewer_model').notNull(),
    generatorResponseId: text('generator_response_id'),
    reviewerResponseId: text('reviewer_response_id'),
    totalCostUsd: doublePrecision('total_cost_usd').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    demoIdx: index('demo_design_specs_demo_idx').on(t.demoId),
    leadIdx: index('demo_design_specs_lead_idx').on(t.leadId),
  }),
);

// --- Phase 9: cold email writer + reviewer ---

export const emailDrafts = pgTable(
  'email_drafts',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    demoId: text('demo_id').references(() => demos.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    ctaKind: text('cta_kind').notNull(),
    hasDemoUrlPlaceholder: boolean('has_demo_url_placeholder').notNull().default(false),
    status: text('status').notNull(),
    writerPromptVersion: text('writer_prompt_version').notNull(),
    reviewerPromptVersion: text('reviewer_prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    rulesVersion: text('rules_version').notNull(),
    provider: text('provider').notNull(),
    requestedWriterModel: text('requested_writer_model').notNull(),
    requestedReviewerModel: text('requested_reviewer_model').notNull(),
    writerResponseId: text('writer_response_id'),
    reviewerResponseId: text('reviewer_response_id'),
    reviewerDecision: text('reviewer_decision'),
    fabricationRisk: boolean('fabrication_risk'),
    personalizationSupported: boolean('personalization_supported'),
    claimHonest: boolean('claim_honest'),
    reviewerProblems: jsonb('reviewer_problems'),
    totalCostUsd: doublePrecision('total_cost_usd').notNull(),
    // Phase 10 human review (dashboard). Distinct from the automated reviewer verdict above.
    humanDecision: text('human_decision'),
    humanNotes: text('human_notes'),
    humanReviewedAt: timestamp('human_reviewed_at', { withTimezone: true }),
    humanReviewedBy: text('human_reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index('email_drafts_lead_idx').on(t.leadId),
    statusCk: check('email_draft_status_ck', sql`${t.status} IN ('DRAFTED','APPROVED','REVIEW_FAILED')`),
    humanDecisionCk: check('email_draft_human_decision_ck', sql`${t.humanDecision} IS NULL OR ${t.humanDecision} IN ('APPROVED','REJECTED')`),
  }),
);

export const emailFactInputs = pgTable(
  'email_fact_inputs',
  {
    id: text('id').primaryKey(),
    emailId: text('email_id').notNull().references(() => emailDrafts.id, { onDelete: 'cascade' }),
    leadFactId: text('lead_fact_id').notNull().references(() => leadFacts.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
  },
  (t) => ({ emailIdx: index('email_fact_inputs_email_idx').on(t.emailId) }),
);

export const emailFindingInputs = pgTable(
  'email_finding_inputs',
  {
    id: text('id').primaryKey(),
    emailId: text('email_id').notNull().references(() => emailDrafts.id, { onDelete: 'cascade' }),
    auditFindingId: text('audit_finding_id').notNull().references(() => auditFindings.id, { onDelete: 'cascade' }),
    directive: text('directive').notNull(),
  },
  (t) => ({ emailIdx: index('email_finding_inputs_email_idx').on(t.emailId) }),
);

// --- Phase 11: Netlify preview deployment + email finalization ---

export const demoDeploymentRuns = pgTable(
  'demo_deployment_runs',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    demoId: text('demo_id').notNull().references(() => demos.id, { onDelete: 'cascade' }),
    originalEmailDraftId: text('original_email_draft_id').references(() => emailDrafts.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    siteId: text('site_id').notNull(),
    deployId: text('deploy_id'),
    artifactHash: text('artifact_hash').notNull(),
    // Persisted BEFORE the external call so a timeout/uncertain response can be reconciled.
    attemptFingerprint: text('attempt_fingerprint').notNull(),
    outcome: text('outcome').notNull(),
    draftUrl: text('draft_url'),
    permalinkUrl: text('permalink_url'),
    verifiedUrl: text('verified_url'),
    verificationResult: jsonb('verification_result'),
    errorClass: text('error_class'),
    callsMade: integer('calls_made').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    leadIdx: index('demo_deployment_runs_lead_idx').on(t.leadId),
    // Idempotency: a provider deploy id is unique; a site+artifact may have only ONE verified deploy.
    deployIdUk: uniqueIndex('demo_deployment_runs_deploy_uk').on(t.provider, t.deployId).where(sql`${t.deployId} IS NOT NULL`),
    verifiedArtifactUk: uniqueIndex('demo_deployment_runs_verified_artifact_uk').on(t.siteId, t.artifactHash).where(sql`${t.outcome} = 'DEPLOYED_AND_VERIFIED'`),
  }),
);

export const emailDraftFinalizations = pgTable(
  'email_draft_finalizations',
  {
    id: text('id').primaryKey(),
    originalDraftId: text('original_draft_id').notNull().references(() => emailDrafts.id, { onDelete: 'cascade' }),
    deploymentRunId: text('deployment_run_id').notNull().references(() => demoDeploymentRuns.id, { onDelete: 'cascade' }),
    verifiedDeploymentUrl: text('verified_deployment_url').notNull(),
    originalBodyHash: text('original_body_hash').notNull(),
    resolvedBody: text('resolved_body').notNull(),
    resolvedBodyHash: text('resolved_body_hash').notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }).notNull().defaultNow(),
    // Second human approval of the URL-resolved email (distinct from the tokenized-draft approval).
    finalHumanDecision: text('final_human_decision'),
    finalHumanNotes: text('final_human_notes'),
    finalReviewedAt: timestamp('final_reviewed_at', { withTimezone: true }),
    finalReviewedBy: text('final_reviewed_by'),
    finalReviewedSource: text('final_reviewed_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    draftIdx: index('email_draft_finalizations_draft_idx').on(t.originalDraftId),
    draftDeployUk: uniqueIndex('email_draft_finalizations_draft_deploy_uk').on(t.originalDraftId, t.deploymentRunId),
    finalDecisionCk: check('email_finalization_decision_ck', sql`${t.finalHumanDecision} IS NULL OR ${t.finalHumanDecision} IN ('APPROVED','REJECTED')`),
  }),
);

// --- Phase 12: Gmail draft creation (drafts only; never send) ---

export const gmailDrafts = pgTable(
  'gmail_drafts',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    finalizedEmailId: text('finalized_email_id').references(() => emailDraftFinalizations.id, { onDelete: 'set null' }),
    recipientEmail: text('recipient_email').notNull(),
    senderEmail: text('sender_email').notNull(),
    gmailAccount: text('gmail_account').notNull(),
    provider: text('provider').notNull(),
    providerDraftId: text('provider_draft_id'),
    threadId: text('thread_id'),
    messageId: text('message_id'),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
    sourceEmailVersion: text('source_email_version').notNull(),
    outcome: text('outcome').notNull(),
    errorClass: text('error_class'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    leadIdx: index('gmail_drafts_lead_idx').on(t.leadId),
    // Duplicate prevention: one draft per (account + finalized-email + recipient) fingerprint,
    // and a provider draft id is globally unique.
    fingerprintUk: uniqueIndex('gmail_drafts_fingerprint_uk').on(t.gmailAccount, t.idempotencyFingerprint),
    providerDraftUk: uniqueIndex('gmail_drafts_provider_draft_uk').on(t.provider, t.providerDraftId).where(sql`${t.providerDraftId} IS NOT NULL`),
  }),
);

// --- Phase 13: scheduling (records intended send times only; never sends) ---

export const sendSchedules = pgTable(
  'send_schedules',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    gmailDraftId: text('gmail_draft_id').notNull().references(() => gmailDrafts.id, { onDelete: 'cascade' }),
    // Integrity binding (amendment 4): the schedule is invalid if any of these change.
    providerDraftId: text('provider_draft_id').notNull(),
    finalizedContentHash: text('finalized_content_hash').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    scheduledAtUtc: timestamp('scheduled_at_utc', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull(),
    rulesVersion: text('rules_version').notNull(),
    computedFrom: jsonb('computed_from').notNull(),
    integrityFingerprint: text('integrity_fingerprint').notNull(),
    origin: text('origin').notNull(), // 'auto' | 'manual'
    status: text('status').notNull(), // 'SCHEDULED' | 'CANCELLED' | 'SUPERSEDED' | 'FULFILLED' | 'INVALIDATED'
    supersededById: text('superseded_by_id'),
    cancelReason: text('cancel_reason'),
    rescheduleCount: integer('reschedule_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    invalidationReason: text('invalidation_reason'),
  },
  (t) => ({
    leadIdx: index('send_schedules_lead_idx').on(t.leadId),
    // Exactly one ACTIVE schedule per Gmail draft; cancelled/superseded rows are retained (history).
    activeUk: uniqueIndex('send_schedules_active_uk').on(t.gmailDraftId).where(sql`${t.status} = 'SCHEDULED'`),
    statusCk: check('send_schedule_status_ck', sql`${t.status} IN ('SCHEDULED','CANCELLED','SUPERSEDED','FULFILLED','INVALIDATED')`),
  }),
);

// --- Phase 14: controlled sending (one known draft, explicit confirmation, durable outcome) ---

export const sendingReadinessApprovals = pgTable(
  'sending_readiness_approvals',
  {
    id: text('id').primaryKey(),
    gmailAccount: text('gmail_account').notNull(),
    policyVersion: text('policy_version').notNull(),
    approvedBy: text('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revokeReason: text('revoke_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index('sending_readiness_account_idx').on(t.gmailAccount, t.policyVersion),
    activeUk: uniqueIndex('sending_readiness_active_uk').on(t.gmailAccount, t.policyVersion).where(sql`${t.revokedAt} IS NULL`),
    revocationCk: check('sending_readiness_revocation_ck', sql`(${t.revokedAt} IS NULL AND ${t.revokedBy} IS NULL AND ${t.revokeReason} IS NULL) OR (${t.revokedAt} IS NOT NULL AND ${t.revokedBy} IS NOT NULL AND ${t.revokeReason} IS NOT NULL)`),
  }),
);

export const sendAttempts = pgTable(
  'send_attempts',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    scheduleId: text('schedule_id').notNull().references(() => sendSchedules.id, { onDelete: 'cascade' }),
    gmailDraftId: text('gmail_draft_id').notNull().references(() => gmailDrafts.id, { onDelete: 'cascade' }),
    readinessApprovalId: text('readiness_approval_id').notNull().references(() => sendingReadinessApprovals.id, { onDelete: 'restrict' }),
    gmailAccount: text('gmail_account').notNull(),
    recipientHash: text('recipient_hash').notNull(),
    finalizedContentHash: text('finalized_content_hash').notNull(),
    scheduleIntegrityFingerprint: text('schedule_integrity_fingerprint').notNull(),
    approvedEnvelopeHash: text('approved_envelope_hash').notNull(),
    observedEnvelopeHash: text('observed_envelope_hash').notNull(),
    sendFingerprint: text('send_fingerprint').notNull(),
    confirmationFingerprint: text('confirmation_fingerprint').notNull(),
    confirmedBy: text('confirmed_by').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    providerMessageId: text('provider_message_id'),
    providerThreadId: text('provider_thread_id'),
    errorClass: text('error_class'),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull(),
    callStartedAt: timestamp('call_started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    reconciledOutcome: text('reconciled_outcome'),
    reconciledBy: text('reconciled_by'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    reconciliationNote: text('reconciliation_note'),
  },
  (t) => ({
    leadIdx: index('send_attempts_lead_idx').on(t.leadId),
    scheduleIdx: index('send_attempts_schedule_idx').on(t.scheduleId),
    fingerprintUk: uniqueIndex('send_attempts_fingerprint_uk').on(t.sendFingerprint),
    confirmedScheduleUk: uniqueIndex('send_attempts_confirmed_schedule_uk').on(t.scheduleId).where(sql`${t.status} = 'SENT_CONFIRMED' OR ${t.reconciledOutcome} = 'CONFIRMED_SENT'`),
    blockingScheduleUk: uniqueIndex('send_attempts_blocking_schedule_uk').on(t.scheduleId).where(sql`${t.status} IN ('RESERVED','CALL_STARTED','SENT_CONFIRMED') OR (${t.status} = 'OUTCOME_UNKNOWN' AND ${t.reconciledOutcome} IS DISTINCT FROM 'CONFIRMED_NOT_SENT')`),
    providerMessageUk: uniqueIndex('send_attempts_provider_message_uk').on(t.providerMessageId).where(sql`${t.providerMessageId} IS NOT NULL`),
    accountCompletedIdx: index('send_attempts_account_completed_idx').on(t.gmailAccount, sql`COALESCE(${t.reconciledAt}, ${t.completedAt})`).where(sql`${t.status} = 'SENT_CONFIRMED' OR ${t.reconciledOutcome} = 'CONFIRMED_SENT'`),
    statusCk: check('send_attempt_status_ck', sql`${t.status} IN ('RESERVED','CALL_STARTED','SENT_CONFIRMED','DEFINITIVE_FAILURE','OUTCOME_UNKNOWN','DUPLICATE_PREVENTED')`),
    reconciliationCk: check('send_attempt_reconciliation_ck', sql`(${t.reconciledOutcome} IS NULL AND ${t.reconciledBy} IS NULL AND ${t.reconciledAt} IS NULL AND ${t.reconciliationNote} IS NULL) OR (${t.reconciledOutcome} IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT') AND ${t.reconciledBy} IS NOT NULL AND ${t.reconciledAt} IS NOT NULL AND ${t.reconciliationNote} IS NOT NULL)`),
  }),
);

// --- Controlled end-to-end validation (explicitly non-sendable) ---

export const controlledTestRuns = pgTable(
  'controlled_test_runs',
  {
    id: text('id').primaryKey(),
    prospectRunId: text('prospect_run_id').notNull().references(() => prospectRuns.id, { onDelete: 'cascade' }),
    pipelineRunId: text('pipeline_run_id').notNull().references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    recipientEmail: text('recipient_email').notNull(),
    recipientFingerprint: text('recipient_fingerprint').notNull(),
    recipientEnvName: text('recipient_env_name').notNull(),
    actor: text('actor').notNull().default('SYSTEM_CONTROLLED_TEST'),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('RUNNING'),
    sendable: boolean('sendable').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    // Preserve failed attempt history while permitting an explicit retry. A prospect
    // run may still have at most one active or successfully completed controlled run.
    prospectRunUk: uniqueIndex('controlled_test_runs_prospect_run_uk').on(t.prospectRunId)
      .where(sql`${t.status} IN ('RUNNING','COMPLETED')`),
    leadIdx: index('controlled_test_runs_lead_idx').on(t.leadId),
    statusCk: check('controlled_test_runs_status_ck', sql`${t.status} IN ('RUNNING','COMPLETED','FAILED')`),
    actorCk: check('controlled_test_runs_actor_ck', sql`${t.actor} = 'SYSTEM_CONTROLLED_TEST'`),
    reasonCk: check('controlled_test_runs_reason_ck', sql`${t.reason} = 'operator-controlled end-to-end validation'`),
    notSendableCk: check('controlled_test_runs_not_sendable_ck', sql`${t.sendable} = false`),
    recipientEnvCk: check('controlled_test_runs_recipient_env_ck', sql`${t.recipientEnvName} = 'TEST_RECIPIENT_EMAIL'`),
  }),
);

export const controlledTestArtifactApprovals = pgTable(
  'controlled_test_artifact_approvals',
  {
    id: text('id').primaryKey(),
    controlledTestRunId: text('controlled_test_run_id').notNull().references(() => controlledTestRuns.id, { onDelete: 'cascade' }),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    artifactType: text('artifact_type').notNull(),
    artifactId: text('artifact_id').notNull(),
    artifactHash: text('artifact_hash').notNull(),
    actor: text('actor').notNull().default('SYSTEM_CONTROLLED_TEST'),
    reason: text('reason').notNull(),
    recipientFingerprint: text('recipient_fingerprint').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    artifactUk: uniqueIndex('controlled_test_artifact_approvals_artifact_uk').on(t.controlledTestRunId, t.artifactType, t.artifactId),
    runIdx: index('controlled_test_artifact_approvals_run_idx').on(t.controlledTestRunId),
    typeCk: check('controlled_test_artifact_approvals_type_ck', sql`${t.artifactType} IN ('DEMO','EMAIL_DRAFT','FINALIZED_EMAIL')`),
    actorCk: check('controlled_test_artifact_approvals_actor_ck', sql`${t.actor} = 'SYSTEM_CONTROLLED_TEST'`),
    reasonCk: check('controlled_test_artifact_approvals_reason_ck', sql`${t.reason} = 'operator-controlled end-to-end validation'`),
  }),
);

export const controlledTestEvaluations = pgTable(
  'controlled_test_evaluations',
  {
    id: text('id').primaryKey(),
    controlledTestRunId: text('controlled_test_run_id').notNull().references(() => controlledTestRuns.id, { onDelete: 'cascade' }),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    gmailDraftId: text('gmail_draft_id').references(() => gmailDrafts.id, { onDelete: 'set null' }),
    scheduleId: text('schedule_id').references(() => sendSchedules.id, { onDelete: 'set null' }),
    evaluationType: text('evaluation_type').notNull(),
    outcome: text('outcome').notNull().default('CONTROLLED_TEST_NOT_SENDABLE'),
    report: jsonb('report').notNull(),
    sendable: boolean('sendable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runTypeUk: uniqueIndex('controlled_test_evaluations_run_type_uk').on(t.controlledTestRunId, t.evaluationType),
    typeCk: check('controlled_test_evaluations_type_ck', sql`${t.evaluationType} IN ('READINESS','DRY_RUN')`),
    outcomeCk: check('controlled_test_evaluations_outcome_ck', sql`${t.outcome} = 'CONTROLLED_TEST_NOT_SENDABLE'`),
    notSendableCk: check('controlled_test_evaluations_not_sendable_ck', sql`${t.sendable} = false`),
  }),
);

// --- Demo Engine V2 Milestone 1: inert, additive foundation only. ---
// These tables have no relationship to the V1 `demos` table or any deployment,
// email, Gmail, scheduling, or sending table.

const DEMO_V2_HASH_SQL = "^[a-f0-9]{64}$";
const DEMO_V2_LANGUAGE_SQL = "'de','en','fr','he','ar'";
const DEMO_V2_DIRECTION_SQL = "'LTR','RTL'";

export const demoV2Artifacts = pgTable(
  'demo_v2_artifacts',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    demoDecisionId: text('demo_decision_id').notNull().references(() => demoDecisions.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    engineVersion: text('engine_version').notNull().default('v2'),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull().default('INTELLIGENCE_PENDING'),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    currentLeadUk: uniqueIndex('demo_v2_artifacts_current_lead_uk').on(t.leadId).where(sql`${t.isCurrent}`),
    leadIdx: index('demo_v2_artifacts_lead_idx').on(t.leadId),
    decisionIdx: index('demo_v2_artifacts_decision_idx').on(t.demoDecisionId),
    statusIdx: index('demo_v2_artifacts_status_idx').on(t.status, t.isCurrent),
    engineCk: check('demo_v2_artifacts_engine_ck', sql`${t.engineVersion} = 'v2'`),
    statusCk: check('demo_v2_artifacts_status_ck', sql`${t.status} IN (
      'INTELLIGENCE_PENDING','INTELLIGENCE_READY','CONTENT_PENDING','CONTENT_READY',
      'ASSET_REVIEW_PENDING','FOUNDATION_READY','BRIEF_READY','PLAN_READY','RENDERING',
      'RENDERED','AUTO_REVIEW_PENDING','AUTO_REVIEW_PASSED','REVISION_REQUIRED',
      'HUMAN_REVIEW_REQUIRED','HUMAN_APPROVED','REJECTED','BLOCKED','SUPERSEDED')`),
  }),
);

export const demoV2ClinicIntelligencePackages = pgTable(
  'demo_v2_clinic_intelligence_packages',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    primaryLanguage: text('primary_language').notNull(),
    primaryDirection: text('primary_direction').notNull(),
    supportedLanguages: jsonb('supported_languages').notNull(),
    package: jsonb('package').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    packageHash: text('package_hash').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_intelligence_artifact_version_uk').on(t.artifactId, t.version),
    currentUk: uniqueIndex('demo_v2_intelligence_current_uk').on(t.artifactId).where(sql`${t.isCurrent}`),
    statusIdx: index('demo_v2_intelligence_status_idx').on(t.artifactId, t.status),
    hashIdx: index('demo_v2_intelligence_hash_idx').on(t.packageHash),
    versionCk: check('demo_v2_intelligence_version_ck', sql`${t.version} > 0`),
    statusCk: check('demo_v2_intelligence_status_ck', sql`${t.status} IN ('DRAFT','READY','STALE','BLOCKED')`),
    languageCk: check('demo_v2_intelligence_language_ck', sql.raw(`primary_language IN (${DEMO_V2_LANGUAGE_SQL})`)),
    directionCk: check('demo_v2_intelligence_direction_ck', sql.raw(`primary_direction IN (${DEMO_V2_DIRECTION_SQL})`)),
    languagesJsonCk: check('demo_v2_intelligence_languages_json_ck', sql`jsonb_typeof(${t.supportedLanguages}) = 'array'`),
    hashCk: check('demo_v2_intelligence_hash_ck', sql.raw(`input_fingerprint ~ '${DEMO_V2_HASH_SQL}' AND package_hash ~ '${DEMO_V2_HASH_SQL}'`)),
    finalizedCk: check('demo_v2_intelligence_finalized_ck', sql`${t.status} <> 'READY' OR ${t.finalizedAt} IS NOT NULL`),
  }),
);

export const demoV2ClinicIntelligenceSources = pgTable(
  'demo_v2_clinic_intelligence_sources',
  {
    id: text('id').primaryKey(),
    clinicIntelligencePackageId: text('clinic_intelligence_package_id').notNull()
      .references(() => demoV2ClinicIntelligencePackages.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    sourceRole: text('source_role').notNull(),
    leadFactId: text('lead_fact_id').references(() => leadFacts.id, { onDelete: 'restrict' }),
    auditFindingId: text('audit_finding_id').references(() => auditFindings.id, { onDelete: 'restrict' }),
    captureEvidenceId: text('capture_evidence_id').references(() => captureEvidence.id, { onDelete: 'restrict' }),
    evidenceId: text('evidence_id').references(() => evidence.id, { onDelete: 'restrict' }),
    sourceRecordHash: text('source_record_hash').notNull(),
    sourceCapturedAt: timestamp('source_captured_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packageIdx: index('demo_v2_intelligence_sources_package_idx').on(t.clinicIntelligencePackageId),
    leadFactIdx: index('demo_v2_intelligence_sources_lead_fact_idx').on(t.leadFactId),
    findingIdx: index('demo_v2_intelligence_sources_finding_idx').on(t.auditFindingId),
    captureIdx: index('demo_v2_intelligence_sources_capture_idx').on(t.captureEvidenceId),
    evidenceIdx: index('demo_v2_intelligence_sources_evidence_idx').on(t.evidenceId),
    leadFactUk: uniqueIndex('demo_v2_intelligence_sources_lead_fact_uk')
      .on(t.clinicIntelligencePackageId, t.leadFactId).where(sql`${t.leadFactId} IS NOT NULL`),
    findingUk: uniqueIndex('demo_v2_intelligence_sources_finding_uk')
      .on(t.clinicIntelligencePackageId, t.auditFindingId).where(sql`${t.auditFindingId} IS NOT NULL`),
    captureUk: uniqueIndex('demo_v2_intelligence_sources_capture_uk')
      .on(t.clinicIntelligencePackageId, t.captureEvidenceId).where(sql`${t.captureEvidenceId} IS NOT NULL`),
    evidenceUk: uniqueIndex('demo_v2_intelligence_sources_evidence_uk')
      .on(t.clinicIntelligencePackageId, t.evidenceId).where(sql`${t.evidenceId} IS NOT NULL`),
    kindCk: check('demo_v2_intelligence_sources_kind_ck', sql`${t.sourceKind} IN ('LEAD_FACT','AUDIT_FINDING','CAPTURE_EVIDENCE','EVIDENCE')`),
    roleCk: check('demo_v2_intelligence_sources_role_ck', sql`${t.sourceRole} IN ('IDENTITY','CONTENT','CLAIM','AUDIT','LANGUAGE','ASSET_CONTEXT','CONTACT','CONSTRAINT','OTHER')`),
    exactSourceCk: check('demo_v2_intelligence_sources_exact_source_ck', sql`
      num_nonnulls(${t.leadFactId}, ${t.auditFindingId}, ${t.captureEvidenceId}, ${t.evidenceId}) = 1
      AND ((${t.sourceKind} = 'LEAD_FACT' AND ${t.leadFactId} IS NOT NULL)
        OR (${t.sourceKind} = 'AUDIT_FINDING' AND ${t.auditFindingId} IS NOT NULL)
        OR (${t.sourceKind} = 'CAPTURE_EVIDENCE' AND ${t.captureEvidenceId} IS NOT NULL)
        OR (${t.sourceKind} = 'EVIDENCE' AND ${t.evidenceId} IS NOT NULL))`),
    hashCk: check('demo_v2_intelligence_sources_hash_ck', sql.raw(`source_record_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2PrimaryContentPackages = pgTable(
  'demo_v2_primary_content_packages',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    clinicIntelligencePackageId: text('clinic_intelligence_package_id').notNull()
      .references(() => demoV2ClinicIntelligencePackages.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    language: text('language').notNull(),
    direction: text('direction').notNull(),
    status: text('status').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    contentHash: text('content_hash').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_primary_content_artifact_version_uk').on(t.artifactId, t.version),
    currentUk: uniqueIndex('demo_v2_primary_content_current_uk').on(t.artifactId).where(sql`${t.isCurrent}`),
    intelligenceIdx: index('demo_v2_primary_content_intelligence_idx').on(t.clinicIntelligencePackageId),
    hashIdx: index('demo_v2_primary_content_hash_idx').on(t.contentHash),
    versionCk: check('demo_v2_primary_content_version_ck', sql`${t.version} > 0`),
    statusCk: check('demo_v2_primary_content_status_ck', sql`${t.status} IN ('DRAFT','READY','STALE','REJECTED')`),
    languageCk: check('demo_v2_primary_content_language_ck', sql.raw(`language IN (${DEMO_V2_LANGUAGE_SQL})`)),
    directionCk: check('demo_v2_primary_content_direction_ck', sql.raw(`direction IN (${DEMO_V2_DIRECTION_SQL})`)),
    hashCk: check('demo_v2_primary_content_hash_ck', sql.raw(`source_fingerprint ~ '${DEMO_V2_HASH_SQL}' AND content_hash ~ '${DEMO_V2_HASH_SQL}'`)),
    finalizedCk: check('demo_v2_primary_content_finalized_ck', sql`${t.status} <> 'READY' OR ${t.finalizedAt} IS NOT NULL`),
  }),
);

export const demoV2ContentItems = pgTable(
  'demo_v2_content_items',
  {
    id: text('id').primaryKey(),
    contentPackageId: text('content_package_id').notNull()
      .references(() => demoV2PrimaryContentPackages.id, { onDelete: 'cascade' }),
    contentKey: text('content_key').notNull(),
    contentKind: text('content_kind').notNull(),
    claimClass: text('claim_class').notNull(),
    textValue: text('text_value'),
    structuredValue: jsonb('structured_value'),
    translatable: boolean('translatable').notNull().default(true),
    position: integer('position').notNull().default(0),
    itemHash: text('item_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUk: uniqueIndex('demo_v2_content_items_package_key_uk').on(t.contentPackageId, t.contentKey),
    packageIdx: index('demo_v2_content_items_package_idx').on(t.contentPackageId),
    hashIdx: index('demo_v2_content_items_hash_idx').on(t.itemHash),
    kindCk: check('demo_v2_content_items_kind_ck', sql`${t.contentKind} IN ('LABEL','NAV_LABEL','HEADING','BODY','CTA_LABEL','SERVICE_NAME','FAQ_QUESTION','FAQ_ANSWER','ALT_TEXT','CONTACT','HOURS','LEGAL','STRUCTURED')`),
    claimCk: check('demo_v2_content_items_claim_ck', sql`${t.claimClass} IN ('VERBATIM_FACT','EVIDENCE_BOUND_DERIVATION','UI_LABEL','LEGAL_DISCLOSURE')`),
    valueCk: check('demo_v2_content_items_value_ck', sql`num_nonnulls(${t.textValue}, ${t.structuredValue}) = 1`),
    positionCk: check('demo_v2_content_items_position_ck', sql`${t.position} >= 0`),
    hashCk: check('demo_v2_content_items_hash_ck', sql.raw(`item_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ContentItemSources = pgTable(
  'demo_v2_content_item_sources',
  {
    contentItemId: text('content_item_id').notNull().references(() => demoV2ContentItems.id, { onDelete: 'cascade' }),
    intelligenceSourceId: text('intelligence_source_id').notNull()
      .references(() => demoV2ClinicIntelligenceSources.id, { onDelete: 'restrict' }),
    relationship: text('relationship').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.contentItemId, t.intelligenceSourceId] }),
    sourceIdx: index('demo_v2_content_item_sources_source_idx').on(t.intelligenceSourceId),
    relationshipCk: check('demo_v2_content_item_sources_relationship_ck', sql`${t.relationship} IN ('SUPPORTS','CONSTRAINS','SOURCE_TEXT')`),
  }),
);

export const demoV2TranslationPackages = pgTable(
  'demo_v2_translation_packages',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    sourceContentPackageId: text('source_content_package_id').notNull()
      .references(() => demoV2PrimaryContentPackages.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    language: text('language').notNull(),
    direction: text('direction').notNull(),
    status: text('status').notNull(),
    sourceContentHash: text('source_content_hash').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    translationHash: text('translation_hash'),
    reviewStatus: text('review_status').notNull().default('NOT_REVIEWED'),
    reviewActorType: text('review_actor_type'),
    reviewActorId: text('review_actor_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNotes: text('review_notes'),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_translations_artifact_language_version_uk').on(t.artifactId, t.language, t.version),
    currentUk: uniqueIndex('demo_v2_translations_current_uk').on(t.artifactId, t.language).where(sql`${t.isCurrent}`),
    sourceIdx: index('demo_v2_translations_source_idx').on(t.sourceContentPackageId),
    statusIdx: index('demo_v2_translations_status_idx').on(t.status, t.reviewStatus),
    hashIdx: index('demo_v2_translations_hash_idx').on(t.translationHash),
    versionCk: check('demo_v2_translations_version_ck', sql`${t.version} > 0`),
    languageCk: check('demo_v2_translations_language_ck', sql.raw(`language IN (${DEMO_V2_LANGUAGE_SQL})`)),
    directionCk: check('demo_v2_translations_direction_ck', sql.raw(`direction IN (${DEMO_V2_DIRECTION_SQL})`)),
    statusCk: check('demo_v2_translations_status_ck', sql`${t.status} IN ('DRAFT','INCOMPLETE','READY_FOR_REVIEW','REVIEWED','STALE','REJECTED')`),
    reviewStatusCk: check('demo_v2_translations_review_status_ck', sql`${t.reviewStatus} IN ('NOT_REVIEWED','APPROVED','REJECTED')`),
    actorCk: check('demo_v2_translations_actor_ck', sql`${t.reviewActorType} IS NULL OR ${t.reviewActorType} IN ('MODEL','HUMAN','SYSTEM')`),
    hashCk: check('demo_v2_translations_hash_ck', sql.raw(`source_content_hash ~ '${DEMO_V2_HASH_SQL}' AND source_fingerprint ~ '${DEMO_V2_HASH_SQL}' AND (translation_hash IS NULL OR translation_hash ~ '${DEMO_V2_HASH_SQL}')`)),
    humanApprovalCk: check('demo_v2_translations_human_approval_ck', sql`
      ${t.reviewStatus} <> 'APPROVED'
      OR (${t.status} = 'REVIEWED' AND ${t.reviewActorType} = 'HUMAN'
        AND length(trim(${t.reviewActorId})) > 0 AND ${t.reviewedAt} IS NOT NULL
        AND ${t.translationHash} IS NOT NULL AND ${t.finalizedAt} IS NOT NULL)`),
  }),
);

export const demoV2TranslationRecords = pgTable(
  'demo_v2_translation_records',
  {
    id: text('id').primaryKey(),
    translationPackageId: text('translation_package_id').notNull()
      .references(() => demoV2TranslationPackages.id, { onDelete: 'cascade' }),
    sourceContentItemId: text('source_content_item_id').notNull()
      .references(() => demoV2ContentItems.id, { onDelete: 'restrict' }),
    sourceItemHash: text('source_item_hash').notNull(),
    translatedText: text('translated_text'),
    translatedStructuredValue: jsonb('translated_structured_value'),
    translationItemHash: text('translation_item_hash'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemUk: uniqueIndex('demo_v2_translation_records_item_uk').on(t.translationPackageId, t.sourceContentItemId),
    statusIdx: index('demo_v2_translation_records_status_idx').on(t.translationPackageId, t.status),
    sourceIdx: index('demo_v2_translation_records_source_idx').on(t.sourceContentItemId),
    statusCk: check('demo_v2_translation_records_status_ck', sql`${t.status} IN ('MISSING','TRANSLATED','REVIEWED','STALE','REJECTED')`),
    valueCk: check('demo_v2_translation_records_value_ck', sql`
      (${t.status} = 'MISSING' AND num_nonnulls(${t.translatedText}, ${t.translatedStructuredValue}, ${t.translationItemHash}) = 0)
      OR (${t.status} IN ('TRANSLATED','REVIEWED') AND num_nonnulls(${t.translatedText}, ${t.translatedStructuredValue}) = 1 AND ${t.translationItemHash} IS NOT NULL)
      OR (${t.status} IN ('STALE','REJECTED'))`),
    hashCk: check('demo_v2_translation_records_hash_ck', sql.raw(`source_item_hash ~ '${DEMO_V2_HASH_SQL}' AND (translation_item_hash IS NULL OR translation_item_hash ~ '${DEMO_V2_HASH_SQL}')`)),
  }),
);

export const demoV2AssetCatalogs = pgTable(
  'demo_v2_asset_catalogs',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    clinicIntelligencePackageId: text('clinic_intelligence_package_id').notNull()
      .references(() => demoV2ClinicIntelligencePackages.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    catalogHash: text('catalog_hash').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_asset_catalogs_artifact_version_uk').on(t.artifactId, t.version),
    currentUk: uniqueIndex('demo_v2_asset_catalogs_current_uk').on(t.artifactId).where(sql`${t.isCurrent}`),
    intelligenceIdx: index('demo_v2_asset_catalogs_intelligence_idx').on(t.clinicIntelligencePackageId),
    hashIdx: index('demo_v2_asset_catalogs_hash_idx').on(t.catalogHash),
    versionCk: check('demo_v2_asset_catalogs_version_ck', sql`${t.version} > 0`),
    statusCk: check('demo_v2_asset_catalogs_status_ck', sql`${t.status} IN ('DRAFT','READY_FOR_REVIEW','READY','BLOCKED','STALE')`),
    hashCk: check('demo_v2_asset_catalogs_hash_ck', sql.raw(`source_fingerprint ~ '${DEMO_V2_HASH_SQL}' AND catalog_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2Assets = pgTable(
  'demo_v2_assets',
  {
    id: text('id').primaryKey(),
    assetCatalogId: text('asset_catalog_id').notNull().references(() => demoV2AssetCatalogs.id, { onDelete: 'cascade' }),
    sourceCapturedPageId: text('source_captured_page_id').references(() => capturedPages.id, { onDelete: 'restrict' }),
    sourceCaptureEvidenceId: text('source_capture_evidence_id').references(() => captureEvidence.id, { onDelete: 'restrict' }),
    sourcePageUrl: text('source_page_url').notNull(),
    directUrl: text('direct_url'),
    finalUrl: text('final_url'),
    contentHash: text('content_hash'),
    mimeType: text('mime_type'),
    byteSize: integer('byte_size'),
    width: integer('width'),
    height: integer('height'),
    aspectRatio: doublePrecision('aspect_ratio'),
    altText: text('alt_text'),
    nearbyCaption: text('nearby_caption'),
    nearbyHeading: text('nearby_heading'),
    category: text('category').notNull(),
    availabilityStatus: text('availability_status').notNull(),
    firstPartyStatus: text('first_party_status').notNull(),
    qualityStatus: text('quality_status').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    recordHash: text('record_hash').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recordUk: uniqueIndex('demo_v2_assets_catalog_record_uk').on(t.assetCatalogId, t.recordHash),
    contentUk: uniqueIndex('demo_v2_assets_catalog_content_uk').on(t.assetCatalogId, t.contentHash)
      .where(sql`${t.contentHash} IS NOT NULL`),
    categoryIdx: index('demo_v2_assets_category_idx').on(t.assetCatalogId, t.category),
    availabilityIdx: index('demo_v2_assets_availability_idx').on(t.assetCatalogId, t.availabilityStatus),
    pageIdx: index('demo_v2_assets_page_idx').on(t.sourceCapturedPageId),
    evidenceIdx: index('demo_v2_assets_evidence_idx').on(t.sourceCaptureEvidenceId),
    categoryCk: check('demo_v2_assets_category_ck', sql`${t.category} IN ('HERO','CLINIC_INTERIOR','EXTERIOR','TEAM','DOCTOR','TREATMENT','EQUIPMENT','LOCATION','LOGO','DECORATIVE','UNSUITABLE')`),
    availabilityCk: check('demo_v2_assets_availability_ck', sql`${t.availabilityStatus} IN ('DISCOVERED','AVAILABLE','UNAVAILABLE','BLOCKED','UNKNOWN')`),
    ownershipCk: check('demo_v2_assets_ownership_ck', sql`${t.firstPartyStatus} IN ('FIRST_PARTY','APPROVED_FIRST_PARTY_CDN','THIRD_PARTY','UNKNOWN')`),
    qualityCk: check('demo_v2_assets_quality_ck', sql`${t.qualityStatus} IN ('UNASSESSED','SUITABLE','UNSUITABLE')`),
    dimensionsCk: check('demo_v2_assets_dimensions_ck', sql`
      (${t.byteSize} IS NULL OR ${t.byteSize} >= 0) AND (${t.width} IS NULL OR ${t.width} >= 0)
      AND (${t.height} IS NULL OR ${t.height} >= 0) AND (${t.aspectRatio} IS NULL OR ${t.aspectRatio} > 0)`),
    hashCk: check('demo_v2_assets_hash_ck', sql.raw(`record_hash ~ '${DEMO_V2_HASH_SQL}' AND (content_hash IS NULL OR content_hash ~ '${DEMO_V2_HASH_SQL}')`)),
  }),
);

export const demoV2AssetSelections = pgTable(
  'demo_v2_asset_selections',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').notNull().references(() => demoV2Assets.id, { onDelete: 'restrict' }),
    selectionKey: text('selection_key').notNull(),
    version: integer('version').notNull(),
    intendedSection: text('intended_section').notNull(),
    intendedUse: text('intended_use').notNull(),
    desktopCrop: jsonb('desktop_crop'),
    mobileCrop: jsonb('mobile_crop'),
    focalPoint: jsonb('focal_point'),
    overlay: jsonb('overlay'),
    contrastResult: jsonb('contrast_result'),
    fallback: jsonb('fallback'),
    sourceAttribution: text('source_attribution'),
    status: text('status').notNull(),
    boundAssetRecordHash: text('bound_asset_record_hash').notNull(),
    selectionHash: text('selection_hash').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_asset_selections_artifact_key_version_uk').on(t.artifactId, t.selectionKey, t.version),
    currentUk: uniqueIndex('demo_v2_asset_selections_current_uk').on(t.artifactId, t.selectionKey).where(sql`${t.isCurrent}`),
    assetIdx: index('demo_v2_asset_selections_asset_idx').on(t.assetId),
    statusIdx: index('demo_v2_asset_selections_status_idx').on(t.artifactId, t.status),
    hashIdx: index('demo_v2_asset_selections_hash_idx').on(t.selectionHash),
    versionCk: check('demo_v2_asset_selections_version_ck', sql`${t.version} > 0`),
    statusCk: check('demo_v2_asset_selections_status_ck', sql`${t.status} IN ('PROPOSED','REUSE_REVIEW_REQUIRED','SELECTED','REJECTED','STALE')`),
    hashCk: check('demo_v2_asset_selections_hash_ck', sql.raw(`bound_asset_record_hash ~ '${DEMO_V2_HASH_SQL}' AND selection_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2AssetReuseReviews = pgTable(
  'demo_v2_asset_reuse_reviews',
  {
    id: text('id').primaryKey(),
    assetSelectionId: text('asset_selection_id').notNull()
      .references(() => demoV2AssetSelections.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    decision: text('decision').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    evidenceNote: text('evidence_note').notNull(),
    boundAssetRecordHash: text('bound_asset_record_hash').notNull(),
    boundSelectionHash: text('bound_selection_hash').notNull(),
    reviewHash: text('review_hash').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_asset_reuse_reviews_selection_version_uk').on(t.assetSelectionId, t.version),
    currentUk: uniqueIndex('demo_v2_asset_reuse_reviews_current_uk').on(t.assetSelectionId).where(sql`${t.isCurrent}`),
    decisionIdx: index('demo_v2_asset_reuse_reviews_decision_idx').on(t.decision),
    versionCk: check('demo_v2_asset_reuse_reviews_version_ck', sql`${t.version} > 0`),
    decisionCk: check('demo_v2_asset_reuse_reviews_decision_ck', sql`${t.decision} IN ('APPROVED_CONCEPT_USE','NEEDS_RIGHTS_REVIEW','REJECTED')`),
    actorCk: check('demo_v2_asset_reuse_reviews_actor_ck', sql`${t.actorType} IN ('MODEL','HUMAN','SYSTEM') AND length(trim(${t.actorId})) > 0`),
    humanDecisionCk: check('demo_v2_asset_reuse_reviews_human_decision_ck', sql`
      ${t.decision} NOT IN ('APPROVED_CONCEPT_USE','REJECTED') OR ${t.actorType} = 'HUMAN'`),
    noteCk: check('demo_v2_asset_reuse_reviews_note_ck', sql`length(trim(${t.evidenceNote})) > 0`),
    hashCk: check('demo_v2_asset_reuse_reviews_hash_ck', sql.raw(`bound_asset_record_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_selection_hash ~ '${DEMO_V2_HASH_SQL}' AND review_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2CreativeBriefs = pgTable(
  'demo_v2_creative_briefs',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    clinicIntelligencePackageId: text('clinic_intelligence_package_id').notNull()
      .references(() => demoV2ClinicIntelligencePackages.id, { onDelete: 'restrict' }),
    primaryContentPackageId: text('primary_content_package_id').notNull()
      .references(() => demoV2PrimaryContentPackages.id, { onDelete: 'restrict' }),
    assetCatalogId: text('asset_catalog_id').notNull().references(() => demoV2AssetCatalogs.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    brief: jsonb('brief').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    briefHash: text('brief_hash').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_creative_briefs_artifact_version_uk').on(t.artifactId, t.version),
    currentUk: uniqueIndex('demo_v2_creative_briefs_current_uk').on(t.artifactId).where(sql`${t.isCurrent}`),
    intelligenceIdx: index('demo_v2_creative_briefs_intelligence_idx').on(t.clinicIntelligencePackageId),
    contentIdx: index('demo_v2_creative_briefs_content_idx').on(t.primaryContentPackageId),
    catalogIdx: index('demo_v2_creative_briefs_catalog_idx').on(t.assetCatalogId),
    hashIdx: index('demo_v2_creative_briefs_hash_idx').on(t.briefHash),
    versionCk: check('demo_v2_creative_briefs_version_ck', sql`${t.version} > 0`),
    statusCk: check('demo_v2_creative_briefs_status_ck', sql`${t.status} IN ('DRAFT','VALIDATED','STALE','REJECTED')`),
    hashCk: check('demo_v2_creative_briefs_hash_ck', sql.raw(`input_fingerprint ~ '${DEMO_V2_HASH_SQL}' AND brief_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ExperiencePlans = pgTable(
  'demo_v2_experience_plans',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    creativeBriefId: text('creative_brief_id').notNull().references(() => demoV2CreativeBriefs.id, { onDelete: 'restrict' }),
    primaryContentPackageId: text('primary_content_package_id').notNull()
      .references(() => demoV2PrimaryContentPackages.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    primaryLanguage: text('primary_language').notNull(),
    primaryDirection: text('primary_direction').notNull(),
    supportedLanguages: jsonb('supported_languages').notNull(),
    componentRegistryVersion: text('component_registry_version').notNull(),
    componentRegistryHash: text('component_registry_hash').notNull(),
    referenceLibraryVersion: text('reference_library_version').notNull(),
    referenceLibraryHash: text('reference_library_hash').notNull(),
    plan: jsonb('plan').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    planHash: text('plan_hash').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_experience_plans_artifact_version_uk').on(t.artifactId, t.version),
    currentUk: uniqueIndex('demo_v2_experience_plans_current_uk').on(t.artifactId).where(sql`${t.isCurrent}`),
    briefIdx: index('demo_v2_experience_plans_brief_idx').on(t.creativeBriefId),
    contentIdx: index('demo_v2_experience_plans_content_idx').on(t.primaryContentPackageId),
    hashIdx: index('demo_v2_experience_plans_hash_idx').on(t.planHash),
    registryIdx: index('demo_v2_experience_plans_registry_idx').on(t.componentRegistryHash),
    versionCk: check('demo_v2_experience_plans_version_ck', sql`${t.version} > 0`),
    statusCk: check('demo_v2_experience_plans_status_ck', sql`${t.status} IN ('DRAFT','VALIDATED','STALE','REJECTED')`),
    languageCk: check('demo_v2_experience_plans_language_ck', sql.raw(`primary_language IN (${DEMO_V2_LANGUAGE_SQL})`)),
    directionCk: check('demo_v2_experience_plans_direction_ck', sql.raw(`primary_direction IN (${DEMO_V2_DIRECTION_SQL})`)),
    languagesJsonCk: check('demo_v2_experience_plans_languages_json_ck', sql`jsonb_typeof(${t.supportedLanguages}) = 'array'`),
    hashCk: check('demo_v2_experience_plans_hash_ck', sql.raw(`component_registry_hash ~ '${DEMO_V2_HASH_SQL}' AND reference_library_hash ~ '${DEMO_V2_HASH_SQL}' AND input_fingerprint ~ '${DEMO_V2_HASH_SQL}' AND plan_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ExperiencePlanTranslations = pgTable(
  'demo_v2_experience_plan_translations',
  {
    experiencePlanId: text('experience_plan_id').notNull().references(() => demoV2ExperiencePlans.id, { onDelete: 'cascade' }),
    translationPackageId: text('translation_package_id').notNull()
      .references(() => demoV2TranslationPackages.id, { onDelete: 'restrict' }),
    boundTranslationHash: text('bound_translation_hash').notNull(),
    boundSourceContentHash: text('bound_source_content_hash').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.experiencePlanId, t.translationPackageId] }),
    translationIdx: index('demo_v2_plan_translations_translation_idx').on(t.translationPackageId),
    hashCk: check('demo_v2_plan_translations_hash_ck', sql.raw(`bound_translation_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_source_content_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ExperiencePlanAssets = pgTable(
  'demo_v2_experience_plan_assets',
  {
    experiencePlanId: text('experience_plan_id').notNull().references(() => demoV2ExperiencePlans.id, { onDelete: 'cascade' }),
    assetSelectionId: text('asset_selection_id').notNull().references(() => demoV2AssetSelections.id, { onDelete: 'restrict' }),
    reuseReviewId: text('reuse_review_id').notNull().references(() => demoV2AssetReuseReviews.id, { onDelete: 'restrict' }),
    boundAssetRecordHash: text('bound_asset_record_hash').notNull(),
    boundSelectionHash: text('bound_selection_hash').notNull(),
    boundReuseReviewHash: text('bound_reuse_review_hash').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.experiencePlanId, t.assetSelectionId] }),
    selectionIdx: index('demo_v2_plan_assets_selection_idx').on(t.assetSelectionId),
    reviewIdx: index('demo_v2_plan_assets_review_idx').on(t.reuseReviewId),
    hashCk: check('demo_v2_plan_assets_hash_ck', sql.raw(`bound_asset_record_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_selection_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_reuse_review_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ApprovalPackages = pgTable(
  'demo_v2_approval_packages',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    clinicIntelligencePackageId: text('clinic_intelligence_package_id').notNull()
      .references(() => demoV2ClinicIntelligencePackages.id, { onDelete: 'restrict' }),
    primaryContentPackageId: text('primary_content_package_id').notNull()
      .references(() => demoV2PrimaryContentPackages.id, { onDelete: 'restrict' }),
    assetCatalogId: text('asset_catalog_id').notNull().references(() => demoV2AssetCatalogs.id, { onDelete: 'restrict' }),
    creativeBriefId: text('creative_brief_id').notNull().references(() => demoV2CreativeBriefs.id, { onDelete: 'restrict' }),
    experiencePlanId: text('experience_plan_id').notNull().references(() => demoV2ExperiencePlans.id, { onDelete: 'restrict' }),
    schemaVersion: text('schema_version').notNull(),
    intelligenceHash: text('intelligence_hash').notNull(),
    primaryContentHash: text('primary_content_hash').notNull(),
    translationSetHash: text('translation_set_hash').notNull(),
    assetCatalogHash: text('asset_catalog_hash').notNull(),
    assetSelectionSetHash: text('asset_selection_set_hash').notNull(),
    creativeBriefHash: text('creative_brief_hash').notNull(),
    experiencePlanHash: text('experience_plan_hash').notNull(),
    componentRegistryVersion: text('component_registry_version').notNull(),
    componentRegistryHash: text('component_registry_hash').notNull(),
    referenceLibraryVersion: text('reference_library_version').notNull(),
    referenceLibraryHash: text('reference_library_hash').notNull(),
    renderHash: text('render_hash').notNull(),
    screenshotSetHash: text('screenshot_set_hash').notNull(),
    qualityRubricVersion: text('quality_rubric_version').notNull(),
    qualityRubricHash: text('quality_rubric_hash').notNull(),
    visualReviewSetHash: text('visual_review_set_hash').notNull(),
    approvalPackageHash: text('approval_package_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packageUk: uniqueIndex('demo_v2_approval_packages_artifact_hash_uk').on(t.artifactId, t.approvalPackageHash),
    planIdx: index('demo_v2_approval_packages_plan_idx').on(t.experiencePlanId),
    renderIdx: index('demo_v2_approval_packages_render_idx').on(t.renderHash),
    hashIdx: index('demo_v2_approval_packages_hash_idx').on(t.approvalPackageHash),
    hashesCk: check('demo_v2_approval_packages_hashes_ck', sql.raw(`
      intelligence_hash ~ '${DEMO_V2_HASH_SQL}' AND primary_content_hash ~ '${DEMO_V2_HASH_SQL}'
      AND translation_set_hash ~ '${DEMO_V2_HASH_SQL}' AND asset_catalog_hash ~ '${DEMO_V2_HASH_SQL}'
      AND asset_selection_set_hash ~ '${DEMO_V2_HASH_SQL}' AND creative_brief_hash ~ '${DEMO_V2_HASH_SQL}'
      AND experience_plan_hash ~ '${DEMO_V2_HASH_SQL}' AND component_registry_hash ~ '${DEMO_V2_HASH_SQL}'
      AND reference_library_hash ~ '${DEMO_V2_HASH_SQL}' AND render_hash ~ '${DEMO_V2_HASH_SQL}'
      AND screenshot_set_hash ~ '${DEMO_V2_HASH_SQL}' AND quality_rubric_hash ~ '${DEMO_V2_HASH_SQL}'
      AND visual_review_set_hash ~ '${DEMO_V2_HASH_SQL}' AND approval_package_hash ~ '${DEMO_V2_HASH_SQL}'`)),
    rubricCk: check('demo_v2_approval_packages_rubric_ck', sql`length(trim(${t.qualityRubricVersion})) > 0`),
  }),
);

export const demoV2ApprovalTranslationInputs = pgTable(
  'demo_v2_approval_translation_inputs',
  {
    approvalPackageId: text('approval_package_id').notNull().references(() => demoV2ApprovalPackages.id, { onDelete: 'cascade' }),
    translationPackageId: text('translation_package_id').notNull()
      .references(() => demoV2TranslationPackages.id, { onDelete: 'restrict' }),
    boundSourceContentHash: text('bound_source_content_hash').notNull(),
    boundTranslationHash: text('bound_translation_hash').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.approvalPackageId, t.translationPackageId] }),
    hashCk: check('demo_v2_approval_translations_hash_ck', sql.raw(`bound_source_content_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_translation_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ApprovalAssetInputs = pgTable(
  'demo_v2_approval_asset_inputs',
  {
    approvalPackageId: text('approval_package_id').notNull().references(() => demoV2ApprovalPackages.id, { onDelete: 'cascade' }),
    assetSelectionId: text('asset_selection_id').notNull().references(() => demoV2AssetSelections.id, { onDelete: 'restrict' }),
    reuseReviewId: text('reuse_review_id').notNull().references(() => demoV2AssetReuseReviews.id, { onDelete: 'restrict' }),
    boundAssetRecordHash: text('bound_asset_record_hash').notNull(),
    boundSelectionHash: text('bound_selection_hash').notNull(),
    boundReuseReviewHash: text('bound_reuse_review_hash').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.approvalPackageId, t.assetSelectionId] }),
    hashCk: check('demo_v2_approval_assets_hash_ck', sql.raw(`bound_asset_record_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_selection_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_reuse_review_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ApprovalDecisions = pgTable(
  'demo_v2_approval_decisions',
  {
    id: text('id').primaryKey(),
    approvalPackageId: text('approval_package_id').notNull().references(() => demoV2ApprovalPackages.id, { onDelete: 'cascade' }),
    decision: text('decision').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    reviewCycle: integer('review_cycle'),
    score: doublePrecision('score'),
    blockerCount: integer('blocker_count'),
    categoryScores: jsonb('category_scores').notNull(),
    notes: text('notes'),
    boundApprovalPackageHash: text('bound_approval_package_hash').notNull(),
    boundVisualReviewSetHash: text('bound_visual_review_set_hash').notNull(),
    boundQualityRubricHash: text('bound_quality_rubric_hash').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packageTimeIdx: index('demo_v2_approval_decisions_package_time_idx').on(t.approvalPackageId, t.decidedAt),
    cycleUk: uniqueIndex('demo_v2_approval_decisions_cycle_uk').on(t.approvalPackageId, t.decision, t.reviewCycle)
      .where(sql`${t.reviewCycle} IS NOT NULL`),
    humanUk: uniqueIndex('demo_v2_approval_decisions_human_uk').on(t.approvalPackageId)
      .where(sql`${t.decision} IN ('HUMAN_APPROVED','HUMAN_REJECTED')`),
    decisionCk: check('demo_v2_approval_decisions_decision_ck', sql`${t.decision} IN ('AUTO_REVIEW_PASSED','AUTO_REVIEW_FAILED','HUMAN_APPROVED','HUMAN_REJECTED')`),
    actorCk: check('demo_v2_approval_decisions_actor_ck', sql`${t.actorType} IN ('MODEL','HUMAN','SYSTEM') AND length(trim(${t.actorId})) > 0`),
    cycleCk: check('demo_v2_approval_decisions_cycle_ck', sql`${t.reviewCycle} IS NULL OR ${t.reviewCycle} BETWEEN 1 AND 3`),
    scoreCk: check('demo_v2_approval_decisions_score_ck', sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 100`),
    blockersCk: check('demo_v2_approval_decisions_blockers_ck', sql`${t.blockerCount} IS NULL OR ${t.blockerCount} >= 0`),
    categoryJsonCk: check('demo_v2_approval_decisions_categories_json_ck', sql`jsonb_typeof(${t.categoryScores}) = 'object'`),
    autoPassCk: check('demo_v2_approval_decisions_auto_pass_ck', sql`
      ${t.decision} <> 'AUTO_REVIEW_PASSED'
      OR (${t.actorType} IN ('MODEL','SYSTEM') AND ${t.score} >= 85 AND ${t.blockerCount} = 0
        AND ${t.categoryScores} <> '{}'::jsonb)`),
    actorDecisionCk: check('demo_v2_approval_decisions_actor_decision_ck', sql`
      (${t.decision} IN ('AUTO_REVIEW_PASSED','AUTO_REVIEW_FAILED') AND ${t.actorType} IN ('MODEL','SYSTEM'))
      OR (${t.decision} IN ('HUMAN_APPROVED','HUMAN_REJECTED') AND ${t.actorType} = 'HUMAN')`),
    hashCk: check('demo_v2_approval_decisions_hash_ck', sql.raw(`bound_approval_package_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_visual_review_set_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_quality_rubric_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ApprovalInvalidations = pgTable(
  'demo_v2_approval_invalidations',
  {
    id: text('id').primaryKey(),
    approvalPackageId: text('approval_package_id').notNull().references(() => demoV2ApprovalPackages.id, { onDelete: 'cascade' }),
    reasonCode: text('reason_code').notNull(),
    changedBindings: jsonb('changed_bindings').notNull(),
    previousPackageHash: text('previous_package_hash').notNull(),
    observedFingerprint: text('observed_fingerprint').notNull(),
    actorType: text('actor_type').notNull().default('SYSTEM'),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packageUk: uniqueIndex('demo_v2_approval_invalidations_package_uk').on(t.approvalPackageId),
    timeIdx: index('demo_v2_approval_invalidations_time_idx').on(t.invalidatedAt),
    reasonCk: check('demo_v2_approval_invalidations_reason_ck', sql`${t.reasonCode} IN (
      'INTELLIGENCE_CHANGED','PRIMARY_CONTENT_CHANGED','TRANSLATION_CHANGED','ASSET_CATALOG_CHANGED',
      'ASSET_SELECTION_CHANGED','REUSE_REVIEW_CHANGED','CREATIVE_BRIEF_CHANGED','EXPERIENCE_PLAN_CHANGED',
      'COMPONENT_REGISTRY_CHANGED','REFERENCE_LIBRARY_CHANGED','RENDER_CHANGED','SCREENSHOT_SET_CHANGED',
      'QUALITY_RUBRIC_CHANGED','VISUAL_REVIEW_SET_CHANGED','MANUAL_INVALIDATION')`),
    actorCk: check('demo_v2_approval_invalidations_actor_ck', sql`${t.actorType} IN ('SYSTEM','HUMAN')`),
    hashCk: check('demo_v2_approval_invalidations_hash_ck', sql.raw(`previous_package_hash ~ '${DEMO_V2_HASH_SQL}' AND observed_fingerprint ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

// --- Milestone 3B1: render / screenshot / review-package persistence (immutable, versioned) ---

export const demoV2RenderVersions = pgTable(
  'demo_v2_render_versions',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    experiencePlanId: text('experience_plan_id').notNull().references(() => demoV2ExperiencePlans.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    referenceFamily: text('reference_family').notNull(),
    bundleLocation: text('bundle_location').notNull(),
    status: text('status').notNull().default('RENDERED'),
    primaryLanguage: text('primary_language').notNull(),
    supportedLanguages: jsonb('supported_languages').notNull(),
    intelligenceHash: text('intelligence_hash').notNull(),
    contentHash: text('content_hash').notNull(),
    translationHash: text('translation_hash'),
    assetSelectionSetHash: text('asset_selection_set_hash').notNull(),
    componentRegistryHash: text('component_registry_hash').notNull(),
    referenceLibraryHash: text('reference_library_hash').notNull(),
    creativeBriefHash: text('creative_brief_hash').notNull(),
    experiencePlanHash: text('experience_plan_hash').notNull(),
    renderHash: text('render_hash').notNull(),
    structurallyEligible: boolean('structurally_eligible').notNull(),
    deterministicValidation: jsonb('deterministic_validation').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    supersededById: text('superseded_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionUk: uniqueIndex('demo_v2_render_versions_artifact_version_uk').on(t.artifactId, t.version),
    currentUk: uniqueIndex('demo_v2_render_versions_current_uk').on(t.artifactId).where(sql`${t.isCurrent}`),
    renderHashIdx: index('demo_v2_render_versions_hash_idx').on(t.renderHash),
    versionCk: check('demo_v2_render_versions_version_ck', sql`${t.version} > 0`),
    statusCk: check('demo_v2_render_versions_status_ck', sql`${t.status} IN ('RENDERED','SUPERSEDED')`),
    languageCk: check('demo_v2_render_versions_language_ck', sql.raw(`primary_language IN (${DEMO_V2_LANGUAGE_SQL})`)),
    hashCk: check('demo_v2_render_versions_hash_ck', sql.raw(
      `render_hash ~ '${DEMO_V2_HASH_SQL}' AND content_hash ~ '${DEMO_V2_HASH_SQL}'`
      + ` AND intelligence_hash ~ '${DEMO_V2_HASH_SQL}' AND (translation_hash IS NULL OR translation_hash ~ '${DEMO_V2_HASH_SQL}')`)),
  }),
);

export const demoV2Screenshots = pgTable(
  'demo_v2_screenshots',
  {
    id: text('id').primaryKey(),
    renderVersionId: text('render_version_id').notNull().references(() => demoV2RenderVersions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    language: text('language').notNull(),
    viewport: text('viewport').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    fileHash: text('file_hash').notNull(),
    location: text('location').notNull(),
    screenshotSetHash: text('screenshot_set_hash').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    renderHash: text('render_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    memberUk: uniqueIndex('demo_v2_screenshots_member_uk').on(t.renderVersionId, t.kind, t.language, t.viewport),
    setIdx: index('demo_v2_screenshots_set_idx').on(t.screenshotSetHash),
    kindCk: check('demo_v2_screenshots_kind_ck', sql`${t.kind} IN ('ORIGINAL','FINAL')`),
    viewportCk: check('demo_v2_screenshots_viewport_ck', sql`${t.viewport} IN ('DESKTOP','TABLET','MOBILE')`),
    languageCk: check('demo_v2_screenshots_language_ck', sql.raw(`language IN (${DEMO_V2_LANGUAGE_SQL})`)),
    dimensionsCk: check('demo_v2_screenshots_dimensions_ck', sql`${t.width} > 0 AND ${t.height} > 0`),
    hashCk: check('demo_v2_screenshots_hash_ck', sql.raw(`file_hash ~ '${DEMO_V2_HASH_SQL}' AND screenshot_set_hash ~ '${DEMO_V2_HASH_SQL}' AND render_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

export const demoV2ReviewPackages = pgTable(
  'demo_v2_review_packages',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    renderVersionId: text('render_version_id').notNull().references(() => demoV2RenderVersions.id, { onDelete: 'cascade' }),
    schemaVersion: text('schema_version').notNull(),
    referenceFamily: text('reference_family').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    primaryLanguage: text('primary_language').notNull(),
    supportedLanguages: jsonb('supported_languages').notNull(),
    payload: jsonb('payload').notNull(),
    renderHash: text('render_hash').notNull(),
    screenshotSetHash: text('screenshot_set_hash').notNull(),
    reviewPackageHash: text('review_package_hash').notNull(),
    structurallyEligible: boolean('structurally_eligible').notNull(),
    /** Milestone 3B1 never makes a render deployment eligible. */
    deploymentEligible: boolean('deployment_eligible').notNull().default(false),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    renderUk: uniqueIndex('demo_v2_review_packages_render_uk').on(t.renderVersionId),
    currentUk: uniqueIndex('demo_v2_review_packages_current_uk').on(t.artifactId).where(sql`${t.isCurrent}`),
    hashIdx: index('demo_v2_review_packages_hash_idx').on(t.reviewPackageHash),
    deploymentCk: check('demo_v2_review_packages_deployment_ck', sql`${t.deploymentEligible} = false`),
    hashCk: check('demo_v2_review_packages_hash_ck', sql.raw(`render_hash ~ '${DEMO_V2_HASH_SQL}' AND screenshot_set_hash ~ '${DEMO_V2_HASH_SQL}' AND review_package_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

/**
 * Milestone 3B2B1: immutable Sol visual-review records. Each row binds a verdict to the exact
 * render / screenshot-set / review-package hashes and the reviewer input fingerprint. A verdict is
 * APPROVE | REVISE | REJECT only — the vocabulary cannot express AUTO_REVIEW_PASSED — and a mock
 * verdict must cost $0. Rows are never mutated except to flip is_current / stale.
 */
export const demoV2VisualReviews = pgTable(
  'demo_v2_visual_reviews',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => demoV2Artifacts.id, { onDelete: 'cascade' }),
    renderVersionId: text('render_version_id').notNull().references(() => demoV2RenderVersions.id, { onDelete: 'cascade' }),
    reviewPackageId: text('review_package_id').notNull().references(() => demoV2ReviewPackages.id, { onDelete: 'cascade' }),
    reviewRunId: text('review_run_id').notNull(),
    cycle: integer('cycle').notNull(),
    provider: text('provider').notNull(),
    requestedModel: text('requested_model').notNull(),
    resolvedModel: text('resolved_model'),
    reasoningEffort: text('reasoning_effort').notNull(),
    schemaVersion: text('schema_version').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    boundRenderHash: text('bound_render_hash').notNull(),
    boundScreenshotSetHash: text('bound_screenshot_set_hash').notNull(),
    boundReviewPackageHash: text('bound_review_package_hash').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    rubricHash: text('rubric_hash').notNull(),
    overallScore: integer('overall_score').notNull(),
    categoryScores: jsonb('category_scores').notNull(),
    blockers: jsonb('blockers').notNull(),
    findings: jsonb('findings').notNull(),
    permittedRevisionOperations: jsonb('permitted_revision_operations').notNull(),
    decision: text('decision').notNull(),
    inputTokens: integer('input_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
    responseId: text('response_id'),
    reviewOutputHash: text('review_output_hash').notNull(),
    stale: boolean('stale').notNull().default(false),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    renderUk: uniqueIndex('demo_v2_visual_reviews_render_uk').on(t.renderVersionId),
    runCycleUk: uniqueIndex('demo_v2_visual_reviews_run_cycle_uk').on(t.reviewRunId, t.cycle),
    currentUk: uniqueIndex('demo_v2_visual_reviews_current_uk').on(t.artifactId).where(sql`${t.isCurrent}`),
    artifactIdx: index('demo_v2_visual_reviews_artifact_idx').on(t.artifactId),
    fingerprintIdx: index('demo_v2_visual_reviews_fingerprint_idx').on(t.inputFingerprint),
    outputHashIdx: index('demo_v2_visual_reviews_output_hash_idx').on(t.reviewOutputHash),
    cycleCk: check('demo_v2_visual_reviews_cycle_ck', sql`${t.cycle} BETWEEN 1 AND 3`),
    providerCk: check('demo_v2_visual_reviews_provider_ck', sql`${t.provider} IN ('mock','openai')`),
    decisionCk: check('demo_v2_visual_reviews_decision_ck', sql`${t.decision} IN ('APPROVE','REVISE','REJECT')`),
    scoreCk: check('demo_v2_visual_reviews_score_ck', sql`${t.overallScore} BETWEEN 0 AND 100`),
    costCk: check('demo_v2_visual_reviews_cost_ck', sql`${t.costUsd} >= 0`),
    mockCostCk: check('demo_v2_visual_reviews_mock_cost_ck', sql`${t.provider} <> 'mock' OR ${t.costUsd} = 0`),
    hashCk: check('demo_v2_visual_reviews_hash_ck', sql.raw(
      `input_fingerprint ~ '${DEMO_V2_HASH_SQL}' AND bound_render_hash ~ '${DEMO_V2_HASH_SQL}'`
      + ` AND bound_screenshot_set_hash ~ '${DEMO_V2_HASH_SQL}' AND bound_review_package_hash ~ '${DEMO_V2_HASH_SQL}'`
      + ` AND rubric_hash ~ '${DEMO_V2_HASH_SQL}' AND review_output_hash ~ '${DEMO_V2_HASH_SQL}'`)),
  }),
);

// --- Phase 17A: outreach tracking & follow-up operations (tracking only; NEVER sends) ---
//
// Postgres is the source of truth. These tables model a campaign, per-(lead×campaign×
// contact) outreach state, immutable message history, follow-up queue, replies, and an
// immutable per-record event timeline. No row here ever triggers a send or a Gmail mutation.

export const outreachCampaigns = pgTable(
  'outreach_campaigns',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sequencePolicy: jsonb('sequence_policy').notNull(),
    timezone: text('timezone').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameUk: uniqueIndex('outreach_campaigns_name_uk').on(t.name),
    statusCk: check('outreach_campaign_status_ck', sql`${t.status} IN ('ACTIVE','PAUSED','ARCHIVED')`),
  }),
);

export const outreachRecords = pgTable(
  'outreach_records',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id').notNull().references(() => outreachCampaigns.id, { onDelete: 'cascade' }),
    leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    contactEmail: text('contact_email').notNull(),
    status: text('status').notNull().default('DRAFT_READY'),
    sequenceStep: integer('sequence_step').notNull().default(0),
    owner: text('owner'),
    timezone: text('timezone').notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    nextFollowupAt: timestamp('next_followup_at', { withTimezone: true }),
    lastReplyAt: timestamp('last_reply_at', { withTimezone: true }),
    replyCategory: text('reply_category'),
    doNotContact: boolean('do_not_contact').notNull().default(false),
    outcome: text('outcome'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index('outreach_records_lead_idx').on(t.leadId),
    campaignIdx: index('outreach_records_campaign_idx').on(t.campaignId),
    contactIdx: index('outreach_records_contact_idx').on(t.contactEmail),
    // Prevent duplicate ACTIVE outreach for the same (campaign, lead, contact). A record
    // is "active" while it is not in a terminal state; terminal rows are retained (history).
    activeUk: uniqueIndex('outreach_records_active_uk')
      .on(t.campaignId, t.leadId, t.contactEmail)
      .where(sql`${t.status} NOT IN ('UNSUBSCRIBED','DO_NOT_CONTACT','CLOSED_WON','CLOSED_LOST')`),
    statusCk: check('outreach_record_status_ck', sql`${t.status} IN (
      'DRAFT_READY','AWAITING_APPROVAL','APPROVED_TO_SEND','INITIAL_SENT',
      'FOLLOW_UP_1_DUE','FOLLOW_UP_1_SENT','FOLLOW_UP_2_DUE','FOLLOW_UP_2_SENT',
      'REPLIED_POSITIVE','REPLIED_NEUTRAL','REPLIED_NEGATIVE','BOUNCED','UNSUBSCRIBED',
      'DO_NOT_CONTACT','MEETING_BOOKED','CLOSED_WON','CLOSED_LOST')`),
  }),
);

export const outreachMessages = pgTable(
  'outreach_messages',
  {
    id: text('id').primaryKey(),
    outreachRecordId: text('outreach_record_id').notNull().references(() => outreachRecords.id, { onDelete: 'cascade' }),
    messageType: text('message_type').notNull(),
    sequenceStep: integer('sequence_step').notNull(),
    // Exact subject/body snapshot — NEVER updated or deleted after insert.
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    contentHash: text('content_hash').notNull(),
    emailDraftId: text('email_draft_id').references(() => emailDrafts.id, { onDelete: 'set null' }),
    finalizedEmailId: text('finalized_email_id').references(() => emailDraftFinalizations.id, { onDelete: 'set null' }),
    gmailMessageId: text('gmail_message_id'),
    gmailThreadId: text('gmail_thread_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recordIdx: index('outreach_messages_record_idx').on(t.outreachRecordId),
    threadIdx: index('outreach_messages_thread_idx').on(t.gmailThreadId),
    typeCk: check('outreach_message_type_ck', sql`${t.messageType} IN ('INITIAL','FOLLOW_UP')`),
  }),
);

export const outreachFollowups = pgTable(
  'outreach_followups',
  {
    id: text('id').primaryKey(),
    outreachRecordId: text('outreach_record_id').notNull().references(() => outreachRecords.id, { onDelete: 'cascade' }),
    step: integer('step').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull(),
    status: text('status').notNull().default('DUE'),
    blockedReason: text('blocked_reason'),
    cancelledReason: text('cancelled_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recordIdx: index('outreach_followups_record_idx').on(t.outreachRecordId),
    // At most one pending (DUE) follow-up per record+step; cancelled/postponed rows retained.
    pendingUk: uniqueIndex('outreach_followups_pending_uk').on(t.outreachRecordId, t.step).where(sql`${t.status} = 'DUE'`),
    statusCk: check('outreach_followup_status_ck', sql`${t.status} IN ('DUE','CANCELLED','POSTPONED','SENT')`),
    stepCk: check('outreach_followup_step_ck', sql`${t.step} IN (1,2)`),
  }),
);

export const outreachReplies = pgTable(
  'outreach_replies',
  {
    id: text('id').primaryKey(),
    outreachRecordId: text('outreach_record_id').notNull().references(() => outreachRecords.id, { onDelete: 'cascade' }),
    gmailThreadId: text('gmail_thread_id').notNull(),
    gmailMessageId: text('gmail_message_id').notNull(),
    fromEmail: text('from_email').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    classification: text('classification').notNull(),
    preview: text('preview').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recordIdx: index('outreach_replies_record_idx').on(t.outreachRecordId),
    // A given Gmail message is recorded as a reply at most once (idempotent sync).
    messageUk: uniqueIndex('outreach_replies_message_uk').on(t.gmailMessageId),
    classificationCk: check('outreach_reply_classification_ck', sql`${t.classification} IN ('positive','neutral','negative','unsubscribe','bounce')`),
  }),
);


export const outreachEvents = pgTable(
  'outreach_events',
  {
    id: text('id').primaryKey(),
    outreachRecordId: text('outreach_record_id').notNull().references(() => outreachRecords.id, { onDelete: 'cascade' }),
    // 1-based monotonic position within the record's timeline; strictly increasing.
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    message: text('message').notNull(),
    data: jsonb('data'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recordSeqUk: uniqueIndex('outreach_events_record_seq_uk').on(t.outreachRecordId, t.seq),
  }),
);

// Phase 17C: delivery failure reconciliation. Correlates a tracked outbound message with a
// Gmail Delivery Status Notification (DSN) and records the diagnostic fields that make the
// outreach state auditable. Immutable (insert-only): the outbound message row is never
// mutated — a message stays historically "sent" while its outreach state may become BOUNCED.
export const outreachDeliveryEvents = pgTable(
  'outreach_delivery_events',
  {
    id: text('id').primaryKey(),
    outreachRecordId: text('outreach_record_id').notNull().references(() => outreachRecords.id, { onDelete: 'cascade' }),
    outreachMessageId: text('outreach_message_id').references(() => outreachMessages.id, { onDelete: 'set null' }),
    deliveryStatus: text('delivery_status').notNull(),
    permanence: text('permanence').notNull(),
    rejectionCode: text('rejection_code'),
    diagnosticText: text('diagnostic_text'),
    dsnStatus: text('dsn_status'),
    dsnAction: text('dsn_action'),
    finalRecipient: text('final_recipient'),
    originalRecipient: text('original_recipient'),
    bounceAt: timestamp('bounce_at', { withTimezone: true }),
    originalGmailMessageId: text('original_gmail_message_id'),
    originalGmailThreadId: text('original_gmail_thread_id'),
    dsnGmailMessageId: text('dsn_gmail_message_id').notNull(),
    dsnGmailThreadId: text('dsn_gmail_thread_id'),
    preview: text('preview').notNull(),
    // Phase 17C1 operator correction: invalidate (supersede) a mis-correlated event without
    // deleting it. Null while valid.
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededReason: text('superseded_reason'),
    supersededBy: text('superseded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recordIdx: index('outreach_delivery_events_record_idx').on(t.outreachRecordId),
    // A given DSN Gmail message is recorded at most once (idempotent reconciliation).
    dsnUk: uniqueIndex('outreach_delivery_events_dsn_uk').on(t.dsnGmailMessageId),
    statusCk: check('outreach_delivery_status_ck', sql`${t.deliveryStatus} IN ('DELIVERED','BOUNCED','DELIVERY_UNKNOWN')`),
    permanenceCk: check('outreach_delivery_permanence_ck', sql`${t.permanence} IN ('PERMANENT','TEMPORARY','UNKNOWN')`),
  }),
);

// --- Phase 7A1: deterministic competitor candidate research (fixtures/CSV only) ---
// Additive, immutable/versioned. No website evidence, no email-package, no live-provider data.

export const competitorResearchRuns = pgTable(
  'competitor_research_runs',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('DRAFT'),
    outcome: text('outcome').notNull(),
    activeRadius: text('active_radius').notNull(),
    inputHash: text('input_hash').notNull(),
    configHash: text('config_hash').notNull(),
    rulesVersion: text('rules_version').notNull(),
    version: integer('version').notNull(),
    candidateCount: integer('candidate_count').notNull(),
    acceptedCount: integer('accepted_count').notNull(),
    rejectedCount: integer('rejected_count').notNull(),
    primaryRadiusKm: doublePrecision('primary_radius_km').notNull(),
    fallbackRadiusKm: doublePrecision('fallback_radius_km').notNull(),
    maxSelected: integer('max_selected').notNull(),
    // Additive supersession: a materially-different rerun supersedes prior DRAFT runs (never deletes).
    supersededBy: text('superseded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index('competitor_research_runs_lead_idx').on(t.leadId),
    // Idempotency anchor: identical input+config for a lead is one run, never duplicated.
    idempotencyUk: uniqueIndex('competitor_research_runs_idempotency_uk').on(t.leadId, t.inputHash, t.configHash),
    // Immutable per-lead version identity.
    versionUk: uniqueIndex('competitor_research_runs_version_uk').on(t.leadId, t.version),
    providerCk: check('competitor_research_runs_provider_ck', sql`${t.provider} IN ('fixture','operator_csv')`),
    statusCk: check('competitor_research_runs_status_ck', sql`${t.status} IN ('DRAFT','SUPERSEDED')`),
    outcomeCk: check('competitor_research_runs_outcome_ck', sql`${t.outcome} IN ('RESEARCHED','INSUFFICIENT_COMPARABLE','NO_CANDIDATES_FOUND')`),
    radiusCk: check('competitor_research_runs_radius_ck', sql`${t.activeRadius} IN ('PRIMARY_5KM','FALLBACK_10KM')`),
  }),
);

export const competitorCandidates = pgTable(
  'competitor_candidates',
  {
    id: text('id').primaryKey(),
    researchRunId: text('research_run_id')
      .notNull()
      .references(() => competitorResearchRuns.id, { onDelete: 'cascade' }),
    rowIndex: integer('row_index').notNull(),
    providerCandidateId: text('provider_candidate_id'),
    businessName: text('business_name'),
    normalizedName: text('normalized_name'),
    rawDomain: text('raw_domain'),
    normalizedDomain: text('normalized_domain'),
    primaryCategory: text('primary_category'),
    normalizedPrimaryCategory: text('normalized_primary_category'),
    secondaryCategories: jsonb('secondary_categories').notNull(),
    normalizedServices: jsonb('normalized_services').notNull(),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    city: text('city'),
    market: text('market'),
    language: text('language'),
    businessType: text('business_type'),
    parentBrand: text('parent_brand'),
    normalizedParentBrand: text('normalized_parent_brand'),
    branchId: text('branch_id'),
    brandKey: text('brand_key').notNull(),
    distanceMeters: doublePrecision('distance_meters'),
    categoryMatch: text('category_match'),
    comparabilityScore: integer('comparability_score'),
    confidence: text('confidence'),
    disposition: text('disposition').notNull(),
    rejectionReason: text('rejection_reason'),
    reasonDetail: text('reason_detail').notNull(),
    acceptanceRank: integer('acceptance_rank'),
    scoreBreakdown: jsonb('score_breakdown').notNull(),
    gateResults: jsonb('gate_results').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('competitor_candidates_run_idx').on(t.researchRunId),
    dispositionCk: check('competitor_candidates_disposition_ck', sql`${t.disposition} IN ('ACCEPTED','REJECTED')`),
    categoryMatchCk: check('competitor_candidates_category_match_ck', sql`${t.categoryMatch} IS NULL OR ${t.categoryMatch} IN ('EXACT','RELATED','WEAK','NONE')`),
    confidenceCk: check('competitor_candidates_confidence_ck', sql`${t.confidence} IS NULL OR ${t.confidence} IN ('HIGH','MEDIUM','LOW')`),
  }),
);

// --- Phase 7A2: competitor website evidence capture (additive; dedicated, non-lead-bound tables) ---

const COMPETITOR_EVIDENCE_CATEGORIES =
  "'BOOKING_CTA_VISIBLE','PHONE_VISIBLE','WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE','MOBILE_STICKY_CONTACT_CONTROL','SERVICE_INFORMATION_VISIBLE','LOCATION_VISIBLE','OPENING_HOURS_VISIBLE','TEAM_OR_PRACTITIONER_INFORMATION','ON_SITE_TESTIMONIAL_OR_REVIEW_SECTION','PRICING_OR_FINANCING_INFORMATION','EMERGENCY_OR_URGENT_SERVICE_MESSAGE','LANGUAGE_SUPPORT_VISIBLE','FAQ_CONTENT_VISIBLE','MOBILE_NAVIGATION_DEPTH','CONTACT_PATH_DEPTH'";
const COMPETITOR_OBSERVATION_KINDS = "'DIRECT_OBSERVATION','DETERMINISTIC_INTERPRETATION','UNSUPPORTED_INFERENCE'";
const COMPETITOR_FRESHNESS_STATUSES = "'FRESH','STALE','UNREPRODUCIBLE'";
const COMPETITOR_CAPTURE_OUTCOMES = "'CAPTURED','PARTIAL','NO_ELIGIBLE_COMPETITORS','ALL_INACCESSIBLE','GUARD_FAILED'";

export const competitorCaptureRuns = pgTable(
  'competitor_capture_runs',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    researchRunId: text('research_run_id')
      .notNull()
      .references(() => competitorResearchRuns.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    method: text('method').notNull(),
    purpose: text('purpose').notNull().default('COMPETITOR_CAPTURE'),
    status: text('status').notNull().default('DRAFT'),
    outcome: text('outcome').notNull(),
    rulesVersion: text('rules_version').notNull(),
    version: integer('version').notNull(),
    inputHash: text('input_hash').notNull(),
    configHash: text('config_hash').notNull(),
    contentHash: text('content_hash').notNull(),
    competitorCount: integer('competitor_count').notNull(),
    pageCount: integer('page_count').notNull(),
    evidenceCount: integer('evidence_count').notNull(),
    activeEvidenceCount: integer('active_evidence_count').notNull(),
    withheldEvidenceCount: integer('withheld_evidence_count').notNull(),
    maxPages: integer('max_pages').notNull(),
    maxDepth: integer('max_depth').notNull(),
    // Additive supersession: a materially-changed recapture supersedes prior DRAFT runs (never deletes).
    supersededBy: text('superseded_by'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index('competitor_capture_runs_lead_idx').on(t.leadId),
    researchIdx: index('competitor_capture_runs_research_idx').on(t.researchRunId),
    // Idempotency: identical eligible set + config + resulting content is one run, never duplicated.
    idempotencyUk: uniqueIndex('competitor_capture_runs_idempotency_uk').on(t.researchRunId, t.inputHash, t.configHash, t.contentHash),
    versionUk: uniqueIndex('competitor_capture_runs_version_uk').on(t.researchRunId, t.version),
    providerCk: check('competitor_capture_runs_provider_ck', sql`${t.provider} IN ('fixture','playwright')`),
    methodCk: check('competitor_capture_runs_method_ck', sql`${t.method} IN ('FIXTURE','LIVE_BROWSER')`),
    purposeCk: check('competitor_capture_runs_purpose_ck', sql`${t.purpose} = 'COMPETITOR_CAPTURE'`),
    statusCk: check('competitor_capture_runs_status_ck', sql`${t.status} IN ('DRAFT','SUPERSEDED')`),
    outcomeCk: check('competitor_capture_runs_outcome_ck', sql.raw(`outcome IN (${COMPETITOR_CAPTURE_OUTCOMES})`)),
  }),
);

export const competitorCapturedPages = pgTable(
  'competitor_captured_pages',
  {
    id: text('id').primaryKey(),
    captureRunId: text('capture_run_id')
      .notNull()
      .references(() => competitorCaptureRuns.id, { onDelete: 'cascade' }),
    competitorCandidateId: text('competitor_candidate_id')
      .notNull()
      .references(() => competitorCandidates.id, { onDelete: 'cascade' }),
    requestedUrl: text('requested_url').notNull(),
    finalUrl: text('final_url').notNull(),
    normalizedOrigin: text('normalized_origin').notNull(),
    role: text('role').notNull(),
    profile: text('profile').notNull(),
    ok: boolean('ok').notNull(),
    httpStatus: integer('http_status'),
    errorKinds: jsonb('error_kinds').notNull(),
    // No raw HTML is retained; only a content hash for reproducibility/idempotency.
    rawDomHash: text('raw_dom_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('competitor_captured_pages_run_idx').on(t.captureRunId),
    competitorIdx: index('competitor_captured_pages_competitor_idx').on(t.competitorCandidateId),
    profileCk: check('competitor_captured_pages_profile_ck', sql`${t.profile} IN ('desktop','mobile')`),
  }),
);

export const competitorEvidenceItems = pgTable(
  'competitor_evidence_items',
  {
    id: text('id').primaryKey(),
    captureRunId: text('capture_run_id')
      .notNull()
      .references(() => competitorCaptureRuns.id, { onDelete: 'cascade' }),
    competitorCandidateId: text('competitor_candidate_id')
      .notNull()
      .references(() => competitorCandidates.id, { onDelete: 'cascade' }),
    evidenceCategory: text('evidence_category').notNull(),
    observationKind: text('observation_kind').notNull(),
    observation: text('observation').notNull(),
    sourcePageUrl: text('source_page_url').notNull(),
    normalizedOrigin: text('normalized_origin').notNull(),
    selector: text('selector'),
    sourceExcerpt: text('source_excerpt'),
    profile: text('profile').notNull(),
    numericValue: integer('numeric_value'),
    confidence: text('confidence').notNull(),
    freshnessStatus: text('freshness_status').notNull(),
    withholdingReason: text('withholding_reason'),
    safeForOutreach: boolean('safe_for_outreach').notNull(),
    active: boolean('active').notNull(),
    captureMethod: text('capture_method').notNull(),
    provider: text('provider').notNull(),
    rulesVersion: text('rules_version').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('competitor_evidence_items_run_idx').on(t.captureRunId),
    competitorIdx: index('competitor_evidence_items_competitor_idx').on(t.captureRunId, t.competitorCandidateId),
    activeIdx: index('competitor_evidence_items_active_idx').on(t.captureRunId, t.active),
    categoryCk: check('competitor_evidence_items_category_ck', sql.raw(`evidence_category IN (${COMPETITOR_EVIDENCE_CATEGORIES})`)),
    kindCk: check('competitor_evidence_items_kind_ck', sql.raw(`observation_kind IN (${COMPETITOR_OBSERVATION_KINDS})`)),
    confidenceCk: check('competitor_evidence_items_confidence_ck', sql`${t.confidence} IN ('HIGH','MEDIUM','LOW')`),
    freshnessCk: check('competitor_evidence_items_freshness_ck', sql.raw(`freshness_status IN (${COMPETITOR_FRESHNESS_STATUSES})`)),
    profileCk: check('competitor_evidence_items_profile_ck', sql`${t.profile} IN ('desktop','mobile')`),
  }),
);

// --- Phase 7A3A: deterministic competitor pattern packages (additive; immutable/versioned) ---
// No email, no AI, no Gmail/Sheets, no sending. Approval never happens automatically; supersession
// marks prior DRAFT packages SUPERSEDED and never deletes history.

const COMPETITOR_PATTERN_RESULTS = "'ALL_OBSERVED','MAJORITY_OBSERVED','NO_PATTERN','INSUFFICIENT_DATA'";
const COMPETITOR_PACKAGE_STATUSES = "'DRAFT','REVIEWED','APPROVED','REJECTED','SUPERSEDED','INVALIDATED'";
const COMPETITOR_WORDING_FORMS = "'TWO_OF_TWO','TWO_OF_THREE','ALL_OF_THREE','NONE'";

export const competitorPatternPackages = pgTable(
  'competitor_pattern_packages',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    researchRunId: text('research_run_id')
      .notNull()
      .references(() => competitorResearchRuns.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('DRAFT'),
    version: integer('version').notNull(),
    inputHash: text('input_hash').notNull(),
    configHash: text('config_hash').notNull(),
    packageHash: text('package_hash').notNull(),
    rulesVersion: text('rules_version').notNull(),
    confidence: text('confidence').notNull(),
    freshnessEvaluatedAt: timestamp('freshness_evaluated_at', { withTimezone: true }).notNull(),
    selectedCompetitorIds: jsonb('selected_competitor_ids').notNull(),
    captureRunIds: jsonb('capture_run_ids').notNull(),
    eligibleEvidenceCount: integer('eligible_evidence_count').notNull(),
    excludedEvidenceCount: integer('excluded_evidence_count').notNull(),
    exclusionReasons: jsonb('exclusion_reasons').notNull(),
    prohibitedClaims: jsonb('prohibited_claims').notNull(),
    // Immutable approval/rejection/invalidation/supersession metadata (append-only).
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: text('rejected_by'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    invalidatedBy: text('invalidated_by'),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    supersededBy: text('superseded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index('competitor_pattern_packages_lead_idx').on(t.leadId),
    idempotencyUk: uniqueIndex('competitor_pattern_packages_idempotency_uk').on(t.leadId, t.inputHash, t.configHash),
    versionUk: uniqueIndex('competitor_pattern_packages_version_uk').on(t.leadId, t.version),
    statusCk: check('competitor_pattern_packages_status_ck', sql.raw(`status IN (${COMPETITOR_PACKAGE_STATUSES})`)),
    confidenceCk: check('competitor_pattern_packages_confidence_ck', sql`${t.confidence} IN ('HIGH','MEDIUM','LOW')`),
  }),
);

export const competitorPatterns = pgTable(
  'competitor_patterns',
  {
    id: text('id').primaryKey(),
    packageId: text('package_id')
      .notNull()
      .references(() => competitorPatternPackages.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    result: text('result').notNull(),
    presentCount: integer('present_count').notNull(),
    absentCount: integer('absent_count').notNull(),
    unknownCount: integer('unknown_count').notNull(),
    usableDenominator: integer('usable_denominator').notNull(),
    totalSelected: integer('total_selected').notNull(),
    participatingCompetitorIds: jsonb('participating_competitor_ids').notNull(),
    evidenceItemIds: jsonb('evidence_item_ids').notNull(),
    confidence: text('confidence').notNull(),
    wordingForm: text('wording_form').notNull(),
    wordingText: text('wording_text'),
    consequenceLabel: text('consequence_label'),
    numericMedian: doublePrecision('numeric_median'),
    numericValues: jsonb('numeric_values').notNull(),
    isDepth: boolean('is_depth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packageIdx: index('competitor_patterns_package_idx').on(t.packageId),
    resultCk: check('competitor_patterns_result_ck', sql.raw(`result IN (${COMPETITOR_PATTERN_RESULTS})`)),
    confidenceCk: check('competitor_patterns_confidence_ck', sql`${t.confidence} IN ('HIGH','MEDIUM','LOW')`),
    wordingFormCk: check('competitor_patterns_wording_form_ck', sql.raw(`wording_form IN (${COMPETITOR_WORDING_FORMS})`)),
    countsCk: check('competitor_patterns_counts_ck', sql`${t.presentCount} >= 0 AND ${t.absentCount} >= 0 AND ${t.unknownCount} >= 0 AND ${t.usableDenominator} >= 0 AND ${t.totalSelected} >= 0`),
  }),
);

export const competitorProspectContrasts = pgTable(
  'competitor_prospect_contrasts',
  {
    id: text('id').primaryKey(),
    packageId: text('package_id')
      .notNull()
      .references(() => competitorPatternPackages.id, { onDelete: 'cascade' }),
    patternId: text('pattern_id').references(() => competitorPatterns.id, { onDelete: 'set null' }),
    category: text('category').notNull(),
    contrastKind: text('contrast_kind').notNull(),
    prospectState: text('prospect_state').notNull(),
    prospectEvidenceRef: text('prospect_evidence_ref').notNull(),
    confidence: text('confidence').notNull(),
    consequenceLabel: text('consequence_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packageIdx: index('competitor_prospect_contrasts_package_idx').on(t.packageId),
    kindCk: check('competitor_prospect_contrasts_kind_ck', sql`${t.contrastKind} IN ('BOOLEAN')`),
    stateCk: check('competitor_prospect_contrasts_state_ck', sql`${t.prospectState} IN ('ABSENT')`),
    confidenceCk: check('competitor_prospect_contrasts_confidence_ck', sql`${t.confidence} IN ('HIGH','MEDIUM','LOW')`),
  }),
);

export const competitorPatternEvidenceRefs = pgTable(
  'competitor_pattern_evidence_refs',
  {
    id: text('id').primaryKey(),
    packageId: text('package_id')
      .notNull()
      .references(() => competitorPatternPackages.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    evidenceItemId: text('evidence_item_id').notNull(),
    captureRunId: text('capture_run_id'),
    competitorCandidateId: text('competitor_candidate_id'),
    category: text('category'),
    sourceUrl: text('source_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packageIdx: index('competitor_pattern_evidence_refs_package_idx').on(t.packageId),
    kindCk: check('competitor_pattern_evidence_refs_kind_ck', sql`${t.kind} IN ('COMPETITOR','PROSPECT')`),
  }),
);

// --- Phase 7A3B: competitor email enrichment (companion traceability; additive, immutable) ---

const EMAIL_COMPETITOR_EVIDENCE_MODES_SQL = "'NONE','APPROVED_COMPETITOR_PATTERN_PACKAGE'";
const EMAIL_CLAIM_TYPES_SQL =
  "'PROSPECT_OBSERVATION','COMPETITOR_PATTERN','PROSPECT_CONTRAST','CAUTIOUS_CONSEQUENCE','RECOMMENDATION','CTA'";

/**
 * One row per ENRICHED composed email artifact. Prospect-only emails have NO row here. Package
 * provenance is stored as plain text (not FKs) so historical traceability survives package supersession/
 * expiry. The composed-message hash pins the exact enriched artifact used for preview/review/approval.
 */
export const emailCompetitorEnrichment = pgTable(
  'email_competitor_enrichment',
  {
    id: text('id').primaryKey(),
    emailId: text('email_id')
      .notNull()
      .references(() => emailDrafts.id, { onDelete: 'cascade' }),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    competitorEvidenceUsed: text('competitor_evidence_used').notNull(),
    schemaVersion: text('schema_version').notNull(),
    rulesVersion: text('rules_version').notNull(),
    packageId: text('package_id').notNull(),
    packageVersion: integer('package_version').notNull(),
    packageHash: text('package_hash').notNull(),
    selectedPatternId: text('selected_pattern_id').notNull(),
    selectedContrastId: text('selected_contrast_id'),
    primaryIssueEvidenceId: text('primary_issue_evidence_id').notNull(),
    primaryIssueFindingRef: text('primary_issue_finding_ref').notNull(),
    alignmentAuditCategory: text('alignment_audit_category').notNull(),
    alignmentEvidenceCategory: text('alignment_evidence_category').notNull(),
    revalidatedAt: timestamp('revalidated_at', { withTimezone: true }).notNull(),
    recomputedHashMatched: boolean('recomputed_hash_matched').notNull(),
    composedMessageHash: text('composed_message_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUk: uniqueIndex('email_competitor_enrichment_email_uk').on(t.emailId),
    leadIdx: index('email_competitor_enrichment_lead_idx').on(t.leadId),
    modeCk: check('email_competitor_enrichment_mode_ck', sql.raw(`competitor_evidence_used IN (${EMAIL_COMPETITOR_EVIDENCE_MODES_SQL})`)),
  }),
);

/**
 * Per-claim traceability ledger for a composed email. Bounded text span + exact provenance per
 * substantive sentence. Append-only; historical rows are never mutated when a package later changes.
 */
export const emailClaimLedger = pgTable(
  'email_claim_ledger',
  {
    id: text('id').primaryKey(),
    emailId: text('email_id')
      .notNull()
      .references(() => emailDrafts.id, { onDelete: 'cascade' }),
    enrichmentId: text('enrichment_id').references(() => emailCompetitorEnrichment.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    claimType: text('claim_type').notNull(),
    text: text('text').notNull(),
    prospectEvidenceIds: jsonb('prospect_evidence_ids').notNull(),
    patternId: text('pattern_id'),
    contrastId: text('contrast_id'),
    competitorEvidenceIds: jsonb('competitor_evidence_ids').notNull(),
    packageId: text('package_id'),
    packageVersion: integer('package_version'),
    packageHash: text('package_hash'),
    rulesVersion: text('rules_version').notNull(),
    validatedAt: timestamp('validated_at', { withTimezone: true }).notNull(),
    externallySafe: boolean('externally_safe').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index('email_claim_ledger_email_idx').on(t.emailId),
    emailOrdinalUk: uniqueIndex('email_claim_ledger_email_ordinal_uk').on(t.emailId, t.ordinal),
    claimTypeCk: check('email_claim_ledger_claim_type_ck', sql.raw(`claim_type IN (${EMAIL_CLAIM_TYPES_SQL})`)),
  }),
);
