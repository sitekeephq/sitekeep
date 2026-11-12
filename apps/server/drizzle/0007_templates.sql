CREATE TABLE "folder_virtual_children" (
	"folder_id" uuid PRIMARY KEY NOT NULL,
	"children" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_slots" (
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"party" text,
	"code" text,
	"description" text,
	"company_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "project_slots_project_id_key_pk" PRIMARY KEY("project_id","key")
);
--> statement-breakpoint
CREATE TABLE "project_template_origins" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"template_id" text,
	"template_name" text NOT NULL,
	"dimensions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "state_label" text;--> statement-breakpoint
ALTER TABLE "folder_virtual_children" ADD CONSTRAINT "folder_virtual_children_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_slots" ADD CONSTRAINT "project_slots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_slots" ADD CONSTRAINT "project_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_origins" ADD CONSTRAINT "project_template_origins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_slots_company_idx" ON "project_slots" USING btree ("company_id");