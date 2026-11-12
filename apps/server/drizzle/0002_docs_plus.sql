CREATE TABLE "attribute_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_attribute_bindings" (
	"folder_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	CONSTRAINT "folder_attribute_bindings_folder_id_definition_id_pk" PRIMARY KEY("folder_id","definition_id")
);
--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_attribute_bindings" ADD CONSTRAINT "folder_attribute_bindings_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_attribute_bindings" ADD CONSTRAINT "folder_attribute_bindings_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definitions_name" ON "attribute_definitions" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "folder_attribute_bindings_def_idx" ON "folder_attribute_bindings" USING btree ("definition_id");