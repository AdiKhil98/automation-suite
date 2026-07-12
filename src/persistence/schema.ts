import {
  type AnyPgColumn,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
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
