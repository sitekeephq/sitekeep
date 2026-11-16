CREATE TABLE "closeout_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"options" jsonb NOT NULL,
	"requested_by" uuid,
	"job_id" uuid,
	"files_total" integer DEFAULT 0 NOT NULL,
	"files_done" integer DEFAULT 0 NOT NULL,
	"bytes_total" bigint DEFAULT 0 NOT NULL,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"storage_key" text,
	"size" bigint,
	"sha256" text,
	"audit_chain" jsonb,
	"problems" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "closeout_archives" ADD CONSTRAINT "closeout_archives_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closeout_archives" ADD CONSTRAINT "closeout_archives_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "closeout_archives_project_idx" ON "closeout_archives" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;