CREATE TABLE "model_markup_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"markup_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_markups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"version_ids" jsonb NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"color" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"viewpoint" jsonb NOT NULL,
	"anchor" jsonb,
	"shapes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_id" uuid NOT NULL,
	"issue_id" uuid,
	"carried_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_markup_comments" ADD CONSTRAINT "model_markup_comments_markup_id_model_markups_id_fk" FOREIGN KEY ("markup_id") REFERENCES "public"."model_markups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_markup_comments" ADD CONSTRAINT "model_markup_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_markups" ADD CONSTRAINT "model_markups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_markups" ADD CONSTRAINT "model_markups_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_markups" ADD CONSTRAINT "model_markups_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_markups" ADD CONSTRAINT "model_markups_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_markups" ADD CONSTRAINT "model_markups_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_markups" ADD CONSTRAINT "model_markups_carried_from_id_model_markups_id_fk" FOREIGN KEY ("carried_from_id") REFERENCES "public"."model_markups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_markup_comments_markup_idx" ON "model_markup_comments" USING btree ("markup_id","created_at");--> statement-breakpoint
CREATE INDEX "model_markups_file_idx" ON "model_markups" USING btree ("project_id","file_id");--> statement-breakpoint
CREATE INDEX "model_markups_version_idx" ON "model_markups" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "model_markups_carried_idx" ON "model_markups" USING btree ("carried_from_id");