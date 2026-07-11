CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim" text NOT NULL,
	"raw_evidence" text NOT NULL,
	"confidence" double precision NOT NULL,
	"screenshot_path" text,
	"selector" text
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"business_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"domain" text,
	"normalized_domain" text,
	"place_id" text,
	"city" text,
	"country" text,
	"status" text DEFAULT 'NEW' NOT NULL,
	"priority" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text,
	"run_id" text,
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"message" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"dry_run" text DEFAULT 'true' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;