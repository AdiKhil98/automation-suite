CREATE TABLE "demo_v2_visual_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "render_version_id" text NOT NULL REFERENCES "demo_v2_render_versions"("id") ON DELETE CASCADE,
  "review_package_id" text NOT NULL REFERENCES "demo_v2_review_packages"("id") ON DELETE CASCADE,
  "review_run_id" text NOT NULL,
  "cycle" integer NOT NULL,
  "provider" text NOT NULL,
  "requested_model" text NOT NULL,
  "resolved_model" text,
  "reasoning_effort" text NOT NULL,
  "schema_version" text NOT NULL,
  "input_fingerprint" text NOT NULL,
  "bound_render_hash" text NOT NULL,
  "bound_screenshot_set_hash" text NOT NULL,
  "bound_review_package_hash" text NOT NULL,
  "rubric_version" text NOT NULL,
  "rubric_hash" text NOT NULL,
  "overall_score" integer NOT NULL,
  "category_scores" jsonb NOT NULL,
  "blockers" jsonb NOT NULL,
  "findings" jsonb NOT NULL,
  "permitted_revision_operations" jsonb NOT NULL,
  "decision" text NOT NULL,
  "input_tokens" integer,
  "cached_input_tokens" integer,
  "output_tokens" integer,
  "reasoning_tokens" integer,
  "cost_usd" numeric(12, 6) NOT NULL,
  "response_id" text,
  "review_output_hash" text NOT NULL,
  "stale" boolean DEFAULT false NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_visual_reviews_cycle_ck" CHECK ("cycle" BETWEEN 1 AND 3),
  CONSTRAINT "demo_v2_visual_reviews_provider_ck" CHECK (provider IN ('mock','openai')),
  CONSTRAINT "demo_v2_visual_reviews_decision_ck" CHECK (decision IN ('APPROVE','REVISE','REJECT')),
  CONSTRAINT "demo_v2_visual_reviews_score_ck" CHECK ("overall_score" BETWEEN 0 AND 100),
  CONSTRAINT "demo_v2_visual_reviews_cost_ck" CHECK ("cost_usd" >= 0),
  CONSTRAINT "demo_v2_visual_reviews_mock_cost_ck" CHECK (provider <> 'mock' OR "cost_usd" = 0),
  CONSTRAINT "demo_v2_visual_reviews_hash_ck" CHECK (
    input_fingerprint ~ '^[a-f0-9]{64}$'
    AND bound_render_hash ~ '^[a-f0-9]{64}$'
    AND bound_screenshot_set_hash ~ '^[a-f0-9]{64}$'
    AND bound_review_package_hash ~ '^[a-f0-9]{64}$'
    AND rubric_hash ~ '^[a-f0-9]{64}$'
    AND review_output_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_visual_reviews_render_uk" ON "demo_v2_visual_reviews" ("render_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_visual_reviews_run_cycle_uk" ON "demo_v2_visual_reviews" ("review_run_id","cycle");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_visual_reviews_current_uk" ON "demo_v2_visual_reviews" ("artifact_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_visual_reviews_artifact_idx" ON "demo_v2_visual_reviews" ("artifact_id");--> statement-breakpoint
CREATE INDEX "demo_v2_visual_reviews_fingerprint_idx" ON "demo_v2_visual_reviews" ("input_fingerprint");--> statement-breakpoint
CREATE INDEX "demo_v2_visual_reviews_output_hash_idx" ON "demo_v2_visual_reviews" ("review_output_hash");
