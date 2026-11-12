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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "param_change_checks" ADD CONSTRAINT "param_change_checks_request_id_param_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."param_change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_checks" ADD CONSTRAINT "param_change_checks_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_items" ADD CONSTRAINT "param_change_items_request_id_param_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."param_change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_base_version_id_file_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_applied_version_id_file_versions_id_fk" FOREIGN KEY ("applied_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_verified_version_id_file_versions_id_fk" FOREIGN KEY ("verified_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "param_change_requests" ADD CONSTRAINT "param_change_requests_lost_version_id_file_versions_id_fk" FOREIGN KEY ("lost_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "param_change_checks_version_idx" ON "param_change_checks" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "param_change_items_request_idx" ON "param_change_items" USING btree ("request_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "param_change_requests_number" ON "param_change_requests" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "param_change_requests_status_idx" ON "param_change_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "param_change_requests_file_idx" ON "param_change_requests" USING btree ("file_id");