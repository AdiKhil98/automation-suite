CREATE TABLE "demo_v2_render_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "experience_plan_id" text NOT NULL REFERENCES "demo_v2_experience_plans"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "renderer_version" text NOT NULL,
  "reference_family" text NOT NULL,
  "bundle_location" text NOT NULL,
  "status" text DEFAULT 'RENDERED' NOT NULL,
  "primary_language" text NOT NULL,
  "supported_languages" jsonb NOT NULL,
  "intelligence_hash" text NOT NULL,
  "content_hash" text NOT NULL,
  "translation_hash" text,
  "asset_selection_set_hash" text NOT NULL,
  "component_registry_hash" text NOT NULL,
  "reference_library_hash" text NOT NULL,
  "creative_brief_hash" text NOT NULL,
  "experience_plan_hash" text NOT NULL,
  "render_hash" text NOT NULL,
  "structurally_eligible" boolean NOT NULL,
  "deterministic_validation" jsonb NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "superseded_by_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_render_versions_version_ck" CHECK ("version" > 0),
  CONSTRAINT "demo_v2_render_versions_status_ck" CHECK (status IN ('RENDERED','SUPERSEDED')),
  CONSTRAINT "demo_v2_render_versions_language_ck" CHECK (primary_language IN ('de','en','fr','he','ar')),
  CONSTRAINT "demo_v2_render_versions_hash_ck" CHECK (render_hash ~ '^[a-f0-9]{64}$' AND content_hash ~ '^[a-f0-9]{64}$' AND intelligence_hash ~ '^[a-f0-9]{64}$' AND (translation_hash IS NULL OR translation_hash ~ '^[a-f0-9]{64}$'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_render_versions_artifact_version_uk" ON "demo_v2_render_versions" ("artifact_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_render_versions_current_uk" ON "demo_v2_render_versions" ("artifact_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_render_versions_hash_idx" ON "demo_v2_render_versions" ("render_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_screenshots" (
  "id" text PRIMARY KEY NOT NULL,
  "render_version_id" text NOT NULL REFERENCES "demo_v2_render_versions"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "language" text NOT NULL,
  "viewport" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "file_hash" text NOT NULL,
  "location" text NOT NULL,
  "screenshot_set_hash" text NOT NULL,
  "renderer_version" text NOT NULL,
  "render_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_screenshots_kind_ck" CHECK (kind IN ('ORIGINAL','FINAL')),
  CONSTRAINT "demo_v2_screenshots_viewport_ck" CHECK (viewport IN ('DESKTOP','TABLET','MOBILE')),
  CONSTRAINT "demo_v2_screenshots_language_ck" CHECK (language IN ('de','en','fr','he','ar')),
  CONSTRAINT "demo_v2_screenshots_dimensions_ck" CHECK ("width" > 0 AND "height" > 0),
  CONSTRAINT "demo_v2_screenshots_hash_ck" CHECK (file_hash ~ '^[a-f0-9]{64}$' AND screenshot_set_hash ~ '^[a-f0-9]{64}$' AND render_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_screenshots_member_uk" ON "demo_v2_screenshots" ("render_version_id","kind","language","viewport");--> statement-breakpoint
CREATE INDEX "demo_v2_screenshots_set_idx" ON "demo_v2_screenshots" ("screenshot_set_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_review_packages" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "render_version_id" text NOT NULL REFERENCES "demo_v2_render_versions"("id") ON DELETE CASCADE,
  "schema_version" text NOT NULL,
  "reference_family" text NOT NULL,
  "renderer_version" text NOT NULL,
  "primary_language" text NOT NULL,
  "supported_languages" jsonb NOT NULL,
  "payload" jsonb NOT NULL,
  "render_hash" text NOT NULL,
  "screenshot_set_hash" text NOT NULL,
  "review_package_hash" text NOT NULL,
  "structurally_eligible" boolean NOT NULL,
  "deployment_eligible" boolean DEFAULT false NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_review_packages_deployment_ck" CHECK ("deployment_eligible" = false),
  CONSTRAINT "demo_v2_review_packages_hash_ck" CHECK (render_hash ~ '^[a-f0-9]{64}$' AND screenshot_set_hash ~ '^[a-f0-9]{64}$' AND review_package_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_review_packages_render_uk" ON "demo_v2_review_packages" ("render_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_review_packages_current_uk" ON "demo_v2_review_packages" ("artifact_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_review_packages_hash_idx" ON "demo_v2_review_packages" ("review_package_hash");
