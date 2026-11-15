-- ISO 19650 foundation (docs/features/CDE_STATES.md).
-- Generated with drizzle-kit, then edited:
--  * the DROP / DISABLE ROW LEVEL SECURITY statements for module tables (ai, coordinate, field,
--    connect, planning, cost) are removed: those tables belong to the Enterprise modules now
--    (their own migrations) and must never be dropped by the core;
--  * files.container_id is added nullable, backfilled, given a default trigger and only then
--    made NOT NULL (expand, backfill, constrain).
-- The backfills are idempotent; apps/server/src/scripts/cde-backfill.ts runs the same steps in
-- batches on demand.
CREATE TABLE "cde_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"mode" text NOT NULL,
	"workflow_template_id" uuid,
	"require_reason" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_codes" (
	"project_id" uuid NOT NULL,
	"code_norm" text NOT NULL,
	"container_id" uuid NOT NULL,
	"first_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_codes_project_id_code_norm_pk" PRIMARY KEY("project_id","code_norm")
);
--> statement-breakpoint
CREATE TABLE "project_cde_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"enforce_transitions" boolean DEFAULT false NOT NULL,
	"code_scheme" text DEFAULT 'iso_uk_na' NOT NULL,
	"suitability_codes" jsonb,
	"revision_rules" jsonb,
	"archive_folder_id" uuid,
	"container_standard_id" uuid,
	"wip_policy" text DEFAULT 'grants' NOT NULL,
	"admin_sees_wip" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_roles" ADD COLUMN "kind" text DEFAULT 'role' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_roles" ADD COLUMN "company_id" uuid;
--> statement-breakpoint
ALTER TABLE "project_roles" ADD COLUMN "code" text;
--> statement-breakpoint
ALTER TABLE "project_roles" ADD COLUMN "is_lead" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "hash" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "ip" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "user_agent" text;
--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "suitability_code" text;
--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "revision_code" text;
--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "codes_set_by" uuid;
--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "codes_set_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "container_id" uuid;
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "document_code" text;
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "cde_status" text;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "owner_team_id" uuid;
--> statement-breakpoint
ALTER TABLE "cde_transitions" ADD CONSTRAINT "cde_transitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cde_transitions" ADD CONSTRAINT "cde_transitions_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_codes" ADD CONSTRAINT "document_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_codes" ADD CONSTRAINT "document_codes_first_file_id_files_id_fk" FOREIGN KEY ("first_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_cde_settings" ADD CONSTRAINT "project_cde_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_cde_settings" ADD CONSTRAINT "project_cde_settings_archive_folder_id_folders_id_fk" FOREIGN KEY ("archive_folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_cde_settings" ADD CONSTRAINT "project_cde_settings_container_standard_id_naming_standards_id_fk" FOREIGN KEY ("container_standard_id") REFERENCES "public"."naming_standards"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "cde_transitions_unique" ON "cde_transitions" USING btree ("project_id",coalesce("from_state", ''),"to_state");
--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_codes_set_by_users_id_fk" FOREIGN KEY ("codes_set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_team_id_project_roles_id_fk" FOREIGN KEY ("owner_team_id") REFERENCES "public"."project_roles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_project_action_idx" ON "audit_log" USING btree ("project_id","action","at");
--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target_type","target_id");
--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id","at");
--> statement-breakpoint
CREATE INDEX "files_container_idx" ON "files" USING btree ("container_id");
--> statement-breakpoint
-- New files start their own container unless the caller sets one (review copies inherit it).
CREATE OR REPLACE FUNCTION files_container_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.container_id IS NULL THEN
    NEW.container_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS files_container_default ON "files";
--> statement-breakpoint
CREATE TRIGGER files_container_default BEFORE INSERT ON "files" FOR EACH ROW EXECUTE FUNCTION files_container_default();
--> statement-breakpoint
-- Backfill 1: every existing file is its own container.
UPDATE "files" SET "container_id" = "id" WHERE "container_id" IS NULL;
--> statement-breakpoint
-- Backfill 2: an approved review copy belongs to the container of its source; chains (WIP copy to
-- Shared, Shared copy to Published) are walked to the first source. A copy with several sources
-- takes the earliest review's. Bounded: at most 64 steps (also guards against copy cycles).
WITH RECURSIVE "src" AS (
  SELECT DISTINCT ON (rf."copied_file_id") rf."copied_file_id" AS "file_id", rf."file_id" AS "source_id"
  FROM "review_files" rf
  JOIN "reviews" r ON r."id" = rf."review_id"
  JOIN "files" c ON c."id" = rf."copied_file_id"
  WHERE rf."copied_file_id" IS NOT NULL AND rf."copied_file_id" <> rf."file_id"
  ORDER BY rf."copied_file_id", r."created_at", rf."id"
), "walk" ("file_id", "root_id", "depth") AS (
  SELECT "file_id", "source_id", 1 FROM "src"
  UNION ALL
  SELECT w."file_id", s."source_id", w."depth" + 1
  FROM "walk" w JOIN "src" s ON s."file_id" = w."root_id"
  WHERE w."depth" < 64 AND s."source_id" <> w."file_id"
), "roots" AS (
  SELECT DISTINCT ON ("file_id") "file_id", "root_id" FROM "walk" ORDER BY "file_id", "depth" DESC
)
UPDATE "files" f SET "container_id" = root."container_id"
FROM "roots" x JOIN "files" root ON root."id" = x."root_id"
WHERE f."id" = x."file_id" AND f."container_id" IS DISTINCT FROM root."container_id";
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "container_id" SET NOT NULL;
--> statement-breakpoint
-- Backfill 3: settings rows for existing projects, enforcement off (D-8).
INSERT INTO "project_cde_settings" ("project_id", "enforce_transitions")
SELECT "id", false FROM "projects"
ON CONFLICT ("project_id") DO NOTHING;
