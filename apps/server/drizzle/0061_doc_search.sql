-- Document search (docs/features/DOCUMENT_SEARCH.md, issue #191): saved searches and their shares,
-- a full-text vector of each version's text (relevance ranking) and, on PostgreSQL with pg_trgm,
-- trigram indexes that serve the search's LIKE '%…%' matching. PGlite (tests, single-server
-- installs) has no pg_trgm: the same queries run there without these indexes.
CREATE TABLE IF NOT EXISTS "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_search_shares" (
	"search_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	CONSTRAINT "saved_search_shares_search_id_subject_type_subject_id_pk" PRIMARY KEY("search_id","subject_type","subject_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "saved_search_shares" ADD CONSTRAINT "saved_search_shares_search_id_saved_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_search_shares_subject_idx" ON "saved_search_shares" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_searches_project_idx" ON "saved_searches" USING btree ("project_id","owner_id");--> statement-breakpoint
-- Folded the same way as the search (fold() in src/modules/documents/search.ts, foldTr in the app).
ALTER TABLE "version_texts" ADD COLUMN IF NOT EXISTS "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, lower(translate(left(content, 100000), 'İIıŞĞÜÖÇ/-_.,;:', 'iiişğüöç       ')))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "version_texts_tsv_idx" ON "version_texts" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_versions_uploaded_idx" ON "file_versions" USING btree ("uploaded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_project_live_idx" ON "files" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
-- Trigram indexes when pg_trgm can be installed (a trusted extension since PostgreSQL 13). Without it
-- search still works, by scanning. The expressions must stay identical to fold() in search.ts.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
		BEGIN
			CREATE EXTENSION IF NOT EXISTS pg_trgm;
		EXCEPTION WHEN OTHERS THEN
			RAISE NOTICE 'pg_trgm could not be installed (%); document search runs without trigram indexes', SQLERRM;
		END;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
		EXECUTE $i$CREATE INDEX IF NOT EXISTS "files_name_trgm_idx" ON "files" USING gin (lower(translate(name, 'İIıŞĞÜÖÇ', 'iiişğüöç')) gin_trgm_ops)$i$;
		EXECUTE $i$CREATE INDEX IF NOT EXISTS "files_attributes_trgm_idx" ON "files" USING gin (lower(translate(attributes::text, 'İIıŞĞÜÖÇ', 'iiişğüöç')) gin_trgm_ops)$i$;
		EXECUTE $i$CREATE INDEX IF NOT EXISTS "version_texts_content_trgm_idx" ON "version_texts" USING gin (lower(translate(content, 'İIıŞĞÜÖÇ', 'iiişğüöç')) gin_trgm_ops)$i$;
	END IF;
END $$;
