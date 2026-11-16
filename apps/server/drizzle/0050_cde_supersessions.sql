CREATE TABLE "cde_supersessions" (
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"superseded_version_id" uuid NOT NULL,
	"review_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cde_supersessions_version_id_superseded_version_id_pk" PRIMARY KEY("version_id","superseded_version_id")
);
--> statement-breakpoint
ALTER TABLE "cde_supersessions" ADD CONSTRAINT "cde_supersessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cde_supersessions" ADD CONSTRAINT "cde_supersessions_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cde_supersessions" ADD CONSTRAINT "cde_supersessions_superseded_version_id_file_versions_id_fk" FOREIGN KEY ("superseded_version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cde_supersessions" ADD CONSTRAINT "cde_supersessions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cde_supersessions_superseded" ON "cde_supersessions" USING btree ("superseded_version_id");--> statement-breakpoint
-- Backfill (ISO-12): archive copies made before this migration. The cde.superseded audit event names
-- the archive copy (file and version number) and the review; the review's approved copy in the same
-- container is the version that replaced it.
INSERT INTO "cde_supersessions" ("project_id", "version_id", "superseded_version_id", "review_id", "created_at")
SELECT a."project_id", nv."id", av."id", rv."id", a."at"
FROM "audit_log" a
JOIN "files" af ON af."id"::text = a."target_id"
JOIN "file_versions" av ON av."file_id" = af."id" AND av."version"::text = a."details"->>'version'
JOIN "reviews" rv ON rv."id"::text = a."details"->>'reviewId'
JOIN "review_files" rf ON rf."review_id" = rv."id" AND rf."copied_version_id" IS NOT NULL
JOIN "file_versions" nv ON nv."id" = rf."copied_version_id"
JOIN "files" nf ON nf."id" = nv."file_id" AND nf."container_id" = af."container_id"
WHERE a."action" = 'cde.superseded' AND a."target_type" = 'file' AND a."project_id" = af."project_id" AND nv."id" <> av."id"
ON CONFLICT DO NOTHING;
