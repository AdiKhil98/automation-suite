-- Deterministic outreach-finding bridge. Additive only — no existing table is altered, and the AI
-- audit history is untouched. Two new tables let an operator-approved, evidence-backed,
-- template-constrained finding feed outreach composition for a lead whose AI audit produced no
-- outreach-safe finding, WITHOUT fabricating an AI audit run.
--
-- Provenance is pinned to 'DETERMINISTIC_OPERATOR_APPROVED' by a CHECK; it is never AI-generated and
-- never reviewer-approved. A partial unique index enforces at most one ACTIVE finding per
-- (lead, category). Reversal: remove the two new tables once unused.

CREATE TABLE "deterministic_findings" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "capture_run_id" text NOT NULL,
  "category" text NOT NULL,
  "finding_ref" text NOT NULL,
  "observation" text NOT NULL,
  "recommendation" text NOT NULL,
  "safe_for_outreach" boolean NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "provenance" text NOT NULL,
  "approved_by" text NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  "template_version" text NOT NULL,
  "rules_version" text NOT NULL,
  "evidence_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deterministic_finding_category_ck" CHECK (category IN ('CTA_CLARITY','BOOKING_FRICTION','CONTACT_FRICTION','MOBILE_USABILITY','SERVICE_CLARITY','TRUST_SIGNALS','SOCIAL_PROOF','NAVIGATION','READABILITY','LOCAL_INFORMATION','VISUAL_HIERARCHY','TECHNICAL_RENDERING','ACCESSIBILITY_INDICATOR','DESKTOP_MOBILE_CONSISTENCY','OTHER')),
  CONSTRAINT "deterministic_finding_status_ck" CHECK (status IN ('ACTIVE','SUPERSEDED')),
  CONSTRAINT "deterministic_finding_provenance_ck" CHECK (provenance = 'DETERMINISTIC_OPERATOR_APPROVED'),
  CONSTRAINT "deterministic_finding_safe_ck" CHECK (safe_for_outreach = true)
);--> statement-breakpoint
ALTER TABLE "deterministic_findings" ADD CONSTRAINT "deterministic_findings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deterministic_findings" ADD CONSTRAINT "deterministic_findings_capture_run_id_website_capture_runs_id_fk" FOREIGN KEY ("capture_run_id") REFERENCES "website_capture_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deterministic_findings_lead_idx" ON "deterministic_findings" ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deterministic_findings_active_uk" ON "deterministic_findings" ("lead_id","category") WHERE "status" = 'ACTIVE';--> statement-breakpoint

CREATE TABLE "deterministic_finding_evidence" (
  "deterministic_finding_id" text NOT NULL,
  "capture_evidence_id" text NOT NULL,
  CONSTRAINT "deterministic_finding_evidence_pk" PRIMARY KEY("deterministic_finding_id","capture_evidence_id")
);--> statement-breakpoint
ALTER TABLE "deterministic_finding_evidence" ADD CONSTRAINT "deterministic_finding_evidence_finding_id_fk" FOREIGN KEY ("deterministic_finding_id") REFERENCES "deterministic_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deterministic_finding_evidence" ADD CONSTRAINT "deterministic_finding_evidence_capture_evidence_id_fk" FOREIGN KEY ("capture_evidence_id") REFERENCES "capture_evidence"("id") ON DELETE cascade ON UPDATE no action;
