ALTER TABLE "lead_facts" DROP CONSTRAINT IF EXISTS "lead_facts_fact_type_ck";--> statement-breakpoint
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_fact_type_ck" CHECK (fact_type IN ('business_name','official_domain','official_website_url','candidate_website_url','google_place_id','official_location_page_url','domain','phone','contact_email','contact_form_url','formatted_address','latitude','longitude','city','country','category','rating','review_count','business_status','ownership_type','contact_timezone'));--> statement-breakpoint
ALTER TABLE "lead_facts" DROP CONSTRAINT IF EXISTS "lead_facts_source_type_ck";--> statement-breakpoint
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_source_type_ck" CHECK (source_type IN ('mock','manual','website','google_places'));--> statement-breakpoint

CREATE TABLE "website_verification_attempts" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "enrichment_attempt_id" text NOT NULL,
  "candidate_url" text NOT NULL,
  "hostname" text,
  "attempted_at" timestamp with time zone NOT NULL,
  "final_classification" text NOT NULL,
  "failure_stage" text,
  "error_code" text,
  "http_status" integer,
  "redirect_count" integer DEFAULT 0 NOT NULL,
  "elapsed_ms" integer NOT NULL,
  "resolved_ip_family" integer,
  "retryable" boolean NOT NULL,
  CONSTRAINT "website_verification_classification_ck" CHECK (final_classification IN ('OK','TRANSIENT','INVALID','POLICY_BLOCKED')),
  CONSTRAINT "website_verification_failure_stage_ck" CHECK (failure_stage IS NULL OR failure_stage IN ('DNS','TCP_CONNECT','TLS','HTTP','REDIRECT','TIMEOUT','POLICY','UNKNOWN')),
  CONSTRAINT "website_verification_http_status_ck" CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
  CONSTRAINT "website_verification_redirect_count_ck" CHECK (redirect_count >= 0),
  CONSTRAINT "website_verification_elapsed_ms_ck" CHECK (elapsed_ms >= 0),
  CONSTRAINT "website_verification_ip_family_ck" CHECK (resolved_ip_family IS NULL OR resolved_ip_family IN (4,6)),
  CONSTRAINT "website_verification_success_ck" CHECK ((final_classification = 'OK' AND failure_stage IS NULL AND error_code IS NULL) OR final_classification <> 'OK')
);--> statement-breakpoint
ALTER TABLE "website_verification_attempts" ADD CONSTRAINT "website_verification_attempts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_verification_attempts" ADD CONSTRAINT "website_verification_attempts_enrichment_attempt_id_enrichment_attempts_id_fk" FOREIGN KEY ("enrichment_attempt_id") REFERENCES "public"."enrichment_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_verification_attempts_lead_attempted_idx" ON "website_verification_attempts" USING btree ("lead_id","attempted_at");--> statement-breakpoint
CREATE INDEX "website_verification_attempts_enrichment_attempt_idx" ON "website_verification_attempts" USING btree ("enrichment_attempt_id");
