CREATE TABLE "source_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"source_place_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"source_entity_id" text NOT NULL,
	"source_request_id" text NOT NULL,
	"processing_result" text NOT NULL,
	"match_tier" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"campaign" text NOT NULL,
	"provider" text NOT NULL,
	"query" jsonb,
	"field_mask" text NOT NULL,
	"page_index" integer NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"billed_tier" text,
	"estimated_cost_usd" double precision,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "business_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "normalized_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "normalized_phone" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "formatted_address" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "normalized_address" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "facts_source" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "facts_source_url" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "facts_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "dedup_status" text DEFAULT 'UNIQUE' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "duplicate_of" text;--> statement-breakpoint
ALTER TABLE "source_entities" ADD CONSTRAINT "source_entities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_observations" ADD CONSTRAINT "source_observations_source_entity_id_source_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."source_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_observations" ADD CONSTRAINT "source_observations_source_request_id_source_requests_id_fk" FOREIGN KEY ("source_request_id") REFERENCES "public"."source_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_requests" ADD CONSTRAINT "source_requests_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_entities_provider_placeid_uk" ON "source_entities" USING btree ("provider","source_place_id");--> statement-breakpoint
CREATE INDEX "source_observations_entity_idx" ON "source_observations" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX "source_observations_request_idx" ON "source_observations" USING btree ("source_request_id");--> statement-breakpoint
CREATE INDEX "source_requests_run_idx" ON "source_requests" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_duplicate_of_leads_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_place_id_idx" ON "leads" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "leads_normalized_domain_idx" ON "leads" USING btree ("normalized_domain");--> statement-breakpoint
CREATE INDEX "leads_normalized_phone_idx" ON "leads" USING btree ("normalized_phone");