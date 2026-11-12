CREATE TABLE "autodesk_file_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"external_item_id" text NOT NULL,
	"external_version_id" text NOT NULL,
	"version_number" integer,
	"name" text NOT NULL,
	"source_path" text,
	"size_bytes" bigint,
	"target_folder_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"action" text,
	"file_id" uuid,
	"file_version_id" uuid,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "autodesk_file_imports" ADD CONSTRAINT "autodesk_file_imports_connection_id_autodesk_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."autodesk_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autodesk_file_imports" ADD CONSTRAINT "autodesk_file_imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autodesk_file_imports" ADD CONSTRAINT "autodesk_file_imports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autodesk_file_imports_project_idx" ON "autodesk_file_imports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "autodesk_file_imports_item_idx" ON "autodesk_file_imports" USING btree ("connection_id","external_item_id");