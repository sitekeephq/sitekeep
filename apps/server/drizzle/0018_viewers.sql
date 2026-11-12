CREATE TABLE "version_previews" (
	"version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"error" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "version_previews_version_id_kind_pk" PRIMARY KEY("version_id","kind")
);
--> statement-breakpoint
CREATE TABLE "version_texts" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"content" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "version_previews" ADD CONSTRAINT "version_previews_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_texts" ADD CONSTRAINT "version_texts_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_texts" ADD CONSTRAINT "version_texts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "version_texts_project_idx" ON "version_texts" USING btree ("project_id");