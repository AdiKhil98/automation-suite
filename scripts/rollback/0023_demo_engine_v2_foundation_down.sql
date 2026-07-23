DO $$
DECLARE
  populated_table text;
BEGIN
  SELECT table_name INTO populated_table
  FROM (
    VALUES
      ('demo_v2_approval_invalidations'),
      ('demo_v2_approval_decisions'),
      ('demo_v2_approval_asset_inputs'),
      ('demo_v2_approval_translation_inputs'),
      ('demo_v2_approval_packages'),
      ('demo_v2_experience_plan_assets'),
      ('demo_v2_experience_plan_translations'),
      ('demo_v2_experience_plans'),
      ('demo_v2_creative_briefs'),
      ('demo_v2_asset_reuse_reviews'),
      ('demo_v2_asset_selections'),
      ('demo_v2_assets'),
      ('demo_v2_asset_catalogs'),
      ('demo_v2_translation_records'),
      ('demo_v2_translation_packages'),
      ('demo_v2_content_item_sources'),
      ('demo_v2_content_items'),
      ('demo_v2_primary_content_packages'),
      ('demo_v2_clinic_intelligence_sources'),
      ('demo_v2_clinic_intelligence_packages'),
      ('demo_v2_artifacts')
  ) AS candidates(table_name)
  WHERE CASE table_name
    WHEN 'demo_v2_approval_invalidations' THEN EXISTS (SELECT 1 FROM demo_v2_approval_invalidations)
    WHEN 'demo_v2_approval_decisions' THEN EXISTS (SELECT 1 FROM demo_v2_approval_decisions)
    WHEN 'demo_v2_approval_asset_inputs' THEN EXISTS (SELECT 1 FROM demo_v2_approval_asset_inputs)
    WHEN 'demo_v2_approval_translation_inputs' THEN EXISTS (SELECT 1 FROM demo_v2_approval_translation_inputs)
    WHEN 'demo_v2_approval_packages' THEN EXISTS (SELECT 1 FROM demo_v2_approval_packages)
    WHEN 'demo_v2_experience_plan_assets' THEN EXISTS (SELECT 1 FROM demo_v2_experience_plan_assets)
    WHEN 'demo_v2_experience_plan_translations' THEN EXISTS (SELECT 1 FROM demo_v2_experience_plan_translations)
    WHEN 'demo_v2_experience_plans' THEN EXISTS (SELECT 1 FROM demo_v2_experience_plans)
    WHEN 'demo_v2_creative_briefs' THEN EXISTS (SELECT 1 FROM demo_v2_creative_briefs)
    WHEN 'demo_v2_asset_reuse_reviews' THEN EXISTS (SELECT 1 FROM demo_v2_asset_reuse_reviews)
    WHEN 'demo_v2_asset_selections' THEN EXISTS (SELECT 1 FROM demo_v2_asset_selections)
    WHEN 'demo_v2_assets' THEN EXISTS (SELECT 1 FROM demo_v2_assets)
    WHEN 'demo_v2_asset_catalogs' THEN EXISTS (SELECT 1 FROM demo_v2_asset_catalogs)
    WHEN 'demo_v2_translation_records' THEN EXISTS (SELECT 1 FROM demo_v2_translation_records)
    WHEN 'demo_v2_translation_packages' THEN EXISTS (SELECT 1 FROM demo_v2_translation_packages)
    WHEN 'demo_v2_content_item_sources' THEN EXISTS (SELECT 1 FROM demo_v2_content_item_sources)
    WHEN 'demo_v2_content_items' THEN EXISTS (SELECT 1 FROM demo_v2_content_items)
    WHEN 'demo_v2_primary_content_packages' THEN EXISTS (SELECT 1 FROM demo_v2_primary_content_packages)
    WHEN 'demo_v2_clinic_intelligence_sources' THEN EXISTS (SELECT 1 FROM demo_v2_clinic_intelligence_sources)
    WHEN 'demo_v2_clinic_intelligence_packages' THEN EXISTS (SELECT 1 FROM demo_v2_clinic_intelligence_packages)
    WHEN 'demo_v2_artifacts' THEN EXISTS (SELECT 1 FROM demo_v2_artifacts)
  END
  LIMIT 1;

  IF populated_table IS NOT NULL THEN
    RAISE EXCEPTION 'demo_v2_foundation_down_refused:table_not_empty:%', populated_table;
  END IF;
END $$;--> statement-breakpoint

DROP TABLE "demo_v2_approval_invalidations";--> statement-breakpoint
DROP TABLE "demo_v2_approval_decisions";--> statement-breakpoint
DROP TABLE "demo_v2_approval_asset_inputs";--> statement-breakpoint
DROP TABLE "demo_v2_approval_translation_inputs";--> statement-breakpoint
DROP TABLE "demo_v2_approval_packages";--> statement-breakpoint
DROP TABLE "demo_v2_experience_plan_assets";--> statement-breakpoint
DROP TABLE "demo_v2_experience_plan_translations";--> statement-breakpoint
DROP TABLE "demo_v2_experience_plans";--> statement-breakpoint
DROP TABLE "demo_v2_creative_briefs";--> statement-breakpoint
DROP TABLE "demo_v2_asset_reuse_reviews";--> statement-breakpoint
DROP TABLE "demo_v2_asset_selections";--> statement-breakpoint
DROP TABLE "demo_v2_assets";--> statement-breakpoint
DROP TABLE "demo_v2_asset_catalogs";--> statement-breakpoint
DROP TABLE "demo_v2_translation_records";--> statement-breakpoint
DROP TABLE "demo_v2_translation_packages";--> statement-breakpoint
DROP TABLE "demo_v2_content_item_sources";--> statement-breakpoint
DROP TABLE "demo_v2_content_items";--> statement-breakpoint
DROP TABLE "demo_v2_primary_content_packages";--> statement-breakpoint
DROP TABLE "demo_v2_clinic_intelligence_sources";--> statement-breakpoint
DROP TABLE "demo_v2_clinic_intelligence_packages";--> statement-breakpoint
DROP TABLE "demo_v2_artifacts";
