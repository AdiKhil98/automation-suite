CREATE TABLE IF NOT EXISTS "demo_design_specs" (
	"id" text PRIMARY KEY NOT NULL,
	"demo_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"spec_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"rubric_version" text NOT NULL,
	"generator_prompt_version" text NOT NULL,
	"reviewer_prompt_version" text NOT NULL,
	"visual_direction" text NOT NULL,
	"hero_strategy" text NOT NULL,
	"header_variant" text NOT NULL,
	"footer_variant" text NOT NULL,
	"primary_cta_intent" text NOT NULL,
	"primary_cta_label_key" text NOT NULL,
	"component_ids" jsonb NOT NULL,
	"reviewer_decision" text NOT NULL,
	"fabrication_risk" boolean NOT NULL,
	"evidence_consistent" boolean NOT NULL,
	"cta_honest" boolean NOT NULL,
	"reviewer_problems" jsonb NOT NULL,
	"spec" jsonb NOT NULL,
	"provider" text NOT NULL,
	"requested_generator_model" text NOT NULL,
	"requested_reviewer_model" text NOT NULL,
	"generator_response_id" text,
	"reviewer_response_id" text,
	"total_cost_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_design_specs" ADD CONSTRAINT "demo_design_specs_demo_id_demos_id_fk" FOREIGN KEY ("demo_id") REFERENCES "demos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_design_specs" ADD CONSTRAINT "demo_design_specs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_design_specs_demo_idx" ON "demo_design_specs" ("demo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_design_specs_lead_idx" ON "demo_design_specs" ("lead_id");
