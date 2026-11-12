CREATE TABLE "file_markups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"shapes" jsonb NOT NULL,
	"author_id" uuid NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "version_indexes" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"element_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_markups" ADD CONSTRAINT "file_markups_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_markups" ADD CONSTRAINT "file_markups_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_indexes" ADD CONSTRAINT "version_indexes_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_markups_version_idx" ON "file_markups" USING btree ("version_id","page");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_links_unique" ON "issue_links" USING btree ("issue_id","kind","target_id");--> statement-breakpoint
CREATE INDEX "issue_links_target_idx" ON "issue_links" USING btree ("kind","target_id");