-- Guarded reverse for 0025. Refuses to drop a populated table and drops only the V2 table it added.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM demo_v2_visual_reviews) THEN
    RAISE EXCEPTION 'demo_v2_visual_reviews_down_refused:table_not_empty';
  END IF;
END $$;--> statement-breakpoint

DROP TABLE "demo_v2_visual_reviews";
