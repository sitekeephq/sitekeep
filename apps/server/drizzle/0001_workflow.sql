CREATE TABLE "folder_settings" (
	"folder_id" uuid PRIMARY KEY NOT NULL,
	"require_approved_review" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"file_version_id" uuid NOT NULL,
	"source_folder_id" uuid NOT NULL,
	"step_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"final_status" text,
	"decided_at" timestamp with time zone,
	"copied_file_id" uuid,
	"copied_version_id" uuid,
	"copy_error" text
);
--> statement-breakpoint
CREATE TABLE "review_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_file_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"comment" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"target_folder_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"outcome" text,
	"comment" text,
	"details" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"template_id" uuid,
	"template" jsonb NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"step_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"step_due_at" timestamp with time zone,
	"started_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"final_outcomes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "folder_settings" ADD CONSTRAINT "folder_settings_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_files" ADD CONSTRAINT "review_files_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_files" ADD CONSTRAINT "review_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_files" ADD CONSTRAINT "review_files_file_version_id_file_versions_id_fk" FOREIGN KEY ("file_version_id") REFERENCES "public"."file_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_marks" ADD CONSTRAINT "review_marks_review_file_id_review_files_id_fk" FOREIGN KEY ("review_file_id") REFERENCES "public"."review_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_marks" ADD CONSTRAINT "review_marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_target_folder_id_folders_id_fk" FOREIGN KEY ("target_folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_files_unique" ON "review_files" USING btree ("review_id","file_version_id");--> statement-breakpoint
CREATE INDEX "review_files_version_idx" ON "review_files" USING btree ("file_version_id");--> statement-breakpoint
CREATE INDEX "review_files_copy_idx" ON "review_files" USING btree ("copied_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_marks_unique" ON "review_marks" USING btree ("review_file_id","step_index","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_number" ON "reviews" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "workflow_actions_instance_idx" ON "workflow_actions" USING btree ("instance_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_instances_subject" ON "workflow_instances" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "workflow_instances_status_idx" ON "workflow_instances" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "workflow_templates_project_idx" ON "workflow_templates" USING btree ("project_id","kind");