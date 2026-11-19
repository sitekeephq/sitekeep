CREATE TABLE "project_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"scope" text NOT NULL,
	"requested_by" uuid,
	"job_id" uuid,
	"files_total" integer DEFAULT 0 NOT NULL,
	"files_done" integer DEFAULT 0 NOT NULL,
	"bytes_total" bigint DEFAULT 0 NOT NULL,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"counts" jsonb,
	"storage_key" text,
	"size" bigint,
	"sha256" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"job_id" uuid,
	"file_name" text,
	"upload_key" text,
	"size" bigint,
	"sha256" text,
	"code" text NOT NULL,
	"name" text,
	"project_id" uuid,
	"phase" text,
	"files_total" integer DEFAULT 0 NOT NULL,
	"files_done" integer DEFAULT 0 NOT NULL,
	"report" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_exports" ADD CONSTRAINT "project_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_exports" ADD CONSTRAINT "project_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_imports" ADD CONSTRAINT "project_imports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_imports" ADD CONSTRAINT "project_imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_exports_project_idx" ON "project_exports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_imports_created_idx" ON "project_imports" USING btree ("created_at");