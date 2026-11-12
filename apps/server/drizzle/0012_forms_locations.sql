CREATE TABLE "form_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"row" integer,
	"issue_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema" jsonb NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"number_pattern" text NOT NULL,
	"workflow_template_id" uuid,
	"current_version" integer DEFAULT 1 NOT NULL,
	"builtin_key" text,
	"merged_into_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"number" text NOT NULL,
	"number_key" text NOT NULL,
	"seq" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"form_date" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" double precision,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"last_outcome" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "location_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"code" text,
	"type" text,
	"km_start" double precision,
	"km_end" double precision,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"ifc_file_version_id" uuid,
	"ifc_global_id" text,
	"ifc_class" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_attachments" ADD CONSTRAINT "form_attachments_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_attachments" ADD CONSTRAINT "form_attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_issue_links" ADD CONSTRAINT "form_issue_links_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_issue_links" ADD CONSTRAINT "form_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_issue_links" ADD CONSTRAINT "form_issue_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_template_versions" ADD CONSTRAINT "form_template_versions_template_id_form_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_template_versions" ADD CONSTRAINT "form_template_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_template_id_form_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_template_version_id_form_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."form_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_links" ADD CONSTRAINT "location_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_links" ADD CONSTRAINT "location_links_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_links" ADD CONSTRAINT "location_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_ifc_file_version_id_file_versions_id_fk" FOREIGN KEY ("ifc_file_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_attachments_form_idx" ON "form_attachments" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "form_issue_links_form_idx" ON "form_issue_links" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_issue_links_issue" ON "form_issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_template_versions_unique" ON "form_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE INDEX "form_templates_project_idx" ON "form_templates" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_templates_code" ON "form_templates" USING btree ("project_id","code") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "forms_number" ON "forms" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_seq" ON "forms" USING btree ("template_id","number_key","seq");--> statement-breakpoint
CREATE INDEX "forms_project_idx" ON "forms" USING btree ("project_id","status","form_date");--> statement-breakpoint
CREATE UNIQUE INDEX "location_links_target" ON "location_links" USING btree ("kind","target_id");--> statement-breakpoint
CREATE INDEX "location_links_location_idx" ON "location_links" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "locations_parent_idx" ON "locations" USING btree ("project_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_code_unique" ON "locations" USING btree ("project_id","code") WHERE code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "locations_ifc_idx" ON "locations" USING btree ("project_id","ifc_global_id");