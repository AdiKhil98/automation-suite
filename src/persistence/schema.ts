import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
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
      scopeCk: check('suppression_scope_ck', sql`${t.scope} IN ('domain', 'phone', 'place_id', 'email')`),
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

const CAPTURE_PURPOSES = "'AUDIT_CAPTURE','VERIFICATION_CAPTURE'";
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
