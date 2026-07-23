CREATE TABLE "demo_v2_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "demo_decision_id" text NOT NULL REFERENCES "demo_decisions"("id") ON DELETE CASCADE,
  "run_id" text REFERENCES "pipeline_runs"("id") ON DELETE SET NULL,
  "engine_version" text DEFAULT 'v2' NOT NULL,
  "schema_version" text NOT NULL,
  "status" text DEFAULT 'INTELLIGENCE_PENDING' NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_artifacts_engine_ck" CHECK (engine_version = 'v2'),
  CONSTRAINT "demo_v2_artifacts_status_ck" CHECK (status IN (
    'INTELLIGENCE_PENDING','INTELLIGENCE_READY','CONTENT_PENDING','CONTENT_READY',
    'ASSET_REVIEW_PENDING','FOUNDATION_READY','BRIEF_READY','PLAN_READY','RENDERING',
    'RENDERED','AUTO_REVIEW_PENDING','AUTO_REVIEW_PASSED','REVISION_REQUIRED',
    'HUMAN_REVIEW_REQUIRED','HUMAN_APPROVED','REJECTED','BLOCKED','SUPERSEDED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_artifacts_current_lead_uk" ON "demo_v2_artifacts" ("lead_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_artifacts_lead_idx" ON "demo_v2_artifacts" ("lead_id");--> statement-breakpoint
CREATE INDEX "demo_v2_artifacts_decision_idx" ON "demo_v2_artifacts" ("demo_decision_id");--> statement-breakpoint
CREATE INDEX "demo_v2_artifacts_status_idx" ON "demo_v2_artifacts" ("status","is_current");--> statement-breakpoint

CREATE TABLE "demo_v2_clinic_intelligence_packages" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "schema_version" text NOT NULL,
  "status" text NOT NULL,
  "primary_language" text NOT NULL,
  "primary_direction" text NOT NULL,
  "supported_languages" jsonb NOT NULL,
  "package" jsonb NOT NULL,
  "input_fingerprint" text NOT NULL,
  "package_hash" text NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "demo_v2_intelligence_version_ck" CHECK (version > 0),
  CONSTRAINT "demo_v2_intelligence_status_ck" CHECK (status IN ('DRAFT','READY','STALE','BLOCKED')),
  CONSTRAINT "demo_v2_intelligence_language_ck" CHECK (primary_language IN ('de','en','fr','he','ar')),
  CONSTRAINT "demo_v2_intelligence_direction_ck" CHECK (primary_direction IN ('LTR','RTL')),
  CONSTRAINT "demo_v2_intelligence_languages_json_ck" CHECK (jsonb_typeof(supported_languages) = 'array'),
  CONSTRAINT "demo_v2_intelligence_hash_ck" CHECK (
    input_fingerprint ~ '^[a-f0-9]{64}$' AND package_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "demo_v2_intelligence_finalized_ck" CHECK (status <> 'READY' OR finalized_at IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_intelligence_artifact_version_uk" ON "demo_v2_clinic_intelligence_packages" ("artifact_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_intelligence_current_uk" ON "demo_v2_clinic_intelligence_packages" ("artifact_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_intelligence_status_idx" ON "demo_v2_clinic_intelligence_packages" ("artifact_id","status");--> statement-breakpoint
CREATE INDEX "demo_v2_intelligence_hash_idx" ON "demo_v2_clinic_intelligence_packages" ("package_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_clinic_intelligence_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "clinic_intelligence_package_id" text NOT NULL REFERENCES "demo_v2_clinic_intelligence_packages"("id") ON DELETE CASCADE,
  "source_kind" text NOT NULL,
  "source_role" text NOT NULL,
  "lead_fact_id" text REFERENCES "lead_facts"("id") ON DELETE RESTRICT,
  "audit_finding_id" text REFERENCES "audit_findings"("id") ON DELETE RESTRICT,
  "capture_evidence_id" text REFERENCES "capture_evidence"("id") ON DELETE RESTRICT,
  "evidence_id" text REFERENCES "evidence"("id") ON DELETE RESTRICT,
  "source_record_hash" text NOT NULL,
  "source_captured_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_intelligence_sources_kind_ck" CHECK (source_kind IN ('LEAD_FACT','AUDIT_FINDING','CAPTURE_EVIDENCE','EVIDENCE')),
  CONSTRAINT "demo_v2_intelligence_sources_role_ck" CHECK (source_role IN ('IDENTITY','CONTENT','CLAIM','AUDIT','LANGUAGE','ASSET_CONTEXT','CONTACT','CONSTRAINT','OTHER')),
  CONSTRAINT "demo_v2_intelligence_sources_exact_source_ck" CHECK (
    num_nonnulls(lead_fact_id,audit_finding_id,capture_evidence_id,evidence_id) = 1
    AND ((source_kind = 'LEAD_FACT' AND lead_fact_id IS NOT NULL)
      OR (source_kind = 'AUDIT_FINDING' AND audit_finding_id IS NOT NULL)
      OR (source_kind = 'CAPTURE_EVIDENCE' AND capture_evidence_id IS NOT NULL)
      OR (source_kind = 'EVIDENCE' AND evidence_id IS NOT NULL))),
  CONSTRAINT "demo_v2_intelligence_sources_hash_ck" CHECK (source_record_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE INDEX "demo_v2_intelligence_sources_package_idx" ON "demo_v2_clinic_intelligence_sources" ("clinic_intelligence_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_intelligence_sources_lead_fact_idx" ON "demo_v2_clinic_intelligence_sources" ("lead_fact_id");--> statement-breakpoint
CREATE INDEX "demo_v2_intelligence_sources_finding_idx" ON "demo_v2_clinic_intelligence_sources" ("audit_finding_id");--> statement-breakpoint
CREATE INDEX "demo_v2_intelligence_sources_capture_idx" ON "demo_v2_clinic_intelligence_sources" ("capture_evidence_id");--> statement-breakpoint
CREATE INDEX "demo_v2_intelligence_sources_evidence_idx" ON "demo_v2_clinic_intelligence_sources" ("evidence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_intelligence_sources_lead_fact_uk" ON "demo_v2_clinic_intelligence_sources" ("clinic_intelligence_package_id","lead_fact_id") WHERE "lead_fact_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_intelligence_sources_finding_uk" ON "demo_v2_clinic_intelligence_sources" ("clinic_intelligence_package_id","audit_finding_id") WHERE "audit_finding_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_intelligence_sources_capture_uk" ON "demo_v2_clinic_intelligence_sources" ("clinic_intelligence_package_id","capture_evidence_id") WHERE "capture_evidence_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_intelligence_sources_evidence_uk" ON "demo_v2_clinic_intelligence_sources" ("clinic_intelligence_package_id","evidence_id") WHERE "evidence_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "demo_v2_primary_content_packages" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "clinic_intelligence_package_id" text NOT NULL REFERENCES "demo_v2_clinic_intelligence_packages"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "schema_version" text NOT NULL,
  "language" text NOT NULL,
  "direction" text NOT NULL,
  "status" text NOT NULL,
  "source_fingerprint" text NOT NULL,
  "content_hash" text NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "demo_v2_primary_content_version_ck" CHECK (version > 0),
  CONSTRAINT "demo_v2_primary_content_status_ck" CHECK (status IN ('DRAFT','READY','STALE','REJECTED')),
  CONSTRAINT "demo_v2_primary_content_language_ck" CHECK (language IN ('de','en','fr','he','ar')),
  CONSTRAINT "demo_v2_primary_content_direction_ck" CHECK (direction IN ('LTR','RTL')),
  CONSTRAINT "demo_v2_primary_content_hash_ck" CHECK (
    source_fingerprint ~ '^[a-f0-9]{64}$' AND content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "demo_v2_primary_content_finalized_ck" CHECK (status <> 'READY' OR finalized_at IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_primary_content_artifact_version_uk" ON "demo_v2_primary_content_packages" ("artifact_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_primary_content_current_uk" ON "demo_v2_primary_content_packages" ("artifact_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_primary_content_intelligence_idx" ON "demo_v2_primary_content_packages" ("clinic_intelligence_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_primary_content_hash_idx" ON "demo_v2_primary_content_packages" ("content_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_content_items" (
  "id" text PRIMARY KEY NOT NULL,
  "content_package_id" text NOT NULL REFERENCES "demo_v2_primary_content_packages"("id") ON DELETE CASCADE,
  "content_key" text NOT NULL,
  "content_kind" text NOT NULL,
  "claim_class" text NOT NULL,
  "text_value" text,
  "structured_value" jsonb,
  "translatable" boolean DEFAULT true NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "item_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_content_items_kind_ck" CHECK (content_kind IN ('LABEL','NAV_LABEL','HEADING','BODY','CTA_LABEL','SERVICE_NAME','FAQ_QUESTION','FAQ_ANSWER','ALT_TEXT','CONTACT','HOURS','LEGAL','STRUCTURED')),
  CONSTRAINT "demo_v2_content_items_claim_ck" CHECK (claim_class IN ('VERBATIM_FACT','EVIDENCE_BOUND_DERIVATION','UI_LABEL','LEGAL_DISCLOSURE')),
  CONSTRAINT "demo_v2_content_items_value_ck" CHECK (num_nonnulls(text_value,structured_value) = 1),
  CONSTRAINT "demo_v2_content_items_position_ck" CHECK (position >= 0),
  CONSTRAINT "demo_v2_content_items_hash_ck" CHECK (item_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_content_items_package_key_uk" ON "demo_v2_content_items" ("content_package_id","content_key");--> statement-breakpoint
CREATE INDEX "demo_v2_content_items_package_idx" ON "demo_v2_content_items" ("content_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_content_items_hash_idx" ON "demo_v2_content_items" ("item_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_content_item_sources" (
  "content_item_id" text NOT NULL REFERENCES "demo_v2_content_items"("id") ON DELETE CASCADE,
  "intelligence_source_id" text NOT NULL REFERENCES "demo_v2_clinic_intelligence_sources"("id") ON DELETE RESTRICT,
  "relationship" text NOT NULL,
  CONSTRAINT "demo_v2_content_item_sources_pk" PRIMARY KEY ("content_item_id","intelligence_source_id"),
  CONSTRAINT "demo_v2_content_item_sources_relationship_ck" CHECK (relationship IN ('SUPPORTS','CONSTRAINS','SOURCE_TEXT'))
);--> statement-breakpoint
CREATE INDEX "demo_v2_content_item_sources_source_idx" ON "demo_v2_content_item_sources" ("intelligence_source_id");--> statement-breakpoint

CREATE TABLE "demo_v2_translation_packages" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "source_content_package_id" text NOT NULL REFERENCES "demo_v2_primary_content_packages"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "language" text NOT NULL,
  "direction" text NOT NULL,
  "status" text NOT NULL,
  "source_content_hash" text NOT NULL,
  "source_fingerprint" text NOT NULL,
  "translation_hash" text,
  "review_status" text DEFAULT 'NOT_REVIEWED' NOT NULL,
  "review_actor_type" text,
  "review_actor_id" text,
  "reviewed_at" timestamp with time zone,
  "review_notes" text,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "demo_v2_translations_version_ck" CHECK (version > 0),
  CONSTRAINT "demo_v2_translations_language_ck" CHECK (language IN ('de','en','fr','he','ar')),
  CONSTRAINT "demo_v2_translations_direction_ck" CHECK (direction IN ('LTR','RTL')),
  CONSTRAINT "demo_v2_translations_status_ck" CHECK (status IN ('DRAFT','INCOMPLETE','READY_FOR_REVIEW','REVIEWED','STALE','REJECTED')),
  CONSTRAINT "demo_v2_translations_review_status_ck" CHECK (review_status IN ('NOT_REVIEWED','APPROVED','REJECTED')),
  CONSTRAINT "demo_v2_translations_actor_ck" CHECK (review_actor_type IS NULL OR review_actor_type IN ('MODEL','HUMAN','SYSTEM')),
  CONSTRAINT "demo_v2_translations_hash_ck" CHECK (
    source_content_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
    AND (translation_hash IS NULL OR translation_hash ~ '^[a-f0-9]{64}$')),
  CONSTRAINT "demo_v2_translations_human_approval_ck" CHECK (
    review_status <> 'APPROVED'
    OR (status = 'REVIEWED' AND review_actor_type = 'HUMAN'
      AND length(trim(review_actor_id)) > 0 AND reviewed_at IS NOT NULL
      AND translation_hash IS NOT NULL AND finalized_at IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_translations_artifact_language_version_uk" ON "demo_v2_translation_packages" ("artifact_id","language","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_translations_current_uk" ON "demo_v2_translation_packages" ("artifact_id","language") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_translations_source_idx" ON "demo_v2_translation_packages" ("source_content_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_translations_status_idx" ON "demo_v2_translation_packages" ("status","review_status");--> statement-breakpoint
CREATE INDEX "demo_v2_translations_hash_idx" ON "demo_v2_translation_packages" ("translation_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_translation_records" (
  "id" text PRIMARY KEY NOT NULL,
  "translation_package_id" text NOT NULL REFERENCES "demo_v2_translation_packages"("id") ON DELETE CASCADE,
  "source_content_item_id" text NOT NULL REFERENCES "demo_v2_content_items"("id") ON DELETE RESTRICT,
  "source_item_hash" text NOT NULL,
  "translated_text" text,
  "translated_structured_value" jsonb,
  "translation_item_hash" text,
  "status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_translation_records_status_ck" CHECK (status IN ('MISSING','TRANSLATED','REVIEWED','STALE','REJECTED')),
  CONSTRAINT "demo_v2_translation_records_value_ck" CHECK (
    (status = 'MISSING' AND num_nonnulls(translated_text,translated_structured_value,translation_item_hash) = 0)
    OR (status IN ('TRANSLATED','REVIEWED') AND num_nonnulls(translated_text,translated_structured_value) = 1 AND translation_item_hash IS NOT NULL)
    OR status IN ('STALE','REJECTED')),
  CONSTRAINT "demo_v2_translation_records_hash_ck" CHECK (
    source_item_hash ~ '^[a-f0-9]{64}$' AND (translation_item_hash IS NULL OR translation_item_hash ~ '^[a-f0-9]{64}$'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_translation_records_item_uk" ON "demo_v2_translation_records" ("translation_package_id","source_content_item_id");--> statement-breakpoint
CREATE INDEX "demo_v2_translation_records_status_idx" ON "demo_v2_translation_records" ("translation_package_id","status");--> statement-breakpoint
CREATE INDEX "demo_v2_translation_records_source_idx" ON "demo_v2_translation_records" ("source_content_item_id");--> statement-breakpoint

CREATE TABLE "demo_v2_asset_catalogs" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "clinic_intelligence_package_id" text NOT NULL REFERENCES "demo_v2_clinic_intelligence_packages"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "schema_version" text NOT NULL,
  "status" text NOT NULL,
  "source_fingerprint" text NOT NULL,
  "catalog_hash" text NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "demo_v2_asset_catalogs_version_ck" CHECK (version > 0),
  CONSTRAINT "demo_v2_asset_catalogs_status_ck" CHECK (status IN ('DRAFT','READY_FOR_REVIEW','READY','BLOCKED','STALE')),
  CONSTRAINT "demo_v2_asset_catalogs_hash_ck" CHECK (
    source_fingerprint ~ '^[a-f0-9]{64}$' AND catalog_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_asset_catalogs_artifact_version_uk" ON "demo_v2_asset_catalogs" ("artifact_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_asset_catalogs_current_uk" ON "demo_v2_asset_catalogs" ("artifact_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_asset_catalogs_intelligence_idx" ON "demo_v2_asset_catalogs" ("clinic_intelligence_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_asset_catalogs_hash_idx" ON "demo_v2_asset_catalogs" ("catalog_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "asset_catalog_id" text NOT NULL REFERENCES "demo_v2_asset_catalogs"("id") ON DELETE CASCADE,
  "source_captured_page_id" text REFERENCES "captured_pages"("id") ON DELETE RESTRICT,
  "source_capture_evidence_id" text REFERENCES "capture_evidence"("id") ON DELETE RESTRICT,
  "source_page_url" text NOT NULL,
  "direct_url" text,
  "final_url" text,
  "content_hash" text,
  "mime_type" text,
  "byte_size" integer,
  "width" integer,
  "height" integer,
  "aspect_ratio" double precision,
  "alt_text" text,
  "nearby_caption" text,
  "nearby_heading" text,
  "category" text NOT NULL,
  "availability_status" text NOT NULL,
  "first_party_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "record_hash" text NOT NULL,
  "captured_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_assets_category_ck" CHECK (category IN ('HERO','CLINIC_INTERIOR','EXTERIOR','TEAM','DOCTOR','TREATMENT','EQUIPMENT','LOCATION','LOGO','DECORATIVE','UNSUITABLE')),
  CONSTRAINT "demo_v2_assets_availability_ck" CHECK (availability_status IN ('DISCOVERED','AVAILABLE','UNAVAILABLE','BLOCKED','UNKNOWN')),
  CONSTRAINT "demo_v2_assets_ownership_ck" CHECK (first_party_status IN ('FIRST_PARTY','APPROVED_FIRST_PARTY_CDN','THIRD_PARTY','UNKNOWN')),
  CONSTRAINT "demo_v2_assets_quality_ck" CHECK (quality_status IN ('UNASSESSED','SUITABLE','UNSUITABLE')),
  CONSTRAINT "demo_v2_assets_dimensions_ck" CHECK (
    (byte_size IS NULL OR byte_size >= 0) AND (width IS NULL OR width >= 0)
    AND (height IS NULL OR height >= 0) AND (aspect_ratio IS NULL OR aspect_ratio > 0)),
  CONSTRAINT "demo_v2_assets_hash_ck" CHECK (
    record_hash ~ '^[a-f0-9]{64}$' AND (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_assets_catalog_record_uk" ON "demo_v2_assets" ("asset_catalog_id","record_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_assets_catalog_content_uk" ON "demo_v2_assets" ("asset_catalog_id","content_hash") WHERE "content_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "demo_v2_assets_category_idx" ON "demo_v2_assets" ("asset_catalog_id","category");--> statement-breakpoint
CREATE INDEX "demo_v2_assets_availability_idx" ON "demo_v2_assets" ("asset_catalog_id","availability_status");--> statement-breakpoint
CREATE INDEX "demo_v2_assets_page_idx" ON "demo_v2_assets" ("source_captured_page_id");--> statement-breakpoint
CREATE INDEX "demo_v2_assets_evidence_idx" ON "demo_v2_assets" ("source_capture_evidence_id");--> statement-breakpoint

CREATE TABLE "demo_v2_asset_selections" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "asset_id" text NOT NULL REFERENCES "demo_v2_assets"("id") ON DELETE RESTRICT,
  "selection_key" text NOT NULL,
  "version" integer NOT NULL,
  "intended_section" text NOT NULL,
  "intended_use" text NOT NULL,
  "desktop_crop" jsonb,
  "mobile_crop" jsonb,
  "focal_point" jsonb,
  "overlay" jsonb,
  "contrast_result" jsonb,
  "fallback" jsonb,
  "source_attribution" text,
  "status" text NOT NULL,
  "bound_asset_record_hash" text NOT NULL,
  "selection_hash" text NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_asset_selections_version_ck" CHECK (version > 0),
  CONSTRAINT "demo_v2_asset_selections_status_ck" CHECK (status IN ('PROPOSED','REUSE_REVIEW_REQUIRED','SELECTED','REJECTED','STALE')),
  CONSTRAINT "demo_v2_asset_selections_hash_ck" CHECK (
    bound_asset_record_hash ~ '^[a-f0-9]{64}$' AND selection_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_asset_selections_artifact_key_version_uk" ON "demo_v2_asset_selections" ("artifact_id","selection_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_asset_selections_current_uk" ON "demo_v2_asset_selections" ("artifact_id","selection_key") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_asset_selections_asset_idx" ON "demo_v2_asset_selections" ("asset_id");--> statement-breakpoint
CREATE INDEX "demo_v2_asset_selections_status_idx" ON "demo_v2_asset_selections" ("artifact_id","status");--> statement-breakpoint
CREATE INDEX "demo_v2_asset_selections_hash_idx" ON "demo_v2_asset_selections" ("selection_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_asset_reuse_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "asset_selection_id" text NOT NULL REFERENCES "demo_v2_asset_selections"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "decision" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "evidence_note" text NOT NULL,
  "bound_asset_record_hash" text NOT NULL,
  "bound_selection_hash" text NOT NULL,
  "review_hash" text NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  CONSTRAINT "demo_v2_asset_reuse_reviews_version_ck" CHECK (version > 0),
  CONSTRAINT "demo_v2_asset_reuse_reviews_decision_ck" CHECK (decision IN ('APPROVED_CONCEPT_USE','NEEDS_RIGHTS_REVIEW','REJECTED')),
  CONSTRAINT "demo_v2_asset_reuse_reviews_actor_ck" CHECK (
    actor_type IN ('MODEL','HUMAN','SYSTEM') AND length(trim(actor_id)) > 0),
  CONSTRAINT "demo_v2_asset_reuse_reviews_human_decision_ck" CHECK (
    decision NOT IN ('APPROVED_CONCEPT_USE','REJECTED') OR actor_type = 'HUMAN'),
  CONSTRAINT "demo_v2_asset_reuse_reviews_note_ck" CHECK (length(trim(evidence_note)) > 0),
  CONSTRAINT "demo_v2_asset_reuse_reviews_hash_ck" CHECK (
    bound_asset_record_hash ~ '^[a-f0-9]{64}$' AND bound_selection_hash ~ '^[a-f0-9]{64}$'
    AND review_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_asset_reuse_reviews_selection_version_uk" ON "demo_v2_asset_reuse_reviews" ("asset_selection_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_asset_reuse_reviews_current_uk" ON "demo_v2_asset_reuse_reviews" ("asset_selection_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_asset_reuse_reviews_decision_idx" ON "demo_v2_asset_reuse_reviews" ("decision");--> statement-breakpoint

CREATE TABLE "demo_v2_creative_briefs" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "clinic_intelligence_package_id" text NOT NULL REFERENCES "demo_v2_clinic_intelligence_packages"("id") ON DELETE RESTRICT,
  "primary_content_package_id" text NOT NULL REFERENCES "demo_v2_primary_content_packages"("id") ON DELETE RESTRICT,
  "asset_catalog_id" text NOT NULL REFERENCES "demo_v2_asset_catalogs"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "schema_version" text NOT NULL,
  "status" text NOT NULL,
  "brief" jsonb NOT NULL,
  "input_fingerprint" text NOT NULL,
  "brief_hash" text NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "demo_v2_creative_briefs_version_ck" CHECK (version > 0),
  CONSTRAINT "demo_v2_creative_briefs_status_ck" CHECK (status IN ('DRAFT','VALIDATED','STALE','REJECTED')),
  CONSTRAINT "demo_v2_creative_briefs_hash_ck" CHECK (
    input_fingerprint ~ '^[a-f0-9]{64}$' AND brief_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_creative_briefs_artifact_version_uk" ON "demo_v2_creative_briefs" ("artifact_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_creative_briefs_current_uk" ON "demo_v2_creative_briefs" ("artifact_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_creative_briefs_intelligence_idx" ON "demo_v2_creative_briefs" ("clinic_intelligence_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_creative_briefs_content_idx" ON "demo_v2_creative_briefs" ("primary_content_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_creative_briefs_catalog_idx" ON "demo_v2_creative_briefs" ("asset_catalog_id");--> statement-breakpoint
CREATE INDEX "demo_v2_creative_briefs_hash_idx" ON "demo_v2_creative_briefs" ("brief_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_experience_plans" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "creative_brief_id" text NOT NULL REFERENCES "demo_v2_creative_briefs"("id") ON DELETE RESTRICT,
  "primary_content_package_id" text NOT NULL REFERENCES "demo_v2_primary_content_packages"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "schema_version" text NOT NULL,
  "status" text NOT NULL,
  "primary_language" text NOT NULL,
  "primary_direction" text NOT NULL,
  "supported_languages" jsonb NOT NULL,
  "component_registry_version" text NOT NULL,
  "component_registry_hash" text NOT NULL,
  "reference_library_version" text NOT NULL,
  "reference_library_hash" text NOT NULL,
  "plan" jsonb NOT NULL,
  "input_fingerprint" text NOT NULL,
  "plan_hash" text NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "demo_v2_experience_plans_version_ck" CHECK (version > 0),
  CONSTRAINT "demo_v2_experience_plans_status_ck" CHECK (status IN ('DRAFT','VALIDATED','STALE','REJECTED')),
  CONSTRAINT "demo_v2_experience_plans_language_ck" CHECK (primary_language IN ('de','en','fr','he','ar')),
  CONSTRAINT "demo_v2_experience_plans_direction_ck" CHECK (primary_direction IN ('LTR','RTL')),
  CONSTRAINT "demo_v2_experience_plans_languages_json_ck" CHECK (jsonb_typeof(supported_languages) = 'array'),
  CONSTRAINT "demo_v2_experience_plans_hash_ck" CHECK (
    component_registry_hash ~ '^[a-f0-9]{64}$' AND reference_library_hash ~ '^[a-f0-9]{64}$'
    AND input_fingerprint ~ '^[a-f0-9]{64}$' AND plan_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_experience_plans_artifact_version_uk" ON "demo_v2_experience_plans" ("artifact_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_experience_plans_current_uk" ON "demo_v2_experience_plans" ("artifact_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "demo_v2_experience_plans_brief_idx" ON "demo_v2_experience_plans" ("creative_brief_id");--> statement-breakpoint
CREATE INDEX "demo_v2_experience_plans_content_idx" ON "demo_v2_experience_plans" ("primary_content_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_experience_plans_hash_idx" ON "demo_v2_experience_plans" ("plan_hash");--> statement-breakpoint
CREATE INDEX "demo_v2_experience_plans_registry_idx" ON "demo_v2_experience_plans" ("component_registry_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_experience_plan_translations" (
  "experience_plan_id" text NOT NULL REFERENCES "demo_v2_experience_plans"("id") ON DELETE CASCADE,
  "translation_package_id" text NOT NULL REFERENCES "demo_v2_translation_packages"("id") ON DELETE RESTRICT,
  "bound_translation_hash" text NOT NULL,
  "bound_source_content_hash" text NOT NULL,
  CONSTRAINT "demo_v2_experience_plan_translations_pk" PRIMARY KEY ("experience_plan_id","translation_package_id"),
  CONSTRAINT "demo_v2_plan_translations_hash_ck" CHECK (
    bound_translation_hash ~ '^[a-f0-9]{64}$' AND bound_source_content_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE INDEX "demo_v2_plan_translations_translation_idx" ON "demo_v2_experience_plan_translations" ("translation_package_id");--> statement-breakpoint

CREATE TABLE "demo_v2_experience_plan_assets" (
  "experience_plan_id" text NOT NULL REFERENCES "demo_v2_experience_plans"("id") ON DELETE CASCADE,
  "asset_selection_id" text NOT NULL REFERENCES "demo_v2_asset_selections"("id") ON DELETE RESTRICT,
  "reuse_review_id" text NOT NULL REFERENCES "demo_v2_asset_reuse_reviews"("id") ON DELETE RESTRICT,
  "bound_asset_record_hash" text NOT NULL,
  "bound_selection_hash" text NOT NULL,
  "bound_reuse_review_hash" text NOT NULL,
  CONSTRAINT "demo_v2_experience_plan_assets_pk" PRIMARY KEY ("experience_plan_id","asset_selection_id"),
  CONSTRAINT "demo_v2_plan_assets_hash_ck" CHECK (
    bound_asset_record_hash ~ '^[a-f0-9]{64}$' AND bound_selection_hash ~ '^[a-f0-9]{64}$'
    AND bound_reuse_review_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE INDEX "demo_v2_plan_assets_selection_idx" ON "demo_v2_experience_plan_assets" ("asset_selection_id");--> statement-breakpoint
CREATE INDEX "demo_v2_plan_assets_review_idx" ON "demo_v2_experience_plan_assets" ("reuse_review_id");--> statement-breakpoint

CREATE TABLE "demo_v2_approval_packages" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "demo_v2_artifacts"("id") ON DELETE CASCADE,
  "clinic_intelligence_package_id" text NOT NULL REFERENCES "demo_v2_clinic_intelligence_packages"("id") ON DELETE RESTRICT,
  "primary_content_package_id" text NOT NULL REFERENCES "demo_v2_primary_content_packages"("id") ON DELETE RESTRICT,
  "asset_catalog_id" text NOT NULL REFERENCES "demo_v2_asset_catalogs"("id") ON DELETE RESTRICT,
  "creative_brief_id" text NOT NULL REFERENCES "demo_v2_creative_briefs"("id") ON DELETE RESTRICT,
  "experience_plan_id" text NOT NULL REFERENCES "demo_v2_experience_plans"("id") ON DELETE RESTRICT,
  "schema_version" text NOT NULL,
  "intelligence_hash" text NOT NULL,
  "primary_content_hash" text NOT NULL,
  "translation_set_hash" text NOT NULL,
  "asset_catalog_hash" text NOT NULL,
  "asset_selection_set_hash" text NOT NULL,
  "creative_brief_hash" text NOT NULL,
  "experience_plan_hash" text NOT NULL,
  "component_registry_version" text NOT NULL,
  "component_registry_hash" text NOT NULL,
  "reference_library_version" text NOT NULL,
  "reference_library_hash" text NOT NULL,
  "render_hash" text NOT NULL,
  "screenshot_set_hash" text NOT NULL,
  "quality_rubric_version" text NOT NULL,
  "quality_rubric_hash" text NOT NULL,
  "visual_review_set_hash" text NOT NULL,
  "approval_package_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_approval_packages_hashes_ck" CHECK (
    intelligence_hash ~ '^[a-f0-9]{64}$' AND primary_content_hash ~ '^[a-f0-9]{64}$'
    AND translation_set_hash ~ '^[a-f0-9]{64}$' AND asset_catalog_hash ~ '^[a-f0-9]{64}$'
    AND asset_selection_set_hash ~ '^[a-f0-9]{64}$' AND creative_brief_hash ~ '^[a-f0-9]{64}$'
    AND experience_plan_hash ~ '^[a-f0-9]{64}$' AND component_registry_hash ~ '^[a-f0-9]{64}$'
    AND reference_library_hash ~ '^[a-f0-9]{64}$' AND render_hash ~ '^[a-f0-9]{64}$'
    AND screenshot_set_hash ~ '^[a-f0-9]{64}$' AND quality_rubric_hash ~ '^[a-f0-9]{64}$'
    AND visual_review_set_hash ~ '^[a-f0-9]{64}$' AND approval_package_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "demo_v2_approval_packages_rubric_ck" CHECK (length(trim(quality_rubric_version)) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_approval_packages_artifact_hash_uk" ON "demo_v2_approval_packages" ("artifact_id","approval_package_hash");--> statement-breakpoint
CREATE INDEX "demo_v2_approval_packages_plan_idx" ON "demo_v2_approval_packages" ("experience_plan_id");--> statement-breakpoint
CREATE INDEX "demo_v2_approval_packages_render_idx" ON "demo_v2_approval_packages" ("render_hash");--> statement-breakpoint
CREATE INDEX "demo_v2_approval_packages_hash_idx" ON "demo_v2_approval_packages" ("approval_package_hash");--> statement-breakpoint

CREATE TABLE "demo_v2_approval_translation_inputs" (
  "approval_package_id" text NOT NULL REFERENCES "demo_v2_approval_packages"("id") ON DELETE CASCADE,
  "translation_package_id" text NOT NULL REFERENCES "demo_v2_translation_packages"("id") ON DELETE RESTRICT,
  "bound_source_content_hash" text NOT NULL,
  "bound_translation_hash" text NOT NULL,
  CONSTRAINT "demo_v2_approval_translation_inputs_pk" PRIMARY KEY ("approval_package_id","translation_package_id"),
  CONSTRAINT "demo_v2_approval_translations_hash_ck" CHECK (
    bound_source_content_hash ~ '^[a-f0-9]{64}$' AND bound_translation_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint

CREATE TABLE "demo_v2_approval_asset_inputs" (
  "approval_package_id" text NOT NULL REFERENCES "demo_v2_approval_packages"("id") ON DELETE CASCADE,
  "asset_selection_id" text NOT NULL REFERENCES "demo_v2_asset_selections"("id") ON DELETE RESTRICT,
  "reuse_review_id" text NOT NULL REFERENCES "demo_v2_asset_reuse_reviews"("id") ON DELETE RESTRICT,
  "bound_asset_record_hash" text NOT NULL,
  "bound_selection_hash" text NOT NULL,
  "bound_reuse_review_hash" text NOT NULL,
  CONSTRAINT "demo_v2_approval_asset_inputs_pk" PRIMARY KEY ("approval_package_id","asset_selection_id"),
  CONSTRAINT "demo_v2_approval_assets_hash_ck" CHECK (
    bound_asset_record_hash ~ '^[a-f0-9]{64}$' AND bound_selection_hash ~ '^[a-f0-9]{64}$'
    AND bound_reuse_review_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint

CREATE TABLE "demo_v2_approval_decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "approval_package_id" text NOT NULL REFERENCES "demo_v2_approval_packages"("id") ON DELETE CASCADE,
  "decision" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "review_cycle" integer,
  "score" double precision,
  "blocker_count" integer,
  "category_scores" jsonb NOT NULL,
  "notes" text,
  "bound_approval_package_hash" text NOT NULL,
  "bound_visual_review_set_hash" text NOT NULL,
  "bound_quality_rubric_hash" text NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_approval_decisions_decision_ck" CHECK (decision IN ('AUTO_REVIEW_PASSED','AUTO_REVIEW_FAILED','HUMAN_APPROVED','HUMAN_REJECTED')),
  CONSTRAINT "demo_v2_approval_decisions_actor_ck" CHECK (
    actor_type IN ('MODEL','HUMAN','SYSTEM') AND length(trim(actor_id)) > 0),
  CONSTRAINT "demo_v2_approval_decisions_cycle_ck" CHECK (review_cycle IS NULL OR review_cycle BETWEEN 1 AND 3),
  CONSTRAINT "demo_v2_approval_decisions_score_ck" CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  CONSTRAINT "demo_v2_approval_decisions_blockers_ck" CHECK (blocker_count IS NULL OR blocker_count >= 0),
  CONSTRAINT "demo_v2_approval_decisions_categories_json_ck" CHECK (jsonb_typeof(category_scores) = 'object'),
  CONSTRAINT "demo_v2_approval_decisions_auto_pass_ck" CHECK (
    decision <> 'AUTO_REVIEW_PASSED'
    OR (actor_type IN ('MODEL','SYSTEM') AND score >= 85 AND blocker_count = 0 AND category_scores <> '{}'::jsonb)),
  CONSTRAINT "demo_v2_approval_decisions_actor_decision_ck" CHECK (
    (decision IN ('AUTO_REVIEW_PASSED','AUTO_REVIEW_FAILED') AND actor_type IN ('MODEL','SYSTEM'))
    OR (decision IN ('HUMAN_APPROVED','HUMAN_REJECTED') AND actor_type = 'HUMAN')),
  CONSTRAINT "demo_v2_approval_decisions_hash_ck" CHECK (
    bound_approval_package_hash ~ '^[a-f0-9]{64}$'
    AND bound_visual_review_set_hash ~ '^[a-f0-9]{64}$'
    AND bound_quality_rubric_hash ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE INDEX "demo_v2_approval_decisions_package_time_idx" ON "demo_v2_approval_decisions" ("approval_package_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_approval_decisions_cycle_uk" ON "demo_v2_approval_decisions" ("approval_package_id","decision","review_cycle") WHERE "review_cycle" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_approval_decisions_human_uk" ON "demo_v2_approval_decisions" ("approval_package_id") WHERE "decision" IN ('HUMAN_APPROVED','HUMAN_REJECTED');--> statement-breakpoint

CREATE TABLE "demo_v2_approval_invalidations" (
  "id" text PRIMARY KEY NOT NULL,
  "approval_package_id" text NOT NULL REFERENCES "demo_v2_approval_packages"("id") ON DELETE CASCADE,
  "reason_code" text NOT NULL,
  "changed_bindings" jsonb NOT NULL,
  "previous_package_hash" text NOT NULL,
  "observed_fingerprint" text NOT NULL,
  "actor_type" text DEFAULT 'SYSTEM' NOT NULL,
  "invalidated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_v2_approval_invalidations_reason_ck" CHECK (reason_code IN (
    'INTELLIGENCE_CHANGED','PRIMARY_CONTENT_CHANGED','TRANSLATION_CHANGED','ASSET_CATALOG_CHANGED',
    'ASSET_SELECTION_CHANGED','REUSE_REVIEW_CHANGED','CREATIVE_BRIEF_CHANGED','EXPERIENCE_PLAN_CHANGED',
    'COMPONENT_REGISTRY_CHANGED','REFERENCE_LIBRARY_CHANGED','RENDER_CHANGED','SCREENSHOT_SET_CHANGED',
    'QUALITY_RUBRIC_CHANGED','VISUAL_REVIEW_SET_CHANGED','MANUAL_INVALIDATION')),
  CONSTRAINT "demo_v2_approval_invalidations_actor_ck" CHECK (actor_type IN ('SYSTEM','HUMAN')),
  CONSTRAINT "demo_v2_approval_invalidations_hash_ck" CHECK (
    previous_package_hash ~ '^[a-f0-9]{64}$' AND observed_fingerprint ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "demo_v2_approval_invalidations_package_uk" ON "demo_v2_approval_invalidations" ("approval_package_id");--> statement-breakpoint
CREATE INDEX "demo_v2_approval_invalidations_time_idx" ON "demo_v2_approval_invalidations" ("invalidated_at");
