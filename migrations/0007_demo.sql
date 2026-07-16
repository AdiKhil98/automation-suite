CREATE TABLE "demo_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"run_id" text,
	"decision" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"opportunity_score" integer,
	"min_opportunity" integer NOT NULL,
	"justified_by_score" boolean NOT NULL,
	"justified_by_finding" boolean NOT NULL,
	"brief_rules_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_decision_ck" CHECK ("demo_decisions"."decision" IN ('BUILD_DEMO','NO_DEMO'))
);
--> statement-breakpoint
CREATE TABLE "demo_fact_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"demo_id" text NOT NULL,
	"lead_fact_id" text NOT NULL,
	"field" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_finding_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"demo_id" text NOT NULL,
	"audit_finding_id" text NOT NULL,
	"directive" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demos" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"demo_decision_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"path" text NOT NULL,
	"status" text NOT NULL,
	"noindex_verified" boolean DEFAULT false NOT NULL,
	"disclosure_present" boolean DEFAULT false NOT NULL,
	"content_hash" text,
	"cta_kind" text,
	"facts_used" jsonb,
	"finding_refs" jsonb,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"approval_source" text,
	"approval_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_status_ck" CHECK ("demos"."status" IN ('GENERATED_PENDING_REVIEW','APPROVED','REJECTED','SUPERSEDED','BUILD_FAILED'))
);
--> statement-breakpoint
ALTER TABLE "demo_decisions" ADD CONSTRAINT "demo_decisions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_decisions" ADD CONSTRAINT "demo_decisions_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_fact_inputs" ADD CONSTRAINT "demo_fact_inputs_demo_id_demos_id_fk" FOREIGN KEY ("demo_id") REFERENCES "public"."demos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_fact_inputs" ADD CONSTRAINT "demo_fact_inputs_lead_fact_id_lead_facts_id_fk" FOREIGN KEY ("lead_fact_id") REFERENCES "public"."lead_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_finding_inputs" ADD CONSTRAINT "demo_finding_inputs_demo_id_demos_id_fk" FOREIGN KEY ("demo_id") REFERENCES "public"."demos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_finding_inputs" ADD CONSTRAINT "demo_finding_inputs_audit_finding_id_audit_findings_id_fk" FOREIGN KEY ("audit_finding_id") REFERENCES "public"."audit_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demos" ADD CONSTRAINT "demos_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demos" ADD CONSTRAINT "demos_demo_decision_id_demo_decisions_id_fk" FOREIGN KEY ("demo_decision_id") REFERENCES "public"."demo_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_decisions_lead_idx" ON "demo_decisions" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "demo_fact_inputs_demo_idx" ON "demo_fact_inputs" USING btree ("demo_id");--> statement-breakpoint
CREATE INDEX "demo_finding_inputs_demo_idx" ON "demo_finding_inputs" USING btree ("demo_id");--> statement-breakpoint
CREATE INDEX "demos_lead_idx" ON "demos" USING btree ("lead_id");