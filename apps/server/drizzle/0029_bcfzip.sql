CREATE TABLE "issue_related_topics" (
	"issue_id" uuid NOT NULL,
	"related_guid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_related_topics_issue_id_related_guid_pk" PRIMARY KEY("issue_id","related_guid")
);
--> statement-breakpoint
CREATE TABLE "issue_viewpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"guid" text NOT NULL,
	"idx" integer DEFAULT 1 NOT NULL,
	"viewpoint" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "guid" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "viewpoint_guid" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "modified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "modified_by" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "imported_author" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "guid" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "reference_links" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "modified_by" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "imported_from" jsonb;--> statement-breakpoint
-- Existing issues and comments keep their id as BCF GUID.
UPDATE "issues" SET "guid" = "id"::text;--> statement-breakpoint
UPDATE "issue_comments" SET "guid" = "id"::text;--> statement-breakpoint
ALTER TABLE "issue_related_topics" ADD CONSTRAINT "issue_related_topics_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_viewpoints" ADD CONSTRAINT "issue_viewpoints_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_viewpoints" ADD CONSTRAINT "issue_viewpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_viewpoints_guid" ON "issue_viewpoints" USING btree ("issue_id","guid");--> statement-breakpoint
CREATE INDEX "issue_viewpoints_issue_idx" ON "issue_viewpoints" USING btree ("issue_id","idx");--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comments_guid" ON "issue_comments" USING btree ("issue_id","guid");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_guid" ON "issues" USING btree ("project_id","guid");