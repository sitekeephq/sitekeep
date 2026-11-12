CREATE TABLE IF NOT EXISTS "autodesk_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"external_hub_id" text,
	"external_project_id" text NOT NULL,
	"external_project_name" text,
	"account_id" text,
	"authorized_autodesk_id" text,
	"authorized_email" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_completed_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"last_error" text,
	"watermarks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"parent_external_id" text,
	"display_name" text,
	"source_created_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"source_deleted" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_entity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"native_type" text NOT NULL,
	"native_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "showcase_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "showcase_records" (
	"batch_id" uuid NOT NULL,
	"native_type" text NOT NULL,
	"native_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_document_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_hub_id" text NOT NULL,
	"external_project_id" text NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"parent_external_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"version_number" integer,
	"web_url" text,
	"source_created_at" timestamp with time zone,
	"source_modified_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'autodesk_connections_project_id_projects_id_fk') THEN ALTER TABLE "autodesk_connections" ADD CONSTRAINT "autodesk_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'autodesk_connections_created_by_users_id_fk') THEN ALTER TABLE "autodesk_connections" ADD CONSTRAINT "autodesk_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'autodesk_connections_updated_by_users_id_fk') THEN ALTER TABLE "autodesk_connections" ADD CONSTRAINT "autodesk_connections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_entities_connection_id_autodesk_connections_id_fk') THEN ALTER TABLE "external_entities" ADD CONSTRAINT "external_entities_connection_id_autodesk_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."autodesk_connections"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_entity_links_connection_id_autodesk_connections_id_fk') THEN ALTER TABLE "external_entity_links" ADD CONSTRAINT "external_entity_links_connection_id_autodesk_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."autodesk_connections"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_sync_runs_connection_id_autodesk_connections_id_fk') THEN ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_connection_id_autodesk_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."autodesk_connections"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'showcase_batches_project_id_projects_id_fk') THEN ALTER TABLE "showcase_batches" ADD CONSTRAINT "showcase_batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'showcase_batches_created_by_users_id_fk') THEN ALTER TABLE "showcase_batches" ADD CONSTRAINT "showcase_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'showcase_records_batch_id_showcase_batches_id_fk') THEN ALTER TABLE "showcase_records" ADD CONSTRAINT "showcase_records_batch_id_showcase_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."showcase_batches"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_document_sources_project_id_projects_id_fk') THEN ALTER TABLE "external_document_sources" ADD CONSTRAINT "external_document_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_documents_source_id_external_document_sources_id_fk') THEN ALTER TABLE "external_documents" ADD CONSTRAINT "external_documents_source_id_external_document_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."external_document_sources"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autodesk_connections_project_external" ON "autodesk_connections" USING btree ("project_id","external_project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autodesk_connections_due_idx" ON "autodesk_connections" USING btree ("enabled","next_sync_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_entities_connection_kind_external" ON "external_entities" USING btree ("connection_id","kind","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_entities_kind_idx" ON "external_entities" USING btree ("connection_id","kind","source_deleted");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_entity_links_source" ON "external_entity_links" USING btree ("connection_id","kind","external_id","native_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_entity_links_native_idx" ON "external_entity_links" USING btree ("native_type","native_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_sync_runs_connection_idx" ON "integration_sync_runs" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "showcase_batches_project_key" ON "showcase_batches" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "showcase_records_unique" ON "showcase_records" USING btree ("batch_id","native_type","native_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "showcase_records_native_idx" ON "showcase_records" USING btree ("native_type","native_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_document_sources_project_provider_external" ON "external_document_sources" USING btree ("project_id","provider","external_project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_document_sources_project_idx" ON "external_document_sources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_documents_source_external" ON "external_documents" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_documents_parent_idx" ON "external_documents" USING btree ("source_id","parent_external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_documents_source_kind_idx" ON "external_documents" USING btree ("source_id","kind");