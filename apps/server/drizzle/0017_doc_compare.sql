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
--> statement-breakpoint
ALTER TABLE "doc_comparisons" ADD CONSTRAINT "doc_comparisons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comparisons" ADD CONSTRAINT "doc_comparisons_from_version_id_file_versions_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comparisons" ADD CONSTRAINT "doc_comparisons_to_version_id_file_versions_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comparisons" ADD CONSTRAINT "doc_comparisons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_comparisons_pair" ON "doc_comparisons" USING btree ("from_version_id","to_version_id");--> statement-breakpoint
CREATE INDEX "doc_comparisons_project_idx" ON "doc_comparisons" USING btree ("project_id");