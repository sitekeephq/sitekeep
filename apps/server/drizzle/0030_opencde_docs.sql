CREATE TABLE "opencde_doc_session_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"session_file_id" text NOT NULL,
	"file_name" text NOT NULL,
	"document_id" uuid,
	"target_name" text,
	"size_in_bytes" bigint,
	"part_size" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_id" uuid,
	"version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencde_doc_session_files_uq" UNIQUE("session_id","session_file_id")
);
--> statement-breakpoint
CREATE TABLE "opencde_doc_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid NOT NULL,
	"oauth_client_id" uuid,
	"client_name" text NOT NULL,
	"ui_key_hash" text NOT NULL,
	"ui_expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"callback_url" text NOT NULL,
	"callback_expires_at" timestamp with time zone NOT NULL,
	"supported_extensions" text[] DEFAULT '{}'::text[] NOT NULL,
	"project_id" uuid,
	"folder_id" uuid,
	"comment" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selected_version_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "opencde_doc_sessions_ui_key_hash_unique" UNIQUE("ui_key_hash")
);
--> statement-breakpoint
CREATE TABLE "opencde_upload_parts" (
	"file_row_id" uuid NOT NULL,
	"part_index" integer NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencde_upload_parts_file_row_id_part_index_pk" PRIMARY KEY("file_row_id","part_index")
);
--> statement-breakpoint
ALTER TABLE "opencde_doc_session_files" ADD CONSTRAINT "opencde_doc_session_files_session_id_opencde_doc_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."opencde_doc_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opencde_doc_session_files" ADD CONSTRAINT "opencde_doc_session_files_document_id_files_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opencde_doc_session_files" ADD CONSTRAINT "opencde_doc_session_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opencde_doc_session_files" ADD CONSTRAINT "opencde_doc_session_files_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opencde_doc_sessions" ADD CONSTRAINT "opencde_doc_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opencde_doc_sessions" ADD CONSTRAINT "opencde_doc_sessions_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opencde_doc_sessions" ADD CONSTRAINT "opencde_doc_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opencde_doc_sessions" ADD CONSTRAINT "opencde_doc_sessions_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opencde_upload_parts" ADD CONSTRAINT "opencde_upload_parts_file_row_id_opencde_doc_session_files_id_fk" FOREIGN KEY ("file_row_id") REFERENCES "public"."opencde_doc_session_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opencde_doc_sessions_user_idx" ON "opencde_doc_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "opencde_doc_sessions_expires_idx" ON "opencde_doc_sessions" USING btree ("expires_at");