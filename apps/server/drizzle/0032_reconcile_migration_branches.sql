-- Reconcile databases whose migration history followed the former origin/main 0017-0019 branch.
-- doc_comparisons is created by this branch's first skipped migration, so its presence means
-- the complete 0017-0030 sequence has already run.
DO $reconcile$
BEGIN
	IF to_regclass('public.doc_comparisons') IS NULL THEN
		-- 0017_doc_compare.sql
		CREATE TABLE "doc_comparisons" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"project_id" uuid NOT NULL,
			"from_version_id" uuid NOT NULL,
			"to_version_id" uuid NOT NULL,
			"status" text DEFAULT 'running' NOT NULL,
			"error" text,
			"result" jsonb,
			"regions" jsonb,
			"regions_at" timestamp with time zone,
			"ai_status" text DEFAULT 'none' NOT NULL,
			"ai_bullets" jsonb,
			"ai_model" text,
			"ai_error" text,
			"ai_started_at" timestamp with time zone,
			"ai_finished_at" timestamp with time zone,
			"created_by" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL
		);

		ALTER TABLE "doc_comparisons" ADD CONSTRAINT "doc_comparisons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "doc_comparisons" ADD CONSTRAINT "doc_comparisons_from_version_id_file_versions_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "doc_comparisons" ADD CONSTRAINT "doc_comparisons_to_version_id_file_versions_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "doc_comparisons" ADD CONSTRAINT "doc_comparisons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
		CREATE UNIQUE INDEX "doc_comparisons_pair" ON "doc_comparisons" USING btree ("from_version_id","to_version_id");
		CREATE INDEX "doc_comparisons_project_idx" ON "doc_comparisons" USING btree ("project_id");

		-- 0018_viewers.sql
		CREATE TABLE "version_previews" (
			"version_id" uuid NOT NULL,
			"kind" text NOT NULL,
			"status" text DEFAULT 'pending' NOT NULL,
			"storage_key" text,
			"error" text,
			"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
			"attempts" integer DEFAULT 0 NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
			CONSTRAINT "version_previews_version_id_kind_pk" PRIMARY KEY("version_id","kind")
		);

		CREATE TABLE "version_texts" (
			"version_id" uuid PRIMARY KEY NOT NULL,
			"project_id" uuid NOT NULL,
			"source" text NOT NULL,
			"content" text NOT NULL,
			"truncated" boolean DEFAULT false NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL
		);

		ALTER TABLE "version_previews" ADD CONSTRAINT "version_previews_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "version_texts" ADD CONSTRAINT "version_texts_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "version_texts" ADD CONSTRAINT "version_texts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		CREATE INDEX "version_texts_project_idx" ON "version_texts" USING btree ("project_id");

		-- 0019_wopi.sql
		CREATE TABLE "wopi_locks" (
			"file_id" uuid PRIMARY KEY NOT NULL,
			"lock_id" text NOT NULL,
			"user_id" uuid,
			"editor" text,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"expires_at" timestamp with time zone NOT NULL,
			"refreshed_by" uuid
		);

		CREATE TABLE "wopi_tokens" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"token_hash" text NOT NULL,
			"user_id" uuid NOT NULL,
			"project_id" uuid NOT NULL,
			"file_id" uuid NOT NULL,
			"mode" text NOT NULL,
			"permission" jsonb NOT NULL,
			"post_message_origin" text,
			"editor" text NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"expires_at" timestamp with time zone NOT NULL,
			"last_used_at" timestamp with time zone,
			CONSTRAINT "wopi_tokens_token_hash_unique" UNIQUE("token_hash")
		);

		ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_refreshed_by_users_id_fk" FOREIGN KEY ("refreshed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "wopi_tokens" ADD CONSTRAINT "wopi_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "wopi_tokens" ADD CONSTRAINT "wopi_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "wopi_tokens" ADD CONSTRAINT "wopi_tokens_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
		CREATE INDEX "wopi_tokens_file_idx" ON "wopi_tokens" USING btree ("file_id");
		CREATE INDEX "wopi_tokens_expires_idx" ON "wopi_tokens" USING btree ("expires_at");

		-- 0020_report_stamps.sql
		CREATE TABLE "report_change_stamps" (
			"project_id" uuid NOT NULL,
			"scope" text NOT NULL,
			"counter" bigint DEFAULT 0 NOT NULL,
			"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
			CONSTRAINT "report_change_stamps_project_id_scope_pk" PRIMARY KEY("project_id","scope")
		);


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

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "files" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "files" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "files" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "folders" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "folders" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "folders" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "issues" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('issues');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "issues" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('issues');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "issues" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('issues');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "audit_log" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('activity');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "audit_log" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('activity');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "audit_log" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('activity');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "project_members" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('members');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "project_members" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('members');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "project_members" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('members');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "works" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "works" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "works" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "work_types" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "work_types" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "work_types" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "workflow_instances" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "workflow_instances" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "workflow_instances" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "reviews" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "reviews" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "reviews" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "forms" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "forms" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "forms" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "form_templates" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "form_templates" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "form_templates" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('forms');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "locations" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "locations" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "locations" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "location_links" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "location_links" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "location_links" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('locations');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "schedules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "schedules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "schedules" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "clash_tests" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "clash_tests" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "clash_tests" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "model_sets" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "model_sets" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "model_sets" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "doc_comparisons" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('doccompare');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "doc_comparisons" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('doccompare');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "doc_comparisons" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('doccompare');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "spec_registers" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "spec_registers" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "spec_registers" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "doc_extractions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "doc_extractions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "doc_extractions" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('docintel');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "file_versions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'files', 'file_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "file_versions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'files', 'file_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "file_versions" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'files', 'file_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "folder_grants" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'folders', 'folder_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "folder_grants" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'folders', 'folder_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "folder_grants" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('files', 'folders', 'folder_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "work_revisions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "work_revisions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "work_revisions" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "work_receipts" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "work_receipts" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "work_receipts" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('works', 'works', 'work_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "workflow_actions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow', 'workflow_instances', 'instance_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "workflow_actions" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow', 'workflow_instances', 'instance_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "workflow_actions" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('workflow', 'workflow_instances', 'instance_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "review_files" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews', 'reviews', 'review_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "review_files" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews', 'reviews', 'review_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "review_files" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('reviews', 'reviews', 'review_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "schedule_activities" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule', 'schedules', 'schedule_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "schedule_activities" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule', 'schedules', 'schedule_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "schedule_activities" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule', 'schedules', 'schedule_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "clashes" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "clashes" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "clashes" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "clash_groups" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "clash_groups" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "clash_groups" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "clash_runs" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "clash_runs" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "clash_runs" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('coordination', 'clash_tests', 'test_id');

		-- 0021_form_pdf.sql
		CREATE TABLE "form_pdf_sources" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"project_id" uuid NOT NULL,
			"storage_key" text NOT NULL,
			"sha256" text NOT NULL,
			"file_name" text NOT NULL,
			"size" bigint NOT NULL,
			"page_count" integer NOT NULL,
			"pages" jsonb NOT NULL,
			"level" text NOT NULL,
			"field_count" integer DEFAULT 0 NOT NULL,
			"created_by" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL
		);

		ALTER TABLE "form_template_versions" ADD COLUMN "source_id" uuid;
		ALTER TABLE "form_pdf_sources" ADD CONSTRAINT "form_pdf_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "form_pdf_sources" ADD CONSTRAINT "form_pdf_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		CREATE INDEX "form_pdf_sources_project_idx" ON "form_pdf_sources" USING btree ("project_id");
		ALTER TABLE "form_template_versions" ADD CONSTRAINT "form_template_versions_source_id_form_pdf_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."form_pdf_sources"("id") ON DELETE no action ON UPDATE no action;

		-- 0022_saved_views.sql
		CREATE TABLE "saved_views" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"project_id" uuid NOT NULL,
			"owner_id" uuid NOT NULL,
			"name" text NOT NULL,
			"view" text NOT NULL,
			"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
			"shared" boolean DEFAULT false NOT NULL,
			"position" integer DEFAULT 0 NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL
		);

		ALTER TABLE "projects" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
		ALTER TABLE "users" ADD COLUMN "prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;
		ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		CREATE INDEX "saved_views_project_owner_idx" ON "saved_views" USING btree ("project_id","owner_id");

		-- 0023_ai_tasks.sql
		CREATE TABLE "ai_tasks" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"project_id" uuid NOT NULL,
			"kind" text NOT NULL,
			"input" jsonb NOT NULL,
			"requested_by" uuid NOT NULL,
			"status" text DEFAULT 'pending' NOT NULL,
			"claimed_by" uuid,
			"claimed_by_user" uuid,
			"claimed_at" timestamp with time zone,
			"result" jsonb,
			"error" text,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"completed_at" timestamp with time zone,
			"expires_at" timestamp with time zone NOT NULL
		);

		ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_claimed_by_tokens_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."tokens"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_claimed_by_user_users_id_fk" FOREIGN KEY ("claimed_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
		CREATE INDEX "ai_tasks_project_status_idx" ON "ai_tasks" USING btree ("project_id","status");
		CREATE INDEX "ai_tasks_requester_idx" ON "ai_tasks" USING btree ("requested_by","created_at");

		-- 0024_today_summaries.sql
		CREATE TABLE "today_summaries" (
			"user_id" uuid NOT NULL,
			"project_id" uuid NOT NULL,
			"stamp" text,
			"bullets" jsonb,
			"model" text,
			"source" text,
			"generated_at" timestamp with time zone,
			"attempted_at" timestamp with time zone,
			"error" text,
			"error_at" timestamp with time zone,
			CONSTRAINT "today_summaries_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
		);

		ALTER TABLE "today_summaries" ADD CONSTRAINT "today_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "today_summaries" ADD CONSTRAINT "today_summaries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

		-- 0025_sim_4d_5d.sql
		CREATE TABLE "cost_items" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"project_id" uuid NOT NULL,
			"code" text NOT NULL,
			"description" text NOT NULL,
			"unit" text NOT NULL,
			"unit_price" double precision NOT NULL,
			"currency" text DEFAULT 'TRY' NOT NULL,
			"category" text,
			"poz_code" text,
			"created_by" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL
		);

		CREATE TABLE "cost_rules" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"project_id" uuid NOT NULL,
			"file_id" uuid NOT NULL,
			"cost_item_id" uuid,
			"match" jsonb NOT NULL,
			"quantity" text DEFAULT 'count' NOT NULL,
			"multiplier" real DEFAULT 1 NOT NULL,
			"series_id" uuid,
			"activity_code" text,
			"sort_index" integer DEFAULT 0 NOT NULL,
			"created_by" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL
		);

		CREATE TABLE "schedule_link_rules" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"project_id" uuid NOT NULL,
			"series_id" uuid NOT NULL,
			"file_id" uuid NOT NULL,
			"activity_code" text,
			"match" jsonb NOT NULL,
			"sort_index" integer DEFAULT 0 NOT NULL,
			"applied_version_id" uuid,
			"applied_at" timestamp with time zone,
			"applied_count" integer,
			"created_by" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL
		);

		ALTER TABLE "activity_links" ADD COLUMN "rule_id" uuid;
		ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		ALTER TABLE "cost_rules" ADD CONSTRAINT "cost_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cost_rules" ADD CONSTRAINT "cost_rules_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cost_rules" ADD CONSTRAINT "cost_rules_cost_item_id_cost_items_id_fk" FOREIGN KEY ("cost_item_id") REFERENCES "public"."cost_items"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cost_rules" ADD CONSTRAINT "cost_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		ALTER TABLE "schedule_link_rules" ADD CONSTRAINT "schedule_link_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "schedule_link_rules" ADD CONSTRAINT "schedule_link_rules_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "schedule_link_rules" ADD CONSTRAINT "schedule_link_rules_applied_version_id_file_versions_id_fk" FOREIGN KEY ("applied_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "schedule_link_rules" ADD CONSTRAINT "schedule_link_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		CREATE UNIQUE INDEX "cost_items_project_code" ON "cost_items" USING btree ("project_id","code");
		CREATE INDEX "cost_rules_project_idx" ON "cost_rules" USING btree ("project_id","file_id");
		CREATE INDEX "schedule_link_rules_series_idx" ON "schedule_link_rules" USING btree ("series_id","file_id");
		ALTER TABLE "activity_links" ADD CONSTRAINT "activity_links_rule_id_schedule_link_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."schedule_link_rules"("id") ON DELETE cascade ON UPDATE no action;
		-- Live report refresh (see 0020_report_stamps): 5D tables bump the "cost" scope, 4D link rules and links the "schedule" scope.
		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "cost_items" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "cost_items" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "cost_items" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "cost_rules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "cost_rules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "cost_rules" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "schedule_link_rules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "schedule_link_rules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "schedule_link_rules" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		CREATE TRIGGER report_stamp_insert AFTER INSERT ON "activity_links" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		CREATE TRIGGER report_stamp_update AFTER UPDATE ON "activity_links" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		CREATE TRIGGER report_stamp_delete AFTER DELETE ON "activity_links" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');

		-- 0026_opencde_auth.sql
		CREATE TABLE "oauth_clients" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"client_id" text NOT NULL,
			"name" text NOT NULL,
			"description" text,
			"type" text NOT NULL,
			"secret_hash" text,
			"secret_set_at" timestamp with time zone,
			"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
			"scopes" text[] NOT NULL,
			"enabled" boolean DEFAULT true NOT NULL,
			"created_by" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
			CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
		);

		CREATE TABLE "oauth_codes" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"code_hash" text NOT NULL,
			"client_id" uuid NOT NULL,
			"user_id" uuid NOT NULL,
			"redirect_uri" text NOT NULL,
			"scopes" text[] NOT NULL,
			"code_challenge" text,
			"code_challenge_method" text,
			"family_id" uuid NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"expires_at" timestamp with time zone NOT NULL,
			"used_at" timestamp with time zone,
			CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash")
		);

		CREATE TABLE "oauth_consents" (
			"user_id" uuid NOT NULL,
			"client_id" uuid NOT NULL,
			"scopes" text[] NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
			"last_used_at" timestamp with time zone,
			CONSTRAINT "oauth_consents_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
		);

		CREATE TABLE "oauth_refresh_tokens" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"token_hash" text NOT NULL,
			"family_id" uuid NOT NULL,
			"client_id" uuid NOT NULL,
			"user_id" uuid NOT NULL,
			"scopes" text[] NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"expires_at" timestamp with time zone NOT NULL,
			"used_at" timestamp with time zone,
			"revoked_at" timestamp with time zone,
			CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
		);

		ALTER TABLE "tokens" ADD COLUMN "oauth_client_id" uuid;
		ALTER TABLE "tokens" ADD COLUMN "oauth_family_id" uuid;
		ALTER TABLE "tokens" ADD COLUMN "oauth_scopes" text[];
		ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		CREATE INDEX "oauth_codes_expires_idx" ON "oauth_codes" USING btree ("expires_at");
		CREATE INDEX "oauth_refresh_family_idx" ON "oauth_refresh_tokens" USING btree ("family_id");
		CREATE INDEX "oauth_refresh_user_client_idx" ON "oauth_refresh_tokens" USING btree ("user_id","client_id");
		ALTER TABLE "tokens" ADD CONSTRAINT "tokens_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
		CREATE INDEX "tokens_oauth_family_idx" ON "tokens" USING btree ("oauth_family_id");

		-- 0027_model_param.sql
		CREATE TABLE "param_change_checks" (
			"request_id" uuid NOT NULL,
			"version_id" uuid NOT NULL,
			"ok" boolean NOT NULL,
			"present" integer NOT NULL,
			"lost" integer NOT NULL,
			"details" jsonb,
			"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
			CONSTRAINT "param_change_checks_request_id_version_id_pk" PRIMARY KEY("request_id","version_id")
		);

		CREATE TABLE "param_change_items" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"request_id" uuid NOT NULL,
			"position" integer NOT NULL,
			"global_id" text NOT NULL,
			"ifc_class" text NOT NULL,
			"name" text,
			"storey" text,
			"type_name" text,
			"pset" text NOT NULL,
			"property" text NOT NULL,
			"old_value" jsonb,
			"new_value" jsonb NOT NULL,
			"value_type" text NOT NULL,
			"source" text NOT NULL,
			"unchanged" boolean DEFAULT false NOT NULL,
			"result" text DEFAULT 'pending' NOT NULL,
			"result_message" text
		);

		CREATE TABLE "param_change_requests" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"project_id" uuid NOT NULL,
			"number" integer NOT NULL,
			"file_id" uuid NOT NULL,
			"base_version_id" uuid NOT NULL,
			"title" text NOT NULL,
			"reason" text,
			"status" text DEFAULT 'draft' NOT NULL,
			"ownership" text DEFAULT 'revit' NOT NULL,
			"type_mode" text DEFAULT 'instance' NOT NULL,
			"spec" jsonb NOT NULL,
			"work_id" uuid,
			"issue_id" uuid,
			"created_by" uuid NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
			"submitted_at" timestamp with time zone,
			"decided_by" uuid,
			"decided_at" timestamp with time zone,
			"decision_note" text,
			"applied_by" uuid,
			"applied_at" timestamp with time zone,
			"applied_version_id" uuid,
			"verified_version_id" uuid,
			"lost_version_id" uuid,
			"error" text
		);

		ALTER TABLE "param_change_checks" ADD CONSTRAINT "param_change_checks_request_id_param_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."param_change_requests"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "param_change_checks" ADD CONSTRAINT "param_change_checks_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "param_change_items" ADD CONSTRAINT "param_change_items_request_id_param_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."param_change_requests"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_base_version_id_file_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_applied_version_id_file_versions_id_fk" FOREIGN KEY ("applied_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_verified_version_id_file_versions_id_fk" FOREIGN KEY ("verified_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_lost_version_id_file_versions_id_fk" FOREIGN KEY ("lost_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;
		CREATE INDEX "param_change_checks_version_idx" ON "param_change_checks" USING btree ("version_id");
		CREATE INDEX "param_change_items_request_idx" ON "param_change_items" USING btree ("request_id","position");
		CREATE UNIQUE INDEX "param_change_requests_number" ON "param_change_requests" USING btree ("project_id","number");
		CREATE INDEX "param_change_requests_status_idx" ON "param_change_requests" USING btree ("project_id","status");
		CREATE INDEX "param_change_requests_file_idx" ON "param_change_requests" USING btree ("file_id");

		-- 0028_gizlilik.sql
		CREATE TABLE "outbound_log" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"at" timestamp with time zone DEFAULT now() NOT NULL,
			"purpose" text NOT NULL,
			"connection" text,
			"host" text NOT NULL,
			"method" text NOT NULL,
			"local" boolean NOT NULL,
			"blocked" boolean DEFAULT false NOT NULL,
			"bytes_out" integer,
			"bytes_in" integer,
			"status" integer,
			"error" text,
			"duration_ms" integer,
			"user_id" uuid,
			"project_id" uuid,
			"details" jsonb
		);

		CREATE INDEX "outbound_log_at_idx" ON "outbound_log" USING btree ("at");
		CREATE INDEX "outbound_log_purpose_idx" ON "outbound_log" USING btree ("purpose","at");
		CREATE INDEX "outbound_log_host_idx" ON "outbound_log" USING btree ("host","at");

		-- 0029_bcfzip.sql
		CREATE TABLE "issue_related_topics" (
			"issue_id" uuid NOT NULL,
			"related_guid" text NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			CONSTRAINT "issue_related_topics_issue_id_related_guid_pk" PRIMARY KEY("issue_id","related_guid")
		);

		CREATE TABLE "issue_viewpoints" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"issue_id" uuid NOT NULL,
			"guid" text NOT NULL,
			"idx" integer DEFAULT 1 NOT NULL,
			"viewpoint" jsonb NOT NULL,
			"created_by" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL
		);

		ALTER TABLE "issue_comments" ADD COLUMN "guid" text DEFAULT gen_random_uuid()::text NOT NULL;
		ALTER TABLE "issue_comments" ADD COLUMN "viewpoint_guid" text;
		ALTER TABLE "issue_comments" ADD COLUMN "modified_at" timestamp with time zone;
		ALTER TABLE "issue_comments" ADD COLUMN "modified_by" uuid;
		ALTER TABLE "issue_comments" ADD COLUMN "imported_author" text;
		ALTER TABLE "issues" ADD COLUMN "guid" text DEFAULT gen_random_uuid()::text NOT NULL;
		ALTER TABLE "issues" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;
		ALTER TABLE "issues" ADD COLUMN "stage" text;
		ALTER TABLE "issues" ADD COLUMN "reference_links" text[] DEFAULT '{}'::text[] NOT NULL;
		ALTER TABLE "issues" ADD COLUMN "modified_by" uuid;
		ALTER TABLE "issues" ADD COLUMN "imported_from" jsonb;
		-- Existing issues and comments keep their id as BCF GUID.
		UPDATE "issues" SET "guid" = "id"::text;
		UPDATE "issue_comments" SET "guid" = "id"::text;
		ALTER TABLE "issue_related_topics" ADD CONSTRAINT "issue_related_topics_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "issue_viewpoints" ADD CONSTRAINT "issue_viewpoints_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "issue_viewpoints" ADD CONSTRAINT "issue_viewpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		CREATE UNIQUE INDEX "issue_viewpoints_guid" ON "issue_viewpoints" USING btree ("issue_id","guid");
		CREATE INDEX "issue_viewpoints_issue_idx" ON "issue_viewpoints" USING btree ("issue_id","idx");
		ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		ALTER TABLE "issues" ADD CONSTRAINT "issues_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		CREATE UNIQUE INDEX "issue_comments_guid" ON "issue_comments" USING btree ("issue_id","guid");
		CREATE UNIQUE INDEX "issues_guid" ON "issues" USING btree ("project_id","guid");

		-- 0030_opencde_docs.sql
		CREATE TABLE "opencde_doc_session_files" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"session_id" uuid NOT NULL,
			"session_file_id" text NOT NULL,
			"file_name" text NOT NULL,
			"document_id" uuid,
			"target_name" text,
			"size_in_bytes" bigint,
			"part_size" integer,
			"status" text DEFAULT 'pending' NOT NULL,
			"file_id" uuid,
			"version_id" uuid,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			CONSTRAINT "opencde_doc_session_files_uq" UNIQUE("session_id","session_file_id")
		);

		CREATE TABLE "opencde_doc_sessions" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"kind" text NOT NULL,
			"status" text DEFAULT 'pending' NOT NULL,
			"user_id" uuid NOT NULL,
			"oauth_client_id" uuid,
			"client_name" text NOT NULL,
			"ui_key_hash" text NOT NULL,
			"ui_expires_at" timestamp with time zone NOT NULL,
			"claimed_at" timestamp with time zone,
			"claimed_by" text,
			"callback_url" text NOT NULL,
			"callback_expires_at" timestamp with time zone NOT NULL,
			"supported_extensions" text[] DEFAULT '{}'::text[] NOT NULL,
			"project_id" uuid,
			"folder_id" uuid,
			"comment" text,
			"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
			"selected_version_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
			"expires_at" timestamp with time zone NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
			"completed_at" timestamp with time zone,
			CONSTRAINT "opencde_doc_sessions_ui_key_hash_unique" UNIQUE("ui_key_hash")
		);

		CREATE TABLE "opencde_upload_parts" (
			"file_row_id" uuid NOT NULL,
			"part_index" integer NOT NULL,
			"storage_key" text NOT NULL,
			"size" bigint NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			CONSTRAINT "opencde_upload_parts_file_row_id_part_index_pk" PRIMARY KEY("file_row_id","part_index")
		);

		ALTER TABLE "opencde_doc_session_files" ADD CONSTRAINT "opencde_doc_session_files_session_id_opencde_doc_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."opencde_doc_sessions"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "opencde_doc_session_files" ADD CONSTRAINT "opencde_doc_session_files_document_id_files_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "opencde_doc_session_files" ADD CONSTRAINT "opencde_doc_session_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "opencde_doc_session_files" ADD CONSTRAINT "opencde_doc_session_files_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "opencde_doc_sessions" ADD CONSTRAINT "opencde_doc_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "opencde_doc_sessions" ADD CONSTRAINT "opencde_doc_sessions_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "opencde_doc_sessions" ADD CONSTRAINT "opencde_doc_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "opencde_doc_sessions" ADD CONSTRAINT "opencde_doc_sessions_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "opencde_upload_parts" ADD CONSTRAINT "opencde_upload_parts_file_row_id_opencde_doc_session_files_id_fk" FOREIGN KEY ("file_row_id") REFERENCES "public"."opencde_doc_session_files"("id") ON DELETE cascade ON UPDATE no action;
		CREATE INDEX "opencde_doc_sessions_user_idx" ON "opencde_doc_sessions" USING btree ("user_id");
		CREATE INDEX "opencde_doc_sessions_expires_idx" ON "opencde_doc_sessions" USING btree ("expires_at");

	END IF;
END
$reconcile$;
