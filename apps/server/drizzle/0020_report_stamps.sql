CREATE TABLE "report_change_stamps" (
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_change_stamps_project_id_scope_pk" PRIMARY KEY("project_id","scope")
);

--> statement-breakpoint
-- Live report refresh: statement-level triggers bump a per-project, per-scope counter on every write
-- to the tables behind report datasets. One upsert per statement (not per row) via transition tables;
-- statements that change no rows (e.g. INSERT … ON CONFLICT DO NOTHING) do not bump.
CREATE OR REPLACE FUNCTION report_stamp_bump() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rel text := CASE WHEN TG_OP = 'DELETE' THEN 'report_old_rows' ELSE 'report_new_rows' END;
BEGIN
  IF TG_NARGS = 1 THEN
    EXECUTE format(
      'INSERT INTO report_change_stamps AS s (project_id, scope, counter, changed_at) '
      'SELECT DISTINCT r.project_id, %L, 1, now() FROM %I r WHERE r.project_id IS NOT NULL '
      'ON CONFLICT (project_id, scope) DO UPDATE SET counter = s.counter + 1, changed_at = now()',
      TG_ARGV[0], rel);
  ELSE
    EXECUTE format(
      'INSERT INTO report_change_stamps AS s (project_id, scope, counter, changed_at) '
      'SELECT DISTINCT p.project_id, %L, 1, now() FROM %I r JOIN %I p ON p.id = r.%I WHERE p.project_id IS NOT NULL '
      'ON CONFLICT (project_id, scope) DO UPDATE SET counter = s.counter + 1, changed_at = now()',
      TG_ARGV[0], rel, TG_ARGV[1], TG_ARGV[2]);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "files" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "files" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "files" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "folders" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "folders" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "folders" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "issues" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('issues');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "issues" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('issues');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "issues" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('issues');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "audit_log" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('activity');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "audit_log" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('activity');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "audit_log" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('activity');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "project_members" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('members');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "project_members" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('members');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "project_members" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('members');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "works" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "works" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "works" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "work_types" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "work_types" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "work_types" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "workflow_instances" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "workflow_instances" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "workflow_instances" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "reviews" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "reviews" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "reviews" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "forms" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "forms" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "forms" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "form_templates" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "form_templates" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "form_templates" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "locations" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "locations" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "locations" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "location_links" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "location_links" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "location_links" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "schedules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "schedules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "schedules" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "clash_tests" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "clash_tests" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "clash_tests" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "model_sets" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "model_sets" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "model_sets" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "doc_comparisons" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('doccompare');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "doc_comparisons" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('doccompare');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "doc_comparisons" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('doccompare');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "spec_registers" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "spec_registers" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "spec_registers" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "doc_extractions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "doc_extractions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "doc_extractions" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "file_versions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'files', 'file_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "file_versions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'files', 'file_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "file_versions" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'files', 'file_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "folder_grants" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'folders', 'folder_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "folder_grants" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'folders', 'folder_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "folder_grants" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'folders', 'folder_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "work_revisions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "work_revisions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "work_revisions" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "work_receipts" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "work_receipts" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "work_receipts" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "workflow_actions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow', 'workflow_instances', 'instance_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "workflow_actions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow', 'workflow_instances', 'instance_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "workflow_actions" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow', 'workflow_instances', 'instance_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "review_files" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews', 'reviews', 'review_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "review_files" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews', 'reviews', 'review_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "review_files" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews', 'reviews', 'review_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "schedule_activities" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule', 'schedules', 'schedule_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "schedule_activities" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule', 'schedules', 'schedule_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "schedule_activities" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule', 'schedules', 'schedule_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "clashes" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "clashes" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "clashes" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "clash_groups" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "clash_groups" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "clash_groups" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "clash_runs" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "clash_runs" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "clash_runs" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');
