CREATE TABLE "clash_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"assigned_company_id" uuid,
	"issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clash_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"stats" jsonb,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clash_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"model_set_id" uuid NOT NULL,
	"name" text NOT NULL,
	"selection_a" jsonb NOT NULL,
	"selection_b" jsonb NOT NULL,
	"type" text DEFAULT 'hard' NOT NULL,
	"tolerance_mm" real DEFAULT 0 NOT NULL,
	"group_by" text DEFAULT 'elementA' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clashes" (
	"id" text PRIMARY KEY NOT NULL,
	"test_id" uuid NOT NULL,
	"group_id" uuid,
	"file_a" uuid NOT NULL,
	"version_a" uuid NOT NULL,
	"guid_a" text NOT NULL,
	"class_a" text NOT NULL,
	"name_a" text,
	"storey_a" text,
	"system_a" text,
	"file_b" uuid NOT NULL,
	"version_b" uuid NOT NULL,
	"guid_b" text NOT NULL,
	"class_b" text NOT NULL,
	"name_b" text,
	"storey_b" text,
	"system_b" text,
	"point" jsonb NOT NULL,
	"distance" real NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"last_run_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"status_changed_by" uuid,
	"status_changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ids_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"ids_version_id" uuid NOT NULL,
	"ifc_version_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"title" text,
	"specs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"totals" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_set_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_set_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clash_groups" ADD CONSTRAINT "clash_groups_test_id_clash_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."clash_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_groups" ADD CONSTRAINT "clash_groups_assigned_company_id_companies_id_fk" FOREIGN KEY ("assigned_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_groups" ADD CONSTRAINT "clash_groups_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_runs" ADD CONSTRAINT "clash_runs_test_id_clash_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."clash_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_runs" ADD CONSTRAINT "clash_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_tests" ADD CONSTRAINT "clash_tests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_tests" ADD CONSTRAINT "clash_tests_model_set_id_model_sets_id_fk" FOREIGN KEY ("model_set_id") REFERENCES "public"."model_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_tests" ADD CONSTRAINT "clash_tests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clashes" ADD CONSTRAINT "clashes_test_id_clash_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."clash_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clashes" ADD CONSTRAINT "clashes_group_id_clash_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."clash_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clashes" ADD CONSTRAINT "clashes_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ids_reports" ADD CONSTRAINT "ids_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ids_reports" ADD CONSTRAINT "ids_reports_ids_version_id_file_versions_id_fk" FOREIGN KEY ("ids_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ids_reports" ADD CONSTRAINT "ids_reports_ifc_version_id_file_versions_id_fk" FOREIGN KEY ("ifc_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ids_reports" ADD CONSTRAINT "ids_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_set_views" ADD CONSTRAINT "model_set_views_model_set_id_model_sets_id_fk" FOREIGN KEY ("model_set_id") REFERENCES "public"."model_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_set_views" ADD CONSTRAINT "model_set_views_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_sets" ADD CONSTRAINT "model_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_sets" ADD CONSTRAINT "model_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clash_groups_key" ON "clash_groups" USING btree ("test_id","key");--> statement-breakpoint
CREATE INDEX "clash_runs_test_idx" ON "clash_runs" USING btree ("test_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clash_tests_name" ON "clash_tests" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "clashes_test_idx" ON "clashes" USING btree ("test_id","status");--> statement-breakpoint
CREATE INDEX "clashes_group_idx" ON "clashes" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "ids_reports_project_idx" ON "ids_reports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "model_set_views_set_idx" ON "model_set_views" USING btree ("model_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_sets_name" ON "model_sets" USING btree ("project_id","name");