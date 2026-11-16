CREATE TABLE "drawing_sheet_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"states" jsonb DEFAULT '["shared","published"]'::jsonb NOT NULL,
	"folder_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"page_count" integer DEFAULT 1 NOT NULL,
	"number" text NOT NULL,
	"number_key" text NOT NULL,
	"number_source" text NOT NULL,
	"title" text,
	"discipline" text,
	"revision" text,
	"sheet_date" text,
	"edited" boolean DEFAULT false NOT NULL,
	"edited_by" uuid,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_set_items" (
	"set_id" uuid NOT NULL,
	"number_key" text NOT NULL,
	"number" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sheet_set_items_set_id_number_key_pk" PRIMARY KEY("set_id","number_key")
);
--> statement-breakpoint
CREATE TABLE "sheet_set_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue" integer NOT NULL,
	"note" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drawing_sheet_settings" ADD CONSTRAINT "drawing_sheet_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_sheets" ADD CONSTRAINT "drawing_sheets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_sheets" ADD CONSTRAINT "drawing_sheets_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_sheets" ADD CONSTRAINT "drawing_sheets_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_sheets" ADD CONSTRAINT "drawing_sheets_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_set_items" ADD CONSTRAINT "sheet_set_items_set_id_sheet_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."sheet_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_set_items" ADD CONSTRAINT "sheet_set_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_set_publications" ADD CONSTRAINT "sheet_set_publications_set_id_sheet_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."sheet_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_set_publications" ADD CONSTRAINT "sheet_set_publications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_set_publications" ADD CONSTRAINT "sheet_set_publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_sets" ADD CONSTRAINT "sheet_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_sets" ADD CONSTRAINT "sheet_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_sheets_version_page" ON "drawing_sheets" USING btree ("version_id","page");--> statement-breakpoint
CREATE INDEX "drawing_sheets_project_key_idx" ON "drawing_sheets" USING btree ("project_id","number_key");--> statement-breakpoint
CREATE INDEX "drawing_sheets_file_idx" ON "drawing_sheets" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_set_publications_issue" ON "sheet_set_publications" USING btree ("set_id","issue");--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_sets_project_name" ON "sheet_sets" USING btree ("project_id",lower("name"));