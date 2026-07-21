ALTER TABLE "suppression_list" DROP CONSTRAINT IF EXISTS "suppression_scope_ck";--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_scope_ck" CHECK (scope IN ('domain','phone','place_id','email','business'));--> statement-breakpoint

CREATE TABLE "prospect_location_cache" (
  "id" text PRIMARY KEY NOT NULL,
  "normalized_location" text NOT NULL,
  "formatted_location" text NOT NULL,
  "latitude" double precision NOT NULL,
  "longitude" double precision NOT NULL,
  "provider" text NOT NULL,
  "resolved_at" timestamp with time zone NOT NULL,
  CONSTRAINT "prospect_location_cache_latitude_ck" CHECK (latitude >= -90 AND latitude <= 90),
  CONSTRAINT "prospect_location_cache_longitude_ck" CHECK (longitude >= -180 AND longitude <= 180),
  CONSTRAINT "prospect_location_cache_provider_ck" CHECK (provider IN ('google_places'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_location_cache_location_uk" ON "prospect_location_cache" ("normalized_location");--> statement-breakpoint

CREATE TABLE "prospect_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "pipeline_run_id" text NOT NULL,
  "operator_niche" text NOT NULL,
  "included_types" jsonb NOT NULL,
  "requested_location" text NOT NULL,
  "formatted_location" text NOT NULL,
  "latitude" double precision NOT NULL,
  "longitude" double precision NOT NULL,
  "location_provider" text NOT NULL,
  "radius_km" double precision NOT NULL,
  "rank_preference" text NOT NULL,
  "target_qualified" integer NOT NULL,
  "max_candidates" integer NOT NULL,
  "continue_pipeline" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'RUNNING' NOT NULL,
  "result" text,
  "qualified_count" integer DEFAULT 0 NOT NULL,
  "processed_count" integer DEFAULT 0 NOT NULL,
  "external_calls" jsonb NOT NULL,
  "circuit_breaker_reason" text,
  "discovered_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "prospect_runs_status_ck" CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  CONSTRAINT "prospect_runs_result_ck" CHECK (result IS NULL OR result IN ('TARGET_REACHED','CANDIDATE_BUDGET_EXHAUSTED','EXTERNAL_BUDGET_EXHAUSTED','SYSTEMIC_FAILURE')),
  CONSTRAINT "prospect_runs_radius_ck" CHECK (radius_km > 0 AND radius_km <= 50),
  CONSTRAINT "prospect_runs_candidate_cap_ck" CHECK (max_candidates BETWEEN 1 AND 20),
  CONSTRAINT "prospect_runs_target_ck" CHECK (target_qualified >= 1 AND target_qualified <= max_candidates),
  CONSTRAINT "prospect_runs_rank_ck" CHECK (rank_preference IN ('POPULARITY','DISTANCE'))
);--> statement-breakpoint
ALTER TABLE "prospect_runs" ADD CONSTRAINT "prospect_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_runs_pipeline_run_uk" ON "prospect_runs" ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "prospect_runs_status_idx" ON "prospect_runs" ("status");--> statement-breakpoint

CREATE TABLE "prospect_candidates" (
  "id" text PRIMARY KEY NOT NULL,
  "prospect_run_id" text NOT NULL,
  "place_id" text NOT NULL,
  "position" integer NOT NULL,
  "lead_id" text,
  "outcome" text DEFAULT 'DISCOVERED' NOT NULL,
  "skip_reason" text,
  "website_failure_stage" text,
  "website_failure_code" text,
  "website_failure_elapsed_ms" integer,
  "processed_at" timestamp with time zone,
  CONSTRAINT "prospect_candidates_outcome_ck" CHECK (outcome IN ('DISCOVERED','QUALIFIED','DUPLICATE','SUPPRESSED','NO_WEBSITE','CLOSED','WEBSITE_TRANSIENT','WEBSITE_INVALID','DISQUALIFIED','MANUAL_REVIEW','SYSTEMIC_FAILURE')),
  CONSTRAINT "prospect_candidates_position_ck" CHECK (position >= 0),
  CONSTRAINT "prospect_candidates_elapsed_ck" CHECK (website_failure_elapsed_ms IS NULL OR website_failure_elapsed_ms >= 0)
);--> statement-breakpoint
ALTER TABLE "prospect_candidates" ADD CONSTRAINT "prospect_candidates_prospect_run_id_prospect_runs_id_fk" FOREIGN KEY ("prospect_run_id") REFERENCES "public"."prospect_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_candidates" ADD CONSTRAINT "prospect_candidates_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_candidates_run_position_uk" ON "prospect_candidates" ("prospect_run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_candidates_run_place_uk" ON "prospect_candidates" ("prospect_run_id","place_id");--> statement-breakpoint
CREATE INDEX "prospect_candidates_place_idx" ON "prospect_candidates" ("place_id");
