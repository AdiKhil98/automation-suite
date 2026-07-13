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
 * Compliance: Google Places content is never persisted. Google-sourced leads carry
 * only a Place ID (in `place_id` / `source_entities.source_place_id`); their fact
 * columns stay NULL until independent enrichment. `facts_source` is never
 * 'google_places'. See docs/integrations/google-places.md and docs/SECURITY.md.
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
    sourceTypeCk: check('lead_facts_source_type_ck', sql`${t.sourceType} IN ('mock', 'manual', 'website')`),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeValueUk: uniqueIndex('suppression_list_scope_value_uk').on(t.scope, t.value),
    scopeCk: check('suppression_scope_ck', sql`${t.scope} IN ('domain', 'phone', 'place_id')`),
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
