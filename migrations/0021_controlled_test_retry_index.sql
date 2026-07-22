DROP INDEX "controlled_test_runs_prospect_run_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "controlled_test_runs_prospect_run_uk" ON "controlled_test_runs" ("prospect_run_id") WHERE "status" IN ('RUNNING','COMPLETED');
