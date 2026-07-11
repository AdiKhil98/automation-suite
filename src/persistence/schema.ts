import { doublePrecision, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Database schema (Phase 1 subset). Only the entities the deterministic core needs
 * exist yet: leads, evidence, pipeline_runs, pipeline_events. Remaining tables from
 * ARCHITECTURE.md §5 are introduced in the phase that first requires them.
 */

export const leads = pgTable('leads', {
  id: text('id').primaryKey(),
  businessName: text('business_name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  domain: text('domain'),
  normalizedDomain: text('normalized_domain'),
  placeId: text('place_id'),
  city: text('city'),
  country: text('country'),
  status: text('status').notNull().default('NEW'),
  priority: text('priority'),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
