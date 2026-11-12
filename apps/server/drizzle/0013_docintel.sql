CREATE TABLE "doc_extractions" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"antet" jsonb,
	"revision" jsonb,
	"effective_revision" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"page_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec_registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"section_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"used_ai" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_registers_version_id_unique" UNIQUE("version_id")
);
--> statement-breakpoint
ALTER TABLE "doc_extractions" ADD CONSTRAINT "doc_extractions_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_extractions" ADD CONSTRAINT "doc_extractions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_registers" ADD CONSTRAINT "spec_registers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_registers" ADD CONSTRAINT "spec_registers_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_registers" ADD CONSTRAINT "spec_registers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_extractions_project_idx" ON "doc_extractions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "spec_registers_project_idx" ON "spec_registers" USING btree ("project_id");