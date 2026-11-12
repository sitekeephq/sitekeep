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
--> statement-breakpoint
ALTER TABLE "form_template_versions" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "form_pdf_sources" ADD CONSTRAINT "form_pdf_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_pdf_sources" ADD CONSTRAINT "form_pdf_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_pdf_sources_project_idx" ON "form_pdf_sources" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "form_template_versions" ADD CONSTRAINT "form_template_versions_source_id_form_pdf_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."form_pdf_sources"("id") ON DELETE no action ON UPDATE no action;